import './_test-env.mjs';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { Hono } from 'hono';
import { migrate } from '../db/migrate.js';
import { createRepo } from '../db/repo.js';
import { createFeedRepo } from '../db/feeds.js';
import { createCommentRepo } from '../db/comments.js';
import { createLinkRepo } from '../db/links.js';
import { createRefresher } from '../src/feeds/refresh.js';
import { subscribedSite, createLinkSubscriber } from '../src/feeds/subscriptions.js';
import { createLinkChecker } from '../src/links/check.js';
import { publicRoutes } from '../src/routes/public.js';
import { setThemeResolver, setThemeRenderer } from '../src/render/layout.js';
import { registerLinkRoutes } from '../src/routes/admin/links.js';
import { createChecker } from './_check.mjs';
const tick = () => new Promise((r) => setImmediate(r));
const deferred = () => { let resolve; const promise = new Promise((r) => { resolve = r; }); return { promise, resolve }; };
const db = new DatabaseSync(':memory:'); migrate(db, { log() {} });
const repo = createRepo(db), feeds = createFeedRepo(db), comments = createCommentRepo(db), links = createLinkRepo(db);
const post = Number(db.prepare("INSERT INTO posts(slug,kind,title,draft,published_at) VALUES('test','post','Test',0,'2026-01-01')").run().lastInsertRowid);
const comment = (host, path = '/') => comments.add({ postId: post, author: '邻居', website: `https://${host}${path}`, bodyMd: '你好', status: 'approved' });
const rss = '<rss><channel><title>新站</title><link>https://new.example/</link><item><guid>1</guid><title>文章</title><link>https://new.example/p</link></item></channel></rss>';
const ctx = (_c, extra) => ({ csrf: 'test', ...extra });
const { test, report } = createChecker();
try {
  await test('换源清空条目、旧站地址与失败记录；提交的名称保留，新地址可回填', async () => {
    const f = feeds.add({ url: 'https://old.example/rss' });
    feeds.markOk(f.id, { title: '旧站', siteUrl: 'https://old.example/', resolvedUrl: 'https://old.example/atom', etag: 'old' });
    feeds.saveItems(f.id, [{ guid: 'old', title: 'old', link: 'https://old.example/p', author: '', summary: '' }]);
    feeds.markFail(f.id, 'old failure');
    const changed = feeds.update(f.id, { url: 'https://new.example/rss', title: '自定义名称' });
    assert.equal(feeds.countItemsOf(f.id), 0);
    for (const k of ['etag', 'resolved_url', 'last_fetch_at', 'last_ok_at', 'last_error']) assert.equal(changed[k], null);
    assert.equal(changed.site_url, ''); assert.equal(changed.fail_count, 0);
    await createRefresher({ feeds, fetchDoc: async () => ({ text: rss }) }).refreshOne(f.id);
    assert.equal(feeds.get(f.id).title, '自定义名称'); assert.equal(feeds.get(f.id).site_url, 'https://new.example/');
    feeds.update(f.id, { url: changed.url, title: '改名' });
    assert.equal(feeds.countItemsOf(f.id), 1);
  });
  await test('最新评论换网址后缓存跳转与失败计数失效，手动隐藏仍保留', async () => {
    comment('neighbor.example', '/old');
    links.markOk('neighbor.example', { url: 'https://redirect.example/old', title: '旧标题' });
    links.markFail('neighbor.example'); links.markFail('neighbor.example'); links.markFail('neighbor.example');
    links.setHidden('neighbor.example', true);
    comment('neighbor.example', '/');
    const site = links.getSite('neighbor.example');
    assert.equal(site.url, 'https://neighbor.example/'); assert.equal(site.alive, 1);
    assert.equal(site.fail_count, 0); assert.equal(site.checked_at, null); assert.equal(site.hidden, 1);
    const checker = createLinkChecker({ links, probe: async (url) => {
      assert.equal(url, 'https://neighbor.example/'); return { state: 'dead', error: 'timeout' };
    } });
    await checker.checkHost('neighbor.example');
    assert.equal(links.getSite('neighbor.example').fail_count, 1);
    assert.equal(links.getSite('neighbor.example').hidden, 1);
    links.setHidden('neighbor.example', false);
    assert.equal(links.publicList().find((s) => s.host === 'neighbor.example').url, site.url);
  });
  await test('友链主题上下文：name / comments / last_seen 与数据库列名解耦', async () => {
    let captured = null;
    setThemeResolver(() => ({ id: 'capture', name: 'Capture', version: '1.0.0' }));
    setThemeRenderer((theme, opts) => { captured = opts; return '<!doctype html><html><body><main id="main">x</main></body></html>'; });
    try {
      const app = publicRoutes(repo, { links });
      assert.equal((await app.request('/links/')).status, 200);
      const row = captured?.themeData?.links?.find((item) => item.host === 'neighbor.example');
      assert.ok(row, '主题应收到 neighbor.example');
      assert.equal(row.name, '邻居');
      assert.ok(row.comments >= 1);
      assert.ok(row.last_seen, 'last_seen 应取最近的 last_at');
    } finally {
      setThemeResolver(() => null);
      setThemeRenderer(null);
    }
  });
  await test('单站探测走按 host 查询，不读取全量聚合名单', async () => {
    const checker = createLinkChecker({ links: { ...links, listSites() { throw new Error('不应全量查'); } }, probe: async () => ({ state: 'ok' }) });
    assert.equal((await checker.checkHost('neighbor.example')).state, 'ok');
  });
  await test('友圈整轮与手动刷新共用最多 4 个并发额度，重复源只抓一次', async () => {
    db.exec('DELETE FROM feeds');
    const rows = Array.from({ length: 9 }, (_, i) => feeds.add({ url: `https://feed.example/${i}` }));
    const gate = deferred(); let active = 0, max = 0, calls = 0;
    const refresher = createRefresher({ feeds, fetchDoc: async () => {
      calls++; active++; max = Math.max(max, active); await gate.promise; active--; return { text: rss };
    } });
    const bulk = refresher.refreshAll(), manual = refresher.refreshOne(rows[0].id);
    await tick(); assert.equal(active, 4); gate.resolve(); await Promise.all([bulk, manual]);
    assert.equal(max, 4); assert.equal(calls, 9);
  });
  await test('手动全量检查接续自动有限轮次，覆盖 41 个站并显示真实进度', async () => {
    db.exec('DELETE FROM comments; DELETE FROM link_sites');
    for (let i = 0; i < 41; i++) comment(`site${i}.example`);
    const gate = deferred(); let active = 0, max = 0, calls = 0;
    const checker = createLinkChecker({ links, probe: async () => {
      calls++; active++; max = Math.max(max, active); await gate.promise; active--; return { state: 'ok' };
    } });
    const automatic = checker.checkAll({ limit: 2 }); await tick();
    const app = new Hono(); registerLinkRoutes(app, { links, linkChecker: checker, repo }, { ctx });
    const result = await app.request('/admin/links/check-all', { method: 'POST' });
    assert.equal(result.status, 303);
    const full = checker.checkAll({ force: true });
    gate.resolve(); await automatic; const tally = await full;
    assert.equal(tally.total, 41); assert.equal(calls, 43); assert.equal(max, 4);
    assert.deepEqual(checker.progress(), { total: 41, completed: 41, running: false });
    // 跑完页头**不再**钉「最近一轮检查已结束：已完成 41 / 41 个站」—— 那一轮的账都落在名单上了。
    // 锚点与 data-* 得留着：客户端只读它决定停不停轮、按钮解不解禁。
    const page = await (await app.request('/admin/links')).text();
    assert.match(page, /<p class="a-links-progress"[^>]*data-running="0"[^>]*data-completed="41"[^>]*data-total="41"><\/p>/);
    assert.doesNotMatch(page, /已完成 41 \/ 41 个站/);
  });
  await test('取消隐藏时已下线的站先复查，提示与实际可见状态一致', async () => {
    const host = 'site0.example'; for (let i = 0; i < 3; i++) links.markFail(host);
    links.setHidden(host, true); const gate = deferred();
    const checker = createLinkChecker({ links, probe: () => gate.promise });
    const app = new Hono(); registerLinkRoutes(app, { links, linkChecker: checker, repo }, { ctx });
    const response = await app.request('/admin/links/hide', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ host, on: '0' }) });
    assert.match(decodeURIComponent(response.headers.get('location')), /正在复查/);
    assert.equal(links.getSite(host).hidden, 0); assert.equal(links.getSite(host).alive, 0);
    const pending = checker.checkHost(host); gate.resolve({ state: 'ok' }); await pending;
    assert.equal(links.getSite(host).alive, 1);
  });
  await test('前台访问友圈/友链不再触发对外抓取；友链正常页一次查询同时拿列表与统计', async () => {
    let feedCalls = 0, linkCalls = 0, statsCalls = 0;
    const app = publicRoutes(repo, {
      feeds,
      links: { ...links, publicCount() { throw new Error('重复统计'); }, publicStats() { statsCalls++; return links.publicStats(); } },
    });
    // 即便调用方还传旧的 refresher/linkChecker 选项，前台也不应再驱动网络任务。
    assert.equal((await app.request('/friends/')).status, 200);
    assert.equal((await app.request('/links/')).status, 200);
    assert.equal(feedCalls, 0); assert.equal(linkCalls, 0);
    assert.equal(statsCalls, 0, '正常页不应再额外跑一次 publicStats');
  });
  await test('一项落库异常后仍等待其他任务结束，避免失败轮次与下一轮重叠', async () => {
    db.exec('DELETE FROM feeds');
    feeds.add({ url: 'https://fast.example/rss' }); feeds.add({ url: 'https://slow.example/rss' });
    const gate = deferred(); let commits = 0;
    const refresher = createRefresher({ feeds, fetchDoc: async (url) => {
      if (url.includes('slow.example')) await gate.promise;
      return { text: rss };
    }, commit: (write) => { if (++commits <= 2) throw new Error('write failed'); return write(); } });
    const pending = refresher.refreshAll(); await tick();
    assert.equal(refresher.busy(), true); gate.resolve();
    await assert.rejects(pending, /write failed/); assert.equal(refresher.busy(), false);
    assert.equal((await refresher.refreshAll({ force: true })).ok, 2);
  });
  await test('升级旧健康表后旧跳转重新验证，手动隐藏偏好保留', async () => {
    links.setHidden('site1.example', true);
    db.exec('ALTER TABLE link_sites DROP COLUMN source_url; DELETE FROM schema_version WHERE version = 24');
    migrate(db, { log() {} }); const upgraded = createLinkRepo(db).getSite('site1.example');
    assert.equal(upgraded.hidden, 1); assert.equal(upgraded.checked_at, null);
    assert.equal(upgraded.url, 'https://site1.example/');
  });
  await test('同站重复识别：www / 协议 / 路径不同也算同一个站，exceptId 让自己不与自己重复', async () => {
    db.exec('DELETE FROM feeds');
    const row = feeds.add({ url: 'https://dup.example/rss' });
    assert.ok(subscribedSite(feeds, ['https://www.dup.example/feed.xml']), 'www 剥掉后仍是同一站');
    assert.ok(subscribedSite(feeds, ['http://dup.example/anything']), '协议与路径不同也是同一站');
    assert.equal(subscribedSite(feeds, ['https://other.example/feed']), null, '别的站不算重复');
    assert.equal(subscribedSite(feeds, ['https://dup.example/feed'], row.id), null, '检查自己时不算重复');
  });
  await test('批量订阅友链：跳过已订阅（含停用）与隐藏 / 已下线的站，成功入库、失败报因且不留无效订阅', async () => {
    db.exec('DELETE FROM feeds; DELETE FROM comments; DELETE FROM link_sites');
    for (const host of ['a.example', 'b.example', 'c.example', 'd.example', 'dup.example', 'off.example']) comment(host);
    feeds.add({ url: 'https://dup.example/rss' });
    const off = feeds.add({ url: 'https://off.example/rss' });
    feeds.setEnabled(off.id, false);
    links.setHidden('c.example', true);    for (let i = 0; i < 3; i++) links.markFail('d.example');
    const asked = [];
    const refresher = { inspectSource: async (url) => {
      asked.push(url);
      if (url.includes('b.example')) throw new Error('这是一个网页，页面里也没有找到 RSS/Atom 订阅地址');
      return { etag: 'e', lastModified: null, resolvedUrl: null, parsed: {
        title: '甲站', siteUrl: url,
        items: [{ guid: '1', title: '第一篇', link: `${url}p/1`, author: '', summary: '' }],
      } };
    } };
    const sub = createLinkSubscriber({ feeds, links, refresher, mutate: (fn) => fn() });
    assert.equal(sub.pendingCount(), 2, '待订阅只剩 a / b 两个站');
    assert.equal(sub.start(), sub.start(), '重复触发只跑一轮');

    const report = await sub.start();
    assert.equal(report.running, false);
    assert.deepEqual([report.total, report.completed], [4, 4], '候选站 = 全部在名单上且可见的邻居（含已订阅，只是会跳过）');
    const by = Object.fromEntries(report.results.map((r) => [r.host, r]));
    assert.equal(by['a.example'].state, 'added');
    assert.equal(by['b.example'].state, 'failed');
    assert.equal(by['dup.example'].state, 'skipped');
    assert.equal(by['dup.example'].detail, '已经订阅');
    assert.equal(by['off.example'].detail, '已经订阅（已停用）', '停用的源也算已订阅，只是要说清楚');
    assert.ok(!by['c.example'] && !by['d.example'], '隐藏 / 已下线的站根本不进这一轮');
    assert.deepEqual(asked.sort(), ['https://a.example/', 'https://b.example/'], '只对未订阅的站发起抓取');
    assert.ok(feeds.list().some((f) => f.url === 'https://a.example/'), '成功的站落了库');
    assert.equal(feeds.list().filter((f) => f.url.includes('b.example')).length, 0, '失败的站没留下无效订阅');
    assert.equal(feeds.countItemsOf(feeds.getByUrl('https://a.example/').id), 1, '抓到的条目一并入库');
    assert.equal(sub.pendingCount(), 1, '失败的站仍算待订阅，下次可以再试一次');
  });
  await test('批量订阅到达源上限后只说明原因、不再新增', async () => {
    db.exec('DELETE FROM feeds; DELETE FROM comments; DELETE FROM link_sites');
    comment('cap1.example'); comment('cap2.example');
    feeds.add({ url: 'https://cap.example/rss' });
    let touched = 0;
    const sub = createLinkSubscriber({
      feeds, links, maxFeeds: 1,
      refresher: { inspectSource: async () => { touched++; throw new Error('不该被抓'); } },
      mutate: (fn) => fn(),
    });
    const report = await sub.start();
    assert.deepEqual(report.results.map((r) => r.state), ['skipped', 'skipped']);
    assert.ok(report.results.every((r) => /上限/.test(r.detail)), '每条都说明撞了上限');
    assert.equal(touched, 0, '满了就不必再去抓');
    assert.equal(feeds.count(), 1);
  });
} finally { db.close(); }
process.exitCode = report();

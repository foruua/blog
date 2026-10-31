#!/usr/bin/env node
import './_test-env.mjs';

// 友链页测试（派生态名单/健康记录/检查器/页面）。A 归并键 JS↔SQL 对照（websiteHost() 与迁移 023 必须给同一 host，否则同一个站会被拆成两条）；B 名单与健康状态机在**私有临时库**上，不碰共享库（各套件顺序共用一个 DATA_DIR）。
// C 判定口径（真实 socket）：起本机假站点让真 server.js 探，**子进程**带 FEED_ALLOW_PRIVATE=true（假站点只能跑 127.0.0.1，SSRF 要拦的正是它）；拦截由 D 层验证。

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { DatabaseSync } from 'node:sqlite';
import { open, close } from '../db/driver.js';
import { migrate } from '../db/migrate.js';
import { createCommentRepo } from '../db/comments.js';
import { createLinkRepo } from '../db/links.js';
import { hashPassword } from '../src/admin/auth.js';
import { websiteHost } from '../src/util/url.js';
import { createLinkChecker, pageTitle, probeSite, FAIL_LIMIT } from '../src/links/check.js';
import { linksProgress } from '../src/admin/views/links.js';
import { cookieJar, createClient, csrfOf, loginAdmin, progressOf as progressFragment } from './_shared.mjs';

const { startServer } = await import('./_server.mjs');
const { createChecker } = await import('./_check.mjs');
const { requireAdminPassword } = await import('./_admin-password.mjs');

const PASSWORD = requireAdminPassword('test-links.mjs');
const { check, report } = createChecker();

console.log('\n友链测试（归并键 / 名单 / 健康 / 判定口径 / 页面）');
console.log('────────────────────────────────────────────');


const root = fs.mkdtempSync(path.join(os.tmpdir(), 'links-test-'));
const DB = path.join(root, 'blog.db');
const CONTENT = path.join(root, 'content');
fs.mkdirSync(path.join(CONTENT, 'posts'), { recursive: true });
fs.writeFileSync(path.join(CONTENT, 'posts', 'link-host-post.md'),
  '---\ntitle: 友链测试用文章\nslug: link-host-post\ndate: 2026-01-01\n---\n正文。\n');

const db = open(DB);
migrate(db, { log() {} });
db.prepare(`INSERT INTO posts(slug, kind, title, draft, published_at, created_at, updated_at)
  VALUES('link-host-post', 'post', '友链测试用文章', 0, '2026-01-01', '2026-01-01 00:00:00', '2026-01-01 00:00:00')`).run();
db.prepare(`INSERT INTO settings(key, value) VALUES('admin_password_hash', ?)
  ON CONFLICT(key) DO UPDATE SET value = excluded.value`).run(hashPassword(PASSWORD));

const POST_ID = db.prepare(`SELECT id FROM posts WHERE slug = 'link-host-post'`).get().id;
const comments = createCommentRepo(db);
const links = createLinkRepo(db);

const addComment = ({ website, author = '邻居', status = 'approved', isAuthor = false, at = '2026-01-01 00:00:00' }) => {
  const id = comments.add({ postId: POST_ID, author, website, bodyMd: '你好', status, isAuthor });
  db.prepare('UPDATE comments SET created_at = ? WHERE id = ?').run(at, id);
  return id;
};

// A. 归并键：JS 与迁移 SQL 回填

const migrationSql = fs.readFileSync('db/migrations/023_links.sql', 'utf8');
const backfill = [...migrationSql.matchAll(/UPDATE comments SET website_host[\s\S]*?;/g)].map((m) => m[0]);
check('A0 从 023 迁移里抠到了四条回填 UPDATE', backfill.length === 4, `实际 ${backfill.length} 条`);

// 在独立内存库上跑那三条 SQL：不碰真表，也不操心 temp 表盖住 main 表。
const scratch = new DatabaseSync(':memory:');
scratch.exec('CREATE TABLE comments(id INTEGER PRIMARY KEY, website TEXT, website_host TEXT)');
const put = scratch.prepare('INSERT INTO comments(website) VALUES(?)');
const sqlHost = (raw) => {
  scratch.exec('DELETE FROM comments');
  put.run(raw);
  for (const stmt of backfill) scratch.exec(stmt);
  return scratch.prepare('SELECT website_host FROM comments').get().website_host;
};

const CASES = [
  'https://example.com/',
  'https://www.example.com/',
  'https://Example.COM/path?a=1&b=2',
  'http://www.example.com:8080/post/1',
  'https://sub.domain.co.uk/',
  'https://a.b.c.example.com/x/y/z',
  'http://www.www.example.com/',
  'https://xn--fiqs8s.example.com/',
  'https://u:p@example.com/x',
  'http://[::1]:8080/',
  'https://[2001:db8::1]/',
];
for (const raw of CASES) {
  const js = websiteHost(raw);
  const sql = sqlHost(raw);
  check(`A 归并键一致：${raw}`, js === sql && js !== null, `JS=${js} SQL=${sql}`);
}

// 空值/不可用地址：两边都应「不是友链」，只是分支不同 —— JS 返 null，SQL 靠 instr(...,'://')=0 返 NULL。
for (const raw of ['', '   ', 'example.com', 'javascript:alert(1)']) {
  check(`A 归并键一致（无效输入）：${JSON.stringify(raw)}`,
    websiteHost(raw) === null && sqlHost(raw) === null, `JS=${websiteHost(raw)} SQL=${sqlHost(raw)}`);
}

// 非 http(s) 在 JS 侧为 null（入库前已被 normalizeUrl 拦掉）；034 迁移负责把老库也校正到同一口径。
check('A 边界：非 http(s) 在 JS 侧为 null（入库前已被 normalizeUrl 拦掉）', websiteHost('ftp://f.com/x') === null);

{
  // IDN 的 Unicode / punycode 形态不能把同一个站拆成两条：迁移末尾用运行时 websiteHost() 再归一一次。
  const raw = 'https://例子.测试/path';
  const id = comments.add({ postId: POST_ID, author: 'IDN', website: raw, bodyMd: 'x', status: 'spam' });
  db.prepare('UPDATE comments SET website_host = ? WHERE id = ?').run('例子.测试', id);
  db.prepare("DELETE FROM settings WHERE key = 'website_host_js_version'").run();
  migrate(db, { log() {} });
  const fixed = db.prepare('SELECT website_host FROM comments WHERE id = ?').get(id).website_host;
  check('A IDN 站点键在迁移后按运行时口径归一', fixed === websiteHost(raw), `实际 ${fixed}`);
  db.prepare('DELETE FROM comments WHERE id = ?').run(id);
}
check('A 边界：IPv6 带端口两边一致（去端口、保留方括号）',
  websiteHost('http://[::1]:8080/') === '[::1]' && sqlHost('http://[::1]:8080/') === '[::1]',
  `JS=${websiteHost('http://[::1]:8080/')} SQL=${sqlHost('http://[::1]:8080/')}`);
scratch.close();


addComment({ website: 'https://www.alpha.example/one', author: '甲', at: '2026-01-01 10:00:00' });
addComment({ website: 'https://alpha.example/two', author: '乙', at: '2026-01-02 10:00:00' });
addComment({ website: 'http://alpha.example:8080/three', author: '甲', at: '2026-01-03 10:00:00' });
addComment({ website: 'https://beta.example/', author: '丙', at: '2026-01-05 10:00:00' });
addComment({ website: 'https://gamma.example/', author: '丁', at: '2026-01-01 09:00:00' });
addComment({ website: 'https://broken.example/', author: '戊', at: '2026-01-04 10:00:00' });
addComment({ website: 'https://pending.example/', author: '待审', status: 'pending' });
addComment({ website: 'https://spam.example/', author: '垃圾', status: 'spam' });
addComment({ website: 'https://author.example/', author: '博主', isAuthor: true });
addComment({ website: null, author: '没填网址', at: '2026-01-07 10:00:00' });
addComment({ website: '', author: '空网址', at: '2026-01-08 10:00:00' });

check('B1 www./端口/大小写三种写法归并成同一条友链', links.publicCount() === 4, `实际 ${links.publicCount()} 条`);

const list = links.publicList({ limit: 24, offset: 0 });
check('B2 排序按留言条数降序', list.map((r) => r.host).join(',') === 'alpha.example,beta.example,broken.example,gamma.example',
  list.map((r) => r.host).join(','));
check('B3 n 是留言条数', list[0].n === 3 && list[1].n === 1, `alpha=${list[0].n} beta=${list[1].n}`);
check('B4 条数相同时看最近留言（broken 01-04 > gamma 01-01）',
  list.findIndex((r) => r.host === 'broken.example') < list.findIndex((r) => r.host === 'gamma.example'));
check('B5 同一 host 多个昵称：取最近那一条的昵称，people 数不同昵称',
  list[0].author === '甲' && list[0].people === 2, `author=${list[0].author} people=${list[0].people}`);
check('B6 待审 / 垃圾 / 博主本人 / 没填网址 都不算友链',
  !list.some((r) => ['pending.example', 'spam.example', 'author.example'].includes(r.host)));
check('B7 空串网址不算友链', !list.some((r) => r.author === '空网址'));
check('B8 publicStats 的条数是留言总和（不是友链条数）',
  links.publicStats().links === 4 && links.publicStats().comments === 6,
  JSON.stringify(links.publicStats()));

const p1 = links.publicList({ limit: 2, offset: 0 }).map((r) => r.host);
const p2 = links.publicList({ limit: 2, offset: 2 }).map((r) => r.host);
check('B9 分页不重不漏', p1.join(',') === 'alpha.example,beta.example' && p2.join(',') === 'broken.example,gamma.example',
  `${p1.join(',')} / ${p2.join(',')}`);


// 还没探过的站默认可见（坑：hidden/alive 无行时是 NULL，`hidden = 0` 会把 NULL 判成假 → 全都消失）。
check('C1 从没检查过的站默认可见（NULL 不能当假）', links.publicCount() === 4);

links.markOk('alpha.example', { url: 'https://alpha.example/', title: '甲记' });
let site = links.listSites().find((s) => s.host === 'alpha.example');
check('C2 markOk 记下站名与时刻', site.alive === 1 && site.fail_count === 0 && site.site_title === '甲记' && !!site.checked_at);

links.markOk('alpha.example', { url: 'https://alpha.example/', title: '' });
site = links.listSites().find((s) => s.host === 'alpha.example');
check('C3 空标题不该冲掉上一次的好标题（挑战页会给「请稍候」或空）', site.site_title === '甲记');

links.markFail('beta.example', { url: 'https://beta.example/', message: '域名解析不了', failLimit: FAIL_LIMIT });
links.markUnknown('broken.example', { url: 'https://broken.example/', message: 'HTTP 403' });
check('C4 一次失败不落地（还在页面上）', links.publicCount() === 4);
check('C5 unknown 只动 checked_at，不碰 fail_count / alive',
  (() => {
    const s = links.listSites().find((x) => x.host === 'broken.example');
    return s.fail_count === 0 && s.alive === 1 && !!s.checked_at;
  })());

links.markFail('beta.example', { url: 'https://beta.example/', message: '域名解析不了', failLimit: FAIL_LIMIT });
check('C6 第 2 次失败仍在页面上', links.publicCount() === 4);
links.markFail('beta.example', { url: 'https://beta.example/', message: '域名解析不了', failLimit: FAIL_LIMIT });
site = links.listSites().find((s) => s.host === 'beta.example');
check('C7 连续第 3 次失败才下线（alive=0）', site.fail_count === 3 && site.alive === 0, `fail=${site.fail_count} alive=${site.alive}`);
check('C8 下线后从前台消失，但仍在后台名单里，且评论一个字没动',
  links.publicCount() === 3
  && links.adminList().some((r) => r.host === 'beta.example')
  && db.prepare(`SELECT COUNT(*) AS n FROM comments WHERE website_host = 'beta.example'`).get().n === 1);

links.markUnknown('beta.example', { url: 'https://beta.example/', message: 'HTTP 403' });
site = links.listSites().find((s) => s.host === 'beta.example');
check('C9 已下线的站遇到一次 403：既不被"洗白"也不被顶掉', site.fail_count === 3 && site.alive === 0);

links.markOk('beta.example', { url: 'https://beta.example/', title: '乙站' });
site = links.listSites().find((s) => s.host === 'beta.example');
check('C10 站回来了自动复原（fail_count 归零）', site.alive === 1 && site.fail_count === 0);
check('C11 复原后重新出现在前台', links.publicCount() === 4);

check('C12 手动隐藏让这个站从前台消失',
  links.setHidden('gamma.example', true) === true && links.publicCount() === 3
  && !links.publicList({ limit: 24 }).some((r) => r.host === 'gamma.example'));
links.markOk('gamma.example', { url: 'https://gamma.example/', title: '伽马' });
check('C13 隐藏优先于 alive：探测成功也不该把他顶回前台', links.publicCount() === 3);
check('C14 放回来', links.setHidden('gamma.example', false) === true && links.publicCount() === 4);

check('C15 后台统计与列表对得上',
  (() => { const s = links.stats(); return s.total === 4 && s.shown === 4 && s.dead === 0 && s.hidden === 0; })(),
  JSON.stringify(links.stats()));
links.setHidden('gamma.example', true);
check('C16 统计里的 hidden / shown 随隐藏变化',
  (() => { const s = links.stats(); return s.total === 4 && s.shown === 3 && s.hidden === 1; })(),
  JSON.stringify(links.stats()));

// 工作清单**包含**隐藏站（也要继续探，否则悄悄活过来不知道），按最久没查在前排。
const sites = links.listSites();
check('C17 检查清单含全部已知站点（隐藏中的也在里面）',
  sites.length === 4 && sites.some((s) => s.host === 'gamma.example'), sites.map((s) => s.host).join(','));
db.prepare(`UPDATE link_sites SET checked_at = NULL WHERE host IN ('alpha.example', 'broken.example')`).run();
db.prepare(`UPDATE link_sites SET checked_at = '2026-01-01 00:00:00' WHERE host = 'beta.example'`).run();
db.prepare(`UPDATE link_sites SET checked_at = '2026-01-02 00:00:00' WHERE host = 'gamma.example'`).run();
const ordered = links.listSites();
check('C18 最久没查的排在最前（没查过的排在查过的之前）',
  ordered.map((s) => s.host).join(',') === 'alpha.example,broken.example,beta.example,gamma.example',
  ordered.map((s) => `${s.host}:${s.checked_at ?? 'null'}`).join(' '));
links.setHidden('gamma.example', false);

// 评论被删 / 标垃圾后，那份孤儿健康记录要清掉
db.prepare(`UPDATE comments SET status = 'spam' WHERE website_host = 'alpha.example'`).run();
check('C19 评论被标垃圾后健康记录成为孤儿并被清掉',
  links.pruneOrphans() >= 1
  && !links.listSites().some((s) => s.host === 'alpha.example')
  && links.publicCount() === 3);
db.prepare(`UPDATE comments SET status = 'approved' WHERE website_host = 'alpha.example'`).run();
check('C20 评论恢复后重新进入名单（健康记录是新的一行，等于"还没查过"）',
  links.publicCount() === 4 && links.listSites().find((s) => s.host === 'alpha.example')?.checked_at === null);


const fakeRepo = () => {
  const calls = [];
  const sites = [
    { host: 'ok.example', url: 'https://ok.example/', checked_at: null },
    { host: 'gone.example', url: 'https://gone.example/', checked_at: null },
    { host: 'blocked.example', url: 'https://blocked.example/', checked_at: null },
    { host: 'boom.example', url: '', checked_at: null },
  ];
  const stamp = (host) => {
    const s = sites.find((x) => x.host === host);
    if (s) s.checked_at = new Date().toISOString();
  };
  return {
    calls,
    listSites: () => sites,
    getSite: (host) => sites.find((s) => s.host === host) ?? null,
    markOk: (host, o) => { calls.push(['ok', host, o.title]); stamp(host); },
    markFail: (host, o) => { calls.push(['fail', host, o.failLimit]); stamp(host); },
    markUnknown: (host, o) => { calls.push(['unknown', host, o.message]); stamp(host); },
    pruneOrphans: () => 0,
  };
};

{
  const repo = fakeRepo();
  const seen = [];
  const checker = createLinkChecker({
    links: repo,
    probe: async (url) => {
      seen.push(url);
      if (url.includes('ok.example')) return { state: 'ok', ms: 12, status: 200, title: '好站', finalUrl: url };
      if (url.includes('gone.example')) return { state: 'dead', ms: 5, status: 404, error: 'HTTP 404' };
      if (url.includes('blocked.example')) return { state: 'unknown', ms: 8, status: 403, error: 'HTTP 403' };
      throw new Error('网络栈炸了');
    },
  });
  const tally = await checker.checkAll();
  check('D1 一轮把四种结果各走一遍', tally.total === 4 && tally.ok === 1 && tally.dead === 1 && tally.unknown === 2, JSON.stringify(tally));
  check('D2 探测函数自己抛异常按"不明"处理（绝不能因为一个没预料到的异常就判死）',
    repo.calls.some((c) => c[0] === 'unknown' && c[1] === 'boom.example'));
  check('D3 没有 url 时兜底到 https://<host>/', seen.includes('https://boom.example/'));
  check('D4 ok 把站名一起落库', repo.calls.some((c) => c[0] === 'ok' && c[2] === '好站'));
  check('D5 fail 带上门槛值', repo.calls.find((c) => c[0] === 'fail')?.[2] === FAIL_LIMIT);
}

{
  const probed = [];
  const checker2 = createLinkChecker({
    links: fakeRepo(),
    probe: async (url) => { probed.push(url); return { state: 'ok', ms: 1, status: 200, title: 'x' }; },
  });
  const t2 = await checker2.checkAll({ limit: 2 });
  check('D6 limit 限制单轮条数', t2.total === 2 && probed.length === 2, JSON.stringify(t2));
  probed.length = 0;
  const t3 = await checker2.checkAll({ force: true, limit: 2 });
  check('D7 force 忽略复查周期（刚查过也再查）', t3.total === 2 && probed.length === 2, JSON.stringify(t3));
  probed.length = 0;
  const t4 = await checker2.checkAll({ intervalMs: 6 * 3600 * 1000 });
  check('D8 周期内不复查已查过的，只补还没查过的',
    t4.total === 2 && !probed.includes('https://ok.example/') && probed.includes('https://blocked.example/'), JSON.stringify(t4));
  check('D9 补完之后再跑一轮没事可做', (await checker2.checkAll({ intervalMs: 6 * 3600 * 1000 })).total === 0);
  check('D9b 单查不存在的 host 报 missing', (await checker2.checkHost('nobody.example')).state === 'missing');
}

{
  let release;
  const checker3 = createLinkChecker({ links: fakeRepo(), probe: () => new Promise((r) => { release = r; }) });
  const run = checker3.checkAll({ limit: 1 });
  const again = checker3.checkAll({ limit: 1 });
  // 比的是 promise 本身（同一对象），不能 await —— 那一轮要等 release 才结束。
  check('D10 一轮进行中 busy() 为真，并发调用复用同一轮', checker3.busy() === true && again === run);
  await Promise.resolve();
  release({ state: 'ok', ms: 1, status: 200 });
  await run;
  check('D11 一轮结束后 busy() 归假', checker3.busy() === false);
}

// private-host / bad-scheme / bad-url 在解析域名前就抛，一个包都不发；本进程没开 FEED_ALLOW_PRIVATE，内网地址会被拦下。
const probeLocal = await probeSite('http://127.0.0.1:1/');
check('D12 指向内网/本机的站点在解析前就被拦掉 → 算"死"',
  probeLocal.state === 'dead' && probeLocal.code === 'private-host', JSON.stringify(probeLocal));
const probeLoopback = await probeSite('http://localhost/');
check('D13 localhost 同理', probeLoopback.state === 'dead' && probeLoopback.code === 'private-host', JSON.stringify(probeLoopback));
const probeScheme = await probeSite('ftp://example.com/');
check('D14 非 http(s) 算"死"（地址本身不能用）', probeScheme.state === 'dead' && probeScheme.code === 'bad-scheme', JSON.stringify(probeScheme));
const probeJunk = await probeSite('这不是地址');
check('D15 畸形地址算"死"', probeJunk.state === 'dead' && probeJunk.code === 'bad-url', JSON.stringify(probeJunk));
// 端口白名单与友圈抓取共用一份（src/feeds/fetch.js）：非 Web 端口在 DNS 之前就被拒，一个包都不发。
const probePort = await probeSite('http://example.com:6379/');
check('D16 非 Web 端口在解析前被拦掉（端口白名单与友圈共用）',
  probePort.state === 'dead' && probePort.code === 'bad-port', JSON.stringify(probePort));

// E. <title> 提取（只当悬停提示，不能拿来认人）

check('E1 命名实体解码', pageTitle('<title>Hello &amp; World</title>') === 'Hello & World');
check('E2 数字实体解码（真实站点的中文标题里很常见）',
  pageTitle('<title>ACEVS &#8211; 你坚持过什么事情？</title>') === 'ACEVS – 你坚持过什么事情？',
  pageTitle('<title>ACEVS &#8211; 你坚持过什么事情？</title>'));
check('E3 十六进制实体', pageTitle('<title>a &#x2013; b</title>') === 'a – b');
check('E4 标签大小写不敏感', pageTitle('<TITLE>x</TITLE>') === 'x');
check('E5 空白折叠成单个空格', pageTitle('<title>a\n   b\t c</title>') === 'a b c');
check('E6 没有 title 给空串', pageTitle('<html><body>hi</body></html>') === '');
check('E7 超长标题截到 120 字', pageTitle(`<title>${'x'.repeat(400)}</title>`).length === 120);
check('E8 只扫前 200KB（再靠后的 <title> 不该被读到）',
  pageTitle(`${'<!--'.padEnd(200_001, ' ')}<title>太后面了</title>`) === '');


const fake = http.createServer((req, res) => {
  const p = (req.url ?? '/').split('?')[0];
  if (p === '/slow') {
    setTimeout(() => {
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
      res.end('<!doctype html><html><head><title>慢站</title></head><body>hi</body></html>');
    }, 1200);
    return;
  }
  if (p === '/ok') {
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
    return res.end('<!doctype html><html><head><title>邻居的好站</title></head><body>hi</body></html>');
  }
  const code = { '/gone': 404, '/blocked': 403, '/boom': 500 }[p];
  res.writeHead(code ?? 200, { 'Content-Type': 'text/html; charset=utf-8' });
  res.end(code ? 'nope' : 'hi');
});
await new Promise((r) => fake.listen(0, '127.0.0.1', r));
const FAKE = `http://127.0.0.1:${fake.address().port}`;

// 归并键忽略端口，四位共用 host 127.0.0.1；探测地址 = COALESCE(link_sites.url, comments.website)，探过后 url 就写上了 —— 要么删健康记录，要么连 url 一起改。
const HOST = '127.0.0.1';
addComment({ website: `${FAKE}/ok`, author: '本机站', at: '2026-01-06 10:00:00' });
const retarget = (p) => db.prepare(`UPDATE link_sites SET url = ? WHERE host = ?`).run(`${FAKE}${p}`, HOST);
const pointAt = (p, { keepHealth = false } = {}) => {
  db.prepare(`UPDATE comments SET website = ? WHERE website_host = ?`).run(`${FAKE}${p}`, HOST);
  if (keepHealth) retarget(p);
  else db.prepare(`DELETE FROM link_sites WHERE host = ?`).run(HOST);
};
const health = () => db.prepare(`SELECT alive, fail_count, last_error, title, url FROM link_sites WHERE host = ?`).get(HOST);

const srv = await startServer({
  env: {
    DATA_DIR: root, DB_FILE: DB, CONTENT_DIR: CONTENT, UPLOADS_DIR: path.join(root, 'uploads'),
    FEED_REFRESH_MS: '0', LINK_CHECK_MS: '0',    FEED_ALLOW_PRIVATE: 'true',    SITE_DOMAIN: 'example.invalid',
  },
});

const jar = cookieJar();
const req = createClient(srv.base, jar);
const html = async (url) => (await req(url)).text();
const post = (url, fields) => req(url, {
  method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams(fields),
});
const back = (res) => decodeURIComponent(res.headers.get('location') ?? '');

try {
  const front = await html('/links/');
  check('F1 /links 列出友链（派生态的名字与域名）',
    front.includes('本机站') && front.includes('alpha.example') && front.includes('beta.example'));
  check('F2 待审/垃圾/博主本人的站不在前台', !front.includes('pending.example') && !front.includes('spam.example') && !front.includes('author.example'));

  await req('/admin/links');
  check('F3 后台没登录时不放行', jar.cookie === '');
  const login = await loginAdmin(req, PASSWORD);
  check('F4 登录成功', login.status === 303 && jar.cookie.startsWith('blog_admin='), `status=${login.status}`);

  const admin = await html('/admin/links');
  check('F5 /admin/links 列出全部站', admin.includes('本机站') && admin.includes('beta.example') && admin.includes('gamma.example'));
  check('F6 后台给出两个动作', admin.includes('立即检查') && admin.includes('从前台隐藏'));
  check('F7 归并生效：www./端口那三种写法没有各占一行', !admin.includes('www.alpha.example'));
  const csrf = csrfOf(admin);
  check('F8 拿到 csrf', csrf.length > 0);

  pointAt('/ok');
  check('F9 探通：回执说探通了', back(await post('/admin/links/check', { _csrf: csrf, host: HOST })).includes('探通了'));
  check('F10 探通落库：alive=1 / fail_count=0 / 记下对方站名',
    health().alive === 1 && health().fail_count === 0 && health().title === '邻居的好站', JSON.stringify(health()));

  pointAt('/gone');
  const gone = back(await post('/admin/links/check', { _csrf: csrf, host: HOST }));
  check('F11 404 → 打不开（算"死"）', gone.includes('打不开'));
  check('F11b 回执里跟行里同一句人话（`404 地址不存在`），不摆裸状态码', gone.includes('（404 地址不存在）'), gone);
  check('F12 404 落库：fail_count=1，但还没下线', health().alive === 1 && health().fail_count === 1, JSON.stringify(health()));
  const rowGone = await html('/admin/links');
  check('F12b 行里只写「404 地址不存在」，不提次数',
    rowGone.includes('>404 地址不存在</p>') && !/404 地址不存在 · /.test(rowGone), '');

  pointAt('/blocked');
  const blocked = back(await post('/admin/links/check', { _csrf: csrf, host: HOST }));
  check('F13 403 → 看不清（算"不明"，绝不是"死"）', blocked.includes('看不清'));
  check('F14 403 落库：alive=1 且 fail_count 归零（不累加）', health().alive === 1 && health().fail_count === 0, JSON.stringify(health()));
  // 「对方有应答但没让我们读」压成一句人话 + 一句后果（不计入撤下）；报文原文一字不丢进 title。
  const rowBlocked = await html('/admin/links');
  check('F14b 行里只留「403 拒绝访问 · 不计入撤下」，完整报文收进 title',
    rowBlocked.includes('>403 拒绝访问 · 不计入撤下</p>')
    && rowBlocked.includes('title="对方返回 HTTP 403"')
    && !rowBlocked.replace(/title="[^"]*"/g, '').includes('对方返回 HTTP 403'), '');

  pointAt('/boom');
  check('F15 5xx → 看不清', back(await post('/admin/links/check', { _csrf: csrf, host: HOST })).includes('看不清'));
  check('F16 5xx 落库：alive=1 且不累加', health().alive === 1 && health().fail_count === 0, JSON.stringify(health()));
  check('F16b 5xx 也翻成一句人话（`500 对方服务异常`）',
    (await html('/admin/links')).includes('>500 对方服务异常 · 不计入撤下</p>'), '');

  // 门槛：连续三次死才下线，中间夹一次不明不该把已攒的次数洗掉
  pointAt('/gone');
  await post('/admin/links/check', { _csrf: csrf, host: HOST });
  await post('/admin/links/check', { _csrf: csrf, host: HOST });
  // 断言用名片里的域名格 markup，不用裸 host 串 —— 绝对链接本就带 SITE_URL，拿裸串判永远为真。
  const inWall = async () => (await html('/links/')).includes(`class="lk-host">${HOST}<`);
  check('F17 连续两次失败仍在页面上', health().fail_count === 2 && health().alive === 1 && (await inWall()));
  retarget('/blocked');
  await post('/admin/links/check', { _csrf: csrf, host: HOST });
  check('F18 中间夹一次 403 不会把攒下的失败次数清零', health().fail_count === 2, JSON.stringify(health()));
  retarget('/gone');
  await post('/admin/links/check', { _csrf: csrf, host: HOST });
  check('F19 第 3 次失败才下线（alive=0）', health().fail_count === 3 && health().alive === 0, JSON.stringify(health()));
  check('F20 下线后从前台消失，后台仍在名单里',
    !(await inWall()) && (await html('/admin/links')).includes(HOST));

  pointAt('/ok', { keepHealth: true });  await post('/admin/links/check', { _csrf: csrf, host: HOST });
  check('F21 站回来了自动复原并重新出现在前台',
    health().alive === 1 && health().fail_count === 0 && (await inWall()), JSON.stringify(health()));

  const hidden = await post('/admin/links/hide', { _csrf: csrf, host: 'beta.example', on: '1' });
  check('F22 隐藏后跳回并带回执', hidden.status === 303 && back(hidden).includes('/admin/links'), back(hidden));
  check('F23 隐藏立刻从前台消失', !(await html('/links/')).includes('beta.example'));
  await post('/admin/links/hide', { _csrf: csrf, host: 'beta.example', on: '0' });
  check('F24 放回来之后前台又能看到', (await html('/links/')).includes('beta.example'));

  const missing = await post('/admin/links/check', { _csrf: csrf, host: 'nobody.example' });
  check('F25 检查名单外的 host 给出明确回执', back(missing).includes('不在名单里'), back(missing));

  const deep = await req('/links/?page=999');
  check('F26 越界页码被夹到最后一页而不是 500', deep.status === 200, `status=${deep.status}`);
  const bogus = await req('/links/?page=abc');
  check('F27 乱填页码也不炸', bogus.status === 200, `status=${bogus.status}`);

  // 统计行按「友圈」形状（金数字 + 滚动 30 天窗口）。断言两半：形状对 + 数字真跟着库里的留言走；只测形状则窗口口径写错照样能过。
  const statOf = (page) => /<p class="mast-stat">([\s\S]*?)<\/p>/.exec(page)?.[1] ?? '';
  const winOf = (page) => {
    const m = /最近 30 天 (\d+) 条留言/.exec(statOf(page));
    return m ? Number(m[1]) : null;
  };

  const frontNow = await html('/links/');
  const shown = statOf(frontNow);
  check('F28 刊头统计行与友圈同一个形状（<b>N</b> 位邻居 + 「最近 30 天 N 条留言」）',
    /<b>\d+<\/b> 位邻居/.test(shown) && winOf(frontNow) !== null, JSON.stringify(shown));
  check('F28b 名单还在（加的是统计，不是把名单换成一行字）',
    frontNow.includes('class="lk-wall"') && frontNow.includes('class="lk-host"'));

  const nInStat = Number(/<b>(\d+)<\/b>/.exec(shown)?.[1]);
  check('F28c 第一格数的是"页面上有几位"（与名单同源，不是另立一个口径）',
    nInStat === links.publicCount(), `stat=${nInStat} repo=${links.publicCount()}`);
  // 夹具留言都在 2026 年 1 月、早于窗口，所以基线必须是 0，后面 +1 / 退回的断言才有意义。
  check('F28d 夹具留言全在窗口之外，所以「最近 30 天」是 0', winOf(frontNow) === 0, String(winOf(frontNow)));

  const one = db.prepare(`SELECT id, created_at FROM comments
    WHERE status = 'approved' AND is_author = 0 AND website_host = 'alpha.example'
    ORDER BY id LIMIT 1`).get();
  db.prepare(`UPDATE comments SET created_at = datetime('now') WHERE id = ?`).run(one.id);
  check('F28e 窗口内的留言算得进来（挪一条到今天，那一格 +1）',
    winOf(await html('/links/')) === 1, String(winOf(await html('/links/'))));

  db.prepare(`UPDATE comments SET created_at = '2025-01-01 00:00:00' WHERE id = ?`).run(one.id);
  check('F28f 窗口外的留言不算（同一条挪到一年前，数字退回去）',
    winOf(await html('/links/')) === 0, String(winOf(await html('/links/'))));

  // 隐藏中的站不该出现在这一页的任何一句话里 —— 包括这一格（它不在名单上）。
  db.prepare(`UPDATE comments SET created_at = datetime('now') WHERE id = ?`).run(one.id);
  await post('/admin/links/hide', { _csrf: csrf, host: 'alpha.example', on: '1' });
  check('F28g 隐藏的站从这一格里一起消失（统计跟着"页面上有谁"走）',
    winOf(await html('/links/')) === 0, String(winOf(await html('/links/'))));
  await post('/admin/links/hide', { _csrf: csrf, host: 'alpha.example', on: '0' });
  db.prepare('UPDATE comments SET created_at = ? WHERE id = ?').run(one.created_at, one.id);
  check('F28h 复原（把留言时间与隐藏状态都还原）',
    winOf(await html('/links/')) === 0 && (await html('/links/')).includes('alpha.example'));

  const adminNow = await html('/admin/links');
  check('F29 后台顶上那条计数条常在（三档：在页面上 / 已撤下 / 已隐藏）',
    adminNow.includes('class="a-links-tally"')
    && adminNow.includes('<span>已撤下</span>') && adminNow.includes('<span>已隐藏</span>'));
  check('F29b 全都在页面上时，不画「在页面上 9」那条标签线',
    !adminNow.includes('a-links-band'), '还画着标签线');
  check('F29c 行内小字只留「最近检查」那一段',
    adminNow.includes('class="a-fl-meta"') && adminNow.includes('最近检查 ')
    && !adminNow.includes('条留言') && !adminNow.includes('最近留言'),
    adminNow.match(/class="a-fl-meta"[^>]*>([^<]*)/)?.[1] ?? '（找不到那行小字）');
  check('F30 行内不再挂五色徽标（状态改由"在哪一段里"承担）',
    !adminNow.includes('a-pill'), 'a-pill 仍在');

  // 超大页码先按总数夹紧：不拿巨大 OFFSET 扫 LIVE_CTE，也不落到空页。
  const adminOver = await html('/admin/links?page=999');
  check('F30b 后台友链超大页码收敛到最后一页',
    adminOver.includes('alpha.example') && !adminOver.includes('还没有人来过'), '');

  for (let i = 0; i < FAIL_LIMIT; i += 1) {
    links.markFail('gamma.example', { url: 'https://gamma.example/', message: '连不上', failLimit: FAIL_LIMIT });
  }
  await post('/admin/links/hide', { _csrf: csrf, host: 'beta.example', on: '1' });
  const adminThree = await html('/admin/links');
  const at = (s) => adminThree.indexOf(s);

  check('F31 分段顺序固定：在页面上 → 已撤下 → 已隐藏（行也各自落在自己那一段里）',
    at('a-fl-host">alpha.example') > -1
    && at('a-fl-host">alpha.example') < at('a-links-band">已撤下')
    && at('a-links-band">已撤下') < at('a-fl-host">gamma.example')
    && at('a-fl-host">gamma.example') < at('a-links-band">已隐藏')
    && at('a-links-band">已隐藏') < at('a-fl-host">beta.example'));
  check('F31b 只有后两段带标签线；第一段靠 a-links-group-lead 自己起头',
    at('a-links-band">在页面上') === -1 && adminThree.includes('a-links-group-lead'));
  check('F31c 两段的计数由行自己数出来',
    adminThree.includes('a-links-band">已撤下<em>1</em>')
    && adminThree.includes('a-links-band">已隐藏<em>1</em>'));

  db.prepare("DELETE FROM link_sites WHERE host = 'gamma.example'").run();
  await post('/admin/links/hide', { _csrf: csrf, host: 'beta.example', on: '0' });
  check('F31d 还原：三档又只剩「在页面上」，标签线随之消失',
    !(await html('/admin/links')).includes('a-links-band'));

  await post('/admin/links/hide', { _csrf: csrf, host: 'beta.example', on: '1' });
  const adminHidden = await html('/admin/links');
  check('F32 隐藏的站归到「已隐藏」那一段（计数为 1），并从前台消失',
    adminHidden.includes('a-links-band">已隐藏<em>1</em>')
    && !(await html('/links/')).includes('beta.example'));
  await post('/admin/links/hide', { _csrf: csrf, host: 'beta.example', on: '0' });
  check('F33 放回来之后它回到「在页面上」那一段（标签线也跟着没了）',
    (await html('/admin/links')).includes('a-links-band') === false
    && (await html('/links/')).includes('beta.example'));

  const hugePage = await req('/links/?page=999999999999999999999');
  check('G0 超大 page 参数被夹取，不会把 OFFSET 变成非安全整数而 500',
    hugePage.status === 200, `status=${hugePage.status}`);
  const draftId = Number(db.prepare(`INSERT INTO posts(slug, kind, title, draft, published_at, created_at, updated_at)
    VALUES('link-draft-post', 'post', '已下架文章', 1, '2026-01-02', '2026-01-02 00:00:00', '2026-01-02 00:00:00')`).run().lastInsertRowid);
  comments.add({ postId: draftId, author: '下架读者', website: 'https://draft.example', bodyMd: 'draft comment', status: 'approved' });
  check('G0b 草稿/已下架文章上的评论不出现在友链页',
    !(await html('/links/')).includes('draft.example'), '');
  const wallNow = await html('/links/');
  check('G1 前台是名片墙：一位一张卡，名录那套标记一个都没有',
    wallNow.includes('class="lk-wall"') && !wallNow.includes('lk-roster') && !wallNow.includes('lk-row'));
  check('G1b 名单没跟着丢（域名与昵称都还在）',
    wallNow.includes('class="lk-host">alpha.example<') && wallNow.includes('class="lk-name">'));
  check('G1c 友链名片不再显示评论条数，底栏日期靠右',
    !wallNow.includes('class="lk-n"')
    && /\.lk-foot \{[^}]*justify-content:\s*flex-end/.test(await html('/style.css')));

  const adminLinksNow = await html('/admin/links');
  check('G2 后台不再有版式切换（连同那一排按钮的样式钩子一起消失）',
    !adminNow.includes('a-links-layout') && !adminLinksNow.includes('/admin/links/layout'));
  check('G3 「查看前台」已撤掉，页头也不再放动作按钮',
    !adminLinksNow.includes('查看前台') && !adminLinksNow.includes('class="a-actions"'));
  check('G3b 「立即检查全部」与三格账目同住在卡片顶部那一行（账目在左、按钮在右）',
    /<div class="a-links-tools">\s*<ul class="a-links-tally">[\s\S]{0,700}data-links-check-all[\s\S]{0,200}立即检查全部[\s\S]{0,80}<\/form>/.test(adminLinksNow));

  // 老库里可能还留着 links_layout 这一行 —— 值是什么都不该再影响渲染。
  db.prepare(`INSERT INTO settings(key, value) VALUES('links_layout', 'a')
              ON CONFLICT(key) DO UPDATE SET value = 'a'`).run();
  const stale = await html('/links/');
  check('G4 遗留的 links_layout 设置不再影响渲染',
    stale.includes('class="lk-wall"') && !stale.includes('lk-roster'));
  db.prepare("DELETE FROM settings WHERE key = 'links_layout'").run();

  const goneRes = await post('/admin/links/layout', { _csrf: csrf, layout: 'a' });
  check('G5 换版式的端点在（已撤掉）', goneRes.status === 404, String(goneRes.status));

  // H. 「立即检查全部」的进度条：一轮要跑几秒到几十秒，页面是静态快照，不自己更新站主只会盯着「0 / 9」以为卡死（友圈批量订阅踩过同一个坑）。
// POST 带 x-requested-with: fetch 换 204，客户端每 1s 拉片段换进度条，跑完 pjax 刷整页；这里测服务端那半。
  const progressOf = (page) => progressFragment(page, 'a-links-progress');
  const fragment = () => req('/admin/links/check-progress').then((r) => r.text());
  const disabledCheckAll = (page) => /data-links-check-all[\s\S]*?<button[^>]*disabled/.test(page);

  const idle = progressOf(await html('/admin/links'));
  check('H1 没跑过时也留着进度锚点（空壳），客户端不必自己造节点',
    idle !== null && idle.total === 0 && idle.text === '' && idle.percent === null, JSON.stringify(idle));
  check('H2 片段端点回的就是那一块（空壳也照回，不是 404 也不是整页）',
    progressOf(await fragment()) !== null);

  const anon = await fetch(`${srv.base}/admin/links/check-progress`, { redirect: 'manual' });
  check('H3 没登录时片段不放行（回登录页 —— 客户端据此停轮，而不是把登录页塞进进度条）',
    anon.status === 303 && (anon.headers.get('location') ?? '').startsWith('/admin/login'),
    `status=${anon.status} location=${anon.headers.get('location')}`);

  // `/slow` 那一位要 1.2s 才回话，所以这一轮至少跑 1.2s —— 「还在跑」才观察得到。
  pointAt('/slow');
  const started = await req('/admin/links/check-all', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded', 'x-requested-with': 'fetch' },
    body: new URLSearchParams({ _csrf: csrf }),
  });
  check('H4 带 fetch 头提交只回 204（进度条自己会更新，不必整页跳一次）',
    started.status === 204, `status=${started.status}`);

  const running = progressOf(await fragment());
  check('H5 跑着时片段说清楚了：data-running=1 + 总数 + 一句「检查中」',
    running?.running === true && running.total > 0 && running.text.startsWith('检查中')
    && running.completed < running.total, JSON.stringify(running));
  check('H6 跑着时进度条按完成比例画（宽度 = completed / total，不是写死的）',
    running?.percent !== null
    && running.percent === Math.round((running.completed / running.total) * 100), JSON.stringify(running));
  check('H7 跑着的时候「立即检查全部」是禁用的（一轮只跑一次，别让站主白等第二轮）',
    disabledCheckAll(await html('/admin/links')));

  let done = progressOf(await fragment());
  for (let i = 0; i < 60 && done?.running; i += 1) {
    await new Promise((r) => setTimeout(r, 200));
    done = progressOf(await fragment());
  }
  check('H8 跑完之后进度归位：running=0 且 completed 追平 total',
    done?.running === false && done.total > 0 && done.completed === done.total, JSON.stringify(done));
  check('H9 跑完之后整块收起（条子与那句话一起收，页头不留「最近一轮检查已结束：已完成 9 / 9 个站」）',
    done?.percent === null && done.text === '', JSON.stringify(done));
  check('H10 首屏与片段逐字对得上（同一份模板，否则每 1s 换出来的东西会跟首屏打架）',
    JSON.stringify(progressOf(await html('/admin/links'))) === JSON.stringify(done));
  check('H11 跑完之后按钮不再禁用', !disabledCheckAll(await html('/admin/links')));
  check('H12 片段不许被缓存（每 1s 拉一次，缓存住就等于进度不动了）',
    (await req('/admin/links/check-progress')).headers.get('cache-control') === 'no-store');
  check('H13 不带 fetch 头时仍旧整页跳（禁用 JS 的老路照走）',
    back(await post('/admin/links/check-all', { _csrf: csrf })).includes('已开始检查全部站点'));

  // H14 起是纯函数：定时轮常一个站都不欠账，弄不出 total=0，只能直接问渲染函数要。
  const shellOnly = (p) => {
    const out = linksProgress(p);
    return !out.includes('<span>') && !out.includes('a-links-meter') && out.includes('data-links-progress=');
  };
  check('H14 没跑过 / 一轮没活儿可干（0 个站）都不留话 —— 常驻一句「0 / 0 个站」纯是噪音',
    shellOnly(null) && shellOnly({ running: false, total: 0, completed: 0 }), linksProgress({ running: false, total: 0, completed: 0 }));
  check('H15 只有"正在跑"才留话与条子（跑完两条一起收，页头不留满格的账）',
    linksProgress({ running: true, total: 4, completed: 1 }).includes('width: 25%')
    && shellOnly({ running: false, total: 4, completed: 4 }));
  check('H16 比例取整且夹在 0–100（completed 超过 total 也不画出格）',
    linksProgress({ running: true, total: 3, completed: 1 }).includes('width: 33%')
    && linksProgress({ running: true, total: 3, completed: 9 }).includes('completed="3"')
    && linksProgress({ running: true, total: 3, completed: 9 }).includes('width: 100%'));
  check('H17 data-running 是客户端唯一的判据（跑完那枚属性还在，只是不再带话）',
    /data-running="1"[\s\S]*已完成 1 \/ 4 个站/.test(linksProgress({ running: true, total: 4, completed: 1 }))
    && /data-running="0"/.test(linksProgress({ running: false, total: 4, completed: 4 }))
    && shellOnly({ running: false, total: 4, completed: 4 }));
} finally {
  await srv.stop();
  await new Promise((r) => fake.close(r));
}

close(db);
fs.rmSync(root, { recursive: true, force: true });

process.exit(report() ? 1 : 0);

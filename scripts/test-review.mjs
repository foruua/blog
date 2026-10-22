import './_test-env.mjs';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import zlib from 'node:zlib';
import { spawnSync } from 'node:child_process';
import { DatabaseSync } from 'node:sqlite';
import { Hono } from 'hono';
import { migrate } from '../db/migrate.js';
import { createRepo } from '../db/repo.js';
import { createAdminRepo } from '../db/admin.js';
import { createCommentRepo } from '../db/comments.js';
import { createFeedRepo } from '../db/feeds.js';
import { createCrypto } from '../src/auth.js';
import { createAdminAuth } from '../src/admin/auth.js';
import { createRenderer } from '../src/render/markdown.js';
import { adminRoutes } from '../src/routes/admin.js';
import { publicRoutes } from '../src/routes/public.js';
import { commentRoutes } from '../src/routes/comments.js';
import { signModeration } from '../src/comments/moderation.js';
import { createRefresher } from '../src/feeds/refresh.js';
import { fetchDocument } from '../src/feeds/fetch.js';
import { acquireMaintenanceLock } from '../src/util/lock.js';
import { atomicWrite } from '../src/util/files.js';
import { snapshot, verifyBackup, restoreBackup, latestRecoverableBackup } from '../src/backup.js';
import { syncContent } from '../src/content/sync.js';
import { validateSlug } from '../src/util/text.js';
import { startServer } from './_server.mjs';
import { createChecker } from './_check.mjs';

const { test, report } = createChecker();
function context() {
  const db = new DatabaseSync(':memory:'); migrate(db, { log() {} });
  const repo = createRepo(db), adminRepo = createAdminRepo(db), comments = createCommentRepo(db), crypt = createCrypto(db);
  repo.setSetting('admin_password_hash', 'configured');
  const auth = createAdminAuth({ db, crypt });
  const csrf = 'review-csrf', cookie = 'blog_admin=' + crypt.sign({ uid: 'owner', ep: 0, csrf, sid: 'review-session' });
  const app = adminRoutes({ repo, adminRepo, comments, crypt, auth, renderer: createRenderer() });
  const post = (url, body) => app.request(url, { method: 'POST', headers: { Cookie: cookie, 'x-csrf-token': csrf, 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
  const addPost = (slug, kind = 'post') => Number(db.prepare("INSERT INTO posts(slug,kind,title,draft,published_at,comments_on) VALUES(?,?,?,0,'2025-01-01T00:00:00Z',1)").run(slug, kind, slug).lastInsertRowid);
  return { db, repo, adminRepo, comments, crypt, auth, app, post, addPost };
}
function temp() { return fs.mkdtempSync(path.join(os.tmpdir(), 'blog-review-test-')); }
const rss = '<rss version="2.0"><channel><title>Test</title><link>https://example.com</link><item><guid>item</guid><title>Item</title><link>https://example.com/item</link></item></channel></rss>';
const document = { text: rss, finalUrl: 'https://example.com/feed' };
console.log('\n项目审查回归测试');

await test('空轮次结束后，新增源能进入下一轮；限额轮次公平刷新 60 个源', async () => {
  const { db } = context();
  try {
    const feeds = createFeedRepo(db), hits = [];
    const refresher = createRefresher({ feeds, fetchDoc: async (url) => { hits.push(url); return document; }, now: () => Date.now() + 3600000 });
    assert.equal((await refresher.refreshAll()).total, 0); assert.equal(refresher.busy(), false);
    for (let i = 0; i < 60; i++) feeds.add({ url: `https://example.com/${i}` });
    await refresher.refreshAll({ limit: 50 }); await refresher.refreshAll({ limit: 50 });
    assert.equal(new Set(hits).size, 60);
    hits.length = 0; assert.equal((await refresher.refreshAll({ force: true })).total, 60);
    assert.equal(hits.length, 60); assert.equal(refresher.busy(), false);
  } finally { db.close(); }
});
await test('同源抓取合并请求；抓取期间换地址、停用、删除、清空后丢弃旧结果', async () => {
  const { db } = context();
  try {
    const feeds = createFeedRepo(db);
    for (const mutation of ['change', 'disable', 'delete', 'clear']) {
      const feed = feeds.add({ url: `https://example.com/${mutation}` }); let resolve, hits = 0;
      const refresher = createRefresher({ feeds, fetchDoc: () => { hits++; return new Promise((done) => { resolve = done; }); } });
      const a = refresher.refreshOne(feed.id), b = refresher.refreshOne(feed.id);
      assert.equal(a, b); await Promise.resolve(); assert.equal(hits, 1);
      if (mutation === 'change') feeds.update(feed.id, { ...feed, url: feed.url + '-new' });
      if (mutation === 'disable') feeds.setEnabled(feed.id, false);
      if (mutation === 'delete') feeds.remove(feed.id);
      if (mutation === 'clear') feeds.clearItems(feed.id);
      resolve(document); assert.equal((await a).status, 'superseded');
      assert.equal(feeds.countItemsOf(feed.id), 0);
      assert.equal(feeds.get(feed.id)?.last_fetch_at ?? null, null);
    }
  } finally { db.close(); }
});
await test('后台状态变更后原邮件审核链接立即失效', async () => {
  const c = context();
  try {
    const postId = c.addPost('moderation-review');
    const id = c.comments.add({ postId, author: 'A', bodyMd: 'test', status: 'pending' });
    const token = signModeration(c.crypt, { id, nonce: c.comments.get(id).moderation_nonce, epoch: 0, action: 'approve' });
    const routes = commentRoutes({ ...c, notifier: {} });
    assert.equal((await routes.request('/moderate/' + token)).status, 200);
    assert.equal((await c.post('/admin/comments/' + id, { status: 'approved' })).status, 303);
    assert.equal((await routes.request('/moderate/' + token)).status, 400);
  } finally { c.db.close(); }
});
await test('邮件回复消费令牌，重复/并发提交只插入与通知一次；新链接可继续使用', async () => {
  const c = context();
  try {
    const postId = c.addPost('reply-token-review');
    const id = c.comments.add({ postId, author: 'A', bodyMd: 'parent', status: 'approved' });
    const nonce = c.comments.get(id).moderation_nonce;
    const token = signModeration(c.crypt, { id, nonce, epoch: 0, action: 'reply' });
    let notifications = 0;
    const routes = commentRoutes({ ...c, notifier: { notifyCommenter() { notifications++; } } });
    const submit = () => routes.request('/moderate/' + token, { method: 'POST', body: new URLSearchParams({ action: 'reply', body: 'one reply' }) });
    const results = await Promise.all([submit(), submit()]);
    assert.equal(results.filter((r) => r.status === 303).length, 1);
    assert.equal(c.db.prepare('SELECT COUNT(*) AS n FROM comments WHERE parent_id=?').get(id).n, 1);
    assert.equal(notifications, 1);
    assert.notEqual(c.comments.get(id).moderation_nonce, nonce);
    const success = results.find((r) => r.status === 303);
    assert.equal((await routes.request(success.headers.get('location'))).status, 200);
    assert.notEqual((await submit()).status, 303);
    const pendingId = c.comments.add({ postId, author: 'B', bodyMd: 'pending', status: 'pending' });
    const pendingToken = signModeration(c.crypt, { id: pendingId, nonce: c.comments.get(pendingId).moderation_nonce, epoch: 0, action: 'reply' });
    assert.equal((await routes.request('/moderate/' + pendingToken, { method: 'POST', body: new URLSearchParams({ action: 'reply', body: 'no reply' }) })).status, 409);
    assert.equal(notifications, 1);
  } finally { c.db.close(); }
});
await test('保存错误的标题只转义一次，仍阻止 HTML 注入', async () => {
  const c = context();
  try {
    const id = c.addPost('occupied-review');
    c.db.prepare('UPDATE posts SET title=? WHERE id=?').run('A&B <img src=x>', id);
    const res = await c.post('/admin/save', { title: 'another', slug: 'occupied-review', body: 'text' });
    const html = await res.text();
    assert.equal(res.status, 400);
    assert.ok(html.includes('A&amp;B &lt;img src=x&gt;'));
    assert.ok(!html.includes('A&amp;amp;B'));
    assert.ok(!html.includes('<img src=x>'));
  } finally { c.db.close(); }
});
await test('媒体引用缓存随正文更新失效，摘要不缓存，代码示例不算引用', async () => {
  const { mediaUsage, createUsageCache } = await import('../src/media/usage.js');
  const references = createUsageCache({ maxEntries: 2, maxBytes: 1000 });
  const items = [{ id: 1, path: '/uploads/a.png' }, { id: 2, path: '/uploads/b.png' }];
  let post = { id: 1, title: 'old', body_md: '![A](/uploads/a.png)' };
  assert.equal(mediaUsage(items, [post], references).get(1).length, 1);
  post = { ...post, title: 'new' };
  assert.equal(mediaUsage(items, [post], references).get(1)[0].title, 'new');
  post.body_md = '![B][image]\n\n[image]: /uploads/b.png\n\n`![A](/uploads/a.png)`';
  const result = mediaUsage(items, [post], references);
  assert.equal(result.get(1).length, 0); assert.equal(result.get(2).length, 1);
  references('![C](/uploads/c.png)'); references('![D](/uploads/d.png)');
  assert.equal(mediaUsage(items, [], references).get(2).length, 0);
});
await test('第 51 次登出不会恢复旧 cookie；旧版 SID 格式仍被拒绝，过期记录被清理', async () => {
  const c = context();
  try {
    const app = new Hono(); app.get('/issue', (ctx) => { c.auth.issue(ctx); return ctx.text('ok'); });
    app.post('/logout', (ctx) => { c.auth.logout(ctx); return ctx.text('ok'); });
    app.get('/check', (ctx) => ctx.json({ valid: Boolean(c.auth.session(ctx)) }));
    let first;
    for (let i = 0; i < 51; i++) {
      const cookie = (await app.request('/issue')).headers.get('set-cookie').split(';')[0]; first ??= cookie;
      await app.request('/logout', { method: 'POST', headers: { cookie } });
    }
    assert.equal((await (await app.request('/check', { headers: { cookie: first } })).json()).valid, false);
    c.repo.setSetting('admin_revoked_sids', JSON.stringify(['review-session', { sid: 'expired', exp: 1 }]));
    assert.equal((await c.app.request('/admin', { headers: { Cookie: 'blog_admin=' + c.crypt.sign({ uid: 'owner', ep: 0, csrf: 'x', sid: 'review-session' }) } })).status, 303);
    await app.request('/logout', { method: 'POST', headers: { cookie: (await app.request('/issue')).headers.get('set-cookie').split(';')[0] } });
    assert.ok(!JSON.parse(c.repo.getSetting('admin_revoked_sids')).some((item) => item.sid === 'expired'));
  } finally { c.db.close(); }
});
await test('后台拒绝过长 slug 和保留页面名，文件入口采用相同校验', async () => {
  const c = context();
  try {
    for (const slug of ['a'.repeat(180), '中'.repeat(100)]) {
      const result = await c.post('/admin/api/autosave', { title: 'Test', slug, body: 'x', kind: 'post', draft: '1' });
      assert.equal(result.status, 400); assert.ok(validateSlug(slug));
    }
    for (const slug of ['posts', 'admin', 'healthz', 'friends']) {
      assert.equal((await c.post('/admin/api/autosave', { title: 'Page', slug, kind: 'page', body: 'x' })).status, 400);
    }
    const file = path.join(process.env.CONTENT_DIR, 'pages', 'reserved-review.md');
    fs.writeFileSync(file, '---\nslug: posts\ndate: 2025-01-01\n---\nx');
    try { assert.match(syncContent(c.repo, { quiet: true }).errors.join(' '), /系统路由冲突/); }
    finally { fs.rmSync(file); }
  } finally { c.db.close(); }
});
await test('缺失或损坏 owner 的陈旧锁可回收，近期锁仍被拒绝', () => {
  const root = temp();
  try {
    for (const owner of [null, '{', '{}']) {
      const resource = path.join(root, 'resource'), lock = resource + '.blog-lock'; fs.mkdirSync(lock);
      if (owner !== null) fs.writeFileSync(path.join(lock, 'owner.json'), owner);
      fs.utimesSync(lock, new Date(Date.now() - 120000), new Date(Date.now() - 120000));
      acquireMaintenanceLock([resource])(); assert.ok(!fs.existsSync(lock));
    }
    const resource = path.join(root, 'fresh'); fs.mkdirSync(resource + '.blog-lock');
    assert.throws(() => acquireMaintenanceLock([resource]), /资源正在使用/);
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});
await test('同日邻居使用 ID 排序，切为固定页后旧地址重定向到正确 URL', async () => {
  const c = context();
  try {
    const a = c.addPost('equal-a'), b = c.addPost('equal-b');
    assert.equal(c.repo.neighbours(c.repo.getPost('equal-a')).newer.slug, 'equal-b');
    assert.equal(c.repo.neighbours(c.repo.getPost('equal-b')).older.slug, 'equal-a');
    c.db.prepare("UPDATE posts SET kind='page',slug='converted-review' WHERE id=?").run(a);
    c.adminRepo.addAlias('/p/equal-a/', a);
    const pub = publicRoutes(c.repo, c), res = await pub.request('/p/equal-a/');
    assert.equal(res.status, 301); assert.equal(res.headers.get('location'), '/converted-review');
    assert.ok(b > a);
  } finally { c.db.close(); }
});
await test('修订回滚保留自定义 front matter', async () => {
  const c = context();
  try {
    const out = await (await c.post('/admin/api/autosave', { title: 'A', slug: 'restore-front-review', kind: 'post', body: 'first', draft: '1' })).json();
    const item = c.adminRepo.get(out.id); fs.writeFileSync(item.file_path, fs.readFileSync(item.file_path, 'utf8').replace('---\n', '---\ncustom: preserved\n'));
    const revision = c.adminRepo.revisions(out.id)[0];
    assert.equal((await c.post('/admin/restore/' + revision.id, {})).status, 303);
    assert.match(fs.readFileSync(item.file_path, 'utf8'), /custom: preserved/);
    fs.rmSync(item.file_path);
  } finally { c.db.close(); }
});
await test('笔记首屏只加载限定根串和子树，同时保留总数与孤儿提升语义', () => {
  const c = context();
  try {
    const postId = c.addPost('thread-review', 'note');
    const roots = [];
    for (let i = 0; i < 30; i++) roots.push(c.comments.add({ postId, author: 'A', bodyMd: 'root', status: 'approved' }));
    c.comments.add({ postId, parentId: roots[0], author: 'B', bodyMd: 'child', status: 'approved' });
    const rows = c.comments.pageThreadsOf([postId], 5).get(postId);
    assert.equal(rows.length, 6); assert.equal(rows[0].thread_count, 30);
    c.comments.setStatus(roots[0], 'deleted');
    const after = c.comments.pageThreadsOf([postId], 5).get(postId); assert.equal(after[0].thread_count, 30);
    assert.equal(after.length, 5);
  } finally { c.db.close(); }
});
await test('访问友圈页面不会因前台请求催刷（抓取只由定时器/后台触发）', async () => {
  const c = context();
  try {
    const feeds = createFeedRepo(c.db);
    const pub = publicRoutes(c.repo, { ...c, feeds });
    assert.equal((await pub.request('/friends/')).status, 200);
  } finally { c.db.close(); }
});
await test('软链归档不是完整备份，不可用于完整恢复；完整备份不被部分备份挤掉', async () => {
  const c = context(), root = temp();
  try {
    const contentDir = path.join(root, 'content'), uploadsDir = path.join(root, 'uploads'), dir = path.join(root, 'backups');
    fs.mkdirSync(contentDir); fs.mkdirSync(uploadsDir);
    await snapshot(c.db, { contentDir, uploadsDir, dir, keep: 1 });
    const full = latestRecoverableBackup(dir); assert.ok(full);
    fs.writeFileSync(path.join(root, 'outside.md'), 'data'); fs.symlinkSync(path.join(root, 'outside.md'), path.join(contentDir, 'linked.md'));
    const partial = await snapshot(c.db, { contentDir, uploadsDir, dir, keep: 1 }); assert.equal(partial.complete, false);
    assert.equal(latestRecoverableBackup(dir).name, full.name);
    const checked = verifyBackup(path.basename(partial.gzFile).replace('.db.gz', ''), { dir, workDir: path.join(root, 'verify') });
    assert.equal(checked.ok, true);
    assert.throws(() => restoreBackup(checked, { dbFile: path.join(root, 'restored.db'), contentDir: path.join(root, 'restored-content'), uploadsDir: path.join(root, 'restored-uploads') }), /软链/);
    // 资产包按内容哈希命名且被多份备份共享，名字以清单为准，不能再按备份名推导。
    fs.rmSync(path.join(dir, full.assetsName ?? `${full.name}.assets.json.gz`));
    assert.equal(latestRecoverableBackup(dir), null);
  } finally { c.db.close(); fs.rmSync(root, { recursive: true, force: true }); }
});
await test('备份检测缺失响应式候选图', async () => {
  const c = context(), root = temp();
  try {
    const contentDir = path.join(root, 'content'), uploadsDir = path.join(root, 'uploads'); fs.mkdirSync(contentDir); fs.mkdirSync(uploadsDir);
    fs.writeFileSync(path.join(uploadsDir, 'image.png'), 'image');
    c.adminRepo.mediaAdd({ path: '/uploads/image.png', variants: JSON.stringify([{ w: 640, path: '/uploads/image.png.w640.webp' }]) });
    await assert.rejects(snapshot(c.db, { contentDir, uploadsDir, dir: path.join(root, 'backups') }), /附件缺失/);
  } finally { c.db.close(); fs.rmSync(root, { recursive: true, force: true }); }
});
await test('413 同样带安全头和请求 ID；健康检查只对持有 token 的监控公开备份状态', async () => {
  const server = await startServer();
  try {
    const asset = await fetch(server.base + '/nav.js');
    await asset.arrayBuffer();
    const etag = asset.headers.get('etag');
    // etag 可能是弱校验符（响应经 gzip/br 压缩时服务端降为 W/…）。
    // 弱比较下 `W/"x"` 与 `"x"` 等价，所以用它俩都试；别在已带 W/ 的值上再拼一次。
    const bare = etag.replace(/^W\//, '');
    for (const validator of [etag, `W/${bare}`, `"other", ${etag}`, '*']) {
      const cached = await fetch(server.base + '/nav.js', { headers: { 'If-None-Match': validator } });
      assert.equal(cached.status, 304);
      assert.equal(cached.headers.get('cache-control'), asset.headers.get('cache-control'));
      assert.equal(await cached.text(), '');
    }
    const res = await fetch(server.base + '/admin/login', { method: 'POST', body: 'x'.repeat(5000) });
    assert.equal(res.status, 413); assert.ok(res.headers.get('x-request-id'));
    assert.ok(res.headers.get('content-security-policy')); assert.equal(res.headers.get('x-content-type-options'), 'nosniff');
    // 没配 MONITOR_TOKEN 时（生产）匿名只拿得到基础字段：篇数本就公开在 Feed/sitemap 里，
    // 备份年龄与异地状态是内部信息，不该让路过的人读出「这站多久没备份了」。
    const health = await (await fetch(server.base + '/healthz')).json();
    assert.equal(health.ok, true);
    assert.equal(typeof health.posts, 'number');
    assert.ok(!Object.hasOwn(health, 'latestRecoverableBackupAgeSec'), '没配 token 却公开了备份年龄');
    assert.ok(!Object.hasOwn(health, 'offsiteBackup'), '没配 token 却公开了异地备份状态');
  } finally { await server.stop(); }

  // 配了 token：错 token 与不带 token 一律只给基础字段，对的才给备份细节。
  const guarded = await startServer({ env: { MONITOR_TOKEN: 'probe-token' } });
  try {
    const url = guarded.base + '/healthz';
    const anon = await (await fetch(url)).json();
    const wrong = await (await fetch(url, { headers: { 'x-monitor-token': 'probe-tokem' } })).json();
    for (const [label, body] of [['匿名', anon], ['错 token', wrong]]) {
      assert.ok(!Object.hasOwn(body, 'latestRecoverableBackupAgeSec'), `${label}也读到了备份年龄`);
      assert.equal(typeof body.posts, 'number', `${label}也该拿到基础字段`);
    }
    const ok = await (await fetch(url, { headers: { 'x-monitor-token': 'probe-token' } })).json();
    assert.ok(Object.hasOwn(ok, 'latestRecoverableBackupAgeSec'));
    assert.ok(Object.hasOwn(ok, 'offsiteBackup'));
  } finally { await guarded.stop(); }
});
await test('旧迁移链中间态在执行新迁移前明确拒绝', () => {
  const db = new DatabaseSync(':memory:');
  try {
    db.exec("CREATE TABLE posts(id INTEGER PRIMARY KEY); CREATE TABLE schema_version(version INTEGER PRIMARY KEY,name TEXT,applied_at TEXT); INSERT INTO schema_version VALUES(1,'old',NULL)");
    assert.throws(() => migrate(db, { log() {} }), /旧迁移链尚未完成/);
    assert.equal(db.prepare('SELECT COUNT(*) n FROM schema_version').get().n, 1);
  } finally { db.close(); }
});
await test('UTC/Tokyo 的解析、编辑、前台和邮件默认显示使用同一时区', () => {
  for (const offset of ['+00:00', '+09:00']) {
    const run = spawnSync(process.execPath, ['--input-type=module', '-e', `import {parseDate,formatDay,formatDateTime,toLocalInput} from './src/util/text.js';const t=parseDate('2025-01-01 00:30');console.log(JSON.stringify([formatDay(t),formatDateTime(t),toLocalInput(t)]));`], { env: { ...process.env, SITE_TZ_OFFSET: offset }, encoding: 'utf8' });
    assert.equal(run.status, 0, run.stderr);
    assert.deepEqual(JSON.parse(run.stdout), ['2025-01-01', '2025-01-01 00:30', '2025-01-01T00:30:00']);
  }
});
await test('原子写失败保留旧文件；成功后持久化文件和目录', () => {
  const root = temp(), file = path.join(root, 'file.md'); fs.writeFileSync(file, 'before');
  const fsync = fs.fsyncSync;
  try {
    fs.fsyncSync = () => { throw new Error('injected sync failure'); };
    assert.throws(() => atomicWrite(file, 'after'), /injected/); assert.equal(fs.readFileSync(file, 'utf8'), 'before');
    fs.fsyncSync = fsync; atomicWrite(file, 'after'); assert.equal(fs.readFileSync(file, 'utf8'), 'after');
    assert.deepEqual(fs.readdirSync(root), ['file.md']);
  } finally { fs.fsyncSync = fsync; fs.rmSync(root, { recursive: true, force: true }); }
});
await test('DNS 卡住也受总超时约束；混合公私网解析结果被拒绝', async () => {
  const started = Date.now();
  await assert.rejects(fetchDocument('http://example.test/feed', { timeoutMs: 50, lookup: () => new Promise(() => {}) }), (e) => e.code === 'timeout');
  assert.ok(Date.now() - started < 1000);
  await assert.rejects(fetchDocument('http://example.test/feed', { lookup: async () => [{ address: '8.8.8.8', family: 4 }, { address: '127.0.0.1', family: 4 }] }), (e) => e.code === 'private-host');
});
await test('连接只用验证后的解析地址；重定向总超时和压缩后的体积上限生效', async () => {
  const old = process.env.FEED_ALLOW_PRIVATE; process.env.FEED_ALLOW_PRIVATE = 'true';
  const permissive = await import('../src/feeds/fetch.js?review-private');
  if (old == null) delete process.env.FEED_ALLOW_PRIVATE; else process.env.FEED_ALLOW_PRIVATE = old;
  let hostHeader = '', calls = 0;
  const server = http.createServer((req, res) => {
    hostHeader = req.headers.host;
    if (req.url === '/redirect') { setTimeout(() => { res.writeHead(302, { location: '/redirect' }); res.end(); }, 40); return; }
    if (req.url === '/compressed') { res.setHeader('content-encoding', 'gzip'); res.setHeader('content-type', 'application/xml'); res.end(zlib.gzipSync('x'.repeat(20000))); return; }
    res.setHeader('content-type', 'application/rss+xml'); res.end(rss);
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  try {
    const base = `http://feed.example.test:${server.address().port}`;
    const lookup = async () => { calls++; return [{ address: '127.0.0.1', family: 4 }]; };
    assert.match((await permissive.fetchDocument(base, { lookup })).text, /<rss/);
    assert.equal(calls, 1); assert.equal(hostHeader, `feed.example.test:${server.address().port}`);
    await assert.rejects(permissive.fetchDocument(base + '/compressed', { lookup, maxBytes: 1000 }), (e) => e.code === 'too-large');
    const start = Date.now(); await assert.rejects(permissive.fetchDocument(base + '/redirect', { lookup, timeoutMs: 70 }), (e) => e.code === 'timeout');
    assert.ok(Date.now() - start < 300);
  } finally { await new Promise((resolve) => server.close(resolve)); }
});
await test('监测区分可用性、备份过期与异地失败，不把缺字段当健康', async () => {
  const { probe } = await import('./monitor.mjs');
  let body = { ok: true, latestRecoverableBackupAgeSec: 10 }, status = 200;
  const server = http.createServer((_req, res) => { res.writeHead(status, { 'content-type': 'application/json' }); res.end(JSON.stringify(body)); });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const options = { url: `http://127.0.0.1:${server.address().port}/healthz`, maxAgeSec: 100 };
  try {
    assert.equal((await probe(options)).ok, true);
    body.latestRecoverableBackupAgeSec = null; assert.equal((await probe(options)).ok, false);
    body.latestRecoverableBackupAgeSec = 200; assert.equal((await probe(options)).ok, false);
    body.latestRecoverableBackupAgeSec = 10; assert.equal((await probe({ ...options, requireOffsite: true })).ok, false);
    body.offsiteBackup = { state: 'ok', checkedAt: new Date().toISOString() };
    assert.equal((await probe({ ...options, requireOffsite: true })).ok, true);
    status = 503; assert.equal((await probe(options)).ok, false);
  } finally { await new Promise((resolve) => server.close(resolve)); }
});
process.exitCode = report();

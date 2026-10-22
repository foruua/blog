import './_test-env.mjs';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import http from 'node:http';
import { open, close } from '../db/driver.js';
import { createFeedRepo } from '../db/feeds.js';
import { createCommentRepo } from '../db/comments.js';
import { createLinkRepo } from '../db/links.js';
import { createCrypto } from '../src/auth.js';
import { createRefresher } from '../src/feeds/refresh.js';
import { createLinkChecker } from '../src/links/check.js';
import { createWriteBarrier } from '../src/util/lock.js';
import { snapshot, verifyBackup } from '../src/backup.js';
import { DB_FILE, CONTENT_DIR, UPLOADS_DIR, DATA_DIR } from '../src/config.js';
import { startServer } from './_server.mjs';

const tick = () => new Promise((resolve) => setImmediate(resolve));
function deferred() {
  let resolve;
  const promise = new Promise((done) => { resolve = done; });
  return { promise, resolve };
}

// 真实备份与后台写入共享屏障，网络已完成也不能穿过快照阶段。
{
  const db = open(DB_FILE), feeds = createFeedRepo(db), comments = createCommentRepo(db), links = createLinkRepo(db);
  const post = db.prepare('SELECT id FROM posts LIMIT 1').get();
  comments.add({ postId: post.id, author: 'barrier', website: 'https://barrier.example/', bodyMd: 'hello', status: 'approved' });
  const feed = feeds.add({ url: 'https://feed.example/rss' });
  const gate = createWriteBarrier(), resume = gate.pause();
  const refresher = createRefresher({ feeds, commit: gate.run, fetchDoc: async () => ({ notModified: true }) });
  let pruned = 0;
  const checker = createLinkChecker({ links: { ...links, pruneOrphans() { pruned++; return links.pruneOrphans(); } },
    commit: gate.run, probe: async () => ({ state: 'ok', ms: 1, title: 'hello' }) });
  const pending = Promise.all([refresher.refreshOne(feed.id), checker.checkAll({ force: true })]);
  try {
    await tick();
    assert.equal(feeds.get(feed.id).last_fetch_at, null);
    assert.equal(links.listSites().find((s) => s.host === 'barrier.example').checked_at, null);
    assert.equal(pruned, 0);
    const dir = path.join(DATA_DIR, 'background-backup');
    const backup = await snapshot(db, { dir, contentDir: CONTENT_DIR, uploadsDir: UPLOADS_DIR });
    const checked = verifyBackup(path.basename(backup.gzFile).replace('.db.gz', ''), { dir });
    assert.ok(checked.ok); assert.ok(checked.manifest.complete);
    if (checked.dbPath) fs.rmSync(path.dirname(checked.dbPath), { recursive: true, force: true });
    resume(); await pending;
    assert.ok(feeds.get(feed.id).last_fetch_at);
    assert.ok(links.listSites().find((s) => s.host === 'barrier.example').checked_at);
    assert.equal(pruned, 1);
  } finally { resume(); await pending; close(db); }
  console.log('✓ 友圈、友链落库和孤儿清理等待完整备份，恢复后才执行');
}

{
  const gate = createWriteBarrier(); let writes = 0;
  const resume = gate.pause();
  const checker = createLinkChecker({ links: { listSites: () => [], pruneOrphans: () => ++writes }, commit: gate.run });
  const empty = checker.checkAll(); await tick(); assert.equal(writes, 0);
  resume(); const resumeAgain = gate.pause(); await tick(); assert.equal(writes, 0);
  resumeAgain(); await empty; assert.equal(writes, 1);
  console.log('✓ 空轮次与连续暂停不会绕过备份屏障');
}

{
  let sites = [{ host: 'one.example', url: 'https://one.example/', source_url: 'https://one.example/' }];
  let failures = 0, requests = 0;
  let response = deferred();
  const links = { getSite: (host) => sites.find((s) => s.host === host) ?? null, listSites: () => sites, markFail: () => failures++, pruneOrphans: () => 0 };
  const checker = createLinkChecker({ links, probe: async () => { requests++; return response.promise; } });
  const round = checker.checkAll(), manual = checker.checkHost('one.example');
  await tick(); assert.equal(requests, 1);
  response.resolve({ state: 'dead', error: 'timeout' }); await Promise.all([round, manual]);
  assert.equal(failures, 1);
  response = deferred();
  const outdated = checker.checkHost('one.example'); await tick(); sites[0].source_url = 'https://one.example/new';
  response.resolve({ state: 'dead', error: 'timeout' }); assert.equal((await outdated).state, 'superseded');
  assert.equal(failures, 1);
  response = deferred();
  const removed = checker.checkHost('one.example'); await tick(); sites = [];
  response.resolve({ state: 'dead', error: 'timeout' }); assert.equal((await removed).state, 'superseded');
  assert.equal(failures, 1);
  console.log('✓ 同站自动与手动探测只记一次失败，网址变化或删除后丢弃旧结果');
}

// 使用真实请求管线验证外部 IO 不占内容队列。
{
  const entered = deferred(), release = deferred();
  const upstream = http.createServer(async (_req, res) => {
    entered.resolve(); await release.promise;
    res.writeHead(200, { 'content-type': 'text/html' }); res.end('<title>slow</title>');
  });
  await new Promise((resolve) => upstream.listen(0, '127.0.0.1', resolve));
  const srv = await startServer({ env: { FEED_ALLOW_PRIVATE: 'true' } });
  const db = open(DB_FILE), crypt = createCrypto(db), comments = createCommentRepo(db);
  const post = db.prepare("SELECT id,slug FROM posts WHERE kind='post' LIMIT 1").get();
  comments.add({ postId: post.id, author: 'slow', website: `http://127.0.0.1:${upstream.address().port}/`, bodyMd: 'hello', status: 'approved' });
  const csrf = 'background-csrf', cookie = 'blog_admin=' + crypt.sign({ uid: 'owner', ep: 0, csrf, sid: 'background-session' });
  const request = (url, body, owner = true) => fetch(srv.base + url, { method: 'POST',
    headers: { 'content-type': 'application/json', ...(owner ? { cookie, 'x-csrf-token': csrf } : {}) },
    body: JSON.stringify(body), signal: AbortSignal.timeout(3000), redirect: 'manual' });
  const slow = request('/admin/links/check', { host: '127.0.0.1' });
  try {
    await Promise.race([entered.promise, new Promise((_, reject) => setTimeout(() => reject(new Error('探测未启动')), 2000).unref())]);
    assert.equal((await request('/admin/api/preview', { body: 'preview' })).status, 200);
    assert.equal((await request('/admin/save', { title: '并发保存', slug: 'background-save', body: 'saved', draft: '1', kind: 'post' })).status, 303);
    assert.equal((await request('/api/comments', { slug: post.slug, ts: crypt.sign({ purpose: 'comment-ts', ts: Date.now() - 5000, p: post.id }),
      author: 'concurrent', email: 'concurrent@example.com', body: 'comment' }, false)).status, 200);
    release.resolve(); assert.equal((await slow).status, 303);
  } finally {
    release.resolve(); await slow.catch(() => {}); close(db); await srv.stop();
    await new Promise((resolve) => upstream.close(resolve));
  }
  console.log('✓ 慢友链探测期间，预览、内容保存和评论提交均可完成');
}

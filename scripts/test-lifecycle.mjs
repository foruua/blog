import { loginAdminPage } from './_browser.mjs';
import './_test-env.mjs';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { open, close } from '../db/driver.js';
import { createRepo } from '../db/repo.js';
import { createAdminRepo } from '../db/admin.js';
import { createFeedRepo } from '../db/feeds.js';
import { createCommentRepo } from '../db/comments.js';
import { createCrypto } from '../src/auth.js';
import { publicRoutes } from '../src/routes/public.js';
import { recoverWrites, moveFile } from '../src/content/commit.js';
import { writePostFile } from '../src/content/write.js';
import { parseFrontmatter, stringifyFrontmatter } from '../src/content/frontmatter.js';
import { pruneTrash } from '../src/util/trash.js';
import { createWriteBarrier } from '../src/util/lock.js';
import { createAssetVersions } from '../src/render/assets.js';
import { createRefresher } from '../src/feeds/refresh.js';
import { snapshot, verifyBackup, restoreBackup } from '../src/backup.js';
import { startServer } from './_server.mjs';
import { createChecker, SkipTest } from './_check.mjs';

const { test, report } = createChecker();
const dbFile = process.env.DB_FILE, content = process.env.CONTENT_DIR;
let db = open(dbFile);
const repo = createRepo(db);
const journal = path.join(process.env.DATA_DIR, '.write-journal');
const file = path.join(content, 'posts', 'fixture-1.md');
console.log('\n跨生命周期行为测试');
try {
  await test('正文分隔线、YAML 形状和空白逐字保留；读写使用同一安全 YAML 模式', () => {
    for (const body of ['---\nintro: body\n---\nremaining', '\n  indented\n\n', '', '---\n[broken\n---', '中文\r\n']) {
      const target = path.join(content, 'posts', 'roundtrip.md');
      writePostFile({ filePath: target, front: { title: 'yes', date: '2025-01-01', custom: { nested: true } }, body });
      const parsed = parseFrontmatter(fs.readFileSync(target, 'utf8'));
      assert.equal(parsed.content, body); assert.equal(parsed.data.title, 'yes');
      assert.equal(parsed.data.date, '2025-01-01'); assert.deepEqual(parsed.data.custom, { nested: true });
      fs.rmSync(target);
    }
    assert.deepEqual(parseFrontmatter('\uFEFF---\r\ntitle: 中文\r\n---\r\nbody'), { data: { title: '中文' }, content: 'body' });
    assert.throws(() => parseFrontmatter('---\n- bad\n---\nbody'), /键值映射/);
    assert.throws(() => parseFrontmatter('---\na: !!js/function function(){}\n---'), /unknown tag/);
    for (let i = 0; i < 1000; i++) assert.equal(parseFrontmatter(stringifyFrontmatter({ title: 't' }, String(i))).content, String(i));
  });
  await test('日志回滚可重复执行，缺失新文件不阻断旧文件恢复；坏条目预检不改文件', () => {
    fs.mkdirSync(journal, { recursive: true });
    const baseline = fs.readFileSync(file);
    const entries = [{ file: path.join(content, 'posts', 'absent.md'), data: null }, { file, data: baseline.toString('base64') }];
    for (let i = 0; i < 2; i++) {
      fs.writeFileSync(file, 'changed');
      fs.writeFileSync(path.join(journal, 'test.json'), JSON.stringify({ key: 'write_journal:test', entries }));
      assert.equal(recoverWrites(repo), 1); assert.deepEqual(fs.readFileSync(file), baseline);
    }
    fs.writeFileSync(path.join(journal, 'invalid.json'), JSON.stringify({ key: 'write_journal:invalid', entries: [{ file, data: null }, { file, data: 1 }] }));
    assert.equal(recoverWrites(repo, { log: { error() {} } }), 0);
    assert.deepEqual(fs.readFileSync(file), baseline);
    fs.rmSync(journal, { recursive: true });
  });
  await test('回收站从删除时刻计时，旧文件刚删除仍保留，无法识别的历史文件保留', () => {
    const trash = path.join(content, '.trash'); fs.mkdirSync(trash, { recursive: true });
    const original = path.join(content, 'old.txt'); fs.writeFileSync(original, 'old'); fs.utimesSync(original, 0, 0);
    const fresh = path.join(trash, `${Date.now()}-old.txt`); moveFile(original, fresh);
    const expired = path.join(trash, `${Date.now() - 100 * 86400000}-expired.txt`); fs.writeFileSync(expired, 'old');
    const unknown = path.join(trash, 'legacy.txt'); fs.writeFileSync(unknown, 'legacy'); fs.utimesSync(unknown, 0, 0);
    assert.deepEqual(pruneTrash([trash]), [expired]); assert.ok(fs.existsSync(fresh)); assert.ok(fs.existsSync(unknown));
  });
  await test('派生图在回收站用更短保留期，原图仍按长保留期', () => {
    const trash = path.join(content, '.trash'); fs.mkdirSync(trash, { recursive: true });
    const old = Date.now() - 10 * 86400000;
    const derivedOld = path.join(trash, `${old}-a.jpg.derived-thumb.webp`); fs.writeFileSync(derivedOld, 'x');
    const derivedFresh = path.join(trash, `${Date.now()}-b.jpg.derived-w640.webp`); fs.writeFileSync(derivedFresh, 'x');
    const originalOld = path.join(trash, `${old}-c.jpg`); fs.writeFileSync(originalOld, 'x');
    // 原图恰好叫 x.w640.webp 时不能再被按派生图误删（旧实现只看后缀）。
    const originalLooksDerived = path.join(trash, `${old}-d.jpg.w640.webp`); fs.writeFileSync(originalLooksDerived, 'x');
    const removed = pruneTrash([trash], { derivedMaxAgeMs: 7 * 86400000 });
    assert.deepEqual(new Set(removed), new Set([derivedOld]));
    assert.ok(fs.existsSync(derivedFresh)); assert.ok(fs.existsSync(originalOld));
    assert.ok(fs.existsSync(originalLooksDerived));
  });
  await test('固定页旧地址重定向；别名目标为草稿或未来发布时返回 404', async () => {
    const page = repo.getPost('fixture-page', 'page');
    db.prepare('INSERT OR REPLACE INTO aliases(path,post_id) VALUES(?,?)').run('/old-page', page.id);
    const app = publicRoutes(repo, { comments: createCommentRepo(db), crypt: createCrypto(db) });
    let response = await app.request('/old-page'); assert.equal(response.status, 301); assert.equal(response.headers.get('location'), '/fixture-page');
    db.prepare('UPDATE posts SET draft=1 WHERE id=?').run(page.id);
    assert.equal((await app.request('/old-page')).status, 404);
    db.prepare("UPDATE posts SET draft=0,published_at='2999-01-01T00:00:00Z' WHERE id=?").run(page.id);
    assert.equal((await app.request('/old-page')).status, 404);
    db.prepare('UPDATE posts SET published_at=? WHERE id=?').run(page.published_at, page.id);
  });
  await test('友圈解析支持 100 条配置；单源与全量清空会重置条件缓存并完整重抓', async () => {
    const feeds = createFeedRepo(db), feed = feeds.add({ url: 'https://example.com/lifecycle' });
    const xml = '<rss><channel><title>Example</title>' + Array.from({ length: 60 }, (_, i) => `<item><guid>${i}</guid><title>Item ${i}</title><link>https://example.com/${i}</link></item>`).join('') + '</channel></rss>';
    const refresher = createRefresher({ feeds, keep: 100, fetchDoc: async (_url, options) => options.etag ? { notModified: true } : { text: xml, etag: 'v1', lastModified: 'yesterday' } });
    for (const clear of [() => {}, () => feeds.clearItems(feed.id), () => feeds.clearItems()]) {
      clear(); await refresher.refreshOne(feed.id); assert.equal(feeds.countItemsOf(feed.id), 60);
      assert.equal((await refresher.refreshOne(feed.id)).status, 'unchanged');
    }
  });
  await test('备份屏障只暂停友圈落库；放行后重新检查版本，丢弃清空前的结果', async () => {
    const feeds = createFeedRepo(db), feed = feeds.add({ url: 'https://example.com/barrier' });
    const barrier = createWriteBarrier(); const release = barrier.pause();
    let fetched = false;
    const refresher = createRefresher({ feeds, beforeWrite: barrier.wait, fetchDoc: async () => {
      fetched = true; return { text: '<rss><channel><item><guid>one</guid><title>one</title><link>https://example.com/one</link></item></channel></rss>' };
    } });
    const pending = refresher.refreshOne(feed.id); await new Promise((resolve) => setImmediate(resolve));
    assert.ok(fetched); assert.equal(feeds.countItemsOf(feed.id), 0);
    feeds.clearItems(feed.id); release(); assert.equal((await pending).status, 'superseded');
    await refresher.refreshOne(feed.id); assert.equal(feeds.countItemsOf(feed.id), 1);
  });
  await test('自动修订有独立保留上限，不淘汰手动检查点', () => {
    const admin = createAdminRepo(db), post = repo.getPost('fixture-1');
    admin.addRevision(post.id, 'manual', 'checkpoint');
    for (let i = 0; i < 100; i++) admin.addRevision(post.id, String(i), String(i), 'autosave');
    const revisions = admin.revisions(post.id, 100);
    assert.equal(revisions.length, 31); assert.ok(revisions.some((r) => r.note === 'manual'));
  });
  await test('资源按文件指纹隔离；同大小热更新生效，未变资源无需重读内容', () => {
    const dir = path.join(process.env.DATA_DIR, 'asset-test'); fs.mkdirSync(dir);
    fs.writeFileSync(path.join(dir, 'a.css'), 'aaa'); fs.writeFileSync(path.join(dir, 'b.css'), 'bbb');
    let now = 1000; const version = createAssetVersions(dir, { now: () => now });
    const a = version('a.css'), b = version('b.css'); now += 2000;
    fs.writeFileSync(path.join(dir, 'b.css'), 'ccc');
    assert.equal(version('a.css'), a); assert.notEqual(version('b.css'), b);
    const read = fs.readFileSync; let reads = 0;
    try { fs.readFileSync = (...args) => { reads++; return read(...args); }; now += 2000; version('a.css'); version('b.css'); assert.equal(reads, 0); }
    finally { fs.readFileSync = read; }
  });
  await test('恢复失败回滚旧日志；恢复成功隔离日志；再次启动不重放旧正文', async () => {
    const snap = await snapshot(db), name = path.basename(snap.gzFile).replace('.db.gz', '');
    const verified = verifyBackup(name), baseline = fs.readFileSync(file);
    fs.mkdirSync(journal, { recursive: true });
    fs.writeFileSync(path.join(journal, 'stale.json'), JSON.stringify({ key: 'write_journal:stale', entries: [{ file, data: Buffer.from('STALE').toString('base64') }] }));
    close(db); db = null;
    const options = { dbFile, contentDir: content, uploadsDir: process.env.UPLOADS_DIR };
    const rename = fs.renameSync;
    try {
      fs.renameSync = (from, to) => { if (to === path.resolve(content) && String(from).includes('.blog-restore-')) throw new Error('injected'); return rename(from, to); };
      assert.throws(() => restoreBackup(verified, options), /injected/);
      assert.ok(fs.existsSync(path.join(journal, 'stale.json')));
    } finally { fs.renameSync = rename; }
    restoreBackup(verified, options);
    db = open(dbFile); recoverWrites(createRepo(db)); assert.deepEqual(fs.readFileSync(file), baseline);
    // 恢复成功后旧写日志（含旧文章 base64 全文）应被清掉，不再永久留在 data/ 下。
    assert.ok(!fs.readdirSync(process.env.DATA_DIR).some((n) => n.startsWith('.write-journal.pre-restore-')));
    close(db); db = null;
    fs.writeFileSync(dbFile, 'corrupt database');
    const result = spawnSync(process.execPath, ['scripts/restore.mjs', '--yes', '--from', name], { encoding: 'utf8', timeout: 30000 });
    assert.equal(result.status, 0, result.stderr + result.stdout);
    const raw = fs.readdirSync(process.env.BACKUP_DIR).find((n) => n.startsWith('pre-restore-raw-'));
    assert.equal(fs.readFileSync(path.join(process.env.BACKUP_DIR, raw, 'database'), 'utf8'), 'corrupt database');
    db = open(dbFile); assert.equal(db.prepare('PRAGMA integrity_check').get().integrity_check, 'ok');
    fs.rmSync(path.dirname(verified.dbPath), { recursive: true, force: true });
  });
} finally { if (db) close(db); }

await test('真实浏览器：新建首次自动保存后刷新恢复正文；仅改标题也可恢复', async () => {
  let chromium;
  try { ({ chromium } = await import('playwright')); }
  catch (error) {
    if (process.env.UI_AUDIT_REQUIRED === '1') throw error;
    throw new SkipTest('未安装 playwright/chromium');
  }
  const server = await startServer(); let browser;
  try {
    try { browser = await chromium.launch({ headless: true }); }
    catch (error) {
      if (process.env.UI_AUDIT_REQUIRED === '1') throw error;
      throw new SkipTest('Chromium 未安装（npx playwright install chromium）');
    }
    const page = await browser.newPage();
    page.on('pageerror', (error) => console.error('browser:', error.message));
    page.on('dialog', (dialog) => dialog.accept());
    await loginAdminPage(page, server.base, process.env.ADMIN_PASSWORD);
    await page.goto(server.base + '/admin/new');
    await page.locator('[name=title]').fill('Lifecycle draft'); await page.locator('[name=body]').fill('saved body');
    try { await page.waitForURL(/\/admin\/edit\/\d+$/); } catch (error) { console.error(await page.locator('#a-save-state').textContent()); throw error; }
    await page.locator('[name=body]').fill('unsaved body'); await page.reload();
    await page.getByText('恢复本页未保存的输入', { exact: true }).click();
    assert.equal(await page.locator('[name=body]').inputValue(), 'unsaved body');
    await page.waitForFunction(() => document.getElementById('a-save-state').textContent.includes('已自动保存'));
    await page.locator('[name=title]').fill('unsaved title'); await page.reload();
    await page.getByText('恢复本页未保存的输入', { exact: true }).click();
    assert.equal(await page.locator('[name=title]').inputValue(), 'unsaved title');
    assert.ok(!(await page.evaluate(() => Object.keys(sessionStorage))).includes('blog-draft:new-post'));
  } finally { await browser?.close(); await server.stop(); }
});
process.exitCode = report();

import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
const { DatabaseSync } = await import('node:sqlite');

const work = fs.mkdtempSync(path.join(os.tmpdir(), 'blog-regressions-'));
process.env.CONTENT_DIR = path.join(work, 'content');
process.env.DATA_DIR = path.join(work, 'data');
process.env.UPLOADS_DIR = path.join(work, 'uploads');
process.env.THEMES_DIR = path.join(work, 'themes');
process.env.DB_FILE = path.join(work, 'data', 'blog.db');
process.env.BACKUP_ON_PUBLISH = 'false';
process.env.TZ = 'Asia/Shanghai';
// 单独运行（不经 npm test 的 fixtures 继承）时也要断掉外网：定时抓取/检查与头像回源一律关闭。
process.env.FEED_REFRESH_MS = '0';
process.env.LINK_CHECK_MS = '0';
process.env.AVATAR_UPSTREAMS = '';
for (const dir of ['posts', 'notes']) fs.mkdirSync(path.join(process.env.CONTENT_DIR, dir), { recursive: true });
fs.mkdirSync(process.env.THEMES_DIR, { recursive: true });
const { open, close, migrate, createRepo, createAdminRepo, createCommentRepo, createCrypto } = await import('./_db-stack.mjs');
const { createAdminAuth } = await import('../src/admin/auth.js');
const { createRenderer } = await import('../src/render/markdown.js');
const { adminRoutes } = await import('../src/routes/admin.js');
const { publicRoutes } = await import('../src/routes/public.js');
const { feedRoutes } = await import('../src/routes/feed.js');
const { syncContent } = await import('../src/content/sync.js');
const { snapshot, verifyBackup, restoreBackup } = await import('../src/backup.js');
const { initMail, KEYS, ownerEmail, fromAddress } = await import('../src/mail.js');
const { toIsoOffset, parseDate, formatDay, formatDateTime } = await import('../src/util/text.js');
const { resolveLogDir } = await import('../src/log-rotate.js');
const { JSDOM } = await import('jsdom');
const { editorPage } = await import('../src/admin/views/content.js');
const db = open(process.env.DB_FILE);
migrate(db, { log() {} });
const repo = createRepo(db), adminRepo = createAdminRepo(db), comments = createCommentRepo(db);
repo.setSetting('admin_password_hash', 'fixture-configured');
const crypt = createCrypto(db), auth = createAdminAuth({ db, crypt }), renderer = createRenderer();
initMail({ getSetting: repo.getSetting, crypt });
const app = adminRoutes({ repo, comments, adminRepo, crypt, auth, renderer });
const pub = publicRoutes(repo, { comments, crypt });
const feeds = feedRoutes(repo);
const csrf = 'test-csrf';
const cookie = 'blog_admin=' + crypt.sign({ uid: 'owner', ep: 0, csrf });
const post = (url, body) => app.request(url, {
  method: 'POST', headers: { Cookie: cookie, 'Content-Type': 'application/json', 'x-csrf-token': csrf },
  body: JSON.stringify(body?.id && !Object.hasOwn(body, 'version') ? { ...body, version: adminRepo.get(Number(body.id))?.version } : body),
});
const save = async (body) => {
  const res = await post('/admin/api/autosave', body);
  assert.equal(res.status, 200);
  const out = await res.json(); assert.equal(out.ok, true); return out.id;
};
const input = { title: 'Regression', slug: 'regression', kind: 'post', date: '2025-01-01T12:34:56',
  draft: '', comments: '', body: 'original' };
let pass = 0, fail = 0;
async function test(name, fn) {
  try { await fn(); pass++; console.log('  ✓ ' + name); }
  catch (err) { fail++; console.error('  ✗ ' + name + '\n' + err.stack); }
}
console.log('\nBug 回归测试');
let id;
let dbClosed = false;
try {
  await test('邮件三个写接口都要求登录和 CSRF', async () => {
    for (const route of ['/admin/mail', '/admin/mail/test', '/admin/mail/clear']) {
      const before = repo.getSetting(KEYS.host);
      const res = await app.request(route, { method: 'POST', body: new URLSearchParams({ host: 'evil.example', port: '465', to: 'evil@example.com' }) });
      assert.equal(res.status, 303); assert.match(res.headers.get('location'), /^\/admin\/login/);
      assert.equal(repo.getSetting(KEYS.host), before);
      const missingCsrf = await app.request(route, { method: 'POST', headers: { Cookie: cookie }, body: new URLSearchParams() });
      assert.equal(missingCsrf.status, 403);
    }
    assert.equal((await app.request('/admin/login/')).status, 200);
  });
  await test('年度归档拒绝脚本、非年份，合法年份正常', async () => {
    const res = await pub.request('/a/%3Cimg%20src=x%20onerror=alert(1)%3E');
    assert.equal(res.status, 404); assert.ok(!(await res.text()).includes('<img src=x'));
    assert.equal((await pub.request('/a/not-a-year')).status, 404);
    assert.equal((await pub.request('/a/2025')).status, 200);
  });
  await test('保存日期能原样导入，非法输入返回 400', async () => {
    assert.equal(parseDate(toIsoOffset('2025-01-01T04:34:56Z')), '2025-01-01T04:34:56Z');
    id = await save(input);
    const errors = syncContent(repo, { quiet: true }).errors;
    assert.deepEqual(errors, []); assert.equal(adminRepo.get(id).published_at, '2025-01-01T04:34:56Z');
    assert.equal((await post('/admin/api/autosave', { ...input, id, date: 'invalid' })).status, 400);
  });
  await test('旧错误日期自动修复并保留原文件', async () => {
    const file = path.join(process.env.CONTENT_DIR, 'posts', 'legacy.md');
    const raw = "---\ntitle: legacy\nslug: legacy\ndate: '2025-01-01T12:34:56:00+08:00'\n---\nlegacy body";
    fs.writeFileSync(file, raw);
    assert.deepEqual(syncContent(repo, { quiet: true }).errors, []);
    assert.equal(repo.getPost('legacy').published_at, '2025-01-01T04:34:56Z');
    assert.equal(fs.readFileSync(file + '.before-fix', 'utf8'), raw);
  });
  await test('数据库里出现畸形日期时格式化不抛：页面/Feed 不应 500', async () => {
    assert.equal(formatDay('2020-13-40'), '');
    assert.equal(formatDateTime('not-a-date'), '');
    assert.equal(formatDay('2026-02-30'), '2026-03-02');
  });
  await test('日志目录：服务与 CLI 共用同一解析口径，且展开 ~', async () => {
    assert.equal(resolveLogDir('~/logs'), path.join(os.homedir(), 'logs'));
    assert.equal(resolveLogDir(''), resolveLogDir());
  });
  await test('长 slug 的笔记抽屉保留 ID 后缀，避免多篇抽屉撞 id', async () => {
    const longSlug = 'n'.repeat(65);
    const noteId = await save({ ...input, title: '长 slug 笔记', slug: longSlug, kind: 'note', comments: '1', body: 'note body' });
    assert.ok(noteId);
    const res = await pub.request(`/n/${longSlug}/?partial=comments&panel=note&suffix=-${longSlug}`);
    assert.equal(res.status, 200);
    const html = await res.text();
    assert.match(html, new RegExp(`id="comments-${longSlug}"`));
    assert.match(html, new RegExp(`id="c-body-${longSlug}"`));
  });
  await test('非视频大文件 raw 上传在读入堆之前就返回 413', async () => {
    const big = Buffer.alloc(9 * 1024 * 1024, 0x61);
    const res = await app.request('/admin/api/upload', {
      method: 'POST',
      headers: {
        Cookie: cookie, 'x-csrf-token': csrf, 'x-raw-upload': '1',
        'Content-Type': 'application/octet-stream', 'x-file-name': 'big.bin',
      },
      body: big,
    });
    assert.equal(res.status, 413);
  });
  await test('转义的 front-matter 分隔线（\\---）导入前自动修复并保留原稿', async () => {
    const file = path.join(process.env.CONTENT_DIR, 'posts', 'escaped-front.md');
    const raw = '\\---  \ntitle: 转义分隔线  \nslug: escaped-front  \ndate: 2025-03-03T09:00:07+08:00  \nlang: zh  \n\\---\n\n正文。';
    fs.writeFileSync(file, raw);
    assert.deepEqual(syncContent(repo, { quiet: true }).errors, []);
    const row = repo.getPost('escaped-front');
    assert.equal(row.title, '转义分隔线');
    assert.equal(row.draft, 0);
    assert.equal(row.published_at, '2025-03-03T01:00:07Z');
    assert.equal(fs.readFileSync(file + '.before-fix', 'utf8'), raw);
    assert.ok(fs.readFileSync(file, 'utf8').startsWith('---\ntitle: 转义分隔线\n'), fs.readFileSync(file, 'utf8'));
  });
  await test('代码高亮：抬 PIPELINE_VERSION 后存量 body_html 会跟着重算', async () => {
    const file = path.join(process.env.CONTENT_DIR, 'posts', 'hl-pipeline.md');
    fs.writeFileSync(file, '---\ntitle: 代码高亮\nslug: hl-pipeline\ndate: 2025-02-02T10:00:00+08:00\n---\n\n```js\nconst a = 1; // hi\n```\n');
    assert.deepEqual(syncContent(repo, { quiet: true }).errors, []);
    const row = repo.getPost('hl-pipeline');
    assert.match(row.body_html, /class="hljs language-js"/);
    // 模拟「升级前入库」的行（纯文本、无 hljs、管线号停在上一版）：文件哈希没变，只靠它判「没变」就永不重算 —— 这正是 PIPELINE_VERSION 的理由。
    db.prepare('UPDATE posts SET body_html = ? WHERE id = ?')
      .run('<pre><code class="language-js">const a = 1; // hi\n</code></pre>\n', row.id);
    repo.setSetting('content_pipeline_version', '9:0');
    assert.ok(!repo.getPost('hl-pipeline').body_html.includes('hljs'));
    assert.deepEqual(syncContent(repo, { quiet: true }).errors, []);
    const after = repo.getPost('hl-pipeline');
    assert.match(after.body_html, /class="hljs language-js"/);
    assert.match(after.body_html, /hljs-keyword/);
  });

  await test('回滚保留日期评论，删库重建一致', async () => {
    const rev = adminRepo.revisions(id)[0].id;
    await save({ ...input, id, body: 'changed' });
    assert.equal((await post('/admin/restore/' + rev, {})).status, 303);
    const savedPost = repo.getPost(input.slug);
    assert.equal(savedPost.body_md, 'original');
    const fresh = open(path.join(work, 'rebuilt.db')); migrate(fresh, { log() {} });
    try {
      const rebuiltRepo = createRepo(fresh); assert.deepEqual(syncContent(rebuiltRepo, { quiet: true }).errors, []);
      const rebuilt = rebuiltRepo.getPost(input.slug);
      for (const key of ['draft', 'comments_on', 'published_at', 'body_md']) assert.equal(rebuilt[key], savedPost[key]);
    } finally { close(fresh); }
  });
  await test('post → note 迁移文件，同步保持类型，旧 URL 可跳转', async () => {
    const old = adminRepo.get(id).file_path;
    await save({ ...input, id, kind: 'note' });
    assert.ok(!fs.existsSync(old)); assert.match(adminRepo.get(id).file_path, /notes/);
    repo.setSetting('content_pipeline_version', '0'); syncContent(repo, { quiet: true });
    assert.equal(adminRepo.get(id).kind, 'note');
    assert.equal((await pub.request('/p/regression/')).headers.get('location'), '/n/regression/');

    assert.equal((await pub.request('/regression/')).status, 404);
  });
  await test('同秒 45 篇文章分页不遗漏也不重复', async () => {
    for (let i = 0; i < 45; i++) repo.upsertFromFile({ slug: `equal-${i}`, kind: 'post', title: `equal ${i}`,
      bodyMd: 'equal', bodyHtml: '<p>equal</p>', toc: [], draft: false,
      publishedAt: '2025-06-01T00:00:00Z', wordCount: 1, filePath: null, fileHash: null, source: 'admin' }, { force: true });
    for (const kind of ['post', null]) {
      let before = null; const ids = [];
      while (true) {
        const rows = repo.feed({ kind, before, limit: 20 }); if (!rows.length) break;
        ids.push(...rows.filter((p) => p.slug.startsWith('equal-')).map((p) => p.id));
        const last = rows.at(-1); before = `${last.published_at}|${last.id}`;
      }
      assert.equal(ids.length, 45); assert.equal(new Set(ids).size, 45);
    }
    assert.match(await (await pub.request('/posts/')).text(), /%7C\d+/);
  });
  await test('笔记无 JS 评论表单使用 /n/ 路径', async () => {
    await save({ ...input, slug: 'note-form', kind: 'note', comments: '1' });
    assert.match(await (await pub.request('/n/note-form/')).text(), /action="\/n\/note-form\/comment"/);
  });
  await test('固定页上的评论：后台列表里的链接指向 /<slug>，点开是 200 而不是 404', async () => {
    // 曾出错：固定页评论的站主邮件里「查看这条评论」被拼成 /p/about/ —— 固定页走 /<slug>，点开 404。
    await save({ ...input, slug: 'reg-page', kind: 'page', title: 'Regression Page', comments: '1' });
    assert.deepEqual(syncContent(repo, { quiet: true }).errors, []);
    const page = repo.getPost('reg-page', 'page');
    assert.ok(page, '固定页没同步进库');
    assert.equal((await pub.request('/reg-page')).status, 200);
    assert.equal((await pub.request('/p/reg-page/')).status, 404, '手写前缀拼出来的地址本来就是 404');

    const cid = comments.add({ postId: page.id, parentId: null, author: '凌云', emailHash: 'reg-page-hash',
      emailEnc: null, website: null, bodyMd: '测试数据库和', status: 'approved', ipHash: null, isAuthor: false });
    const list = await (await app.request('/admin/comments', { headers: { Cookie: cookie } })).text();
    const href = /href="([^"]*reg-page[^"]*)"/.exec(list)?.[1] ?? '';
    assert.match(href, /^\/reg-page#c\d+$/, `后台「文章」列的链接是 ${href || '(没找到)'}`);
    assert.equal((await pub.request(href.split('#')[0])).status, 200, `后台给出的链接打不开：${href}`);
    assert.equal(comments.get(cid).status, 'approved');
  });
  await test('清除邮件配置后环境变量收件人及发信人生效', async () => {
    process.env.OWNER_EMAIL = 'env@example.com'; process.env.MAIL_FROM = 'sender@example.com';
    repo.setSetting(KEYS.to, 'page@example.com'); repo.setSetting(KEYS.from, 'page-sender@example.com');
    await post('/admin/mail/clear', {});
    assert.equal(ownerEmail(), 'env@example.com'); assert.equal(fromAddress(), 'sender@example.com');
  });
  await test('相对日期：刚刚 / 分钟 / 小时 / 昨天 / 天 / 月 / 年', async () => {
    const { relativeDate, relativeOrDay } = await import('../src/util/text.js');
    const now = Date.parse('2026-10-05T12:00:00Z');
    assert.equal(relativeDate('2026-10-05T11:59:40Z', now), '刚刚');
    assert.equal(relativeDate('2026-10-05T11:40:00Z', now), '20 分钟前');
    assert.equal(relativeDate('2026-10-05T07:00:00Z', now), '5 小时前');
    assert.equal(relativeDate('2026-10-04T10:00:00Z', now), '昨天');
    assert.equal(relativeDate('2026-10-03T10:00:00Z', now), '前天');
    assert.equal(relativeDate('2026-09-13T00:00:00Z', now), '22 天前');
    assert.equal(relativeDate('2026-07-01T00:00:00Z', now), '3 个月前');
    assert.equal(relativeDate('2024-06-01T00:00:00Z', now), '2 年前');

    assert.equal(relativeOrDay('2026-09-13T00:00:00Z', now), '22 天前');
    assert.equal(relativeOrDay('2026-08-20T00:00:00Z', now), '2026-08-20');
  });

  await test('阅读时长：按总字数折算、四舍五入、最少 1 分钟、空正文为 0', async () => {
    const { readingMinutes } = await import('../src/util/text.js');
    assert.equal(readingMinutes(0), 0);
    assert.equal(readingMinutes(1), 1);    assert.equal(readingMinutes(300), 1);
    assert.equal(readingMinutes(450), 2);    assert.equal(readingMinutes(3000), 10);
  });

  await test('正文图片：开头图片优先加载、其余懒加载，Markdown 里不写属性', async () => {

    const { html } = renderer.render('![图](/uploads/x.png)');
    assert.match(html, /<img src="\/uploads\/x\.png" alt="图" loading="eager" fetchpriority="high" decoding="async">/);
    assert.ok(!html.includes('{width='), html);
  });

  await test('wiki-link 按 slug 和标题正确跳到目标内容', async () => {

    assert.equal((await pub.request('/go/regression')).headers.get('location'), '/n/regression/');
    assert.equal((await pub.request('/go/Regression')).headers.get('location'), '/n/regression/');
  });
  await test('SQLite UTC 时间在上海时区显示和 Feed 输出正确', async () => {
    assert.equal(formatDateTime('2025-01-01 00:00:00'), '2025-01-01 08:00');
    db.prepare("UPDATE posts SET updated_at = '2025-01-01 00:00:00' WHERE slug = 'equal-44'").run();
    const json = await (await feeds.request('/feed.json')).json();
    assert.equal(json.items.find((p) => p.url.includes('equal-44')).date_modified, '2025-01-01T00:00:00.000Z');
    assert.match(await (await feeds.request('/atom.xml')).text(), /<updated>2025-01-01T00:00:00.000Z<\/updated>/);
  });
  await test('完整备份在空目录恢复文件、附件、评论及旧版本；损坏归档被拒绝', async () => {
    const articleId = await save({ ...input, slug: 'backup-version', body: 'snapshot body', comments: '1' });
    comments.add({ postId: articleId, author: 'reader', bodyMd: 'comment', status: 'approved' });
    fs.mkdirSync(path.join(process.env.UPLOADS_DIR, '2025', '01'), { recursive: true });
    fs.writeFileSync(path.join(process.env.UPLOADS_DIR, '2025', '01', 'image.png'), Buffer.from('image bytes'));
    const dir = path.join(work, 'backups'); const snap = await snapshot(db, { dir });
    await save({ ...input, id: articleId, slug: 'backup-version', body: 'newer body', comments: '1' });
    const name = path.basename(snap.gzFile).replace('.db.gz', '');
    const verified = verifyBackup(name, { dir, workDir: path.join(work, 'verify') }); assert.equal(verified.ok, true);
    const recovered = restoreBackup(verified, { dbFile: path.join(work, 'recovered', 'blog.db'),
      contentDir: path.join(work, 'recovered', 'content'), uploadsDir: path.join(work, 'recovered', 'uploads') });
    const restored = open(recovered.dbFile);
    try {
      const rr = createRepo(restored); const row = rr.getPost('backup-version');
      assert.equal(row.body_md, 'snapshot body'); assert.ok(row.file_path.startsWith(recovered.contentDir));
      assert.equal(createCommentRepo(restored).countOfPost(row.id), 1);
      assert.match(fs.readFileSync(row.file_path, 'utf8'), /snapshot body/);
      assert.equal(fs.readFileSync(path.join(recovered.uploadsDir, '2025', '01', 'image.png'), 'utf8'), 'image bytes');
    } finally { close(restored); }
    const good = fs.readFileSync(snap.assetsFile); fs.writeFileSync(snap.assetsFile, good.subarray(0, 12));
    assert.equal(verifyBackup(name, { dir, workDir: path.join(work, 'verify') }).ok, false);
    fs.writeFileSync(snap.assetsFile, good);
    assert.throws(() => restoreBackup({ ...verified, bundle: null }, recovered), /旧备份/);
    const unsafe = structuredClone(verified.bundle); unsafe.content[0].path = '../escape.md';
    assert.throws(() => restoreBackup({ ...verified, bundle: unsafe }, recovered), /路径/);
    assert.ok(!fs.existsSync(path.join(work, 'escape.md')));

    const marker = path.join(recovered.contentDir, 'rollback-marker.txt'); fs.writeFileSync(marker, 'preserve me');
    const rename = fs.renameSync; let injected = false;
    fs.renameSync = (from, to) => {
      if (!injected && from === recovered.uploadsDir) { injected = true; throw new Error('injected rename failure'); }
      return rename(from, to);
    };
    try { assert.throws(() => restoreBackup(verified, recovered), /injected rename failure/); }
    finally { fs.renameSync = rename; }
    assert.equal(fs.readFileSync(marker, 'utf8'), 'preserve me');
    assert.equal(fs.readFileSync(path.join(recovered.uploadsDir, '2025', '01', 'image.png'), 'utf8'), 'image bytes');

  });
  await test('内容根目录缺失不删除已有文章和评论', async () => {
    const total = repo.stats().total; const commentCount = db.prepare('SELECT COUNT(*) AS n FROM comments').get().n;
    fs.renameSync(process.env.CONTENT_DIR, process.env.CONTENT_DIR + '-missing');
    try { syncContent(repo, { quiet: true }); assert.equal(repo.stats().total, total);
      assert.equal(db.prepare('SELECT COUNT(*) AS n FROM comments').get().n, commentCount); }
    finally { fs.renameSync(process.env.CONTENT_DIR + '-missing', process.env.CONTENT_DIR); }
  });
  await test('内容为空时列表页给空状态，而不是只剩一个标题', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'blog-empty-'));
    for (const dir of ['posts', 'notes']) fs.mkdirSync(path.join(root, 'content', dir), { recursive: true });
    const { startServer } = await import('./_server.mjs');
    const srv = await startServer({ env: {
      DATA_DIR: path.join(root, 'data'), DB_FILE: path.join(root, 'data', 'blog.db'),
      CONTENT_DIR: path.join(root, 'content'), UPLOADS_DIR: path.join(root, 'uploads'),
    } });
    try {
      for (const url of ['/posts/', '/notes/']) {
        const res = await fetch(srv.base + url);
        const html = await res.text();
        assert.equal(res.status, 200, url);
        assert.match(html, /还没有内容/, url);
        assert.match(html, /回到首页/, url);
      }
      // 空站点的 Feed / sitemap 也得是合法 200，而不是崩掉
      assert.equal((await fetch(srv.base + '/feed.xml')).status, 200);
      assert.equal((await fetch(srv.base + '/feed.json')).status, 200);
      assert.equal((await fetch(srv.base + '/archive/')).status, 200);
    } finally {
      await srv.stop();
      fs.rmSync(root, { recursive: true, force: true });
    }
  });
  await test('自动保存旧响应和失败重试保留 dirty 状态，新文章 ID 被正确回填', async () => {
    const dom = new JSDOM(editorPage({ post: { kind: 'post', draft: 1, comments_on: 1, body_md: '', tagNames: [] },
      aliases: [], revisions: [], isNew: true, csrf, badges: {} }), { url: 'http://localhost/admin/new', runScripts: 'outside-only' });
    const w = dom.window; const timers = new Map(); let nextTimer = 0; const requests = [];
    w.setTimeout = (fn) => { const id = ++nextTimer; timers.set(id, fn); return id; };
    w.clearTimeout = (id) => timers.delete(id); w.confirm = () => false;
    w.fetch = async (_url, options) => new Promise((resolve, reject) => requests.push({ options, resolve, reject }));
    const tick = async () => { await new Promise((r) => setImmediate(r)); };
    // 一次 input 排两个定时器：草稿落 sessionStorage（节流 500ms）与自动保存（去抖 3s）。这里把到期的全跑掉 ——
    // 写草稿不发请求、顺序无关；只跑第一个会跑成草稿、自动保存永不触发（本用例第一次改完就红的原因）。
    const runTimer = () => { for (const [id, fn] of [...timers]) { timers.delete(id); fn(); } };
    try {
      // admin.js 从 window.__request 发请求。本用例只测自动保存状态机，桩成透传 fetch ——
      // 真包装的 15s 中止定时器会混进 timers.size 断言，其行为已由 test-hardening 加载真 request.js 覆盖。
      // 真实页面总先加载 request.js（提供 __csrf 等）；这里照做，再换 __request 替身。
      w.eval(fs.readFileSync(new URL('../public/request.js', import.meta.url), 'utf8'));
      w.__request = (url, options) => w.fetch(url, options);
      w.eval(fs.readFileSync(new URL('../public/admin-editor.js', import.meta.url), 'utf8'));
      w.eval(fs.readFileSync(new URL('../public/admin.js', import.meta.url), 'utf8'));
      const form = w.document.getElementById('editorForm'), body = form.querySelector('[name=body]');
      const change = (value) => { body.value = value; body.dispatchEvent(new w.Event('input', { bubbles: true })); };
      change('A'); runTimer(); assert.equal(JSON.parse(requests[0].options.body).body, 'A');
      change('B'); requests[0].resolve({ status: 200, json: async () => ({ ok: true, id: 90, savedAt: new Date().toISOString() }) });
      await tick(); assert.equal(form.elements.namedItem('id').value, '90'); assert.equal(w.__beforeNavigate(), false);
      runTimer(); assert.equal(JSON.parse(requests[1].options.body).body, 'B'); requests[1].reject(new Error('network failure'));
      await tick(); assert.equal(w.__beforeNavigate(), false); assert.equal(timers.size, 1);
      runTimer(); requests[2].resolve({ status: 200, json: async () => ({ ok: true, id: 90, savedAt: new Date().toISOString() }) });
      await tick(); assert.equal(w.__beforeNavigate(), true); assert.equal(timers.size, 0);
      change('C'); w.document.getElementById('editorForm').remove(); w.__pjaxHooks.forEach((fn) => fn());
      assert.equal(timers.size, 0);
    } finally { w.close(); }
  });
  await test('笔记折叠：点开下一篇不会收起上一篇（多篇可同开），也不再补滚动', async () => {
    const html = `<!doctype html><html><body><div id="app"><div class="notes" data-kind="note">
      <div class="nf"><details class="nf-fold" open><summary class="nf-sum"><h2 class="nf-title">第一篇</h2></summary><div class="nf-rollout"><div class="nf-panel"><div class="prose note-body">正文一</div></div></div></details><p class="nf-meta"></p></div>
      <div class="nf"><details class="nf-fold"><summary class="nf-sum"><h2 class="nf-title">第二篇</h2></summary><div class="nf-rollout"><div class="nf-panel"><div class="prose note-body">正文二</div></div></div></details><p class="nf-meta"></p></div>
    </div></div></body></html>`;
    const dom = new JSDOM(html, { url: 'https://example.com/notes/', runScripts: 'outside-only', pretendToBeVisual: true });
    const w = dom.window;
    w.matchMedia = () => ({ matches: false, addEventListener() {}, removeEventListener() {} });
    w.eval(fs.readFileSync(new URL('../public/request.js', import.meta.url), 'utf8'));   // 真实页面先加载它（提供 __csrf/__reducedMotion/__openDialog）
    w.__request = async () => ({ ok: false, json: async () => ({ ok: false }) });
    const folds = w.document.querySelectorAll('details.nf-fold');
    const sums = w.document.querySelectorAll('summary.nf-sum');
    const scrolls = [];
    w.scrollBy = (_x, y) => { scrolls.push(y); };
    // JSDOM 没有 WAAPI：给个只挂起、不完成的替身 —— 这样"收完才摘 open"才有东西可等
    w.Element.prototype.animate = () => ({ finished: new Promise(() => {}), cancel() {} });
    try {
      w.eval(fs.readFileSync(new URL('../public/ui.js', import.meta.url), 'utf8'));
      w.eval(fs.readFileSync(new URL('../public/app.js', import.meta.url), 'utf8'));
      assert.equal(folds[0].open, true, '夹具第一篇应已展开');
      assert.equal(folds[1].classList.contains('nf-anim'), true, '每行都应切到 px 高度形态');
      sums[1].dispatchEvent(new w.MouseEvent('click', { bubbles: true, cancelable: true }));
      assert.equal(folds[1].open, true, '被点的那篇应打开');
      assert.equal(folds[0].open, true, '已展开的那篇不该被收起（不互斥）');
      assert.deepEqual(scrolls, [], `不该再有任何滚动补偿：${JSON.stringify(scrolls)}`);
      sums[1].dispatchEvent(new w.MouseEvent('click', { bubbles: true, cancelable: true }));
      assert.equal(folds[1].open, true, '收起途中 open 还挂着（内容不能提前撤走）');
      await new Promise((r) => w.setTimeout(r, 520));   // 等兜底定时器收干净（时长下限 220 + 160）
      assert.equal(folds[1].open, false, '再点一次应收起');
      assert.equal(folds[0].open, true, '收起自己不影响别人');
      assert.equal(folds[1].querySelector('.nf-rollout').style.height, '', '收完要清掉行内高度，交回给 CSS 终态');
    } finally { w.close(); }
  });
  await test('封面视频：普通加载不补第二次 play，bfcache 回退才重试（鸿蒙上多补一次会把起播顶掉）', async () => {
    const html = '<!doctype html><html><body><div id="app"><h1 class="hero-figure"><video class="hero-video" data-video-mode="auto"></video></h1></div></body></html>';
    const dom = new JSDOM(html, { url: 'https://example.com/', runScripts: 'outside-only', pretendToBeVisual: true });
    const w = dom.window;
    w.matchMedia = () => ({ matches: false, addEventListener() {}, removeEventListener() {} });
    const plays = [];
    // 第一次 play() 按自动播放策略被拒（NotAllowedError），之后放行 —— 模拟"首屏那次被拦"。
    w.HTMLMediaElement.prototype.play = function play() {
      plays.push(1);
      return plays.length === 1
        ? Promise.reject(Object.assign(new Error('blocked'), { name: 'NotAllowedError' }))
        : Promise.resolve();
    };
    w.HTMLMediaElement.prototype.pause = () => {};
    const tick = () => new Promise((r) => w.setTimeout(r, 30));
    const pageShow = (persisted) => {
      const event = new w.Event('pageshow');
      Object.defineProperty(event, 'persisted', { value: persisted });
      w.dispatchEvent(event);
    };
    try {
      w.eval(fs.readFileSync(new URL('../public/request.js', import.meta.url), 'utf8'));
      w.eval(fs.readFileSync(new URL('../public/ui.js', import.meta.url), 'utf8'));
      w.eval(fs.readFileSync(new URL('../public/app.js', import.meta.url), 'utf8'));
      await tick();
      const before = plays.length;
      assert.ok(before >= 1, '挂载时应先尝试起播一次');
      // 普通加载也会发 pageshow（persisted=false）：这时首屏那次 play() 往往还没落定，
      // 再补一次会把它顶掉 —— 鸿蒙上表现为「第一次进站干脆不播」。
      pageShow(false);
      await tick();
      assert.equal(plays.length, before, '普通加载的 pageshow 不该再补一次 play');
      // bfcache 回退（persisted=true）：上一次被拦的标记要清掉并重试，否则永远停在黑框上。
      pageShow(true);
      await tick();
      assert.ok(plays.length > before, 'bfcache 回退必须重试一次');
      // 冷启动补播：1.5 秒后若还没真正起来（本例的 play() 只返回 resolved，paused 仍为 true，
      // __heroStarted 因此是 false），必须再补一次 —— 鸿蒙上「冷启动不播、手动刷新就播」靠这一步兜住。
      const beforeRetry = plays.length;
      await new Promise((r) => w.setTimeout(r, 1700));
      assert.ok(plays.length > beforeRetry, '1.5 秒补播应生效');
    } finally { w.close(); }
  });
  await test('封面视频：paused=false 但时间不走（鸿蒙「假播」）→ 看门狗 pause+play 踢一脚', async () => {
    const html = '<!doctype html><html><body><div id="app"><h1 class="hero-figure"><video class="hero-video" data-video-mode="auto"></video></h1></div></body></html>';
    const dom = new JSDOM(html, { url: 'https://example.com/', runScripts: 'outside-only', pretendToBeVisual: true });
    const w = dom.window;
    w.matchMedia = () => ({ matches: false, addEventListener() {}, removeEventListener() {} });
    // 把定时器收进数组，手动"走一拍"看门狗 —— 真等 1.5s×N 太慢，也没必要。
    const timers = [];
    w.setInterval = (fn, ms) => { timers.push({ fn, ms }); return timers.length; };
    w.clearInterval = () => {};
    const plays = [], pauses = [];
    // jsdom 的 paused/readyState 是只读 getter，改成读自定义字段，才能摆出"假播"现场。
    Object.defineProperty(w.HTMLMediaElement.prototype, 'paused', { configurable: true, get() { return this.__paused ?? true; } });
    Object.defineProperty(w.HTMLMediaElement.prototype, 'readyState', { configurable: true, get() { return this.__rs ?? 0; } });
    w.HTMLMediaElement.prototype.play = function play() { plays.push(1); this.__paused = false; return Promise.resolve(); };
    w.HTMLMediaElement.prototype.pause = function pause() { pauses.push(1); this.__paused = true; };
    try {
      w.eval(fs.readFileSync(new URL('../public/request.js', import.meta.url), 'utf8'));
      w.eval(fs.readFileSync(new URL('../public/ui.js', import.meta.url), 'utf8'));
      w.eval(fs.readFileSync(new URL('../public/app.js', import.meta.url), 'utf8'));
      const video = w.document.querySelector('video');
      // 鸿蒙冷启动实测现场：play() 已 resolve、paused=false、readyState=3，但 currentTime 停在 0。
      video.__rs = 3; video.__paused = false; video.currentTime = 0;
      const watchdog = timers.find((t) => t.ms === 1500)?.fn;
      assert.ok(watchdog, '应装上 1.5 秒看门狗');
      const before = plays.length;
      watchdog();                                   // 第一拍只记基线
      assert.equal(pauses.length, 0, '第一拍不该动手');
      watchdog();                                   // 第二拍：时间没往前 → 踢
      assert.equal(pauses.length, 1, '停滞时应当 pause 一次');
      assert.ok(plays.length > before, '踢完必须重新 play');
      // 时间在走时不许动手（真播放时每拍 currentTime 都会往前）
      video.__paused = false; video.currentTime = 2;
      watchdog();
      video.currentTime = 3.5;
      watchdog();
      assert.equal(pauses.length, 1, '正常播放时看门狗不该碰它');
    } finally { w.close(); }
  });
  await test('单文件损坏不阻塞其余内容入库（且内容管线不卡死）', async () => {
    const dir = path.join(process.env.CONTENT_DIR, 'posts');
    const bad = path.join(dir, 'partial-broken.md');
    const good = path.join(dir, 'partial-good.md');
    fs.writeFileSync(bad, '---\ntitle: [\n---\nbroken');
    fs.writeFileSync(good, '---\nslug: partial-good\ntitle: 好文件\ndate: 2025-03-01\n---\n正文');
    try {
      const out = syncContent(repo, { quiet: true });
      assert.ok(out.errors.some((e) => e.includes('partial-broken')), '应报告坏文件');
      assert.ok(repo.getPost('partial-good'), '同一轮里的好文件仍应入库（坏文件只隔离自己）');
    } finally {
      fs.rmSync(bad, { force: true }); fs.rmSync(good, { force: true });
      syncContent(repo, { quiet: true });
      db.prepare('DELETE FROM posts WHERE slug = ?').run('partial-good');
    }
  });
  await test('CLI 在内容与附件目录丢失后完整恢复，启动后保留备份版本', async () => {
    const dir = path.join(work, 'backups');
    const name = fs.readdirSync(dir).find((file) => file.endsWith('.db.gz')).replace('.db.gz', '');
    fs.renameSync(process.env.CONTENT_DIR, process.env.CONTENT_DIR + '-lost');
    fs.renameSync(process.env.UPLOADS_DIR, process.env.UPLOADS_DIR + '-lost');
    close(db); dbClosed = true;
    const result = spawnSync(process.execPath, ['--no-warnings', 'scripts/restore.mjs', '--yes', '--dir', dir, '--from', name], {
      env: process.env, encoding: 'utf8', timeout: 20000,
    });
    assert.equal(result.status, 0, result.stdout + result.stderr);
    const check = open(process.env.DB_FILE);
    try {
      const rr = createRepo(check); assert.deepEqual(syncContent(rr, { quiet: true }).errors, []);
      const article = rr.getPost('backup-version'); assert.equal(article.body_md, 'snapshot body');
      assert.equal(createCommentRepo(check).countOfPost(article.id), 1);
      assert.ok(fs.existsSync(path.join(process.env.UPLOADS_DIR, '2025', '01', 'image.png')));
    } finally { close(check); }
    const { startServer } = await import('./_server.mjs');
    const server = await startServer();
    try {
      assert.match(await (await fetch(server.base + '/p/backup-version/')).text(), /snapshot body/);
      assert.equal(await (await fetch(server.base + '/uploads/2025/01/image.png')).text(), 'image bytes');
    } finally { await server.stop(); }
  });
} finally { if (!dbClosed) close(db); fs.rmSync(work, { recursive: true, force: true }); }
await test('SQL 里不出现编号参数（问号加数字）——老版 node:sqlite 上会抛 column index out of range', () => {
  // 曾实测：db/feeds.js 的 pruneOf 用编号参数（同一 feedId 写两遍 + 一个 LIMIT），在 Node 22.13.0 上每次刷源都失败
  // （只有一句 column index out of range），22.22.2 起才正常；同样语义用匿名 `?` 在所有版本都成立 —— 守住这条。
  // 注释里的写法不算：先剥注释，只扫真进 SQLite 的代码。
  const strip = (s) => s
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/(^|\s)\/\/[^\n]*/gm, '$1');
  const bad = [];
  const walk = (dir) => {
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
      const p = path.join(dir, e.name);
      if (e.isDirectory()) { walk(p); continue; }
      if (!/\.(js|mjs)$/.test(e.name)) continue;
      // `(?<![\w?])` 放过 `failed?1:0` 紧凑三元与 `??0` 空值合并 —— 它们长得像 `?1`/`?0`，而 SQL 编号参数前一定是空格/括号/逗号。
      if (/(?<![\w?])\?\d/.test(strip(fs.readFileSync(p, 'utf8')))) bad.push(p);
    }
  };
  for (const dir of ['db', 'src', 'scripts']) walk(dir);
  assert.deepEqual(bad, [], `这些文件里出现了编号参数：${bad.join(', ')}`);
});
await test('内容地址只从 util/text.js 拼：别处不得手写「笔记→n、其余→p」的前缀判断', () => {
  // 曾出错：固定页评论的站主邮件「查看这条评论」被拼成 /p/about/（固定页走 /<slug>）→ 404。同一手写前缀散在 7 个文件里，
  // 只有 text.js 的 kindPrefix()/postUrl()/contentUrl() 记得这一档 —— 那条字面量三元只允许出现在 src/util/text.js。
  const strip = (s) => s
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/(^|\s)\/\/[^\n]*/gm, '$1');
  const pattern = /['"]\/?n['"]\s*:\s*['"]\/?p['"]/;
  const only = path.join('src', 'util', 'text.js');
  const bad = [];
  const walk = (dir) => {
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
      const p = path.join(dir, e.name);
      if (e.isDirectory()) { walk(p); continue; }
      if (!/\.(js|mjs)$/.test(e.name) || p.endsWith(only)) continue;
      if (pattern.test(strip(fs.readFileSync(p, 'utf8')))) bad.push(p);
    }
  };
  for (const dir of ['db', 'src', 'scripts']) walk(dir);
  assert.deepEqual(bad, [], `这些文件又自己拼了一遍内容前缀：${bad.join(', ')}`);
});
await test('前台友圈不再渲染摘要（summary 只入库，不上前台）', () => {
  // 友圈只留标题：摘要被 300 字上限截成半句、读着比不读更累。解析与入库照旧（test-feeds 的 B25 盯着那一半），
  // 这条只守渲染层：friends.js 不许出现 item.summary，style.css 不许再有 .fc-sum。
  const src = fs.readFileSync(path.join('src', 'render', 'friends.js'), 'utf8');
  const css = fs.readFileSync(path.join('public', 'style.css'), 'utf8');
  assert.ok(!/item\.summary/.test(src), 'friends.js 又在渲染摘要了');
  assert.ok(!/\.fc-sum\b/.test(css), 'style.css 里又出现了 .fc-sum');
});
await test('表单提交的正文在请求入口归一化为 LF（浏览器 FormData 会转 CRLF）', async () => {
  // 浏览器构造 FormData 时按 HTML 规范把 textarea 换行转成 CRLF，服务端原样落盘 → about.md 41 个 CR，整篇 diff 漂移。
  // 写入层按设计逐字保留正文，所以归一化只放在请求入口。
  const { formBody } = await import('../src/routes/admin/shared.js');
  const fd = new FormData();
  fd.set('body', '一\r\n二\r三\n四');
  assert.equal(formBody(fd), '一\n二\n三\n四');
  assert.equal(formBody({ body: 'a\r\nb' }), 'a\nb');
  // 保存 / 自动保存 / 预览都不许绕过入口直接读原值
  const src = fs.readFileSync(path.join('src', 'routes', 'admin.js'), 'utf8');
  assert.ok(!/val\(\s*b\s*,\s*'body'\s*\)/.test(src), "admin.js 又直接读 val(b, 'body')，会漏掉入口归一化");
});
await test('同一天更新仍会刷新 Feed ETag；纯重渲染保留 updated_at', async () => {
  const mem = new DatabaseSync(':memory:');
  try {
    migrate(mem, { log() {} });
    const memRepo = createRepo(mem);
    const memFeeds = feedRoutes(memRepo);
    const rec = {
      slug: 'stamp-post', kind: 'post', title: '时间戳测试', description: '',
      bodyMd: 'a', bodyHtml: '<p>a</p>', toc: [], lang: 'zh', commentsOn: true,
      draft: false, source: 'file', filePath: '/tmp/stamp-post.md', fileHash: 'h1',
      wordCount: 1, publishedAt: '2025-01-01T10:00:00Z',
    };
    const id = memRepo.upsertFromFile(rec).id;
    // 模拟 SQLite datetime('now') 的同日格式：空格分隔，直接字符串比较会输给 published_at 的 T。
    mem.prepare("UPDATE posts SET updated_at='2025-01-01 10:30:00' WHERE id=?").run(id);
    const first = (await memFeeds.request('/feed.xml')).headers.get('etag');
    mem.prepare("UPDATE posts SET updated_at='2025-01-01 11:30:00' WHERE id=?").run(id);
    const second = (await memFeeds.request('/feed.xml')).headers.get('etag');
    assert.notEqual(second, first, '同日更新必须让 Feed ETag 变化，否则客户端会一直 304');

    memRepo.upsertFromFile({ ...rec, bodyHtml: '<p>b</p>' }, { ignoreHash: true, preserveUpdatedAt: true });
    assert.equal(mem.prepare('SELECT updated_at FROM posts WHERE id=?').get(id).updated_at, '2025-01-01 11:30:00',
      '文件哈希没变时，纯重渲染不应刷新 updated_at');
    memRepo.upsertFromFile({ ...rec, bodyHtml: '<p>c</p>' }, { ignoreHash: true });
    assert.notEqual(mem.prepare('SELECT updated_at FROM posts WHERE id=?').get(id).updated_at, '2025-01-01 11:30:00',
      '内容真变了仍应更新时间');
  } finally { mem.close(); }
});
console.log(`  ${pass} 通过 / ${fail} 失败`);
process.exitCode = fail ? 1 : 0;

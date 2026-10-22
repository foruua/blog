import './_test-env.mjs';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import sharp from 'sharp';
import { JSDOM } from 'jsdom';
import { spawnSync } from 'node:child_process';
import { DatabaseSync } from 'node:sqlite';
import { migrate } from '../db/migrate.js';
import { createRepo } from '../db/repo.js';
import { createAdminRepo } from '../db/admin.js';
import { createCommentRepo } from '../db/comments.js';
import { createCrypto } from '../src/auth.js';
import { createAdminAuth } from '../src/admin/auth.js';
import { createRenderer } from '../src/render/markdown.js';
import { adminRoutes } from '../src/routes/admin.js';
import { publicRoutes } from '../src/routes/public.js';
import { SITE, UPLOADS_DIR } from '../src/config.js';
import { probeImage } from '../src/media/image.js';
import { parseFeedsPerPage, saveSettings } from '../src/settings.js';
import { startServer } from './_server.mjs';
import { createChecker, SkipTest } from './_check.mjs';

const { test, report } = createChecker();
function context() {
  const db = new DatabaseSync(':memory:'); migrate(db, { log() {} });
  const repo = createRepo(db), adminRepo = createAdminRepo(db), comments = createCommentRepo(db), crypt = createCrypto(db);
  repo.setSetting('admin_password_hash', 'configured');
  const auth = createAdminAuth({ db, crypt }), renderer = createRenderer();
  const app = adminRoutes({ repo, adminRepo, comments, crypt, auth, renderer });
  const csrf = 'maintenance-csrf';
  const cookie = 'blog_admin=' + crypt.sign({ uid: 'owner', ep: 0, csrf, sid: 'maintenance-session' });
  const get = (url) => app.request(url, { headers: { Cookie: cookie } });
  const post = (url, body = {}, token = csrf) => app.request(url, { method: 'POST',
    headers: { Cookie: cookie, 'x-csrf-token': token, 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
  const add = (slug, body = '', kind = 'post', draft = 0, date = '2025-01-01T00:00:00Z') => Number(db.prepare(
    'INSERT INTO posts(slug,title,kind,body_md,draft,published_at) VALUES(?,?,?,?,?,?)').run(slug, slug, kind, body, draft, date).lastInsertRowid);
  return { db, repo, adminRepo, comments, crypt, renderer, app, get, post, add };
}

console.log('\n内容维护与媒体引用测试');
await test('数字设置拒绝小数、尾随字符、指数与空值，校验失败不执行任何写入', () => {
  for (const raw of ['5.5', '20abc', '2e1', '', 'Infinity', '9007199254740993']) {
    assert.equal(parseFeedsPerPage(raw), null);
    for (const key of ['pageSize', 'homeRecent', 'commentsPerPage']) {
      const writes = [];
      assert.ok(saveSettings({ pageSize: '20', homeRecent: '12', commentsPerPage: '20', [key]: raw }, (...entry) => writes.push(entry)));
      assert.equal(writes.length, 0);
    }
  }
  assert.equal(parseFeedsPerPage(' 20 '), 20);
});

await test('媒体删除预检全部派生路径，拒绝越界路径和指向目录外的软链', async () => {
  const c = context();
  const file = path.join(UPLOADS_DIR, 'review-safe.png');
  const outside = path.join(process.env.DATA_DIR, 'review-outside.png');
  const link = path.join(UPLOADS_DIR, 'review-link.png');
  fs.writeFileSync(file, 'original'); fs.writeFileSync(outside, 'outside'); fs.symlinkSync(outside, link);
  try {
    for (const unsafe of ['/uploads/../data/review-outside.png', '/uploads/review-link.png', '/other/file.png']) {
      for (const field of ['thumbnail', 'variants']) {
        const id = c.adminRepo.mediaAdd({ path: '/uploads/review-safe.png',
          [field]: field === 'thumbnail' ? unsafe : JSON.stringify([{ w: 640, path: unsafe }]) });
        assert.equal((await c.post(`/admin/media/delete/${id}`)).status, 303);
        assert.ok(c.adminRepo.mediaById(id));
        assert.equal(fs.readFileSync(file, 'utf8'), 'original');
        assert.equal(fs.readFileSync(outside, 'utf8'), 'outside');
        c.adminRepo.mediaDelete(id);
      }
    }
  } finally { c.db.close(); for (const p of [file, outside, link]) fs.rmSync(p, { force: true }); }
});

await test('站点设置与首页封面设置中途写入失败时整组回滚', async () => {
  const c = context(), set = c.repo.setSetting;
  c.app.onError((_error, ctx) => ctx.json({ ok: false }, 500));
  try {
    for (const [url, body, values] of [
      ['/admin/settings', { pageSize: '10', homeRecent: '5', commentsPerPage: '10' }, { page_size: '20', home_recent: '12', comments_per_page: '20' }],
      ['/admin/hero', { url: '/uploads/after.png', w: '32', h: '16' }, { hero_image: '/uploads/before.png', hero_image_w: '64', hero_image_h: '32' }],
    ]) {
      for (const [key, value] of Object.entries(values)) set(key, value);
      let writes = 0;
      c.repo.setSetting = (key, value) => { if (++writes === 2) throw new Error('injected settings failure'); return set(key, value); };
      assert.equal((await c.post(url, body)).status, 500);
      c.repo.setSetting = set;
      for (const [key, value] of Object.entries(values)) assert.equal(c.repo.getSetting(key), value);
    }
  } finally { c.repo.setSetting = set; c.db.close(); }
});

await test('上传冲突与部分写入失败保留已有文件，只回收本次新建文件；重复上传直接返回', async () => {
  const c = context();
  const bytes = await sharp({ create: { width: 16, height: 16, channels: 3, background: '#123456' } }).png().toBuffer();
  const hash = probeImage.sha256(bytes), now = new Date();
  const rel = `/uploads/${now.getUTCFullYear()}/${String(now.getUTCMonth() + 1).padStart(2, '0')}/${hash.slice(0, 16)}.png`;
  const file = path.join(UPLOADS_DIR, rel.slice('/uploads/'.length)), thumbnail = file + '.thumb-v3.webp';
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const upload = () => {
    const body = new FormData(); body.set('file', new File([bytes], 'review.png', { type: 'image/png' }));
    return c.app.request('/admin/api/upload', { method: 'POST', headers: { Cookie: 'blog_admin=' + c.crypt.sign({ uid: 'owner', ep: 0, csrf: 'maintenance-csrf' }), 'x-csrf-token': 'maintenance-csrf' }, body });
  };
  const write = fs.writeFileSync;
  c.app.onError((_error, ctx) => ctx.json({ ok: false }, 500));
  try {
    fs.writeFileSync(file, 'existing');
    assert.equal((await upload()).status, 500);
    assert.equal(fs.readFileSync(file, 'utf8'), 'existing');
    fs.rmSync(file);
    fs.writeFileSync(thumbnail, 'existing-thumbnail');
    assert.equal((await upload()).status, 500);
    assert.ok(!fs.existsSync(file));
    assert.equal(fs.readFileSync(thumbnail, 'utf8'), 'existing-thumbnail');
    fs.rmSync(thumbnail);
    const openFile = fs.promises.open;
    fs.promises.open = async (target, flags, mode) => {
      const fh = await openFile(target, flags, mode);
      if (flags === 'wx') {
        const writeAll = fh.writeFile.bind(fh);
        fh.writeFile = async (...args) => { await writeAll(...args); throw new Error('injected upload failure'); };
      }
      return fh;
    };
    assert.equal((await upload()).status, 500);
    assert.ok(!fs.existsSync(file));
    fs.promises.open = openFile;
    assert.equal(c.adminRepo.mediaByHash(hash), undefined);
    assert.equal((await upload()).status, 200);
    assert.equal((await (await upload()).json()).deduped, true);
  } finally {
    fs.writeFileSync = write;
    const media = c.adminRepo.mediaByHash(hash);
    for (const p of [file, thumbnail, ...JSON.parse(media?.variants ?? '[]').map((v) => path.join(UPLOADS_DIR, v.path.slice('/uploads/'.length)))]) fs.rmSync(p, { force: true });
    c.db.close();
  }
});
await test('媒体详情识别原图与派生图、引用式图片、链接、草稿和固定页；忽略代码及外站同路径', async () => {
  const { db, repo, adminRepo, app, get, post, add } = context();
  try {
    const url = '/uploads/2025/01/test.png';
    const id = adminRepo.mediaAdd({ path: url, thumbnail: url + '.thumb.webp', variants: JSON.stringify([{ w: 640, path: url + '.w640.webp' }]), filename: '<script>素材</script>' });
    const originalId = add('文章引用', `![正文](${url}?v=1#图)`);
    const draftId = add('草稿引用', `![引用式][img]\n\n[img]: ${url}.thumb.webp`, 'post', 1);
    const pageId = add('固定页引用', `[下载](${SITE.url}${url}.w640.webp)`, 'page');
    add('代码示例', `\`${url}\`\n\n\`\`\`md\n![代码](${url})\n\`\`\``);
    add('外站图片', `![外站](https://foreign.invalid${url})`);
    add('相似文件', `![相似](${url}-other.png)`);
    const used = adminRepo.postsUsingPath(url);
    assert.deepEqual(new Set(used.map((p) => p.id)), new Set([originalId, draftId, pageId]));
    assert.equal(adminRepo.mediaUsage([adminRepo.mediaById(id)]).get(id).length, 3);
    assert.equal((await app.request(`/admin/media/${id}`)).status, 303);
    const html = await (await get(`/admin/media/${id}`)).text();
    assert.match(html, /草稿/); assert.match(html, /固定页/);
    assert.match(html, new RegExp(`/admin/edit/${draftId}`));
    assert.ok(!html.includes('<script>素材</script>'));
    const fragment = await (await get(`/admin/media/${id}?partial=details`)).text();
    assert.match(fragment, /class="a-media-detail"/);
    assert.ok(!fragment.includes('<!DOCTYPE'));
    assert.match(fragment, new RegExp(`/admin/edit/${draftId}`));
    const library = await (await get('/admin/media')).text();
    assert.match(library, /class="a-media-ref-lbl">引用<span class="a-media-ref-more">详情<\/span><\/span>/);
    assert.match(library, /class="a-media-ref-n">3<\/span>/);
    assert.match(library, /id="a-media-dialog"/);
    assert.match(library, /data-media-details/);
    const deletion = await post(`/admin/media/delete/${id}`);
    assert.equal(deletion.status, 303); assert.ok(adminRepo.mediaById(id));
    repo.setSetting('hero_image', url);
    assert.match(await (await get(`/admin/media/${id}`)).text(), /到设置页更换/);
    assert.equal((await get('/admin/media/999999')).status, 404);
  } finally { db.close(); }
});

await test('年度归档按站点时区过滤，不加载全站列表；总归档不读取正文列', async () => {
  for (const offset of ['+00:00', '+08:00', '+09:00']) {
    const script = `
      import assert from 'node:assert/strict';
      import { DatabaseSync } from 'node:sqlite';
      import { migrate } from './db/migrate.js';
      import { createRepo } from './db/repo.js';
      import { parseDate } from './src/util/text.js';
      const db = new DatabaseSync(':memory:'); migrate(db, {log(){}});
      const repo = createRepo(db);
      const boundary = Date.parse(parseDate('2025-01-01'));
      const insert = db.prepare('INSERT INTO posts(slug,title,draft,kind,published_at) VALUES(?,?,?, ?,?)');
      const add = (slug, t, draft=0, kind='post') => insert.run(slug,slug,draft,kind,new Date(t).toISOString().replace(/\\.\\d{3}Z$/, 'Z'));
      add('before', boundary-1000); add('after', boundary); add('draft',boundary,1); add('page',boundary,0,'page');
      add('next', Date.parse(parseDate('2026-01-01')));
      assert.deepEqual(repo.publishedInYear('2025').map(p=>p.slug), ['after']);
      assert.ok(repo.publishedInYear('2024').some(p=>p.slug==='before'));
      assert.deepEqual(repo.publishedInYear('bad'), []);
      assert.ok(!Object.hasOwn(repo.archiveEntries()[0], 'body_html'));
      const plan = db.prepare("EXPLAIN QUERY PLAN SELECT id FROM posts WHERE draft=0 AND published_at>=? AND published_at<? ORDER BY published_at DESC").all(parseDate('2025-01-01'),parseDate('2026-01-01'));
      assert.ok(plan.some(p=>/SEARCH.*INDEX/.test(p.detail)));
      db.close();
    `;
    const result = spawnSync(process.execPath, ['--input-type=module', '-e', script], { env: { ...process.env, SITE_TZ_OFFSET: offset }, encoding: 'utf8' });
    assert.equal(result.status, 0, result.stderr);
  }
  const { db, repo, comments, crypt, add } = context();
  try {
    add('annual-entry');
    repo.allPublished = () => { throw new Error('不应读取全站列表'); };
    const app = publicRoutes(repo, { comments, crypt });
    assert.match(await (await app.request('/a/2025')).text(), /annual-entry/);
    assert.equal((await app.request('/archive/')).status, 200);
  } finally { db.close(); }
});

await test('首页最近更新只读取展示字段，按时间与 ID 排序并排除草稿和固定页', async () => {
  const { db, repo, comments, crypt, add } = context();
  try {
    add('first'); add('second', '', 'note'); add('draft', '', 'post', 1); add('page', '', 'page');
    add('future', '', 'post', 0, '9999-01-01T00:00:00Z');
    assert.deepEqual(repo.recentEntries(2).map((p) => p.slug), ['second', 'first']);
    // body_head（截断 480 字符）与 lang 是主题 data.recent[] 的展示字段；正文仍不在首页读取路径上。
    assert.deepEqual(Object.keys(repo.recentEntries(1)[0]).sort(), ['body_head', 'id', 'kind', 'lang', 'published_at', 'slug', 'title']);
    repo.feed = () => { throw new Error('首页不应读取正文'); };
    repo.setSetting('home_recent', '2');
    const app = publicRoutes(repo, { comments, crypt });
    const dom = new JSDOM(await (await app.request('/')).text());
    assert.equal(dom.window.document.querySelectorAll('main').length, 1);
    assert.ok(dom.window.document.querySelector('main .hero'));
    assert.ok(dom.window.document.querySelector('main .recent'));
    dom.window.close();
  } finally { db.close(); }
});

await test('预取缓存：有效期内复用，边界和过期重新请求，过期项可再次预取', async () => {
  for (const age of [29999, 30000, 60000]) {
    const dom = new JSDOM('<div id="app"><main id="main">首页</main><a href="/posts/">文章</a></div>', {
      url: 'http://blog.invalid/', runScripts: 'outside-only', pretendToBeVisual: true,
    });
    const w = dom.window;
    let now = 1000, requests = 0;
    w.Date.now = () => now;
    w.scrollTo = () => {};
    w.fetch = async () => {
      const version = ++requests;
      return { ok: true, headers: new w.Headers({ 'content-type': 'text/html' }),
        text: async () => `<title>版本 ${version}</title><div id="app"><main id="main">版本 ${version}</main></div>` };
    };
    // jsdom 不提供 Headers；只需模拟本脚本读取的响应头。
    w.Headers = globalThis.Headers;
    try {
      w.eval(fs.readFileSync(new URL('../public/ui.js', import.meta.url), 'utf8'));
      w.eval(fs.readFileSync(new URL('../public/nav.js', import.meta.url), 'utf8'));
      const hover = () => w.document.querySelector('a').dispatchEvent(new w.MouseEvent('mouseover', { bubbles: true }));
      hover(); await new Promise((resolve) => setImmediate(resolve));
      assert.equal(requests, 1);
      now += age;
      if (age === 60000) { hover(); await new Promise((resolve) => setImmediate(resolve)); }
      await w.__nav.navigate('http://blog.invalid/posts/');
      assert.equal(requests, age < 30000 ? 1 : 2);
      assert.equal(w.document.querySelector('main').textContent, `版本 ${age < 30000 ? 1 : 2}`);
      assert.equal(w.__nav.cache.size, 0);
    } finally { w.close(); }
  }
});

await test('真实浏览器：首页跳转聚焦正文；脚本失败和观察器失败时列表仍可见；减弱动效不播放动画', async () => {
  let chromium;
  try { ({ chromium } = await import('playwright')); }
  catch (error) {
    if (process.env.UI_AUDIT_REQUIRED === '1') throw error;
    throw new SkipTest('未安装 playwright/chromium');
  }
  const server = await startServer(); let browser;
  try {
    try { browser = await chromium.launch(); }
    catch (error) {
      if (process.env.UI_AUDIT_REQUIRED === '1') throw error;
      throw new SkipTest('Chromium 未安装（npx playwright install chromium）');
    }
    const home = await browser.newPage();
    await home.goto(server.base);
    await home.keyboard.press('Tab'); await home.keyboard.press('Enter');
    await home.waitForFunction(() => document.activeElement.id === 'main');
    assert.equal(await home.locator('main .hero').count(), 1);
    assert.equal(await home.locator('main .recent').count(), 1);
    await home.close();
    for (const mode of ['blocked', 'observer-error', 'reduced']) {
      const page = await browser.newPage({ reducedMotion: mode === 'reduced' ? 'reduce' : 'no-preference' });
      if (mode === 'blocked') await page.route('**/app.js?*', (route) => route.abort());
      if (mode === 'observer-error') await page.addInitScript(() => {
        window.IntersectionObserver = class { constructor() { throw new Error('模拟观察器失败'); } };
      });
      for (const url of ['/posts/', '/notes/']) {
        await page.goto(server.base + url);
        const item = page.locator('.list > li, .notes > .nf').first();
        await item.waitFor();
        assert.ok(await item.evaluate((el) => getComputedStyle(el).opacity === '1'));
        assert.equal(await item.evaluate((el) => getComputedStyle(el).filter), 'none');
        if (mode === 'reduced') assert.equal(await item.evaluate((el) => getComputedStyle(el).animationName), 'none');
      }
      await page.close();
    }
  } finally { if (browser) await browser.close(); await server.stop(); }
});

process.exitCode = report();

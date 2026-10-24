import { launchBrowser, loginAdminPage } from './_browser.mjs';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import { BLANK_PNG } from '../src/avatar/cache.js';
import { DatabaseSync } from 'node:sqlite';
import { createFixtures } from './_fixtures.mjs';
import { startServer } from './_server.mjs';
import { PROBE } from './ui-audit.mjs';

const fixtures = await createFixtures();
const srv = await startServer({ env: { ...fixtures.env, FEED_ALLOW_PRIVATE: 'true' } });
const browser = await launchBrowser();
const db = new DatabaseSync(fixtures.env.DB_FILE);
try {
  db.prepare("UPDATE posts SET draft=1 WHERE slug='fixture-1'").run();
  db.prepare("UPDATE posts SET published_at='2099-01-01T00:00:00Z' WHERE slug='fixture-2'").run();
  const page = await browser.newPage({ viewport: { width: 1280, height: 900 }, reducedMotion: 'reduce' });
  await page.goto(srv.base);
  assert.equal(await page.locator('.recent .entries li').count(), 10);
  assert.ok((await page.locator('.recent').boundingBox()).y < 500);
  await page.goto(srv.base + '/posts/');
  // 每行底部有元信息行（.e-meta），li 不再等于 .e-main 的盒子 —— 改为核「主体顶端贴 li 顶、左右撑满、元信息行贴 li 底」。
  const listGaps = await page.locator('.list li').evaluateAll((es) => es.map((e) => {
    const li = e.getBoundingClientRect();
    const main = e.querySelector('.e-main').getBoundingClientRect();
    const meta = e.querySelector('.e-meta').getBoundingClientRect();
    return Math.abs(li.top - main.top) + Math.abs(li.left - main.left)
      + Math.abs(li.right - main.right) + Math.abs(li.bottom - meta.bottom);
  }));
  assert.ok(listGaps.every((gap) => gap < .01), `行盒与主体/元信息行应对齐：${listGaps}`);
  await page.goto(srv.base); 
  await page.setViewportSize({ width: 390, height: 844 });
  const title = await page.locator('.recent .e-title').first().boundingBox();
  const time = await page.locator('.recent time').first().boundingBox();
  assert.ok(time.y >= title.y + title.height);
  assert.equal(await page.locator('.recent time').first().evaluate((e) => getComputedStyle(e).whiteSpace), 'nowrap');
  // 窄屏导航抽屉的行距与命中区（真浏览器量拇指遇到的那两个盒子）。行高由上下内距决定，下界是 44px 触控目标、上界挡「内距又吹回去」；
  await page.evaluate(() => document.querySelector('header.site .navbtn').click());
  await page.waitForTimeout(400);
  const navRows = await page.locator('.mnav-panel ul a')
    .evaluateAll((links) => links.map((a) => +a.getBoundingClientRect().height.toFixed(1)));
  assert.ok(navRows.length >= 5 && navRows.every((h) => h >= 44 && h <= 60), `抽屉行高应在 44–60px：${navRows}`);
  // 抽屉只剩目录 + 检索：底部那排 RSS / 配色 / 后台都已撤掉。
  assert.equal(await page.locator('.mnav-foot').count(), 0, '抽屉不该再有底部工具条');
  assert.equal(await page.locator('.mnav a[href="/feed.xml"], .mnav a[href^="/admin"], .mnav .pal').count(), 0,
    '抽屉里不该再有 RSS / 后台 / 配色入口');
  await page.keyboard.press('Escape');
  await page.waitForTimeout(200);
  for (const [kind, label] of [['post', '文章'], ['note', '笔记']]) {
    await page.goto(`${srv.base}/archive/?kind=${kind}`);
    assert.equal(await page.locator('.arch-filter [aria-current="page"]').textContent(), label);
    assert.ok((await page.locator('.e-kind').allTextContents()).every((text) => text === label));
  }
  await page.goto(srv.base + '/notes/');
  // 笔记列表每篇都是折叠行、**默认全部收起**，评论按钮只在展开面板里 —— 取**第一个还收着的**折叠行展开；
  // 一个都没有（例如意外预展开）就用手上那一篇。
  const folds = page.locator('.notes > .nf .nf-fold');
  const closedIdx = await folds.evaluateAll((els) => els.findIndex((e) => !e.open));
  const target = folds.nth(closedIdx >= 0 ? closedIdx : 0);
  if (closedIdx >= 0) { await target.locator('summary').click(); await page.waitForTimeout(300); }
  const commentToggle = target.locator('[data-comments]');
  for (const expanded of ['true', 'false', 'true', 'false']) {
    await commentToggle.hover();
    await page.mouse.down();
    assert.equal(await commentToggle.evaluate((e) => getComputedStyle(e).opacity), '1');
    await page.mouse.up();
    assert.equal(await commentToggle.getAttribute('aria-expanded'), expanded);
    assert.equal(await commentToggle.evaluate((e) => getComputedStyle(e).opacity), '1');
  }
  await page.goto(srv.base + '/archive/?kind=invalid');
  assert.equal(await page.locator('.arch-filter [aria-current="page"]').textContent(), '全部');
  await page.setViewportSize({ width: 1280, height: 900 });
  await page.goto(srv.base + '/admin');
  await page.locator('[name=password]').fill(fixtures.env.ADMIN_PASSWORD);
  await page.locator('button[type=submit]').click();
  await page.waitForURL(srv.base + '/admin');
  // 手机端换成 App 壳：隐藏左侧轨，顶部应用栏 + 底部四标签；深层页面（设置）仍高亮「更多」。
  await page.setViewportSize({ width: 320, height: 844 });
  await page.goto(srv.base + '/admin/system');
  const shell = await page.evaluate(() => {
    const display = (selector) => { const el = document.querySelector(selector); return el ? getComputedStyle(el).display : null; };
    const active = document.querySelector('.a-tab.on');
    const box = active?.getBoundingClientRect();
    return {
      rail: display('.a-rail'), tabbar: display('.a-tabbar'), mbar: display('.a-mbar'),
      active: active?.textContent.trim(), visible: !!box && box.left >= -1 && box.right <= innerWidth + 1,
    };
  });
  assert.equal(shell.rail, 'none');
  assert.equal(shell.tabbar, 'grid');
  assert.equal(shell.mbar, 'flex');
  assert.equal(shell.active, '更多');
  assert.ok(shell.visible, `底栏当前项应在视口内：${JSON.stringify(shell)}`);
  await page.goto(srv.base + '/admin');
  const contentShell = await page.evaluate(() => {
    const display = (selector) => getComputedStyle(document.querySelector(selector)).display;
    return {
      active: document.querySelector('.a-tab.on')?.textContent.trim(),
      seg: display('.a-seg'), fab: display('.a-fab'),
      headerAction: display('.a-head .a-actions'),
    };
  });
  assert.equal(contentShell.active, '内容');
  assert.equal(contentShell.seg, 'grid');
  assert.equal(contentShell.fab, 'grid');
  assert.equal(contentShell.headerAction, 'none');
  await page.setViewportSize({ width: 1280, height: 900 });
  for (const [status, label] of [['draft', '草稿'], ['scheduled', '定时'], ['published', '已发布']]) {
    await page.goto(`${srv.base}/admin?status=${status}`);
    const states = await page.locator('tbody tr td:first-child').allTextContents();
    assert.ok(states.length > 0 && states.every((text) => text.trim() === label));
    assert.equal(await page.locator('select[name=status]').inputValue(), status);
    assert.ok((await page.locator('.a-search').boundingBox()).y < (await page.locator('.a-table').boundingBox()).y);
    const links = page.locator('.a-pager a');
    const next = await links.count() ? await links.first().getAttribute('href') : null;
    if (next) assert.ok(next.includes(`status=${status}`));
  }
  const insertDraft = db.prepare("INSERT INTO posts(slug,kind,title,draft) VALUES(?,'post',?,1)");
  for (let i = 0; i < 61; i++) insertDraft.run(`filter-draft-${i}`, `分页草稿 ${i}`);
  await page.goto(srv.base + '/admin?status=draft&q=分页草稿');
  assert.equal(await page.locator('.a-title').count(), 60);
  await page.locator('.a-pager a').click();
  await page.waitForURL(/page=2/);
  assert.equal(new URL(page.url()).searchParams.get('status'), 'draft');
  assert.equal(new URL(page.url()).searchParams.get('q'), '分页草稿');
  assert.equal(await page.locator('.a-title').count(), 1);
  db.prepare("DELETE FROM posts WHERE slug LIKE 'filter-draft-%'").run();
  await page.goto(srv.base + '/admin?status=draft&q=fixture-2');
  assert.equal(await page.locator('.a-title').count(), 0);
  await page.goto(srv.base + '/admin/new');
  assert.equal(await page.locator('#f-title').getAttribute('placeholder'), '文章标题');
  const before = db.prepare('SELECT count(*) AS n FROM posts').get().n;
  await page.locator('#f-title').evaluate((e) => { e.value = '预览测试'; });
  await page.locator('#f-body').evaluate((e) => { e.value = '短内容预览。'; });
  await page.locator('[data-editor-preview]').click();
  await page.locator('[data-preview-body] p').waitFor();
  assert.ok((await page.locator('[data-editor-preview-dialog]').boundingBox()).height < 600);
  await page.setViewportSize({ width: 390, height: 844 });
  assert.ok((await page.locator('[data-editor-preview-dialog]').boundingBox()).height < 550);
  await page.locator('[data-preview-close]').click();
  assert.ok((await page.locator('#editorForm .a-bar').boundingBox()).height < 110);
  await page.setViewportSize({ width: 1280, height: 900 });
  await page.locator('#f-body').evaluate((e) => { e.value = '## 当前正文\n\n**预览内容**\n\n' + ('预览沿用文章页的阅读尺度，标题与正文保持清晰的层级。长文在阅读面内滚动，关闭按钮始终可见。\n\n').repeat(24); });
  await page.locator('[data-editor-preview]').click();
  await page.locator('[data-preview-body] strong').waitFor();
  assert.equal(await page.locator('[data-preview-title]').textContent(), '预览测试');
  assert.equal(db.prepare('SELECT count(*) AS n FROM posts').get().n, before);
  assert.equal(await page.locator('.a-editor-hint').count(), 0);
  assert.ok(await page.locator('.a-preview-scroll').evaluate((e) => e.scrollHeight > e.clientHeight));
  const closeBox = await page.locator('[data-preview-close]').boundingBox();
  assert.ok(closeBox.y >= 0 && closeBox.y + closeBox.height < 900);
  if (process.env.UI_REVIEW_SHOTS) {
    fs.mkdirSync('/tmp/blog-ui-after', { recursive: true });
    await page.screenshot({ path: '/tmp/blog-ui-after/preview.png' });
    await page.setViewportSize({ width: 390, height: 844 });
    await page.screenshot({ path: '/tmp/blog-ui-after/preview-mobile.png' });
    await page.setViewportSize({ width: 1280, height: 900 });
  }
  await page.locator('[data-preview-close]').click();
  assert.equal(await page.locator('[data-editor-preview-dialog]').evaluate((e) => e.open), false);
  await page.locator('button[value=save]').click();
  await page.waitForURL(/\/admin\/edit\/\d+/);
  assert.match(await page.locator('#a-save-state').textContent(), /已保存 · \d{4}-\d{2}-\d{2} \d{2}:\d{2}/);
  console.log('UI 改进验证通过：首页布局与条数、归档类型、后台状态查询、预览无写入、保存时间。');
  const editedId = await page.locator('[name=id]').inputValue();
  const originalBody = db.prepare('SELECT body_md FROM posts WHERE id=?').get(editedId).body_md;
  let releaseUpload, uploadStarted = 0;
  await page.route('**/admin/api/upload', async (route) => {
    uploadStarted++;
    const answer = await new Promise((resolve) => { releaseUpload = resolve; });
    try { await route.fulfill({ json: answer }); } catch { /* 已离开页面时请求已取消 */ }
  });
  const chooseFile = () => page.locator('#a-file').setInputFiles({ name: 'test-upload.png', mimeType: 'image/png', buffer: BLANK_PNG });
  await chooseFile();
  await page.locator('#f-body').focus();
  await page.waitForFunction(() => document.querySelector('#a-save-state').textContent.includes('完成后自动保存'));
  assert.equal(db.prepare('SELECT body_md FROM posts WHERE id=?').get(editedId).body_md, originalBody);
  await page.locator('button[value=publish]').click();
  assert.ok((await page.locator('#a-save-state').textContent()).includes('请等待媒体上传完成'));
  await page.locator('.a-rail-nav a[href="/admin"]').click();
  await page.locator('.ui-dialog[open] button[value=cancel]').click();
  assert.equal(await page.locator('#editorForm').count(), 1);
  releaseUpload({ ok: true, url: '/uploads/completed.png' });
  await page.waitForFunction(() => document.querySelector('#a-save-state').textContent.startsWith('已自动保存'));
  let persisted = db.prepare('SELECT body_md FROM posts WHERE id=?').get(editedId).body_md;
  assert.ok(persisted.includes('/uploads/completed.png')); assert.ok(!persisted.includes('uploading:'));
  await page.locator('#a-file').setInputFiles([]);
  await chooseFile();
  await page.waitForFunction(() => document.querySelector('#f-body').value.includes('uploading:2'));
  releaseUpload({ ok: false, error: '模拟上传失败' });
  await page.waitForFunction(() => document.querySelector('#f-body').value.includes('模拟上传失败'));
  await page.waitForFunction(() => document.querySelector('#a-save-state').textContent.startsWith('已自动保存'));
  await page.locator('#a-file').setInputFiles([]);
  await chooseFile();
  await page.waitForFunction(() => document.querySelector('#f-body').value.includes('uploading:3'));
  await page.locator('.a-rail-nav a[href="/admin"]').click();
  await page.locator('.ui-dialog[open] button[value=ok]').click();
  await page.waitForURL(srv.base + '/admin');
  releaseUpload({ ok: true, url: '/uploads/late.png' });
  persisted = db.prepare('SELECT body_md FROM posts WHERE id=?').get(editedId).body_md;
  assert.ok(!persisted.includes('uploading:') && !persisted.includes('/uploads/late.png'));
  const draft = await page.evaluate((id) => JSON.parse(sessionStorage.getItem('blog-draft:' + id)), editedId);
  assert.ok(!draft.body.includes('uploading:') && draft.body.includes('上传已中断'));
  assert.equal(uploadStarted, 3);
  console.log('上传生命周期验证通过：慢上传、失败、保存/发布保护、取消导航与确认离开。');

  let arrived, finishFeed;
  const arrival = new Promise((resolve) => { arrived = resolve; });
  const responseReady = new Promise((resolve) => { finishFeed = resolve; });
  const feedServer = http.createServer(async (_req, res) => {
    arrived(); await responseReady;
    res.writeHead(200, { 'content-type': 'application/rss+xml' });
    res.end('<rss version="2.0"><channel><title>测试源</title><link>https://example.invalid</link></channel></rss>');
  });
  await new Promise((resolve) => feedServer.listen(0, '127.0.0.1', resolve));
  const csrf = await page.locator('[name=_csrf]').first().inputValue();
  const add = page.request.post(srv.base + '/admin/feeds/add', { form: { _csrf: csrf, url: `http://127.0.0.1:${feedServer.address().port}/feed` }, maxRedirects: 0 });
  try {
    await arrival;
    const beforeTime = Date.now();
    const preview = await page.request.post(srv.base + '/admin/api/preview', { data: { _csrf: csrf, body: 'preview' }, headers: { 'x-csrf-token': csrf }, timeout: 1500 });
    assert.equal(preview.status(), 200);
    const saved = await page.request.post(srv.base + '/admin/api/autosave', { data: { _csrf: csrf, title: '并发保存', slug: 'queue-review', body: '正文', kind: 'post' }, headers: { 'x-csrf-token': csrf }, timeout: 1500 });
    assert.equal(saved.status(), 200);
    assert.ok(Date.now() - beforeTime < 3000);
  } finally { finishFeed(); await add; await new Promise((resolve) => feedServer.close(resolve)); }
  db.prepare("INSERT OR REPLACE INTO settings(key,value) VALUES('mail_smtp_host','smtp.example.invalid')").run();
  await page.goto(srv.base + '/admin/system');
  const clear = page.locator('button[formaction="/admin/mail/clear"]');
  for (const theme of ['light', 'dark']) {
    await page.evaluate((theme) => { document.documentElement.dataset.theme = theme; }, theme);
    await clear.hover();
    assert.equal(await clear.evaluate((el) => getComputedStyle(el).color), await clear.evaluate((el) => {
      const sample = document.createElement('span'); sample.style.color = 'var(--danger)'; el.append(sample);
      const color = getComputedStyle(sample).color; sample.remove(); return color;
    }));
  }
  console.log('队列与按钮验证通过：慢订阅不阻塞预览/保存，危险按钮明暗主题悬停清晰。');
  if (process.env.UI_REVIEW_SHOTS) {
    fs.mkdirSync('/tmp/blog-ui-after', { recursive: true });
    for (const [name, url] of [['home', '/'], ['admin', '/admin'], ['editor', '/admin/new'], ['archive', '/archive/?kind=note']]) {
      await page.goto(srv.base + url);
      await page.screenshot({ path: `/tmp/blog-ui-after/${name}.png`, fullPage: false });
    }
    await page.setViewportSize({ width: 390, height: 844 });
    await page.goto(srv.base);
    await page.screenshot({ path: '/tmp/blog-ui-after/mobile.png', fullPage: false });
  }
  await page.setContent(`<style>
    .audit-wrap { display:flex; flex-wrap:wrap; width:50px; gap:8px; font-size:13px; align-items:baseline; }
    .audit-wrap span { width:30px; }
    .audit-misalign { display:flex; gap:8px; font-size:13px; align-items:center; }
    .audit-misalign span:last-child { position:relative; top:3px; }
  </style><div class="audit-wrap"><span>一</span><span>二</span><span>三</span></div>
    <div class="audit-misalign"><span>一</span><span>二</span></div>`);
  const probe = await page.evaluate(PROBE);
  assert.ok(!probe.baseline.some((f) => f.sel.includes('audit-wrap')));
  assert.ok(probe.baseline.some((f) => f.sel.includes('audit-misalign')));
  console.log('审计基线检查：正常换行不误报，同行错位仍会报错。');

  // 后台列表的「分隔线同宽」踩过两次坑：删掉友圈题注后首行上方多一截空白；工具行那条线只横跨版心、比行分割线短 25.6px（行是 -.8rem 出血）。
  await page.setViewportSize({ width: 1280, height: 900 });
  await loginAdminPage(page, srv.base, fixtures.env.ADMIN_PASSWORD);
  for (const [name, url, barSel, rowSel] of [
    ['友圈', '/admin/feeds', '.a-feeds-bar', '.a-feed'],
    ['友链', '/admin/links', '.a-links-tools', '.a-fl'],
  ]) {
    await page.goto(srv.base + url);
    const { bar, rows } = await page.evaluate(([b, r]) => {
      const rect = (el) => { const x = el.getBoundingClientRect(); return { left: Math.round(x.left), right: Math.round(x.right) }; };
      return { bar: rect(document.querySelector(b)), rows: [...document.querySelectorAll(r)].slice(0, 3).map(rect) };
    }, [barSel, rowSel]);
    // 行是出血的（-0.8rem 两侧），工具行那条线要与它们左右对齐 —— 差 1px 以上就算没对齐
    for (const row of rows) {
      assert.ok(Math.abs(row.left - rows[0].left) <= 1 && Math.abs(row.right - rows[0].right) <= 1,
        `${name}：各行的分割线自己就不齐（${JSON.stringify(rows)}）`);
      assert.ok(Math.abs(bar.left - row.left) <= 1 && Math.abs(bar.right - row.right) <= 1,
        `${name}：工具行与行分割线左右不齐（工具行 ${JSON.stringify(bar)}，行 ${JSON.stringify(row)}）`);
    }
  }
  console.log('后台列表分隔线：工具行与每一行的分割线左右对齐。');

  // 封面首帧即终值：把封面图掐掉（模拟"首帧时图还在路上"），相框与 slide 的盒子必须与正常加载时逐像素一致。
  // 踩过的坑：相框用 fit-content 时，图未到 → 没人能算出它多宽 → 首帧塌成 0×0（或 alt 文本那么大），
  // 图到达后再长回来（一次 237px 的布局位移）；四张 loading="lazy" 的图还会在 DidFinishLayout() 撞上
  // LayoutBoxWidth()==0，被 DevTools 记成 LazyLoadImageZeroSize（"懒加载图片应带显式尺寸"）。
  {
    const heroes = ['/uploads/hero-a.png', '/uploads/hero-b.png', '/uploads/hero-c.png'];
    const addMedia = db.prepare('INSERT OR IGNORE INTO media(path,width,height,mime,filename,variants) VALUES(?,?,?,?,?,?)');
    for (const p of heroes) {
      addMedia.run(p, 2160, 1368, 'image/png', p.split('/').pop(),
        JSON.stringify([{ w: 960, path: `${p}.v4-w960.webp` }, { w: 1920, path: `${p}.v4-w1920.webp` }]));
    }
    db.prepare("INSERT INTO settings(key,value) VALUES('hero_images',?) ON CONFLICT(key) DO UPDATE SET value=excluded.value")
      .run(JSON.stringify(heroes.map((p) => ({ path: p, w: 2160, h: 1368 }))));

    const shapeOf = (target) => target.evaluate(() => {
      const box = (el) => `${Math.round(el.getBoundingClientRect().width)}x${Math.round(el.getBoundingClientRect().height)}`;
      return {
        frame: box(document.querySelector('.hero-figure')),
        slides: [...document.querySelectorAll('.hero-slide')].map(box),
      };
    });
    // 图自己喂：夹具里没有这些变体文件，靠服务端会 404 —— 那样两页都退化成 alt 文本，断言会空过。
    const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aD1sAAAAASUVORK5CYII=', 'base64');
    const openHero = async (blockImages) => {
      const p = await browser.newPage({ viewport: { width: 1280, height: 900 }, reducedMotion: 'reduce' });
      await p.route('**/uploads/hero-*', (route) => (blockImages
        ? route.abort()
        : route.fulfill({ contentType: 'image/png', body: png })));
      await p.goto(srv.base + '/');
      await p.waitForSelector('.hero-slide');
      return p;
    };

    const normal = await openHero(false);
    const withImages = await shapeOf(normal);
    await normal.close();
    const blocked = await openHero(true);
    const withoutImages = await shapeOf(blocked);
    await blocked.close();

    assert.ok(withImages.slides.length >= 2, `封面该是轮播：${JSON.stringify(withImages)}`);
    assert.ok(withoutImages.slides.every((s) => !/^0x|x0$/.test(s)), `图未到时 slide 不该是 0 尺寸：${JSON.stringify(withoutImages)}`);
    assert.equal(withoutImages.frame, withImages.frame, `相框在"图未到"与"图已到"两种状态下必须同尺寸：${JSON.stringify({ withImages, withoutImages })}`);
    assert.deepEqual(withoutImages.slides, withImages.slides, `slide 盒子同理：${JSON.stringify({ withImages, withoutImages })}`);
    console.log('封面首帧即终值：图未到时相框与 slide 已是终值，没有位移。');
  }
  // 首帧 theme-color：服务端两条固定 hex 之外，THEME_BOOT 要在 <head> 里就把访客存下的预设/自定义纸色写进
  // 唯一那条无 media 的 meta，手机状态栏才不会停在默认色（部分 WebView 不会在 ui.js 之后再更新）。
  for (const [label, seed] of [
    ['预设+暗色', { palette: 'qingci', theme: 'dark' }],
    ['自定义', { palette: 'custom', palCustom: 'html[data-palette="custom"]{--bg:#123456;--seed-h:120;--seed-lv:mid}' }],
  ]) {
    const ctx = await browser.newContext();
    await ctx.addInitScript((s) => { for (const [k, v] of Object.entries(s)) localStorage.setItem(k, v); }, seed);
    const first = await ctx.newPage();
    await first.goto(srv.base, { waitUntil: 'domcontentloaded' });
    const got = await first.evaluate(() => ({
      meta: document.querySelector('meta[name="theme-color"]:not([media])')?.getAttribute('content') ?? '',
      bg: getComputedStyle(document.documentElement).backgroundColor,
    }));
    assert.equal(got.meta, got.bg, `${label}：theme-color 应与首帧纸色一致`);
    assert.notEqual(got.meta, 'rgb(250, 248, 244)', `${label}：不该停在默认素笺色`);
    await ctx.close();
  }
  console.log('首帧 theme-color：预设与自定义配色都在 <head> 内同步生效。');
} finally {
  db.close();
  await browser.close();
  await srv.stop();
  fixtures.cleanup();
}

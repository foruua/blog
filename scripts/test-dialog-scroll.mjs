import { launchBrowser, loginAdminPage } from './_browser.mjs';
import './_test-env.mjs';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { startIsolated } from './ui-audit.mjs';

const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aD1sAAAAASUVORK5CYII=', 'base64');
fs.writeFileSync(path.join(process.env.UPLOADS_DIR, 'scroll-test.png'), png);
fs.appendFileSync(path.join(process.env.CONTENT_DIR, 'posts', 'why-single-column.md'), '\n![滚动锁测试图片](/uploads/scroll-test.png)\n');
const db = new DatabaseSync(process.env.DB_FILE);
try {
  db.prepare('INSERT INTO media(path,width,height,mime,filename) VALUES(?,1,1,?,?)').run('/uploads/scroll-test.png', 'image/png', 'scroll-test.png');
  db.prepare("INSERT INTO feeds(url,title,sort_order,enabled,display_limit,created_at) VALUES(?,?,0,0,3,?)")
    .run('https://example.invalid/scroll-fixture.xml', '滚动锁测试源', new Date().toISOString());
} finally { db.close(); }

const instance = await startIsolated();
const geometry = (page) => page.evaluate(() => {
  const rects = ['#app', '.a-main', '.a-rail', '.a-bar', '.wrap', '.to-top', '#toast'].flatMap((selector) => {
    const element = document.querySelector(selector);
    if (!element) return [];
    const rect = element.getBoundingClientRect();
    return [{ selector, x: rect.x, width: rect.width, y: rect.y }];
  });
  return { rects, y: window.scrollY, gutter: innerWidth - document.documentElement.clientWidth };
});
const equalGeometry = (before, after, label) => {
  for (const [i, rect] of before.rects.entries()) {
    for (const key of ['x', 'width', 'y']) assert.ok(Math.abs(rect[key] - after.rects[i][key]) <= 1, `${label}: ${rect.selector} ${key} ${rect[key]} → ${after.rects[i][key]}`);
  }
};
// 等滚动真的停下再量。站点把 html{scroll-behavior:smooth} 写在样式里，本套件又爱用 scrollIntoView
// 把触发器摆到视口中央 —— 那是**一段动画**，量到中途那一帧就会被当成"弹窗把页面挪了 3px"
// （曾报 订阅源编辑打开: #app y 0 → -3）。连续 3 帧 scrollY 不变才算落定。
const settle = (page) => page.evaluate(() => new Promise((resolve) => {
  let last = -1, still = 0;
  const tick = () => {
    const y = window.scrollY;
    still = y === last ? still + 1 : 0;
    last = y;
    if (still >= 3) resolve(); else requestAnimationFrame(tick);
  };
  tick();
}));
async function checkDialog(page, label, open, selector, close = () => page.keyboard.press('Escape')) {
  await settle(page);
  const before = await geometry(page);
  await open(); await page.locator(selector).waitFor();
  const during = await geometry(page);
  equalGeometry(before, during, label + '打开');
  assert.equal(await page.evaluate(() => Number.parseFloat(document.documentElement.style.getPropertyValue('--modal-lock-pad'))), before.gutter, label + '补偿当前滚动条');
  await close();
  await page.waitForFunction(() => !document.querySelector('dialog[open]') && !document.documentElement.classList.contains('modal-open'));
  await settle(page);
  const after = await geometry(page);
  equalGeometry(before, after, label + '关闭');
  assert.ok(Math.abs(after.y - before.y) <= 1, label + '恢复原滚动位置');
}
async function lengthen(page) {
  // 模拟加载后内容变长：缓存宽度来不及更新时也必须在打开前重新测量。
  await page.evaluate(() => {
    const spacer = document.createElement('div'); spacer.style.height = '1800px'; spacer.setAttribute('aria-hidden', 'true'); document.querySelector('.a-main').append(spacer);
  });
}
let browser;
try {
  for (const mode of ['classic-light', 'classic-dark', 'overlay', 'touch']) {
    browser = await launchBrowser({ headless: true, ...(mode.startsWith('classic') ? { ignoreDefaultArgs: ['--hide-scrollbars'] } : {}) });
    const context = await browser.newContext({ viewport: mode === 'touch' ? { width: 390, height: 844 } : { width: 1280, height: 900 }, colorScheme: mode === 'classic-dark' ? 'dark' : 'light', isMobile: mode === 'touch', hasTouch: mode === 'touch' });
    // 每个新文档都要关掉平滑滚动与动画：本套件在多个页面之间跳，一次性 addStyleTag 只覆盖第一次加载的
    // 那张文档，后面的页面又会回到站点默认的 html{scroll-behavior:smooth} —— 那正是"背景位移 3px"的来源。
    await context.addInitScript(() => {
      // init 脚本跑在文档刚创建时：documentElement / head 可能还没生出来，两趟都试（立即 + DOMContentLoaded）。
      const apply = () => {
        if (document.documentElement) document.documentElement.style.setProperty('scroll-behavior', 'auto', 'important');
        if (!document.head) return;
        const style = document.createElement('style');
        style.textContent = '*,*::before,*::after{animation:none!important;transition:none!important}';
        document.head.appendChild(style);
      };
      if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', apply, { once: true });
      apply();
    });
    const page = await context.newPage();
    const errors = []; page.on('pageerror', (error) => errors.push(error.message));
    await loginAdminPage(page, instance.base, instance.password);
    await page.goto(instance.base + '/admin/pages');
    if (mode.startsWith('classic')) assert.equal((await geometry(page)).gutter, 0, '先进入无滚动条的短页面');
    // 手机内容页的「写页面」收进右下角悬浮按钮（页头动作在 App 壳下隐藏）。
    const newPage = mode === 'touch' ? '.a-fab[href^="/admin/new"]' : 'a.a-btn[href^="/admin/new"]';
    await page.locator(newPage).click(); await page.waitForURL('**/admin/new?kind=page');
    if (mode.startsWith('classic')) assert.ok((await geometry(page)).gutter > 0, '编辑器必须有实际占位的滚动条，避免漏测');
    await page.evaluate(() => window.scrollTo(0, 120));
    await checkDialog(page, '媒体选择器', () => page.locator('#a-upload-btn').click(), '#a-picker[open]');
    await page.goto(instance.base + '/admin/media'); await lengthen(page);
    await checkDialog(page, '删除确认', () => page.locator('[data-modal-title]').click(), '#a-modal[open]');
    await checkDialog(page, '复制失败提示', () => page.evaluate(() => {
      // 复制降级与 Clipboard API 都在 ui.js：要走到「失败提示」这个弹窗，两条路径都得断掉。
      navigator.clipboard.writeText = async () => { throw new Error('clipboard unavailable'); };
      document.execCommand = () => false;
      document.querySelector('[data-copy]').click();
    }), '.ui-dialog[open]');
    await checkDialog(page, '引用详情', () => page.locator('.a-media-reference').click(), '#a-media-dialog[open] .a-media-detail');
    // 在详情中再打开原图；关闭第二层时第一层仍应保持同一份滚动锁。
    await page.locator('.a-media-reference').click(); await page.locator('.a-media-detail').waitFor();
    const nestedBefore = await geometry(page);
    const nestedPad = await page.evaluate(() => document.documentElement.style.getPropertyValue('--modal-lock-pad'));
    await page.locator('[data-media-original]').click(); await page.locator('.a-media-lightbox[open]').waitFor();
    equalGeometry(nestedBefore, await geometry(page), '嵌套原图打开');
    assert.equal(await page.evaluate(() => document.documentElement.style.getPropertyValue('--modal-lock-pad')), nestedPad, '嵌套弹窗不得重复补偿');
    await page.keyboard.press('Escape'); await page.waitForFunction(() => !document.querySelector('.a-media-lightbox[open]'));
    assert.equal(await page.evaluate(() => document.documentElement.classList.contains('modal-open')), true);
    equalGeometry(nestedBefore, await geometry(page), '嵌套原图关闭');
    await page.keyboard.press('Escape'); await page.waitForFunction(() => !document.documentElement.classList.contains('modal-open'));
    await page.goto(instance.base + '/admin/feeds'); await lengthen(page);
    // 放到视口中央再量：停在贴底位置时 Playwright 的 click 会先自动滚一下，那是测试动作不是页面位移。
    await page.locator('[data-feed-open]').evaluate((el) => el.scrollIntoView({ block: 'center' }));
    // 用元素自身的 click：Playwright 的 click 会为了"可操作性"再滚一次，把测试要量的页面位移污染成 130px。
    await checkDialog(page, '订阅源编辑', () => page.locator('[data-feed-open]').evaluate((el) => el.click()), '.a-feed-editor[open]');
    await page.goto(instance.base + '/admin/new');
    await page.route('**/admin/api/autosave', (route) => route.abort());
    await page.fill('#f-title', '未保存内容');
    // 手机编辑页不挂底栏，用页头的「内容列表」离开；桌面仍从左侧轨直接换区。
    const leaveEditor = mode === 'touch' ? '.a-head .a-back' : '.a-rail-nav a[href="/admin/comments"]';
    await page.locator(leaveEditor).scrollIntoViewIfNeeded();
    await checkDialog(page, '离开编辑确认', () => page.locator(leaveEditor).click(), '.ui-dialog[open]');
    await page.goto(instance.base + '/p/why-single-column/');
    const image = page.locator('[data-lightbox]').first(); await image.scrollIntoViewIfNeeded();
    await page.evaluate(() => window.__toast('背景提示位置检查'));
    await page.waitForTimeout(300);
    await checkDialog(page, '前台图片灯箱', () => image.click(), '#lightbox[open]');
    assert.deepEqual(errors, []);
    console.log(`✓ ${mode}：媒体选择器、删除确认、复制提示、引用详情、嵌套原图、订阅源编辑、离开确认和前台灯箱均无背景位移`);
    await browser.close(); browser = null;
  }
} finally { if (browser) await browser.close(); await instance.stop(); }

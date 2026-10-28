import { launchBrowser, loginAdminPage } from './_browser.mjs';
import './_test-env.mjs';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { startIsolated } from './ui-audit.mjs';

// 先建独立夹具，再取其副本，测试不依赖用户是否已经配置订阅源。
const fixtureDb = new DatabaseSync(process.env.DB_FILE);
let fixturePostId;
try {
  fixtureDb.prepare("INSERT INTO feeds(url,title,sort_order,enabled,created_at) VALUES(?,?,0,0,?)")
    .run('https://example.invalid/ui-fixture.xml', '弹窗测试订阅源', new Date().toISOString());
  const post = fixtureDb.prepare('SELECT id,title,body_md FROM posts WHERE kind = ? LIMIT 1').get('post');
  fixturePostId = post.id;
  fixtureDb.prepare('INSERT INTO revisions(post_id,title,body_md,note,created_at) VALUES(?,?,?,?,?)')
    .run(post.id, post.title, post.body_md, 'ui-fixture', new Date().toISOString());
} finally { fixtureDb.close(); }
const instance = await startIsolated();
let browser;
try {
  browser = await launchBrowser({ headless: true });
  const page = await browser.newPage({ viewport: { width: 390, height: 844 } });
  const errors = [];
  page.on('pageerror', (error) => errors.push(error.message));
  await loginAdminPage(page, instance.base, instance.password);

  await page.goto(instance.base + '/admin/feeds');
  const opener = page.locator('[data-feed-open]').first();
  assert.equal(await opener.count(), 1, '副本需要有订阅源，以覆盖真实编辑弹窗');
  await opener.click();
  const feed = page.locator('.a-feed-editor[open]');
  for (let i = 0; i < 18; i++) {
    await page.keyboard.press('Tab');
    assert.equal(await page.evaluate(() => Boolean(document.activeElement.closest('.a-feed-editor[open]'))), true, 'Tab 不应进入背景页面');
  }
  for (let i = 0; i < 12; i++) {
    await page.keyboard.press('Shift+Tab');
    assert.equal(await page.evaluate(() => Boolean(document.activeElement.closest('.a-feed-editor[open]'))), true);
  }
  const title = feed.locator('[name=title]'); const before = await title.inputValue();
  await title.fill('未保存的修改');
  await page.keyboard.press('Escape');
  await page.locator('.ui-dialog[open]').waitFor();
  await page.locator('.ui-dialog[open] [value=cancel]').click();
  assert.equal(await feed.count(), 1, '取消放弃应保留编辑弹窗');
  assert.equal(await title.inputValue(), '未保存的修改');
  await page.keyboard.press('Escape');
  await page.locator('.ui-dialog[open] [value=ok]').click();
  await page.waitForFunction(() => !document.querySelector('.a-feed-editor[open]'));
  assert.equal(await opener.evaluate((el) => document.activeElement === el), true, '关闭后焦点回入口');
  await opener.click();
  assert.equal(await page.locator('.a-feed-editor[open] [name=title]').inputValue(), before, '放弃后恢复原值');
  // 入场动画 a-pop 会把整个弹窗从 scale(.985) 放大到 1，44px 的按钮在动画途中只有 43.3px。
  // 固定等 300ms 在慢机器上偶尔仍量到动画中途（CI 上就这样假失败过），直接等动画播完。
  await page.locator('.a-feed-editor[open]').evaluate((el) =>
    Promise.all(el.getAnimations({ subtree: true }).map((a) => a.finished)));
  const closeBox = await page.locator('.a-feed-editor[open] [data-feed-close]').first().boundingBox();
  assert.ok(closeBox.width >= 44 && closeBox.height >= 44,
    `移动关闭键至少 44px（实际 ${closeBox.width}×${closeBox.height}）`);
  await page.keyboard.press('Escape');
  console.log('✓ 模态焦点、未保存改动确认、取消/放弃、焦点返回与移动点击尺寸');

  await page.goto(instance.base + '/admin/edit/' + fixturePostId);
  await page.locator('summary').filter({ hasText: '修订历史' }).click();
  let restores = 0;
  await page.route('**/admin/restore/*', async (route) => { restores++; await route.abort(); });
  await page.getByRole('button', { name: '恢复此版本', exact: true }).click();
  await page.locator('#a-modal[open]').waitFor();
  assert.match(await page.locator('#a-modal-note').innerText(), /标题和正文/);
  await page.locator('[data-modal-cancel]').click();
  assert.equal(restores, 0, '取消历史版本恢复不应发送写请求');
  console.log('✓ 历史版本恢复确认与取消无写入');

  await page.goto(instance.base + '/admin/new');
  let requests = 0;
  await page.route('**/admin/api/media?*', async (route) => {
    const n = ++requests;
    if (n === 1) { await route.fulfill({ status: 500, json: { ok: false } }); return; }
    await new Promise((resolve) => setTimeout(resolve, n === 2 ? 500 : 20));
    await route.fulfill({ json: { ok: true, items: [{ path: '/test.png', filename: n === 2 ? '旧结果.png' : '新结果.png', width: 1, height: 1 }], hasMore: false } }).catch(() => {});
  });
  await page.click('#a-upload-btn');
  await page.getByRole('button', { name: '重试', exact: true }).waitFor();
  await page.getByRole('button', { name: '重试', exact: true }).click();
  await page.waitForFunction(() => document.querySelector('#a-picker-body').textContent.includes('正在读取'));
  await page.keyboard.press('Escape');
  await page.click('#a-upload-btn');
  await page.locator('.a-picker-item').waitFor();
  await page.waitForTimeout(600);
  assert.match(await page.locator('#a-picker-body').innerText(), /新结果/);
  assert.doesNotMatch(await page.locator('#a-picker-body').innerText(), /旧结果/);
  await page.keyboard.press('Escape');
  await page.unroute('**/admin/api/media?*');
  console.log('✓ 媒体读取失败重试、关闭取消、再次打开不会被迟到响应覆盖');

  let posts = 0; let sentAction = '';
  await page.route('**/admin/__ui-submit-test', async (route) => {
    posts++; sentAction = route.request().postData();
    await new Promise((resolve) => setTimeout(resolve, 150));
    if (posts === 1) await route.fulfill({ status: 400, json: { error: '测试失败' } });
    else if (posts === 2) await route.fulfill({ status: 500, contentType: 'text/html', body: '<h1>服务器错误</h1>' });
    else await route.abort('failed');
  });
  const result = await page.evaluate(async () => {
    const form = document.createElement('form'); form.method = 'post'; form.action = '/admin/__ui-submit-test';
    form.innerHTML = '<input name="body" value="保留输入"><button name="action" value="save"><svg></svg>保存</button><button name="action" value="publish">发布</button>';
    document.querySelector('#app').append(form);
    const button = form.querySelector('button'); const html = button.innerHTML;
    const pending = window.__nav.submitForm(form, button);
    const disabled = [...form.querySelectorAll('button')].every((el) => el.disabled);
    const duplicate = await window.__nav.submitForm(form, form.querySelectorAll('button')[1]);
    await pending;
    const httpError = await window.__nav.submitForm(form, button);
    const networkError = await window.__nav.submitForm(form, button);
    return { disabled, duplicate: duplicate.busy, restored: button.innerHTML === html, busy: form.getAttribute('aria-busy'), value: form.elements.body.value, enabled: [...form.querySelectorAll('button')].every((el) => !el.disabled), connected: form.isConnected, httpError: httpError.status, networkError: networkError.ok };
  });
  assert.equal(posts, 3, '三次显式尝试不应产生重复提交或网络失败自动重放'); assert.match(sentAction, /save/);
  assert.deepEqual(result, { disabled: true, duplicate: true, restored: true, busy: null, value: '保留输入', enabled: true, connected: true, httpError: 500, networkError: false });
  console.log('✓ 同表单提交互斥、动作值保留、HTTP/网络失败恢复且不重放、按钮图标恢复');

  await page.evaluate(() => {
    // 复制有两条路（见 ui.js 的 copyText）：Clipboard API → execCommand 兜底。两条都失败才该弹「手动复制」。
    // 只打桩 Clipboard 的话，headless 里 execCommand('copy') 会返回 true，弹窗根本不会出现。
    navigator.clipboard.writeText = async () => { throw new Error('clipboard unavailable'); };
    document.execCommand = () => false;
    const button = document.createElement('button'); button.type = 'button'; button.dataset.copy = '/uploads/test.png'; button.textContent = '复制';
    document.body.append(button); button.click();
  });
  assert.equal(await page.locator('.ui-copy-value').inputValue(), '/uploads/test.png');
  await page.getByRole('button', { name: '关闭', exact: true }).click();
  assert.equal(await page.locator('.ui-dialog[open]').count(), 0);

  await page.fill('#f-title', '测试离开提示');
  // 手机编辑页没有底栏，用页头的「内容列表」离开。
  await page.click('.a-head .a-back');
  await page.locator('.ui-dialog[open]').waitFor();
  await page.locator('.ui-dialog[open] [value=cancel]').click();
  assert.equal(new URL(page.url()).pathname, '/admin/new');
  await page.click('.a-head .a-back');
  await page.locator('.ui-dialog[open] [value=ok]').click();
  await page.waitForURL('**/admin');
  assert.equal(await page.locator('#editorForm').count(), 0);
  const danger = page.locator('[data-modal-title]').first();
  if (await danger.count()) {
    await danger.click();
    assert.match(await page.locator('#a-modal').getAttribute('aria-describedby'), /a-modal-body/);
    await page.keyboard.press('Escape');
    assert.equal(await danger.evaluate((el) => el === document.activeElement), true);
  }
  console.log('✓ 站内复制弹窗、异步离开确认、确认框描述与焦点返回');

  await page.goto(instance.base + '/p/why-single-column/');
  let imageRequests = 0;
  const pixel = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aD1sAAAAASUVORK5CYII=', 'base64');
  await page.route('**/__ui-image-one', async (route) => {
    imageRequests++;
    await route.fulfill(imageRequests === 1 ? { status: 404, body: 'missing' } : { contentType: 'image/png', body: pixel });
  });
  await page.route('**/__ui-image-two', async (route) => { await new Promise((resolve) => setTimeout(resolve, 300)); await route.fulfill({ status: 404, body: 'missing' }).catch(() => {}); });
  await page.evaluate(() => {
    for (const [i, src] of ['/__ui-image-one', '/__ui-image-two'].entries()) {
      const button = document.createElement('button'); button.type = 'button'; button.dataset.lightbox = 'ui-test'; button.dataset.full = src; button.dataset.alt = '测试图片' + i; button.textContent = '测试图片' + i;
      document.body.append(button);
    }
  });
  await page.getByRole('button', { name: '测试图片0', exact: true }).click();
  await page.locator('.lb-retry:not([hidden])').waitFor();
  assert.match(await page.locator('.lb-feedback [role=status]').innerText(), /加载失败/);
  await page.getByRole('button', { name: '重试', exact: true }).click();
  await page.waitForFunction(() => { const img = document.querySelector('#lightbox .lb-img'); return !img.hidden && img.naturalWidth > 0; });
  await page.keyboard.press('ArrowRight');
  await page.keyboard.press('ArrowLeft');
  await page.waitForTimeout(400);
  assert.equal(await page.locator('.lb-feedback [role=status]').innerText(), '');
  assert.equal(await page.locator('#lightbox .lb-img').getAttribute('alt'), '测试图片0');
  await page.keyboard.press('Escape');
  assert.equal(await page.evaluate(() => document.documentElement.classList.contains('modal-open')), false);
  assert.equal(await page.locator('#lightbox .lb-img').getAttribute('src'), null);
  console.log('✓ 灯箱加载失败、重试、快速切图过期保护、关闭清理与滚动解锁');
  assert.deepEqual(errors, [], '浏览器不应出现未捕获脚本异常');
} finally {
  if (browser) await browser.close();
  await instance.stop();
}

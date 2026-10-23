import { launchBrowser, loginAdminPage } from './_browser.mjs';
import './_test-env.mjs';
import assert from 'node:assert/strict';
import sharp from 'sharp';
import { startServer } from './_server.mjs';

const server = await startServer();
let browser;
try {
  browser = await launchBrowser();
  const bytes = await sharp({ create: { width: 1200, height: 800, channels: 3, background: '#64748b' } }).png().toBuffer();
  const mount = async (page) => {
    await page.route('**/__lightbox-*', (route) => route.fulfill({ contentType: 'image/png', body: bytes }));
    await page.goto(server.base + '/posts/');
    await page.evaluate(() => {
      for (let i = 0; i < 3; i++) {
        const button = document.createElement('button'); button.textContent = `照片 ${i}`;
        button.dataset.lightbox = 'gesture-test'; button.dataset.full = `/__lightbox-${i}`;
        button.dataset.alt = `照片 ${i}`; document.body.append(button);
      }
    });
    await page.getByRole('button', { name: '照片 0', exact: true }).click();
    await page.locator('#lightbox .lb-zoom:not([disabled])').waitFor();
  };
  const imageState = (page) => page.locator('#lightbox .lb-img').evaluate((img) => ({ transform: img.style.transform, zoomed: img.classList.contains('is-zoomed') }));
  const count = (page) => page.locator('#lightbox .lb-count').innerText();
  const desktop = await browser.newPage({ viewport: { width: 1440, height: 1000 } });
  await mount(desktop);
  await desktop.getByRole('button', { name: '放大图片', exact: true }).click();
  assert.equal((await imageState(desktop)).zoomed, true);
  const rect = await desktop.locator('#lightbox .lb-img').boundingBox();
  await desktop.mouse.move(rect.x + rect.width / 2, rect.y + rect.height / 2);
  await desktop.mouse.down(); await desktop.mouse.move(rect.x + rect.width / 2 + 120, rect.y + rect.height / 2 + 60, { steps: 8 }); await desktop.mouse.up();
  assert.match((await imageState(desktop)).transform, /translate\(120px, 60px\)/);
  assert.equal(await count(desktop), '1 / 3');
  await desktop.keyboard.press('0'); assert.equal((await imageState(desktop)).zoomed, false);
  await desktop.mouse.wheel(0, -300);
  await desktop.waitForFunction(() => document.querySelector('#lightbox .lb-img').classList.contains('is-zoomed'));
  await desktop.keyboard.press('ArrowRight');
  await desktop.locator('#lightbox .lb-zoom:not([disabled])').waitFor();
  assert.deepEqual(await imageState(desktop), { transform: '', zoomed: false });
  assert.equal(await count(desktop), '2 / 3');
  await desktop.keyboard.press('Escape');
  await desktop.getByRole('button', { name: '照片 0', exact: true }).click();
  await desktop.locator('#lightbox .lb-zoom:not([disabled])').waitFor();
  assert.equal((await imageState(desktop)).zoomed, false);
  await desktop.locator('#lightbox .lb-img').click(); assert.equal((await imageState(desktop)).zoomed, true);
  await desktop.keyboard.press('Escape');
  console.log('✓ 桌面点击放大、拖动、滚轮、键盘还原、切图与关闭后重置');

  {
    // 灯箱视频：打开后 <video> 接管显示、图片让位；切条保持同组；关闭时停播并清掉 src。
    const vp = await browser.newPage({ viewport: { width: 1280, height: 900 } });
    const errs = []; vp.on('pageerror', (e) => errs.push(e.message));
    await vp.route('**/__clip.webm', (route) => route.fulfill({ status: 200, contentType: 'video/webm', body: Buffer.alloc(0) }));
    await vp.goto(server.base + '/posts/');
    await vp.evaluate(() => {
      for (let i = 0; i < 2; i++) {
        const v = document.createElement('video');
        v.dataset.lightbox = 'vid'; v.dataset.media = 'video'; v.dataset.full = '/__clip.webm';
        v.dataset.alt = `视频 ${i}`; v.dataset.w = '640'; v.dataset.h = '360';
        v.setAttribute('role', 'button'); v.tabIndex = 0;
        v.style.cssText = 'width:100px;height:56px;background:#000'; v.muted = true;
        document.body.append(v);
      }
    });
    await vp.locator('video[data-lightbox="vid"]').first().click();
    await vp.locator('#lightbox .lb-video').waitFor({ state: 'attached' });
    await vp.waitForFunction(() => document.querySelector('#lightbox .lb-video').hidden === false);
    assert.equal(await vp.locator('#lightbox .lb-img').evaluate((el) => el.hidden), true);
    assert.equal(await vp.locator('#lightbox .lb-video').getAttribute('src'), '/__clip.webm');
    assert.equal(await vp.locator('#lightbox .lb-video').getAttribute('aria-label'), '视频 0');
    assert.equal(await count(vp), '1 / 2');
    await vp.keyboard.press('ArrowRight');
    assert.equal(await vp.locator('#lightbox .lb-video').getAttribute('src'), '/__clip.webm');
    assert.equal(await count(vp), '2 / 2');
    await vp.keyboard.press('Escape');
    await vp.waitForTimeout(80);
    assert.equal(await vp.locator('#lightbox .lb-video').evaluate((v) => v.hidden), true);
    assert.equal(await vp.locator('#lightbox .lb-video').evaluate((v) => v.getAttribute('src')), null);
    assert.deepEqual(errs, []);
    console.log('✓ 灯箱视频：打开、切条、关闭后停播并清源');
  }

  const mobile = await browser.newPage({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true });
  const errors = []; mobile.on('pageerror', (error) => errors.push(error.message));
  await mount(mobile);
  const cdp = await mobile.context().newCDPSession(mobile);
  const touch = (type, points) => cdp.send('Input.dispatchTouchEvent', { type, touchPoints: points.map(([id, x, y]) => ({ id, x, y })) });
  const swipe = async (dx, dy = 0) => {
    const box = await mobile.locator('#lightbox .lb-img').boundingBox();
    const x = box.x + box.width / 2, y = box.y + box.height / 2;
    await touch('touchStart', [[1, x, y]]);
    for (let step = 1; step <= 6; step++) await touch('touchMove', [[1, x + dx * step / 6, y + dy * step / 6]]);
    await touch('touchEnd', []);
  };
  await swipe(-120);
  await mobile.waitForFunction(() => document.querySelector('#lightbox .lb-count').textContent === '2 / 3');
  await mobile.locator('#lightbox .lb-zoom:not([disabled])').waitFor();
  await swipe(120); assert.equal(await count(mobile), '1 / 3');
  await mobile.locator('#lightbox .lb-zoom:not([disabled])').waitFor();
  // 循环切换放在双指缩放之前测：缩放结束后浏览器可能还留着上一段触摸的手势状态，
  // 再用 CDP 发 swipe 会偶发被并进旧手势（Linux CI 实测）。这里先覆盖 1 → 3 → 1 的边界。
  await swipe(120);
  await mobile.waitForFunction(() => document.querySelector('#lightbox .lb-count').textContent === '3 / 3');
  await mobile.locator('#lightbox .lb-img').waitFor({ state: 'visible' });
  await mobile.locator('#lightbox .lb-zoom:not([disabled])').waitFor();
  await swipe(-120);
  await mobile.waitForFunction(() => document.querySelector('#lightbox .lb-count').textContent === '1 / 3');
  await mobile.locator('#lightbox .lb-img').waitFor({ state: 'visible' });
  await mobile.locator('#lightbox .lb-zoom:not([disabled])').waitFor();
  await swipe(10, 80); assert.equal(await count(mobile), '1 / 3');
  const box = await mobile.locator('#lightbox .lb-img').boundingBox();
  const cx = box.x + box.width / 2, cy = box.y + box.height / 2;
  await touch('touchStart', [[1, cx - 30, cy], [2, cx + 30, cy]]);
  await touch('touchMove', [[1, cx - 75, cy], [2, cx + 75, cy]]);
  await touch('touchEnd', []);
  assert.equal((await imageState(mobile)).zoomed, true);
  await swipe(-80); assert.equal(await count(mobile), '1 / 3');
  assert.equal((await imageState(mobile)).zoomed, true);
  // 还原按钮用 click 而不是 tap：tap 会留下一次触摸手势状态，紧接着用 CDP 发下一段 swipe 时，
  // Linux/CI 上偶发把新触摸并进上一段手势。滑动本身仍在前面的用例里走真实 touch 事件。
  await mobile.getByRole('button', { name: '还原图片大小', exact: true }).click();
  await mobile.waitForFunction(() => !document.querySelector('#lightbox .lb-img').classList.contains('is-zoomed'));
  await mobile.waitForTimeout(400);
  assert.equal(await count(mobile), '1 / 3');
  await mobile.locator('[data-lb-close]').tap();
  await mobile.waitForFunction(() => !document.querySelector('#lightbox').open && !document.documentElement.classList.contains('modal-open'));
  assert.equal(await mobile.evaluate(() => document.documentElement.classList.contains('modal-open')), false);
  assert.deepEqual(errors, []);
  console.log('✓ 手机真实触摸左右切图、循环切换、纵向不误切、双指缩放、放大后拖动与关闭解锁');

  await loginAdminPage(desktop, server.base, process.env.ADMIN_PASSWORD);
  await desktop.evaluate(() => {
    const link = document.createElement('a'); link.href = '/__lightbox-admin'; link.dataset.mediaOriginal = ''; link.textContent = '测试原图'; document.body.append(link);
  });
  await desktop.getByRole('link', { name: '测试原图' }).click();
  await desktop.locator('.a-media-lightbox .lb-zoom:not([disabled])').waitFor();
  await desktop.getByRole('button', { name: '放大图片', exact: true }).click();
  assert.equal(await desktop.locator('.a-media-lightbox .lb-img').evaluate((img) => img.classList.contains('is-zoomed')), true);
  await desktop.keyboard.press('Escape');
  console.log('✓ 后台动态原图灯箱共用放大功能');
} finally { await browser?.close(); await server.stop(); }

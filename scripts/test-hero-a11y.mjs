import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import sharp from 'sharp';
import { launchBrowser } from './_browser.mjs';
import { createFixtures } from './_fixtures.mjs';
import { startServer } from './_server.mjs';
import { normalizeImage } from '../src/media/image.js';
import { variantFile, thumbnailFile, serializeVariants } from '../src/media/variants.js';

// 首页轮播的无障碍：换张时不能给「仍持有焦点」的封面加 aria-hidden（Chrome 会拦截并报警，读屏也会突然失焦）。
// 两条都要守住：① 换张前把焦点让给新的当前张；② 灯箱开着时不许自动轮播推进，否则关灯箱会把焦点还原给
// 已标 aria-hidden 的那张（真实用户路径：开灯箱 → 在灯箱里停留/放大 → 关灯箱）。
const fixtures = await createFixtures();
let server, browser;
try {
  const { open, close } = await import('../db/driver.js');
  const { createAdminRepo } = await import('../db/admin.js');
  const { createRepo } = await import('../db/repo.js');
  const db = open(fixtures.env.DB_FILE), admin = createAdminRepo(db), repo = createRepo(db);
  const paths = ['/uploads/hero-a.png', '/uploads/hero-b.png'];
  const entries = [];
  for (const [i, source] of paths.entries()) {
    const absolute = path.join(fixtures.env.UPLOADS_DIR, path.basename(source));
    const input = await sharp({ create: { width: 800, height: 600, channels: 3, background: i ? '#2f5a86' : '#926922' } }).png().toBuffer();
    const result = await normalizeImage(input);
    fs.writeFileSync(absolute, result.buffer);
    fs.writeFileSync(thumbnailFile(absolute), result.thumbnail);
    for (const v of result.variants) fs.writeFileSync(variantFile(absolute, v.width), v.data);
    admin.mediaAdd({ path: source, width: result.width, height: result.height, mime: 'image/png', animated: 0,
      thumbnail: thumbnailFile(source),
      variants: serializeVariants(result.variants.map((v) => ({ w: v.width, path: variantFile(source, v.width) })))});
    entries.push({ path: source, w: result.width, h: result.height });
  }
  repo.setSetting('hero_images', JSON.stringify(entries));
  close(db);

  server = await startServer({ env: fixtures.env });
  browser = await launchBrowser({ headless: true });
  const page = await browser.newPage({ viewport: { width: 1200, height: 800 } });
  const warnings = [];
  page.on('console', (message) => { if (/aria-hidden/.test(message.text())) warnings.push(message.text()); });
  await page.goto(server.base + '/', { waitUntil: 'networkidle' });
  assert.equal(await page.locator('.hero-slide').count(), 2, '需要两张首页图才会渲染轮播');

  // 非当前张在服务端只发 240w 占位图：直接查 HTML，避免脚本的空闲预取先把 data-src 消掉。
  const homeHtml = await (await fetch(server.base + '/')).text();
  assert.match(homeHtml, /class="hero-slide" src="[^"]*\.v4-w240\.webp" data-src="[^"]*\.v4-w\d+\.webp"/,
    '第二张封面应延迟到 data-src，而不是直接下正式尺寸');

  // ① 焦点停在封面上时自动切张：焦点应让给新的当前张，而不是留在被 aria-hidden 的那张上。
  // 圆点已删，切换只由自动轮播推进：开一次灯箱再关（焦点回到封面），鼠标移开后轮播重启，
  // 等下一轮推进时断言焦点交接。
  await page.locator('.hero-slide.is-active').click();
  await page.locator('#lightbox[open]').waitFor();
  await page.locator('#lightbox [data-lb-close]').click();
  await page.mouse.move(10, 10);
  await page.waitForFunction(() => document.querySelectorAll('.hero-slide')[1].classList.contains('is-active'), null, { timeout: 9000 });
  assert.match(await page.locator('.hero-slide').nth(1).getAttribute('srcset') ?? '', /\.v4-w480\.webp 480w/,
    '切到第二张时应把占位图升级成正式 srcset');
  const swapped = await page.evaluate(() => ({
    isActiveSlide: document.activeElement === document.querySelector('.hero-slide.is-active'),
    inHiddenSubtree: Boolean(document.activeElement?.closest('[aria-hidden="true"]')),
  }));
  assert.equal(swapped.inHiddenSubtree, false, '换张后焦点不得处在 aria-hidden 子树里');
  assert.equal(swapped.isActiveSlide, true, '被换下的那张要把焦点交给新的当前张');
  // 封面文字已下线：页面上不该再有 .hero-copy（旧的断言一并撤掉）。
  assert.equal(await page.locator('.hero-copy').count(), 0, '首页不该再渲染封面文字层');

  // ② 开灯箱后等超过一个自动轮播周期：灯箱开着时不许推进（否则关灯箱会把焦点还给已隐藏的封面）。
  const before = await page.locator('.hero-slide.is-active').evaluate((el) => el.getAttribute('data-full'));
  const active = page.locator('.hero-slide.is-active');
  await active.hover();
  await active.click();
  await page.locator('#lightbox[open]').waitFor();
  await page.waitForTimeout(6000);
  const during = await page.locator('.hero-slide.is-active').evaluate((el) => el.getAttribute('data-full'));
  assert.equal(during, before, '灯箱开着时轮播不应推进');
  await page.locator('#lightbox [data-lb-close]').click();
  await page.waitForTimeout(200);
  const afterClose = await page.evaluate(() => ({
    inHiddenSubtree: Boolean(document.activeElement?.closest('[aria-hidden="true"]')),
    onHeroSlide: document.activeElement?.classList.contains('hero-slide') === true,
  }));
  assert.equal(afterClose.inHiddenSubtree, false, '关灯箱后焦点不得落在 aria-hidden 子树里');
  assert.equal(afterClose.onHeroSlide, true, '关灯箱后焦点应回到封面');
  assert.deepEqual(warnings, [], `不应触发 aria-hidden 焦点告警：${warnings.join(' | ')}`);

  await page.close();
  console.log('✓ 轮播换张/开关灯箱都不会把焦点留在 aria-hidden 的封面上');
} finally {
  if (browser) await browser.close();
  if (server) await server.stop();
  fixtures.cleanup();
}

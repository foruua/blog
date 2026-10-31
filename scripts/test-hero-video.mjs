import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import ffmpegStatic from 'ffmpeg-static';
import sharp from 'sharp';
import { launchBrowser, loginAdminPage } from './_browser.mjs';
import { createFixtures } from './_fixtures.mjs';
import { startServer } from './_server.mjs';
import { normalizeImage } from '../src/media/image.js';
import { transcodeHeroVideo } from '../src/media/transcode.js';
import { variantFile, thumbnailFile, serializeVariants } from '../src/media/variants.js';

// 首页封面视频：静音自动循环、点击进灯箱、轮播按视频时长推进、被策略拦截时仍保持版式。
const fixtures = await createFixtures();
let server, browser;
const tempVideo = path.join(os.tmpdir(), `blog-hero-video-${process.pid}.mp4`);
try {
  const { open, close } = await import('../db/driver.js');
  const { createAdminRepo } = await import('../db/admin.js');
  const { createRepo } = await import('../db/repo.js');
  const db = open(fixtures.env.DB_FILE), admin = createAdminRepo(db), repo = createRepo(db);

  execFileSync(ffmpegStatic, [
    '-hide_banner', '-loglevel', 'error', '-y', '-f', 'lavfi',
    '-i', 'testsrc2=size=640x360:rate=24:duration=2', '-c:v', 'libx264', '-pix_fmt', 'yuv420p', tempVideo,
  ], { stdio: 'ignore' });
  const encoded = await transcodeHeroVideo(tempVideo);
  const videoPath = '/uploads/hero-cover.mp4';
  const posterPath = `${videoPath}.poster.webp`;
  fs.writeFileSync(path.join(fixtures.env.UPLOADS_DIR, 'hero-cover.mp4'), encoded.buffer);
  fs.writeFileSync(path.join(fixtures.env.UPLOADS_DIR, 'hero-cover.mp4.poster.webp'), encoded.poster);
  admin.mediaAdd({
    path: videoPath, width: encoded.width, height: encoded.height, bytes: encoded.buffer.length,
    mime: 'video/mp4', hash: 'hero-video-test', filename: 'hero-cover.mp4',
    thumbnail: posterPath, variants: null, animated: 0,
  });

  const imagePath = '/uploads/hero-still.png';
  const imageAbs = path.join(fixtures.env.UPLOADS_DIR, 'hero-still.png');
  const image = await normalizeImage(await sharp({ create: { width: 800, height: 600, channels: 3, background: '#2f5a86' } }).png().toBuffer());
  fs.writeFileSync(imageAbs, image.buffer);
  fs.writeFileSync(thumbnailFile(imageAbs), image.thumbnail);
  for (const v of image.variants) fs.writeFileSync(variantFile(imageAbs, v.width), v.data);
  admin.mediaAdd({
    path: imagePath, width: image.width, height: image.height, mime: 'image/png',
    thumbnail: thumbnailFile(imagePath),
    variants: serializeVariants(image.variants.map((v) => ({ w: v.width, path: variantFile(imagePath, v.width) }))),
  });

  repo.setSetting('hero_images', JSON.stringify([
    { path: videoPath, w: encoded.width, h: encoded.height },
    { path: imagePath, w: image.width, h: image.height },
  ]));
  close(db);

  server = await startServer({ env: fixtures.env });
  const homeHtml = await (await fetch(server.base + '/')).text();
  assert.match(homeHtml, /<link rel="preload" as="image" href="[^"]*hero-cover\.mp4\.poster\.webp"/,
    '视频封面应预载首帧海报，而不是整段 MP4');
  assert.match(homeHtml, /class="hero-video"[^>]*muted[^>]*playsinline/, '封面视频必须静音 + playsinline');
  assert.match(homeHtml, /class="hero-video"[^>]*data-media="video"[^>]*data-full="\/uploads\/hero-cover\.mp4"/,
    '封面视频要挂灯箱标记，点击进灯箱播放');
  assert.match(homeHtml, /poster="[^"]*hero-cover\.mp4\.poster\.webp"/, '视频要带首帧海报');

  browser = await launchBrowser({ headless: true });
  const page = await browser.newPage({ viewport: { width: 1200, height: 800 } });
  await page.goto(server.base + '/', { waitUntil: 'networkidle' });
  await page.waitForFunction(() => {
    const video = document.querySelector('.hero-video');
    return video && !video.paused && video.currentTime > 0.1 && video.readyState >= 2;
  }, null, { timeout: 6000 });

  // 点击封面视频进灯箱：灯箱里用带控制条的同一个 MP4，封面视频暂停。
  await page.locator('.hero-video').click();
  await page.locator('#lightbox[open] .lb-video:not([hidden])').waitFor();
  const lbState = await page.evaluate(() => ({
    src: document.querySelector('#lightbox .lb-video').getAttribute('src'),
    controls: document.querySelector('#lightbox .lb-video').controls,
    heroPaused: document.querySelector('.hero-video').paused,
  }));
  assert.ok(lbState.src?.endsWith('/uploads/hero-cover.mp4'), `灯箱视频地址不对：${lbState.src}`);
  assert.equal(lbState.controls, true, '灯箱视频要有原生控制条');
  assert.equal(lbState.heroPaused, true, '灯箱打开后封面视频应暂停');

  await page.locator('#lightbox [data-lb-close]').click();
  await page.waitForFunction(() => !document.querySelector('#lightbox').open, null, { timeout: 2000 });
  await page.waitForFunction(() => {
    const video = document.querySelector('.hero-video');
    return video && !video.paused;
  }, null, { timeout: 3000 });

  // 视频 2 秒：轮播按视频时长推进，而不是固定 5 秒。
  const started = Date.now();
  await page.waitForFunction(() => document.querySelectorAll('.hero-slide')[1].classList.contains('is-active'), null, { timeout: 4500 });
  const elapsed = Date.now() - started;
  assert.ok(elapsed < 4500, `视频播完后应尽快切到下一张，实际 ${elapsed}ms`);
  const afterSwitch = await page.evaluate(() => {
    const video = document.querySelector('.hero-video');
    return { paused: video.paused, currentTime: video.currentTime, hidden: video.hidden };
  });
  assert.equal(afterSwitch.paused, true, '切走后视频应暂停');
  assert.ok(afterSwitch.currentTime < 0.1, '切走后视频回到开头');
  assert.equal(afterSwitch.hidden, false, '视频本身不应被误隐藏');

  // 播放器报错/卡死：彻底换回首帧海报（视频层退出合成），点击海报仍能打开灯箱播放原视频。
  const fallbackPage = await browser.newPage({ viewport: { width: 1200, height: 800 } });
  await fallbackPage.goto(server.base + '/', { waitUntil: 'networkidle' });
  await fallbackPage.waitForFunction(() => {
    const video = document.querySelector('.hero-video');
    return video && !video.paused && video.currentTime > 0.1;
  }, null, { timeout: 6000 });
  await fallbackPage.evaluate(() => {
    const video = document.querySelector('.hero-video');
    video.src = '/uploads/missing-cover.mp4';
    video.load();
  });
  await fallbackPage.locator('.hero-fallback').waitFor({ timeout: 5000 });
  const fallbackState = await fallbackPage.evaluate(() => {
    const video = document.querySelector('.hero-video');
    const fallback = document.querySelector('.hero-fallback');
    return {
      videoHidden: video.hidden,
      videoNoLightbox: !video.hasAttribute('data-lightbox'),
      fallbackVisible: !fallback.hidden && fallback.src.includes('.poster.webp'),
      fallbackFull: fallback.dataset.full,
    };
  });
  assert.equal(fallbackState.videoHidden, true, '卡死的视频应隐藏');
  assert.equal(fallbackState.videoNoLightbox, true, '隐藏的视频不能再留在灯箱组');
  assert.equal(fallbackState.fallbackVisible, true, '应显示首帧海报');
  assert.ok(fallbackState.fallbackFull?.endsWith('/uploads/hero-cover.mp4'), '海报点击仍应打开原视频');
  await fallbackPage.locator('.hero-fallback').click();
  await fallbackPage.locator('#lightbox[open] .lb-video:not([hidden])').waitFor();
  assert.ok((await fallbackPage.locator('#lightbox .lb-video').getAttribute('src'))?.endsWith('/uploads/hero-cover.mp4'),
    '海报打开灯箱后播放原视频');
  await fallbackPage.locator('#lightbox [data-lb-close]').click();
  await fallbackPage.close();

  // 自动播放被策略拦截：不重试到死，也不破坏版式；轮播按 5 秒兜底继续推进。
  // 浏览器原生的 autoplay 属性不走 JS play()，所以先停掉它再模拟「策略拒绝」，让应用自己的起播路径吃到 NotAllowedError。
  const blocked = await browser.newPage({ viewport: { width: 1200, height: 800 } });
  await blocked.goto(server.base + '/', { waitUntil: 'networkidle' });
  await blocked.evaluate(() => {
    const video = document.querySelector('.hero-video');
    video.removeAttribute('autoplay');
    video.pause();
    try { video.currentTime = 0; } catch { /* ignore */ }
    HTMLMediaElement.prototype.play = function play() {
      return Promise.reject(new DOMException('blocked', 'NotAllowedError'));
    };
  });
  await blocked.waitForTimeout(2200);
  const blockedState = await blocked.evaluate(() => {
    const video = document.querySelector('.hero-video');
    return {
      paused: video.paused,
      frozen: Boolean(document.querySelector('.hero-fallback')),
      visible: !video.hidden,
    };
  });
  assert.equal(blockedState.paused, true, '被拦下时视频应停在首帧');
  assert.equal(blockedState.frozen, false, '只是被策略拦截，不该当成播放器卡死换海报');
  assert.equal(blockedState.visible, true, '被拦下时视频元素仍在，海报通过 poster 显示');
  await blocked.waitForFunction(() => document.querySelectorAll('.hero-slide')[1].classList.contains('is-active'), null, { timeout: 8000 });
  await blocked.close();

  // 后台入口：选视频 → 上传转码 → 列表里出现带「视频」标记的缩略项。
  await loginAdminPage(page, server.base, fixtures.env.ADMIN_PASSWORD);
  await page.goto(server.base + '/admin/system', { waitUntil: 'networkidle' });
  await page.setInputFiles('#heroVideoFile', {
    name: 'admin-cover.mp4', mimeType: 'video/mp4', buffer: fs.readFileSync(tempVideo),
  });
  await page.waitForFunction(() => document.querySelector('#heroState')?.textContent.includes('已加视频'), null, { timeout: 15000 });
  assert.ok(await page.locator('#heroList .a-hero-item .a-hero-kind').count() >= 1, '后台视频缩略项应带「视频」标记');
  assert.match(await page.locator('#heroState').innerText(), /记得点保存/, '上传后应提示保存');

  await page.close();
  console.log('✓ 封面视频：自动循环、点击灯箱、按视频时长推进、被拦截时保持版式');
} finally {
  if (browser) await browser.close();
  if (server) await server.stop();
  fs.rmSync(tempVideo, { force: true });
  fixtures.cleanup();
}

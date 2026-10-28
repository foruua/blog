import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import sharp from 'sharp';
import { DatabaseSync } from 'node:sqlite';
import { normalizeImage, PREVIEW_REUSE_MAX_BYTES } from '../src/media/image.js';
import { thumbnailFile, variantFile, previewSrcsetOf, previewSourceOf, variantWidthsOf, originalPathOf, parseVariants } from '../src/media/variants.js';
import { createRenderer } from '../src/render/markdown.js';
import { withLightbox } from '../src/render/lightbox.js';
import { notesStream, splitImages } from '../src/render/notes.js';
import { createImageInfo } from '../src/media/info.js';
import { migrate } from '../db/migrate.js';

const input = await sharp({ create: { width: 1200, height: 800, channels: 3, background: 'red' } }).png().toBuffer();
const normalized = await normalizeImage(input);
assert.equal(normalized.previewReused, true);
assert.ok(normalized.previewPixelBytes <= PREVIEW_REUSE_MAX_BYTES);
assert.deepEqual(normalized.variants.map((v) => v.width), [240, 480, 640, 768, 960, 1200]);
for (const v of normalized.variants) assert.equal((await sharp(v.data).metadata()).width, v.width);
const small = await normalizeImage(await sharp(input).resize(120).toBuffer());
assert.equal(small.variants.length, 1);
assert.equal(small.variants[0].width, 120);
assert.deepEqual(variantWidthsOf(4000), [240, 480, 640, 768, 960, 1280, 1920, 2560]);
assert.equal((await sharp(small.thumbnail).metadata()).width, 120);
const rotated = await normalizeImage(await sharp(input).jpeg().withMetadata({ orientation: 6 }).toBuffer());
assert.equal(rotated.width, 800);
assert.equal(rotated.height, 1200);
for (const v of rotated.variants) assert.equal((await sharp(v.data).metadata()).width, v.width);
// 两帧 GIF：静态缩略图保留首帧，正文预览保留首帧、原图保留两帧。
const frames = Buffer.alloc(1200 * 800 * 3 * 2, 200);
frames.fill(50, 1200 * 800 * 3);
const gif = await sharp(frames, { raw: { width: 1200, height: 1600, channels: 3, pageHeight: 800 } }).gif({ delay: [100, 100], loop: 0 }).toBuffer();
const animated = await normalizeImage(gif);
assert.equal((await sharp(animated.buffer, { animated: true }).metadata()).pages, 2);
assert.equal((await sharp(animated.thumbnail, { animated: true }).metadata()).pages ?? 1, 1);
assert.equal((await sharp(animated.variants[0].data, { animated: true }).metadata()).pages ?? 1, 1);
const firstFrame = await sharp(animated.variants[0].data).raw().toBuffer();
assert.ok(firstFrame[0] > 170, '预览应显示亮色首帧，不能混入暗色第二帧');
const alphaInput = await sharp({ create: { width: 40, height: 24, channels: 4,
  background: { r: 200, g: 80, b: 20, alpha: 0.25 } } }).png().toBuffer();
const alphaResult = await normalizeImage(alphaInput);
const alphaPreview = await sharp(alphaResult.variants[0].data).raw().toBuffer({ resolveWithObject: true });
assert.equal(alphaPreview.info.channels, 4);
assert.ok(Math.abs(alphaPreview.data[3] - 64) <= 1, '复用像素应保留透明度');
const largeInput = await sharp({ create: { width: 3500, height: 3500, channels: 3, background: 'blue' } }).png().toBuffer();
const largeResult = await normalizeImage(largeInput);
assert.equal(largeResult.previewReused, false);
assert.equal(largeResult.previewPixelBytes, 0);
assert.equal((await sharp(largeResult.variants.at(-1).data).metadata()).width, 2560);
assert.equal(thumbnailFile('/uploads/version.png'), '/uploads/version.png.thumb-v3.webp');
assert.equal(variantFile('/uploads/version.png', 480), '/uploads/version.png.v4-w480.webp');
assert.equal(originalPathOf('/uploads/version.png.v3-w480.webp'), '/uploads/version.png');
assert.equal(previewSrcsetOf({ mime: 'image/gif', variants: '[{"w":240,"path":"x"}]' }), '');
assert.equal(previewSrcsetOf({ path: '/small.png', width: 320, mime: 'image/png', variants: '[{"w":240,"path":"/small.png.v4-w240.webp"},{"w":320,"path":"/small.png.v4-w320.webp"}]' }), '/small.png.v4-w240.webp 240w, /small.png.v4-w320.webp 320w');
// 图片信息缓存：同一路径在同一媒体修订号内只查一次库；修订号一变立即失效。
{
  let revision = 1, lookups = 0;
  const fakeMedia = { mediaByPath: (p) => {
    lookups++;
    return p === '/uploads/cache.png'
      ? { path: p, width: 1200, height: 800, thumbnail: thumbnailFile(p), variants: '[]' }
      : null;
  } };
  const imageInfo = createImageInfo(fakeMedia, { revisionOf: () => revision });
  assert.equal(imageInfo('/uploads/cache.png')?.width, 1200);
  assert.equal(imageInfo('/uploads/cache.png')?.width, 1200);
  assert.equal(lookups, 1);
  revision = 2;
  assert.equal(imageInfo('/uploads/cache.png')?.width, 1200);
  assert.equal(lookups, 2);
}

const media = { path: '/uploads/a.gif', width: 1200, height: 800, mime: 'image/gif', variants: JSON.stringify(normalized.variants.map(v => ({w:v.width,path:variantFile('/uploads/a.gif',v.width)}))) };
const info = { original: media.path, preview: previewSourceOf(media, 960), thumbnail: previewSourceOf(media), srcset: previewSrcsetOf(media,2560), width:1200,height:800 };
const previewHtml = createRenderer({imageInfo:()=>info}).render('![动画](/uploads/a.gif)').html;
assert.ok(!/src="\/uploads\/a.gif"/.test(previewHtml));
assert.ok(!/a.gif 1200w/.test(previewHtml));
assert.match(previewHtml,/data-full="\/uploads\/a.gif"/);
assert.equal(splitImages(previewHtml).images[0].src,media.path);
const lit = withLightbox(previewHtml,'test');
assert.equal((lit.match(/data-full=/g)??[]).length,1);
assert.match(lit,/data-lightbox="test"/);

assert.match(withLightbox('<a href="/uploads/a.gif"><img src="/uploads/a.gif"></a>','test',()=>info),/data-lightbox="test"/);
assert.ok(!withLightbox('<a href="https://example.com"><img src="/uploads/a.gif"></a>','test',()=>info).includes('data-lightbox'));
assert.equal(originalPathOf('/uploads/a.gif.v4-w240.webp?x=1&y=2'), '/uploads/a.gif');
const escapedLightbox = withLightbox('<img src="/uploads/a.gif?x=$&amp;" alt="a $&amp; b">', 'escape');
assert.ok(escapedLightbox.includes('data-full="/uploads/a.gif?x=$&amp;"'));
assert.ok(escapedLightbox.includes('data-alt="a $&amp; b"'));
const renderer = createRenderer();
assert.match(renderer.render('![开头](/a.png)\n\n![后面](/b.png)').html, /loading="eager" fetchpriority="high"/);
assert.match(renderer.render('长'.repeat(500) + '\n\n![后面](/b.png)').html, /loading="lazy"/);

const gallery = notesStream([{ slug: 'test', title: 'test', day: '', text: '', images: [{ src: '/original.gif', thumb: '/preview.webp', previewSrcset: '/small.webp 240w', width: 1200, height: 800 }], commentsHtml: '' }]);
assert.match(gallery, /data-full="\/original.gif"/);
assert.match(gallery, /srcset="\/small.webp 240w"/);

const work = fs.mkdtempSync(path.join(os.tmpdir(), 'blog-media-'));
const env = { ...process.env, DATA_DIR: work, DB_FILE: path.join(work, 'blog.db'), UPLOADS_DIR: path.join(work, 'uploads'), CONTENT_DIR: path.join(work, 'content') };
try {
  fs.mkdirSync(env.UPLOADS_DIR);
  fs.writeFileSync(path.join(env.UPLOADS_DIR, 'sample.png'), input);
  const db = new DatabaseSync(env.DB_FILE); migrate(db, { log() {} });
  db.prepare('INSERT INTO media(path,width,height,mime) VALUES(?,?,?,?)').run('/uploads/sample.png', 0, 0, 'image/png');
  const run = (...args) => {
    const r = spawnSync(process.execPath, ['scripts/backfill-media.mjs', ...args], { env, encoding: 'utf8' });
    assert.equal(r.status, 0, r.stderr + r.stdout); return r.stdout;
  };
  assert.match(run(), /需要处理 1 条/);
  assert.equal(fs.readdirSync(env.UPLOADS_DIR).length, 1);
  assert.equal(db.prepare('SELECT thumbnail FROM media').get().thumbnail, null);
  assert.match(run('--apply'), /已处理 1 条/);
  const row = db.prepare('SELECT * FROM media').get();
  assert.equal(row.thumbnail, thumbnailFile(row.path));
  assert.equal(row.width, 1200);
  assert.equal(row.height, 800);
  for (const v of parseVariants(row.variants)) assert.ok(fs.existsSync(path.join(work, v.path)));
  assert.equal(parseVariants(row.variants)[0].path, variantFile(row.path, 240));
  assert.match(run('--apply'), /已处理 0 条/);
  fs.unlinkSync(path.join(work, variantFile(row.path, 240)));
  assert.match(run('--apply'), /已处理 1 条/);
  // 用旧策略记录模拟升级：回填必须生成新地址，不能覆盖已缓存的旧文件。
  const legacyThumb = '/uploads/sample.png.thumb-v2.webp', legacyVariant = '/uploads/sample.png.v3-w240.webp';
  const legacyThumbFile = path.join(work, legacyThumb), legacyVariantFile = path.join(work, legacyVariant);
  fs.writeFileSync(legacyThumbFile, 'immutable-old-thumb'); fs.writeFileSync(legacyVariantFile, 'immutable-old-variant');
  db.prepare('UPDATE media SET thumbnail=?, variants=?').run(legacyThumb, JSON.stringify([{ w: 240, path: legacyVariant }]));
  assert.match(run('--apply'), /已处理 1 条/);
  assert.equal(fs.readFileSync(legacyThumbFile, 'utf8'), 'immutable-old-thumb');
  assert.equal(fs.readFileSync(legacyVariantFile, 'utf8'), 'immutable-old-variant');
  assert.equal(db.prepare('SELECT thumbnail FROM media').get().thumbnail, thumbnailFile(row.path));
  db.close();
} finally { fs.rmSync(work, { recursive: true, force: true }); }
console.log('媒体验证通过：尺寸、旋转、动画、加载优先级、灯箱原图、只读预览、补齐与重复执行。');

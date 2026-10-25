import fs from 'node:fs';
import path from 'node:path';
import sharp from 'sharp';
import { DATA_DIR } from '../config.js';
import { createAssetVersions } from '../render/assets.js';

// —— 站点图标与分享图 ——
// 原本是 public/ 下的五个静态文件：换 logo 要替换文件、跑 build:assets 重算指纹、再部署一次。
// 这里把「站主上传的图」放进 DATA_DIR/site/，与 uploads/ 同一条原则：可变内容不进源码目录，
// 备份跟着 data/ 走，部署覆盖 public/ 也不会把站主的图冲掉。
//
// 只收两张源图：一张方形（生全套图标）、一张 1200×630（分享图）。
// 之所以不让人逐个传五个尺寸：手工切出来的 maskable 很容易留白边，iPhone 上就是一个缩在中间的方块。

export const SITE_DIR = path.join(DATA_DIR, 'site');

export const ICON_FILES = {
  favicon: 'favicon-32.png',
  icon192: 'icon-192.png',
  icon512: 'icon-512.png',
  maskable: 'icon-maskable-512.png',
  apple: 'apple-touch-icon.png',
  og: 'og-image.jpg',
};

/** 按内容算指纹：同一张图重复上传，地址不变、浏览器不会白刷一遍缓存。 */
const iconVer = createAssetVersions(SITE_DIR, { salt: 'site', ttlMs: 1000 });

export const siteIconPath = (file) => path.join(SITE_DIR, file);
export const hasSiteIcon = (file) => {
  try { return fs.statSync(siteIconPath(file)).isFile(); } catch { return false; }
};

/** 站主传过就用它（带内容指纹），没传返回空串，由调用方回落到 public/ 里的出厂图标。 */
export function siteIconUrl(file) {
  if (!hasSiteIcon(file)) return '';
  return `/site/${file}?v=${iconVer(file)}`;
}

/** 一次性读齐，供 head、manifest 与后台预览共用。空串 = 没上传，调用方回落到 public/ 的出厂文件。 */
export function siteIconsState() {
  const urls = Object.fromEntries(Object.entries(ICON_FILES).map(([key, file]) => [key, siteIconUrl(file)]));
  return {
    ...urls,
    urls,
    custom: Object.fromEntries(Object.entries(urls).map(([key, url]) => [key, Boolean(url)])),
  };
}

// 图标底色：与站点纸色一致。iOS 的 apple-touch-icon 不认透明（会被填成黑底），
// maskable 又要求四周留出安全区，两处都得先铺一层纸色。
const PAPER = '#faf8f4';
const MASK_SIZE = 512;
// Android maskable 的安全区是直径 80% 的圆，内容缩到 80% 就不可能被裁到。
const MASK_INNER = Math.round(MASK_SIZE * 0.8);

function writeAtomic(file, data) {
  const target = siteIconPath(file);
  const temp = `${target}.tmp`;
  fs.mkdirSync(SITE_DIR, { recursive: true });
  fs.writeFileSync(temp, data);
  fs.renameSync(temp, target);
}

const SHARP_INPUT = { failOn: 'none', limitInputPixels: 36_000_000 };

async function decode(buffer, { min }) {
  let meta;
  try { meta = await sharp(buffer, SHARP_INPUT).metadata(); }
  catch { throw new Error('这张图读不出来，换一张 PNG 或 JPG 试试'); }
  if (!meta.width || !meta.height) throw new Error('这张图读不出尺寸，换一张试试');
  if (Math.min(meta.width, meta.height) < min) {
    throw new Error(`图太小了（${meta.width}×${meta.height}），最短边至少要 ${min}px`);
  }
  return meta;
}

/**
 * 方形源图 → 全套图标。等比裁成正方形（cover），不做拉伸：
 * 非正方形的源图会被居中裁掉两侧，这一点在后台表单里写清楚，别让人传一张横向 logo 再疑惑被切了。
 */
export async function installIconSet(buffer) {
  await decode(buffer, { min: 180 });
  const square = sharp(buffer, SHARP_INPUT).rotate().resize(512, 512, { fit: 'cover', position: 'centre', withoutEnlargement: false });

  writeAtomic(ICON_FILES.icon512, await square.clone().png({ compressionLevel: 9 }).toBuffer());
  writeAtomic(ICON_FILES.icon192, await square.clone().resize(192, 192).png({ compressionLevel: 9 }).toBuffer());
  writeAtomic(ICON_FILES.favicon, await square.clone().resize(32, 32).png({ compressionLevel: 9 }).toBuffer());
  writeAtomic(ICON_FILES.apple, await square.clone().resize(180, 180).flatten({ background: PAPER }).png({ compressionLevel: 9 }).toBuffer());

  const inner = await square.clone().resize(MASK_INNER, MASK_INNER).flatten({ background: PAPER }).png().toBuffer();
  const pad = Math.round((MASK_SIZE - MASK_INNER) / 2);
  writeAtomic(ICON_FILES.maskable, await sharp(inner)
    .extend({ top: pad, bottom: MASK_SIZE - MASK_INNER - pad, left: pad, right: MASK_SIZE - MASK_INNER - pad, background: PAPER })
    .png({ compressionLevel: 9 }).toBuffer());

  return Object.keys(ICON_FILES).filter((key) => key !== 'og').length;
}

/** 分享图：1200×630 是 og:image / twitter:card 的通用尺寸，非这个比例的图居中裁切。 */
export async function installOgImage(buffer) {
  await decode(buffer, { min: 600 });
  const jpg = await sharp(buffer, SHARP_INPUT).rotate()
    .resize(1200, 630, { fit: 'cover', position: 'centre' })
    .flatten({ background: PAPER })
    .jpeg({ quality: 84, mozjpeg: true })
    .toBuffer();
  writeAtomic(ICON_FILES.og, jpg);
  return true;
}

/** 全部清掉回到出厂图标。文件不存在也算成功——这个按钮要能反复点。 */
export function clearSiteIcons() {
  let removed = 0;
  for (const file of Object.values(ICON_FILES)) {
    try { fs.unlinkSync(siteIconPath(file)); removed += 1; } catch { /* 已经不在了 */ }
  }
  return removed;
}

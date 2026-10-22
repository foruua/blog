import crypto from 'node:crypto';
import sharp from 'sharp';
import { variantWidthsOf } from './variants.js';
import { sniffImageType, SHARP_INPUT_OPTIONS } from '../util/image.js';

// 原尺寸图保留动画，派生图复用转正后的首帧像素；固定 32MiB 像素预算，大图回退逐档解码以免撑爆内存。
export const PREVIEW_REUSE_MAX_BYTES = 32 * 1024 * 1024;
export async function normalizeImage(input) {
  const image = sharp(input, { ...SHARP_INPUT_OPTIONS, animated: true });
  const metadata = await image.metadata();
  if (!['png', 'jpeg', 'gif', 'webp'].includes(metadata.format) || !metadata.width || !metadata.height
      || metadata.width * metadata.height * (metadata.pages ?? 1) > 40000000) throw new Error('invalid image');
  const { data: buffer, info } = await image.clone().rotate().toBuffer({ resolveWithObject: true });
  const firstFrameHeight = info.pageHeight ?? info.height;
  const reusePixels = info.width * firstFrameHeight * 4 <= PREVIEW_REUSE_MAX_BYTES;
  let pixels;
  if (reusePixels) {
    pixels = await sharp(input, SHARP_INPUT_OPTIONS)
      .rotate().raw().toBuffer({ resolveWithObject: true });
  }
  // 缩略图与各档变体从同一条基准管线 clone：预算内复用已解码像素，预算外也共用同一输入，不逐尺寸重解码。
  const base = pixels
    ? sharp(pixels.data, { raw: { width: pixels.info.width, height: pixels.info.height, channels: pixels.info.channels } })
    : sharp(input, SHARP_INPUT_OPTIONS).rotate();
  const thumbnail = await base.clone().resize(480, 480, { fit: 'inside', withoutEnlargement: true })
    .webp({ quality: 76 }).toBuffer();
  const variants = [];
  const variantErrors = [];
  for (const width of variantWidthsOf(info.width)) {
    try {
      variants.push({ width, data: await base.clone().resize(width, null, { withoutEnlargement: true }).webp({ quality: 78 }).toBuffer() });
    } catch (error) {
      variantErrors.push({ width, message: String(error?.message ?? error).slice(0, 120) });
    }
  }
  return { buffer, thumbnail, variants, variantErrors, previewReused: Boolean(pixels), previewPixelBytes: pixels?.data.length ?? 0, animated: (metadata.pages ?? 1) > 1, width: info.width, height: info.pageHeight ?? info.height };
}

export const ALLOWED_MIME = new Set(['image/png', 'image/jpeg', 'image/gif', 'image/webp']);

const EXT = { 'image/png': 'png', 'image/jpeg': 'jpg', 'image/gif': 'gif', 'image/webp': 'webp' };
export const extensionFor = (m) => EXT[m] ?? 'bin';

// 只嗅探魔数，尺寸与真实解码交给 sharp；这里不再自带 JPEG/WebP 尺寸解析（那套代码已无调用点）。
export const probeImage = {
  mime: sniffImageType,
  sha256: (buf) => crypto.createHash('sha256').update(buf).digest('hex'),
};

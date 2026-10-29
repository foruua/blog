import sharp from 'sharp';
import { AVATAR_SHARP_OPTIONS } from '../util/image.js';

// 把上游头像规范化成小 WebP。必须做：镜像给的图不合身——实测 gravatar.loli.net 无视 s= 固定回一张
// 160×160 PNG（50KB）。不做的话正文里 38px 圆就要下 50KB；规范化后约 2–4KB，格式/尺寸也统一。
// 96px 覆盖 40px 显示尺寸的 2x 屏，默认值由 src/config.js 的 AVATAR_FETCH_SIZE 传入。
// 走与上传管线同一套 sharp 约定（src/media/image.js），但像素上限单独一档（见 AVATAR_SHARP_OPTIONS）：
// 头像输出只有 96px，没必要为一张 7000×7000 的上游图付整幅解码的代价。头像无动画语义，不保留动画帧。
export async function normalizeAvatar(input, size = 96) {
  const out = await sharp(input, AVATAR_SHARP_OPTIONS)
    .rotate()                                   // 带 EXIF 方向的图先摆正
    .resize(size, size, { fit: 'cover', position: 'centre' })
    .webp({ quality: 80 })
    .toBuffer();
  return { body: out, type: 'image/webp' };
}

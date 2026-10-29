// 图片公共件：魔数嗅探与 sharp 输入选项。以前上传管线（media/image.js）与头像缓存（avatar/cache.js）
// 各写一份且行为不一致（GIF 一个认 4 字节、一个认 6 字节；最小长度 16/12 也不同），同一张怪图会得到
// 不同判定，故收敛到这份。最小长度取 12：WEBP 判定要读到第 12 字节；GIF 用完整签名，`GIF8x` 残片不再误判。

export function sniffImageType(buf) {
  if (!Buffer.isBuffer(buf) || buf.length < 12) return null;
  if (buf[0] === 0x89 && buf[1] === 0x50 && buf[2] === 0x4e && buf[3] === 0x47) return 'image/png';
  if (buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff) return 'image/jpeg';
  const gif = buf.subarray(0, 6).toString('latin1');
  if (gif === 'GIF87a' || gif === 'GIF89a') return 'image/gif';
  if (buf.subarray(0, 4).toString('latin1') === 'RIFF' && buf.subarray(8, 12).toString('latin1') === 'WEBP') return 'image/webp';
  return null;
}

// 像素上限：按元数据先拒，别等解码；动画的 pages 要乘进去（100 帧的 600×600 也是 3600 万像素）。
// 默认 8000 万像素（RGBA 解码约 320MB，libvips 按需算区域，实际峰值低于此）——展示尺寸远小于此
// （最宽变体 1600px 左右），80MP 覆盖手机直出到中画幅缩图。可用 MAX_INPUT_PIXELS 环境变量覆盖。
export const MAX_INPUT_PIXELS = Number(process.env.MAX_INPUT_PIXELS) > 0
  ? Number(process.env.MAX_INPUT_PIXELS)
  : 80_000_000;

// 上传管线与头像规范化共用同一组 sharp 约定：限制输入像素、把警告当错误。
export const SHARP_INPUT_OPTIONS = { limitInputPixels: MAX_INPUT_PIXELS, failOn: 'warning' };

// 头像单独一档：输出只有 96px，却沿用 8000 万像素上限，等于让上游回一张 7000×7000 的图先被完整解出来
// 再缩成 96px —— 白烧内存与 CPU，还可能成为放大器。2048² 已经远超任何头像源（含 2x 屏与 EXIF 旋转）。
export const AVATAR_INPUT_PIXELS = Math.min(MAX_INPUT_PIXELS, 2048 * 2048);
export const AVATAR_SHARP_OPTIONS = { limitInputPixels: AVATAR_INPUT_PIXELS, failOn: 'warning' };

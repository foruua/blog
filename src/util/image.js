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

// 上传管线与头像规范化共用同一组 sharp 约定：限制输入像素、把警告当错误。
export const SHARP_INPUT_OPTIONS = { limitInputPixels: 40000000, failOn: 'warning' };

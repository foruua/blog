import crypto from 'node:crypto';

// Gravatar 公开口径：邮箱 trim 小写后的不加盐 md5，与 auth.js 的 fingerprint()（加盐 HMAC、防枚举）
// 不同。md5 只在渲染时现算、不落库——否则等于把可枚举的邮箱指纹永久写进数据库和每份备份。
export const AVATAR_MD5_RE = /^[a-f0-9]{32}$/;

export function emailMd5(email) {
  const norm = String(email ?? '').trim().toLowerCase();
  if (!norm) return null;
  return crypto.createHash('md5').update(norm, 'utf8').digest('hex');
}

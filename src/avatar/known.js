import { emailMd5 } from './md5.js';
import { decryptEmail } from '../auth.js';

/**
 * 只允许“已经在已通过评论里出现过”的头像 hash 触发回源。
 * 否则任意 32 位 hex 都能消耗 Gravatar/镜像预算，并形成邮箱是否有头像的枚举 oracle。
 * 集合带短 TTL；新评论最多晚一分钟获得头像，不影响正常浏览。
 */
export function createKnownAvatars({ comments, crypt, siteEmail = '', ttlMs = 60_000, now = Date.now } = {}) {
  let at = 0;
  let known = new Set();
  // email_enc 每次加密的 IV 都不同，但同一条评论的密文稳定；缓存解密结果，
  // TTL 重建时不必把几千条历史评论重新 AES 解密/算 md5。
  const hashByEnc = new Map();
  const rebuild = () => {
    known = new Set();
    const author = emailMd5(siteEmail);
    if (author) known.add(author);
    const seen = new Set();
    for (const enc of comments.approvedEmailEncs?.() ?? []) {
      seen.add(enc);
      let hash = hashByEnc.get(enc);
      if (hash === undefined) {
        hash = emailMd5(decryptEmail(crypt, enc)) || '';
        hashByEnc.set(enc, hash);
      }
      if (hash) known.add(hash);
    }
    // 评论被删除/改状态后，旧密文不再出现；顺手丢掉缓存项，避免缓存跟着历史增长。
    for (const enc of hashByEnc.keys()) if (!seen.has(enc)) hashByEnc.delete(enc);
    at = now();
  };
  return (hash) => {
    if (now() - at >= ttlMs) rebuild();
    return known.has(String(hash ?? ''));
  };
}

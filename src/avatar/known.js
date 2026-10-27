import { emailMd5 } from './md5.js';
import { decryptEmail } from '../auth.js';

/**
 * 只允许“已经在已通过评论里出现过”的头像 hash 触发回源。
 * 否则任意 32 位 hex 都能消耗 Gravatar/镜像预算，并形成邮箱是否有头像的枚举 oracle。
 *
 * 集合重建要解密历史评论邮箱：评论多时同步跑会卡住事件循环，所以按批让出事件循环。
 * `isKnown` 是异步的：调用方等它完成后再决定是否回源；重建失败时沿用上一份集合。
 */
export function createKnownAvatars({
  comments, crypt, siteEmail = '', ttlMs = 60_000, now = Date.now,
  log = () => {}, chunkSize = 200,
} = {}) {
  let at = 0;
  let retryAt = 0;
  let known = new Set();
  let ready = false;
  let rebuilding = null;
  // email_enc 每次加密的 IV 都不同，但同一条评论的密文稳定；缓存解密结果，TTL 重建时不必重复 AES。
  const hashByEnc = new Map();
  // 后台可热改博主邮箱：允许调用方传 getter，重建时取当前值。
  const siteEmailNow = () => (typeof siteEmail === 'function' ? siteEmail() : siteEmail);
  const authorHashNow = () => emailMd5(siteEmailNow());

  const yieldToEventLoop = () => new Promise((resolve) => setImmediate(resolve));

  function build() {
    if (rebuilding) return rebuilding;
    rebuilding = (async () => {
      const next = new Set();
      const author = authorHashNow();
      if (author) next.add(author);

      const encs = comments.approvedEmailEncs?.() ?? [];
      const seen = new Set(encs);
      for (let start = 0; start < encs.length; start += chunkSize) {
        const end = Math.min(encs.length, start + chunkSize);
        for (let i = start; i < end; i++) {
          const enc = encs[i];
          let hash = hashByEnc.get(enc);
          if (hash === undefined) {
            hash = emailMd5(decryptEmail(crypt, enc)) || '';
            hashByEnc.set(enc, hash);
          }
          if (hash) next.add(hash);
        }
        if (end < encs.length) await yieldToEventLoop();
      }
      // 评论被删除/改状态后，旧密文不再出现；顺手丢掉缓存项，避免缓存跟着历史增长。
      for (const enc of hashByEnc.keys()) if (!seen.has(enc)) hashByEnc.delete(enc);
      known = next;
      ready = true;
      at = now();
      retryAt = 0;
    })().catch((error) => {
      // 保留上一份集合；记录后短暂退避再试，不要因为一次数据库抖动让所有头像长期失效或打爆库。
      log(JSON.stringify({ event: 'avatar.known-rebuild-failed', code: error?.code ?? 'INTERNAL' }));
      at = now();
      retryAt = now() + Math.min(ttlMs, 10_000);
    }).finally(() => { rebuilding = null; });
    return rebuilding;
  }

  async function isKnown(hash) {
    // retryAt 只在失败后退避期非零；优先看它，失败后不会因为 ready 仍为 true 而等满整个 TTL。
    if (retryAt ? now() >= retryAt : !ready || now() - at >= ttlMs) await build();
    const value = String(hash ?? '');
    if (!value) return false;
    // 博主邮箱刚改、集合还没到 TTL 重建时，也要立刻认出新邮箱的 hash。
    if (value === authorHashNow()) return true;
    return known.has(value);
  }

  // 启动时预热可让首个头像请求不必等待重建；调用方可以忽略返回值。
  isKnown.refresh = build;
  return isKnown;
}

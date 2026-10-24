import { envInt } from '../util/env.js';

// 最小填表时间（防机器人）：线上 3 秒。测试夹具把它调到 50ms，避免每个评论用例真等 3 秒；
// 生产环境不要把它设成 0，否则时间戳令牌只剩“是否签发”这一层保护。
const MIN_ELAPSED_MS = envInt(process.env.COMMENT_MIN_ELAPSED_MS, 3000, { min: 0, max: 3600_000 });
const SWEEP_MS = 60 * 1000;
const MAX_KEYS = 20000;

export function createAntispam({ windowMs = 10 * 60 * 1000, maxPerWindow = 5 } = {}) {

  const hits = new Map();
  let lastSweep = Date.now();

  // 清理改成"顺手做"，不再用 setInterval：每次构造 app 起一个定时器会在测试里累积成几十个，且没流量本也不增长。
  function sweep(now = Date.now()) {
    for (const [k, v] of hits) {
      const kept = v.filter((t) => now - t < windowMs);
      if (kept.length) hits.set(k, kept); else hits.delete(k);
    }
    lastSweep = now;
  }

  // sweep 只删「窗口内已无命中」的桶。被大量不同 key（多 IP/代理池）灌满时活跃桶一个都删不掉，Map 会
  // 越过 MAX_KEYS 持续增长；这里按最近命中时间强制淘汰最旧一批给它硬上限（admin 登录限流也走这里，
  // 见 admin/auth.js 的 loginLimiter）。每次接受命中都把 key 删掉重插（见 rateLimited），
  // 故插入序即最近命中序，淘汰只看最前几个。
  function evictOldest() {
    const drop = Math.max(1, hits.size - MAX_KEYS + 1);
    const keys = hits.keys();
    for (let i = 0; i < drop; i++) {
      const next = keys.next();
      if (next.done) break;
      hits.delete(next.value);
    }
  }

  return {

    rateLimited(key, now = Date.now()) {
      // 空 key 不能直接放行：以前 `if (!key) return false` 等于取不到客户端地址就限不了，走 unix socket
      // 或代理没给可用地址时形同不存在；现在统一归到一个固定桶。
      const bucket = key || 'unknown';
      if (now - lastSweep >= SWEEP_MS || hits.size > MAX_KEYS) sweep(now);
      if (hits.size >= MAX_KEYS && !hits.has(bucket)) evictOldest();
      const kept = (hits.get(bucket) ?? []).filter((t) => now - t < windowMs);
      if (kept.length >= maxPerWindow) { hits.set(bucket, kept); return true; }
      kept.push(now);
      // 删掉重插把桶挪到 Map 末尾：插入序即「最近一次被接受命中」升序，evictOldest 才能直接淘汰最前面。
      hits.delete(bucket);
      hits.set(bucket, kept);
      return false;
    },

    // 只查不记：供「先判定、验证通过才算失败」的场景（如登录限流）。
    blocked(key, now = Date.now()) {
      const kept = (hits.get(key || 'unknown') ?? []).filter((t) => now - t < windowMs);
      return kept.length >= maxPerWindow;
    },

    // 清掉某个 key 的历史（如登录成功后重置失败计数）。
    clear(key) { hits.delete(key || 'unknown'); },
  };
}

export function screenSubmission({ honeypot, elapsedToken, now = Date.now() }) {
  if (String(honeypot ?? '').trim()) return 'honeypot';
  if (!elapsedToken || typeof elapsedToken.ts !== 'number') return 'missing-timestamp';
  const elapsed = now - elapsedToken.ts;
  if (elapsed < MIN_ELAPSED_MS) return `too-fast(${elapsed}ms)`;
  if (elapsed > 24 * 3600 * 1000) return 'stale-token';
  return null;
}

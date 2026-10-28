import net from 'node:net';
import { envInt } from '../util/env.js';

// 「邮箱 → 昵称/网址」自动填充查询是匿名、可重复的：不设上限就等于把评论区变成在线枚举接口。
// 三层限额各挡一种打法：
//   1) 单邮箱：挡住盯着某一个人反复确认——换多少 IP 都一样；
//   2) 单 IP 的不同邮箱数：挡住一台机器按名单扫，重复查同一个邮箱不占新名额；
//   3) 全站新邮箱数：挡住代理池/僵尸网络分摊到大量 IP 的批量扫。窗口内已出现过的邮箱仍放行，
//      所以攻击者把额度打满，最坏也只是让「新读者」暂时失去自动填充，不影响评论本身。
// 键一律用加盐指纹（邮箱）与归一化 IP（IPv6 按 /64），限流表里不出现明文邮箱。

const WINDOW_MS = envInt(process.env.READER_PROBE_WINDOW_MS, 10 * 60 * 1000, { min: 1000, max: 24 * 3600 * 1000 });
const PER_EMAIL = envInt(process.env.READER_PROBE_PER_EMAIL, 6, { min: 1, max: 1000 });
const PER_IP = envInt(process.env.READER_PROBE_PER_IP, 12, { min: 1, max: 10000 });
const GLOBAL_MAX = envInt(process.env.READER_PROBE_GLOBAL, 300, { min: 1, max: 1000000 });
const MAX_KEYS = 4096;
const SWEEP_MS = 60 * 1000;

// 把 IPv6 展开成 8 组 4 位十六进制，只取前 4 组（/64）。非法输入不会走到这里（net.isIPv6 先挡）。
function expandIpv6(addr) {
  const [head, tail] = addr.includes('::') ? addr.split('::') : [addr, null];
  const groups = (part) => {
    const out = [];
    for (const g of part ? part.split(':') : []) {
      if (!g.includes('.')) { out.push(g); continue; }
      const [a, b, c, d] = g.split('.').map(Number);
      out.push(((a << 8) | b).toString(16), ((c << 8) | d).toString(16));
    }
    return out;
  };
  const h = groups(head);
  const t = tail === null ? [] : groups(tail);
  const fill = Math.max(0, 8 - h.length - t.length);
  return [...h, ...Array(fill).fill('0'), ...t].map((g) => g.padStart(4, '0')).join(':');
}

// IPv6 单地址限额没有意义：一个 /64 就有 2^64 个地址，换一个就能重置计数，上限形同虚设。
// 但 IPv4-mapped（::ffff:a.b.c.d，双栈监听的常见形态）必须还原成 IPv4，否则所有直连 IPv4 会挤进同一个桶。
export function ipBucket(ip) {
  const raw = String(ip ?? '').trim();
  if (!raw) return 'unknown';
  if (net.isIPv4(raw)) return raw;
  if (!net.isIPv6(raw)) return raw;
  const addr = raw.toLowerCase().split('%')[0];
  const mapped = /^::ffff:(\d+\.\d+\.\d+\.\d+)$/.exec(addr);
  if (mapped) return mapped[1];
  const full = expandIpv6(addr).split(':');
  if (full.slice(0, 5).every((g) => g === '0000') && full[5] === 'ffff') {
    const hi = Number.parseInt(full[6], 16);
    const lo = Number.parseInt(full[7], 16);
    return `${hi >> 8}.${hi & 255}.${lo >> 8}.${lo & 255}`;
  }
  return full.slice(0, 4).join(':');
}

export function createReaderProbeLimiter({
  windowMs = WINDOW_MS,
  perEmail = PER_EMAIL,
  perIp = PER_IP,
  globalMax = GLOBAL_MAX,
  capacity = MAX_KEYS,
} = {}) {
  const emails = new Map(); // 邮箱指纹 -> { start, count }
  const ips = new Map();    // IP 桶 -> { start, seen: Set<邮箱指纹> }
  let global = { start: Date.now(), seen: new Set() };
  let lastSweep = Date.now();

  // 清理摊到时间窗上，别每个请求遍历全表（和 util/http.js 的写限流同一思路）。
  function sweep(now) {
    for (const map of [emails, ips]) {
      for (const [key, entry] of map) if (now - entry.start >= windowMs) map.delete(key);
    }
    lastSweep = now;
  }

  const live = (entry, now) => (entry && now - entry.start < windowMs ? entry : null);

  return {
    /** @returns {{ limited: boolean, reason?: 'email'|'ip'|'global', retryAfter?: number }} */
    check(emailKey, ip, now = Date.now()) {
      const email = emailKey || 'unknown';
      const addr = ip || 'unknown';
      if (now - lastSweep >= SWEEP_MS) sweep(now);
      if (now - global.start >= windowMs) global = { start: now, seen: new Set() };

      const emailEntry = live(emails.get(email), now) ?? { start: now, count: 0 };
      const ipEntry = live(ips.get(addr), now) ?? { start: now, seen: new Set() };
      const ipKnown = ipEntry.seen.has(email);
      const globalKnown = global.seen.has(email);

      let reason = '';
      let startedAt = 0;
      if (emailEntry.count >= perEmail) { reason = 'email'; startedAt = emailEntry.start; }
      else if (!ipKnown && ipEntry.seen.size >= perIp) { reason = 'ip'; startedAt = ipEntry.start; }
      else if (!globalKnown && global.seen.size >= globalMax) { reason = 'global'; startedAt = global.start; }
      if (reason) {
        return { limited: true, reason, retryAfter: Math.max(1, Math.ceil((startedAt + windowMs - now) / 1000)) };
      }

      emailEntry.count += 1;
      emails.delete(email);
      emails.set(email, emailEntry);
      if (emails.size > capacity) emails.delete(emails.keys().next().value);

      if (!ipKnown) ipEntry.seen.add(email);
      ips.delete(addr);
      ips.set(addr, ipEntry);
      if (ips.size > capacity) ips.delete(ips.keys().next().value);

      if (!globalKnown) global.seen.add(email);
      return { limited: false };
    },
  };
}

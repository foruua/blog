import net from 'node:net';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { getConnInfo } from '@hono/node-server/conninfo';
import { SITE, MAX_THEME_ZIP } from '../config.js';

// 真实客户端 IP：仅当 TRUST_PROXY 且直连对端是受信任代理时，才取 X-Forwarded-For 链尾。
const TRUST_PROXY = process.env.TRUST_PROXY === 'true';
const trusted = new Set((process.env.TRUSTED_PROXIES ?? '127.0.0.1,::1,::ffff:127.0.0.1').split(',').map((s) => s.trim()));
export function clientIp(c) {
  let remote = '';
  try { remote = getConnInfo(c).remote?.address ?? ''; } catch { /* In-memory requests have no socket. */ }
  if (TRUST_PROXY && trusted.has(remote)) {
    // 只跳过非法条目，不因为链里混进一个 "unknown" 就整体退回直连地址——那会让所有访客共用
    // 127.0.0.1 一个限流桶，等于关掉按 IP 限流。从右往左仍只信到第一个非可信代理。
    const chain = (c.req.header('x-forwarded-for') ?? '').split(',')
      .map((s) => s.trim()).filter((ip) => net.isIP(ip));
    if (chain.length) {
      chain.push(remote);
      while (chain.length > 1 && trusted.has(chain.at(-1))) chain.pop();
      return chain.at(-1);
    }
  }
  return remote;
}

// 后台会话 cookie 的公共属性；secure 仅站点为 https 时开，COOKIE_INSECURE=true 只作本机 https 调试。
export const cookieBase = () => ({
  path: '/', httpOnly: true, sameSite: 'Lax',
  secure: SITE.url.startsWith('https') && process.env.COOKIE_INSECURE !== 'true',
});

// 评论/审核/登录这类写入口的同源校验：Origin 缺失（curl、邮件客户端、旧客户端）放行，
// 由签名令牌/密码/限流兜底；同站子域会带 Sec-Fetch-Site: same-site，必须拒绝（SameSite=Lax 拦不住）。
export const sameOriginRequest = (c) => {
  const origin = c.req.header('origin');
  if (origin && origin !== new URL(SITE.url).origin) return false;
  const site = c.req.header('sec-fetch-site');
  return !site || site === 'same-origin' || site === 'none';
};

// Accept-Encoding 里某个编码是否可用：不带 q=0，且不是只出现在 q 很小的位置。
// 只做常见的精确/带 q 两种写法的排除；q=0.001 这类仍然算接受（浏览器不会这么发）。
export const acceptsEncoding = (header, name) => {
  const value = String(header ?? '');
  const present = new RegExp(`(?:^|,)\\s*${name}\\s*(?:;|,|$)`, 'i').test(value);
  const refused = new RegExp(`(?:^|,)\\s*${name}\\s*;\\s*q=0(?:\\.0*)?\\s*(?:,|$)`, 'i').test(value);
  return present && !refused;
};

// 按候选顺序挑一个客户端接受的编码；空串表示不压缩。
export const pickEncoding = (header, candidates) => candidates.find((name) => acceptsEncoding(header, name)) ?? '';

export const MAX_UPLOAD = Math.min(32 * 1024 * 1024, Math.max(1024, Number(process.env.MAX_UPLOAD_BYTES) || 8 * 1024 * 1024));
// 视频不重编码，原样落盘，所以能放宽得多；上限 1GB，默认 128MB。请求体仍然整块读进内存，
// 别把它当无限量网盘用——真放长视频更适合外部对象存储/CDN。
export const MAX_VIDEO_UPLOAD = Math.min(1024 * 1024 * 1024, Math.max(1024, Number(process.env.MAX_VIDEO_UPLOAD_BYTES) || 128 * 1024 * 1024));
const WRITE = new Set(['POST', 'PUT', 'PATCH', 'DELETE']);

// 上传是少数会把整个请求体读进内存的路径。除了单请求上限，还要限制同时在飞的数量：
// 两个 128MB 视频并发就足以让窄内存机器进入 swap。门闩在读取 body 之前拿，覆盖到路由处理结束。
const MAX_CONCURRENT_UPLOADS = Math.max(1, Number.parseInt(process.env.MAX_CONCURRENT_UPLOADS ?? '', 10) || 2);
let uploadsActive = 0;
function enterUploadSlot() {
  if (uploadsActive >= MAX_CONCURRENT_UPLOADS) return null;
  uploadsActive++;
  let released = false;
  return () => { if (!released) { released = true; uploadsActive--; } };
}

// 请求体解析并缓存到上下文：CSRF 守卫会先读一次，路由里再读必须拿到同一份。
// 表单保留 FormData 原样（上传需要 File 对象），JSON 解析为对象。四处的「JSON 还是表单」判断收敛到这里。
export async function readBody(c) {
  const cached = c.get('adminBody');
  if (cached !== undefined) return cached;
  const ct = c.req.header('content-type') ?? '';
  const parsed = ct.includes('application/json')
    ? await c.req.json().catch(() => ({}))
    : await c.req.formData().catch(() => new FormData());
  c.set('adminBody', parsed);
  return parsed;
}

// 在 readBody 之上拍平成普通对象（值非字符串取空串）：给只按字段读值的接口用，字段访问不必再判类型。
export async function readBodyObject(c) {
  const b = await readBody(c);
  if (b instanceof FormData) {
    const out = {};
    for (const [k, v] of b.entries()) out[k] = typeof v === 'string' ? v : '';
    return out;
  }
  return b && typeof b === 'object' ? b : {};
}

// 原始二进制上传（后台大文件）先落到系统临时文件，路由再按文件路径处理；避免 128MB 视频整块进内存。
async function spoolRawUpload(c, { limit, timeoutMs }) {
  const dir = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'blog-upload-'));
  const file = path.join(dir, 'body');
  let handle = null;
  let reader = null;
  let timer = null;
  try {
    handle = await fs.promises.open(file, 'wx', 0o600);
    reader = c.req.raw.body.getReader();
    let bytes = 0;
    const timeout = new Promise((_, reject) => {
      timer = setTimeout(() => reject(Object.assign(new Error('timeout'), { code: 'TIMEOUT' })), timeoutMs);
      timer.unref?.();
    });
    while (true) {
      const { done, value } = await Promise.race([reader.read(), timeout]);
      if (done) break;
      bytes += value.byteLength;
      if (bytes > limit) throw Object.assign(new Error('too-large'), { code: 'TOO_LARGE' });
      let offset = 0;
      while (offset < value.byteLength) {
        const { bytesWritten } = await handle.write(value, offset, value.byteLength - offset);
        if (!bytesWritten) throw new Error('write stalled');
        offset += bytesWritten;
      }
    }
    await handle.close();
    handle = null;
    return { dir, file, size: bytes };
  } catch (error) {
    clearTimeout(timer);
    if (reader) void reader.cancel().catch(() => {});
    if (handle) await handle.close().catch(() => {});
    await fs.promises.rm(dir, { recursive: true, force: true }).catch(() => {});
    throw error;
  } finally {
    clearTimeout(timer);
  }
}

// 该中间件幂等：用过一次就把请求体标成 bodyBounded，后续实例直接短路。所以 server/admin/comment 各
// 挂一份都安全——子应用可独立使用（测试就这么挂），分量限制按路径决定，与谁注册无关。
export function boundedBody() {
  return async (c, next) => {
    if (!WRITE.has(c.req.method) || !c.req.raw.body || c.get('bodyBounded')) return next();
    // 路径先归一化尾斜杠再比较：Hono 开了 strict:false，/admin/api/upload/ 也会命中上传处理器，
    // 否则它会落到默认分支、把合法上传按 1MB 快速拒绝。
    const p = c.req.path.replace(/\/+$/, '');
    const isUpload = p === '/admin/api/upload';
    // 主题 ZIP 也是文件上传：不能落进普通表单的 1MB 上限（截图稍大一点就传不上去）。
    const isThemeUpload = p === '/admin/themes/upload';
    // 两者都在鉴权之前整块读请求体，必须共用并发闸门：否则未登录请求也能用 10MB 主题包打内存。
    const needsUploadSlot = isUpload || isThemeUpload;
    const releaseUpload = needsUploadSlot ? enterUploadSlot() : null;
    if (needsUploadSlot && !releaseUpload) {
      c.header('Retry-After', '5');
      return c.json({ ok: false, error: '上传任务过多，请稍后重试' }, 503);
    }
    try {
      const limit = isUpload ? Math.max(MAX_UPLOAD, MAX_VIDEO_UPLOAD) + 65536
        : isThemeUpload ? MAX_THEME_ZIP + 65536
        : p === '/admin/login' ? 4096
        : p.startsWith('/api/comments') || /\/comment$/.test(p) || p.startsWith('/moderate/') ? 32768 : 1024 * 1024;
      if (Number(c.req.header('content-length')) > limit) return c.json({ ok: false, error: '请求内容过大', status: 'too-large' }, 413);
      // 大请求（上传）给更长的读取窗口：15s 是给普通表单的，几十 MB 视频在慢链路上会被误判成超时。
      const timeoutMs = isUpload ? 600000 : isThemeUpload ? 120000 : limit > 1024 * 1024 ? 120000 : 15000;
      // 新前端用 raw body 上传，只有 multipart 旧表单才整块读入内存。
      if (isUpload && (c.req.header('x-raw-upload') === '1'
        || !(c.req.header('content-type') ?? '').toLowerCase().includes('multipart/form-data'))) {
        let temp;
        try { temp = await spoolRawUpload(c, { limit, timeoutMs }); }
        catch (error) {
          if (error.code === 'TOO_LARGE') return c.json({ ok: false, error: '请求内容过大', status: 'too-large' }, 413);
          return c.json({ ok: false, error: '请求读取超时或中断' }, 408);
        }
        c.set('uploadTemp', temp);
        c.set('bodyBounded', true);
        try { await next(); }
        finally { await fs.promises.rm(temp.dir, { recursive: true, force: true }).catch(() => {}); }
        return;
      }
      const reader = c.req.raw.body.getReader();
      let timer; let bytes = 0; const chunks = [];
      const timeout = new Promise((_, reject) => { timer = setTimeout(() => reject(new Error('timeout')), timeoutMs); timer.unref?.(); });
      try {
        while (true) {
          const { done, value } = await Promise.race([reader.read(), timeout]);
          if (done) break;
          bytes += value.byteLength;
          if (bytes > limit) { void reader.cancel().catch(() => {}); return c.json({ ok: false, error: '请求内容过大', status: 'too-large' }, 413); }
          chunks.push(value);
        }
        c.req.raw = new Request(c.req.raw, { body: Buffer.concat(chunks), duplex: 'half' });
        c.set('bodyBounded', true);
      } catch { void reader.cancel().catch(() => {}); return c.json({ ok: false, error: '请求读取超时或中断' }, 408); }
      finally { clearTimeout(timer); }
      await next();
    } finally {
      releaseUpload?.();
    }
  };
}

// 条件请求：拆 If-None-Match、去 W/ 前缀、认 *；命中即视为未修改。静态资源与 Feed/sitemap 共用。
export function ifNoneMatch(c, etag) {
  const validators = (c.req.header('if-none-match') ?? '').split(',').map((value) => value.trim().replace(/^W\//, ''));
  return validators.includes(etag) || validators.includes('*');
}

export function publicWriteRateLimit({ max = 60, windowMs = 60000, capacity = 4096 } = {}) {
  const entries = new Map();
  let sweptAt = Date.now();
  return async (c, next) => {
    if (!WRITE.has(c.req.method)) return next();
    const now = Date.now();
    // 不再维护全站共享的硬拒绝桶：单个 IP 刷满全局额度会让所有访客一起 429。
    // 高基数攻击由单 IP 桶 + 容量淘汰兜底。
    // 清理摊还到时间窗上，而不是每个请求都全量遍历（容量 4096 时那是每请求数千次迭代）。
    if (now - sweptAt >= windowMs) {
      for (const [key, value] of entries) if (now - value.time >= windowMs) entries.delete(key);
      sweptAt = now;
    }
    const key = clientIp(c) || 'unknown';
    let hit = entries.get(key);
    if (!hit) {
      // 容量满时淘汰最旧一条，而非把新访客 429（旧写法在高基数 IP 下会让新 IP 被拒一个窗口期）。time 只在
      // 插入时写、命中不改，故 Map 插入序即时间序，第一个 key 就是最旧那条；旧写法每次都要全表扫描，现在 O(1)。
      if (entries.size >= capacity) {
        const oldest = entries.keys().next().value;
        if (oldest !== undefined) entries.delete(oldest);
      }
      hit = { time: now, count: 0 }; entries.set(key, hit);
    }
    if (++hit.count > max) return c.json({ ok: false, status: 'limited', error: '提交过于频繁' }, 429);
    await next();
  };
}

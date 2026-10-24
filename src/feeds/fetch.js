// 友圈的抓取层：把后台填的地址安全地变成一段文本。重点是防 SSRF——站主填的地址会被服务器带着自身网络身份
// 访问，允许任意地址等于给外网开「读内网」的口子（云元数据 169.254.169.254、路由器后台、本机 admin 端口）：
// 只允许 http/https、不许带账号密码；字面量 IP 与解析结果都须是公网（每次跳转都重验）；限跳转次数、体积与超时。

import dns from 'node:dns/promises';
import net from 'node:net';
import http from 'node:http';
import https from 'node:https';
import { Readable } from 'node:stream';
import zlib from 'node:zlib';
import { SITE } from '../config.js';
import { readBoundedStream } from '../util/stream.js';

export class FeedError extends Error {
  // status 仅在「对方返回非 2xx」时有值，用来区分「404 地址不存在」与「403 不让读」——访客站检查器靠它决定邻居下线还是留着（见 src/links/check.js）。
  constructor(message, code = 'feed', { cause = null, status = null } = {}) {
    super(message, cause ? { cause } : undefined);
    this.name = 'FeedError';
    this.code = code;
    this.status = status;
  }
}

import { envInt } from '../util/env.js';

export const TIMEOUT_MS = envInt(process.env.FEED_TIMEOUT_MS, 8000, { min: 300, max: 60000 });
const MAX_BYTES = envInt(process.env.FEED_MAX_BYTES, 2 * 1024 * 1024, { min: 8192, max: 16 * 1024 * 1024 });
const MAX_REDIRECTS = 3;

// 测试用逃生门：本机测试服务器跑在 127.0.0.1，而 SSRF 防护拦的正是它。默认关闭、启动时 configWarnings() 会警告（与 COOKIE_INSECURE 同类）。
export const ALLOW_PRIVATE_NETWORK = process.env.FEED_ALLOW_PRIVATE === 'true';
const ALLOW_PRIVATE = ALLOW_PRIVATE_NETWORK;

// 端口白名单：友圈地址来自访客/站主填写的站点，端口不限等于借服务器之手探测任意服务（25、6379、9200…）。
// 只放常见 Web 端口；友链探活（src/links/check.js）直接复用这一份口径，免得两处规则各自漂移。
// 本机测试（FEED_ALLOW_PRIVATE=true）跑在随机端口，整体放行。
export const PUBLIC_WEB_PORTS = new Set(['', '80', '443', '8080', '8443']);
export const isPublicWebPort = (port) => PUBLIC_WEB_PORTS.has(String(port ?? ''));

/* 地址校验 */

function v4ToInt(ip) {
  const parts = ip.split('.');
  if (parts.length !== 4) return null;
  let n = 0;
  for (const p of parts) {
    const v = Number(p);
    if (!/^\d{1,3}$/.test(p) || v > 255) return null;
    n = n * 256 + v;
  }
  return n;
}

const V4_BLOCKS = [
  ['0.0.0.0', 8], ['10.0.0.0', 8], ['100.64.0.0', 10], ['127.0.0.0', 8],
  ['169.254.0.0', 16], ['172.16.0.0', 12], ['192.0.0.0', 24], ['192.0.2.0', 24],
  ['192.88.99.0', 24], ['192.168.0.0', 16], ['198.18.0.0', 15], ['198.51.100.0', 24],
  ['203.0.113.0', 24], ['224.0.0.0', 4], ['240.0.0.0', 4],
  // 掩码与基址在模块加载时算好：以前每次调用都要对 14 个网段各跑一次 v4ToInt。
].map(([base, bits]) => {
  const mask = bits === 0 ? 0 : (0xffffffff << (32 - bits)) >>> 0;
  return { mask, base: (v4ToInt(base) & mask) >>> 0 };
});

function isPrivateV4(ip) {
  const n = v4ToInt(ip);
  if (n == null) return true;   // 解析不出来 = 不认识的写法，按不安全处理
  return V4_BLOCKS.some(({ mask, base }) => ((n & mask) >>> 0) === base);
}

export function expandV6(ip) {
  let s = String(ip).toLowerCase().replace(/%.*$/, '');
  if (s.includes('.')) {
    const idx = s.lastIndexOf(':');
    const v4 = v4ToInt(s.slice(idx + 1));
    if (v4 == null) return null;
    s = `${s.slice(0, idx + 1)}${((v4 >>> 16) & 0xffff).toString(16)}:${(v4 & 0xffff).toString(16)}`;
  }
  const [head, tail] = s.split('::');
  const h = head ? head.split(':').filter(Boolean) : [];
  const t = tail ? tail.split(':').filter(Boolean) : [];
  if (h.length + t.length > 8) return null;
  const parts = [...h, ...new Array(8 - h.length - t.length).fill('0'), ...t];
  if (parts.some((p) => !/^[0-9a-f]{1,4}$/.test(p))) return null;
  return parts.map((p) => p.padStart(4, '0')).join('');
}

const v4AtTail = (hex) => `${parseInt(hex.slice(24, 26), 16)}.${parseInt(hex.slice(26, 28), 16)}.${parseInt(hex.slice(28, 30), 16)}.${parseInt(hex.slice(30, 32), 16)}`;

function isPrivateV6(ip) {
  const hex = expandV6(ip);
  if (!hex) return true;
  if (hex === '00000000000000000000000000000000') return true;                             // ::
  if (hex === '00000000000000000000000000000001') return true;                             // ::1
  // IPv4-compatible（::a.b.c.d，前 96 位全 0）：::127.0.0.1 也必须按内网处理。
  if (hex.startsWith('000000000000000000000000')) return isPrivateV4(v4AtTail(hex));
  const first = hex.slice(0, 2);
  if (first === 'fc' || first === 'fd') return true;                                       // fc00::/7
  const top = hex.slice(0, 4);
  if (top >= 'fe80' && top <= 'febf') return true;                                         // fe80::/10
  if (first === 'ff') return true;                                                         // ff00::/8 组播
  if (hex.startsWith('0100000000000000')) return true;                                     // 100::/64 discard-only
  if (hex.startsWith('20010db8')) return true;                                             // 2001:db8::/32 文档
  if (hex.startsWith('200100020000')) return true;                                         // 2001:2::/48 基准测试
  if (hex.startsWith('00000000000000000000ffff')) return isPrivateV4(v4AtTail(hex));       // ::ffff:a.b.c.d
  if (hex.startsWith('0064ff9b')) return isPrivateV4(v4AtTail(hex));                       // 64:ff9b::/96 NAT64
  // ::ffff:0:0/96 IPv4-translated（与上面的 ::ffff:0:0/96-mapped 不同段）
  if (hex.startsWith('0000000000000000ffff0000')) return isPrivateV4(v4AtTail(hex));
  if (top >= 'fec0' && top <= 'feff') return true;                                         // fec0::/10 已废弃的 site-local
  if (hex.startsWith('2002')) return true;                                                 // 2002::/16 6to4（内层可嵌私网 v4）
  if (hex.startsWith('20010000')) return true;                                             // 2001::/32 Teredo
  return false;
}

export const isPrivateAddress = (ip, family = null) => {
  const kind = family ?? net.isIP(ip);
  if (kind === 4) return isPrivateV4(ip);
  if (kind === 6) return isPrivateV6(ip);
  return true;
};

const INTERNAL_HOST_RE = /^(localhost|.*\.localhost|.*\.local|.*\.internal|.*\.localdomain|.*\.home\.arpa)$/i;

// TUN 的 fake-IP 不能作为 SSRF 校验依据。显式启用时用固定的 HTTPS DNS 取真实地址，之后仍校验所有结果并
// 固定建连地址。用哪家解析器很关键：CDN 边缘地址按"问的人在哪"给——拿海外解析器问国内站点会拿到给海外
// 客户的边缘 IP（实测 pwsz.com：1.1.1.1 给的边缘对任何 UA 都回 403/522，阿里 DoH 直接 200），于是同一台
// 机器上浏览器能开、检查器却说"未能确认"。默认先问国内解析器，答不出（个别境外域名）再退回 1.1.1.1。
const DEFAULT_DOH = ['https://dns.alidns.com/resolve', 'https://1.1.1.1/dns-query'];
const DOH_ENDPOINTS = String(process.env.FEED_DNS_DOH ?? '').split(',').map((s) => s.trim()).filter(Boolean);

async function queryDoh(endpoint, host, type, fetcher) {
  const url = new URL(endpoint);
  url.searchParams.set('name', host);
  url.searchParams.set('type', String(type));
  const response = await fetcher(url, { headers: { accept: 'application/dns-json' },
    redirect: 'error', signal: AbortSignal.timeout(5000) });
  if (!response.ok) throw new Error('DNS HTTPS request failed');
  const payload = await response.json();
  if (payload.Status !== 0) throw new Error('DNS resolution failed');
  return (payload.Answer ?? []).filter((a) => a.type === type).map((a) => {
    const family = net.isIP(a.data);
    if (family !== (type === 1 ? 4 : 6)) throw new Error('Invalid DNS address');
    return { address: a.data, family };
  });
}

export async function lookupPublicDns(host, { fetcher = fetch, endpoints = DOH_ENDPOINTS.length ? DOH_ENDPOINTS : DEFAULT_DOH } = {}) {
  let failure = null;
  for (const endpoint of endpoints) {
    try {
      const answers = (await Promise.all([1, 28].map((type) => queryDoh(endpoint, host, type, fetcher)))).flat();
      if (answers.length) return answers;
      failure = new Error('DNS resolution failed');
    } catch (error) { failure = error; }
  }
  throw failure ?? new Error('DNS resolution failed');
}

const defaultLookup = process.env.FEED_DNS_OVER_HTTPS === 'true' ? lookupPublicDns : dns.lookup;

function abortable(promise, signal) {
  if (!signal) return promise;
  signal.throwIfAborted();
  return new Promise((resolve, reject) => {
    const abort = () => reject(signal.reason);
    signal.addEventListener('abort', abort, { once: true });
    promise.then(resolve, reject).finally(() => signal.removeEventListener('abort', abort));
  });
}

// 解析一次，检查全部地址；建连只使用这些已验证的地址。
async function resolveTarget(raw, { signal, lookup = defaultLookup } = {}) {
  let url;
  try { url = new URL(String(raw ?? '').trim()); }
  catch { throw new FeedError('地址格式不对，要写成 https://example.com/feed.xml', 'bad-url'); }
  if (!['http:', 'https:'].includes(url.protocol)) throw new FeedError('只支持 http / https 地址', 'bad-scheme');
  if (url.username || url.password) throw new FeedError('地址里不要带账号密码', 'bad-url');
  const host = url.hostname.replace(/^\[|\]$/g, '');
  if (!ALLOW_PRIVATE && INTERNAL_HOST_RE.test(host)) throw new FeedError(`指向内网地址，已拒绝（${host}）`, 'private-host');
  let addresses;
  try {
    addresses = net.isIP(host) ? [{ address: host, family: net.isIP(host) }]
      : await abortable(lookup(host, { all: true, verbatim: true }), signal);
  } catch (error) {
    if (signal?.aborted) throw signal.reason;
    throw new FeedError(`域名解析不了：${host}`, 'dns', { cause: error });
  }
  if (!addresses.length) throw new FeedError(`域名解析不了：${host}`, 'dns');
  if (!ALLOW_PRIVATE && addresses.some((a) => isPrivateAddress(a.address, a.family))) {
    throw new FeedError(`指向内网或保留地址，已拒绝（${host}）`, 'private-host');
  }
  // 端口白名单放在内网判定之后：私网地址本身更值得优先报出来，而端口检查只看字面量，不会向对方发包。
  if (!ALLOW_PRIVATE && !isPublicWebPort(url.port)) {
    throw new FeedError(`地址端口不在允许范围（只允许 80/443/8080/8443，当前 ${url.port}）`, 'bad-port');
  }
  return { url, addresses };
}

// 仅测试使用（scripts/test-feed-dns.mjs）：生产路径的地址校验都在 fetchDocument 内联走 resolveTarget。
export async function assertPublicUrl(raw, options = {}) {
  return (await resolveTarget(raw, options)).url;
}

// 抓取共享 keep-alive 连接池：此前 agent:false 每次请求都重新 TCP+TLS 握手，
// 30 分钟一轮 × 4 并发、再叠加友链探活，握手开销可观。SSRF 防护与连接池无关——
// 仍靠 resolveTarget 的地址验证 + requestPinned 的自定义 lookup（首次建连同样走 pinned 解析）；
// agent 只按 origin 复用已验证过的连接。timeout 让空闲 socket 30s 后被销毁，别攥着连接不放。
const POOL = { keepAlive: true, keepAliveMsecs: 15_000, timeout: 30_000, maxSockets: 8, scheduling: 'lifo' };
const httpAgent = new http.Agent(POOL);
const httpsAgent = new https.Agent(POOL);

function requestPinned(url, addresses, { signal, headers }) {
  return new Promise((resolve, reject) => {
    const client = url.protocol === 'https:' ? https : http;
    const req = client.get(url, {
      signal, headers, agent: url.protocol === 'https:' ? httpsAgent : httpAgent,
      lookup(_host, options, callback) {
        // 地址在 resolveTarget 里已全部验证过；这里只按调用方要的 family 过滤，让 Node 拿到期望的地址族（不传则返回全部）。
        const list = options?.family ? addresses.filter((a) => a.family === options.family) : addresses;
        const chosen = list.length ? list : addresses;
        if (options.all) callback(null, chosen);
        else callback(null, chosen[0].address, chosen[0].family);
      },
    }, (incoming) => {
      const responseHeaders = new Headers();
      for (const [key, value] of Object.entries(incoming.headers)) if (value != null) {
        responseHeaders.set(key, Array.isArray(value) ? value.join(', ') : value);
      }
      const encoding = String(incoming.headers['content-encoding'] ?? '').toLowerCase();
      const decoder = encoding === 'gzip' ? zlib.createGunzip()
        : encoding === 'deflate' ? zlib.createInflate() : encoding === 'br' ? zlib.createBrotliDecompress() : null;
      const stream = decoder ? incoming.pipe(decoder) : incoming;
      if (decoder) {
        incoming.on('error', (error) => decoder.destroy(error));
        decoder.on('close', () => incoming.destroy());
        responseHeaders.delete('content-length');
      }
      resolve({ status: incoming.statusCode, ok: incoming.statusCode >= 200 && incoming.statusCode < 300,
        headers: responseHeaders, body: Readable.toWeb(stream) });
    });
    req.on('error', reject);
  });
}

/* 文本解码 */

const utf8 = (buf) => new TextDecoder('utf-8').decode(buf);
const replacementRatio = (s) => {
  if (!s.length) return 0;
  let bad = 0;
  for (const ch of s) if (ch === '\ufffd') bad++;
  return bad / s.length;
};

// 老中文博客常见 GBK/GB2312。优先用响应头 charset；没写就看 XML 声明；都没有且 UTF-8 解出一堆替换
// 字符时按 GB18030 再试（它是 GBK/GB2312 超集）。
export function decodeBody(buf, contentType = '') {
  // BOM 优先。UTF-16 的 BOM 不能漏：漏了会被当 UTF-8 解成一片乱码（即使标签写了 utf-16 也救不回来）。
  if (buf.length >= 3 && buf[0] === 0xef && buf[1] === 0xbb && buf[2] === 0xbf) return utf8(buf.subarray(3));
  if (buf.length >= 2 && buf[0] === 0xff && buf[1] === 0xfe) return new TextDecoder('utf-16le').decode(buf.subarray(2));
  if (buf.length >= 2 && buf[0] === 0xfe && buf[1] === 0xff) return new TextDecoder('utf-16be').decode(buf.subarray(2));

  const fromHeader = /charset\s*=\s*"?([\w-]+)"?/i.exec(contentType ?? '')?.[1];
  let text = utf8(buf);
  const declared = fromHeader ?? /<\?xml[^>]*encoding\s*=\s*["']([\w-]+)["']/i.exec(text.slice(0, 400))?.[1];
  const label = String(declared ?? '').toLowerCase();

  // 声明了 UTF-16 却没带 BOM：按声明的字节序解（'utf-16' 归到更常见的 LE）。
  if (label === 'utf-16' || label === 'utf-16le') return new TextDecoder('utf-16le').decode(buf);
  if (label === 'utf-16be') return new TextDecoder('utf-16be').decode(buf);

  if (label && !['utf-8', 'utf8', 'us-ascii', 'ascii'].includes(label)) {
    try { return new TextDecoder(label).decode(buf); } catch { /* 不认识的字符集标签，落到下面的兜底 */ }
  }
  if (!label && replacementRatio(text) > 0.02) {
    try { return new TextDecoder('gb18030').decode(buf); } catch { /* 用不了就保持 UTF-8 结果 */ }
  }
  return text;
}

/* 抓取 */

const userAgent = () => {
  const ua = `Mozilla/5.0 (compatible; BlogFriendCircle/1.0; +${SITE.url})`;
  // HTTP 头只能 latin-1：站名/域名含非 ASCII 时宁可用通用 UA，也不能让 fetch 抛错
  return /^[\u0020-\u007e]*$/.test(ua) ? ua : 'Mozilla/5.0 (compatible; BlogFriendCircle/1.0)';
};

const short = (s, n = 120) => String(s ?? '').replace(/\s+/g, ' ').trim().slice(0, n);

async function readLimited(res, maxBytes) {
  const declared = Number(res.headers.get('content-length'));
  if (Number.isFinite(declared) && declared > maxBytes) {
    await res.body?.cancel().catch(() => {});
    throw new FeedError(`对方内容超过 ${Math.round(maxBytes / 1024)}KB`, 'too-large');
  }
  const buf = await readBoundedStream(res.body, maxBytes);
  if (buf === null) throw new FeedError(`对方内容超过 ${Math.round(maxBytes / 1024)}KB`, 'too-large');
  return buf;
}

// 拉取一个源。redirect 手动逐跳处理（redirect:'follow' 会绕过地址校验）。
// @returns {{notModified:boolean, text?:string, etag?:string|null, lastModified?:string|null, finalUrl:string, status:number}}
export async function fetchDocument(rawUrl, { etag = null, lastModified = null, timeoutMs = TIMEOUT_MS, maxBytes = MAX_BYTES, signal: outerSignal, lookup = defaultLookup } = {}) {
  let target = String(rawUrl ?? '').trim();
  // 调用方已带超时信号（refresh.js 用 AbortSignal.timeout）时不再叠一个重复定时器，没有才自己起。
  let timer = null;
  let signal;
  if (outerSignal) {
    signal = outerSignal;
  } else {
    const controller = new AbortController();
    timer = setTimeout(() => controller.abort(new DOMException('Timed out', 'TimeoutError')), timeoutMs);
    signal = controller.signal;
  }

  try {
    for (let hop = 0; hop <= MAX_REDIRECTS; hop++) {
      let url;
      try {
        signal.throwIfAborted();
        const resolved = await resolveTarget(target, { signal, lookup });
        url = resolved.url;
        let res;
        try {
          res = await requestPinned(url, resolved.addresses, {
            signal,
            headers: {
              'user-agent': userAgent(),
              accept: 'application/atom+xml, application/rss+xml, application/xml;q=0.9, text/xml;q=0.9, text/html;q=0.8, */*;q=0.5',
              'accept-language': 'zh-CN,zh;q=0.9,en;q=0.6',
              ...(etag ? { 'if-none-match': etag } : {}),
              ...(lastModified ? { 'if-modified-since': lastModified } : {}),
            },
          });
        } catch (error) {
          const aborted = signal.aborted || error?.name === 'AbortError' || error?.name === 'TimeoutError';
  // 正常报文（如 connect ECONNREFUSED 1.2.3.4:443）只留错误码：那才是排障要看的，后面地址与英文句在后台每行都是噪音（见 util/failure.js）。
          throw new FeedError(aborted
            ? `抓取超时（${Math.max(1, Math.round(timeoutMs / 1000))} 秒）`
            : `连不上对方站点（${error?.code ?? '网络错误'}）`, aborted ? 'timeout' : 'network');
        }

        if ([301, 302, 303, 307, 308].includes(res.status)) {
          const location = res.headers.get('location');
          await res.body?.cancel().catch(() => {});
          if (!location) throw new FeedError(`对方返回 ${res.status} 跳转却没给目标地址`, 'redirect');
          let next;
          try { next = new URL(location, url).href; } catch { throw new FeedError('对方的跳转地址无法解析', 'redirect'); }
          if (hop === MAX_REDIRECTS) throw new FeedError(`跳转超过 ${MAX_REDIRECTS} 次`, 'redirect');
          target = next;
          continue;
        }

        if (res.status === 304) {
          await res.body?.cancel().catch(() => {});
          return { notModified: true, status: 304, finalUrl: url.href, etag: res.headers.get('etag'), lastModified: res.headers.get('last-modified') };
        }

        if (!res.ok) {
          await res.body?.cancel().catch(() => {});
          // 只有 404 配解释（「地址填错了」是可执行动作）。403 不解释：实测多半是 WAF 按来源 IP 拦，写成「可能需要浏览器 UA」会引错方向；行里只留 `403 拒绝访问`（见 util/failure.js）。
          const hint = res.status === 404 ? '（这个地址不存在）' : '';
          throw new FeedError(`对方返回 HTTP ${res.status}${hint}`, 'http', { status: res.status });
        }

        const type = (res.headers.get('content-type') ?? '').toLowerCase();
        if (type.includes('json')) {
          await res.body?.cancel().catch(() => {});
          throw new FeedError('对方返回的是 JSON Feed，目前只支持 RSS / Atom', 'content-type');
        }
        if (type && !/xml|rss|atom|text\/plain|text\/html|octet-stream/.test(type)) {
          await res.body?.cancel().catch(() => {});
          throw new FeedError(`对方返回的是 ${short(type, 40)}，不是订阅源`, 'content-type');
        }

        const buf = await readLimited(res, maxBytes);
        return {
          notModified: false,
          text: decodeBody(buf, type),
          status: res.status,
          finalUrl: url.href,
          etag: res.headers.get('etag'),
          lastModified: res.headers.get('last-modified'),
        };
      } catch (error) {
        if (error instanceof FeedError) throw error;
        // 超时可能在建连/等响应头/读响应体三个阶段，抛出的都是同类 abort 错误，这里统一翻成人话——从「This operation was aborted」看不出是对方太慢。
        const aborted = signal.aborted || error?.name === 'AbortError' || error?.name === 'TimeoutError';
        throw new FeedError(aborted
          ? `抓取超时（${Math.max(1, Math.round(timeoutMs / 1000))} 秒没读完）`
          : `读不到对方内容（${error?.code ?? '连接中断'}）`, aborted ? 'timeout' : 'network');
      }
    }
    throw new FeedError(`跳转超过 ${MAX_REDIRECTS} 次`, 'redirect');
  } finally { if (timer) clearTimeout(timer); }
}

/* 自动发现 */

const attrOf = (tag, name) => {
  const m = new RegExp(`\\s${name}\\s*=\\s*("([^"]*)"|'([^']*)'|([^\\s"'>]+))`, 'i').exec(tag);
  return m?.[2] ?? m?.[3] ?? m?.[4] ?? '';
};

// 从网页找 `<link rel="alternate" type="application/rss+xml" href=...>`：站主常只记得主页，让服务端自己发现订阅地址比要求他翻源码友好。
export function discoverFeeds(html, baseUrl) {
  const found = [];
  for (const m of String(html ?? '').matchAll(/<link\b[^>]*>/gi)) {
    const tag = m[0];
    const rel = attrOf(tag, 'rel');
    const type = attrOf(tag, 'type').toLowerCase();
    const href = attrOf(tag, 'href');
    if (!rel || !/\balternate\b/i.test(rel)) continue;
    if (type && !/rss|atom|\+xml/.test(type)) continue;
    if (!href) continue;
    try {
      const url = new URL(href, baseUrl);
      if (url.protocol === 'http:' || url.protocol === 'https:') found.push(url.href);
    } catch { /* 坏链接直接忽略 */ }
  }
  return [...new Set(found)];
}

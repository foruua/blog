import crypto from 'node:crypto';
import { gzip, brotliCompress, constants as zlibConstants } from 'node:zlib';
import { promisify } from 'node:util';
import { envInt } from '../util/env.js';
import { acceptsEncoding, ifNoneMatch } from '../util/http.js';
import { mediaRevision } from '../media/revision.js';

const gzipAsync = promisify(gzip);
const brotliAsync = promisify(brotliCompress);

// 与 server.js 的静态资源清单解耦：调用方传入 isImmutableAsset 判定即可。
const NON_HTML_PATH_RE = /^\/(?:admin|moderate|unsubscribe|healthz|api|avatar|uploads|theme-assets|site)(?:$|\/)|^\/(?:feed\.xml|atom\.xml|feed\.json|sitemap\.xml|robots\.txt|site\.webmanifest|favicon\.ico)$/;
const HTML_CACHE_QUERY_KEYS = new Set([
  'before', 'n', 'cpage', 'reply', 'c', 'partial', 'panel', 'suffix', 'q', 'kind', 'page',
]);
const TS_TOKEN_RE = /(name="ts" value=")([^"]*)(")/g;

/**
 * 匿名 HTML 页面缓存 + 弱 ETag + 自带 br/gzip。
 *
 * 页面发 `Cache-Control: no-cache`（每次回源校验，避免引用旧指纹的 nav.js/style.css），
 * 但仍用内容修订号缓存匿名 HTML，命中时直接回；内容/评论/设置/媒体/主题任何一处变了修订号就变。
 * 两个必须一起处理的点：
 *   1. 评论时间戳令牌每次渲染都不同，会把正文哈希冲掉——只对「哈希」这一步归一到小时档；命中时重新签发。
 *   2. Cloudflare 会改写/重压 HTML 并丢掉源站 ETag；加 `no-transform` 才肯透传，而 Hono 的 compress()
 *      见这条头就不压了，所以 HTML 的 br/gzip 在这里自己做。
 */
export function createHtmlCache({
  repo, themes, crypt, isImmutableAsset = () => false,
  ttlMs = envInt(process.env.HTML_CACHE_TTL_MS, 60_000, { min: 0, max: 60 * 60 * 1000 }),
  maxEntries = 200, maxChars = 8 * 1024 * 1024, maxBody = 2 * 1024 * 1024,
}) {
  const enabled = ttlMs > 0;
  const cache = new Map();
  let chars = 0;
  // 记账要含压缩副本：无令牌页面的条目上会挂 br/gzip 两份 Buffer（见 compressedFor），
  // 只算 body 的话实际峰值内存可达声明预算的 ~3 倍。
  const encBytes = (entry) => (entry.enc ? Object.values(entry.enc).reduce((n, b) => n + b.length, 0) : 0);

  function drop(key) {
    const entry = cache.get(key);
    if (!entry) return;
    chars -= entry.body.length + encBytes(entry);
    cache.delete(key);
  }

  function get(key, revision) {
    if (!enabled) return null;
    const entry = cache.get(key);
    if (!entry) return null;
    if (Date.now() - entry.at > ttlMs || entry.revision !== revision) {
      drop(key);
      return null;
    }
    // 插入序当 LRU：命中后挪到队尾。
    cache.delete(key);
    cache.set(key, entry);
    return entry;
  }

  function set(key, entry) {
    if (!enabled || entry.body.length > maxBody) return;
    drop(key);
    while (cache.size >= maxEntries || chars + entry.body.length > maxChars) {
      const first = cache.keys().next();
      if (first.done) break;
      drop(first.value);
    }
    cache.set(key, entry);
    chars += entry.body.length;
  }

  // 缓存键只保留会改变正文的查询参数：任意 ?utm_/随机参数不应各开一份缓存把条目挤空。
  // 用 URL 原始 pathname 保留尾斜杠差异（Hono 的 c.req.path 会把 /posts/ 归一成 /posts）。
  const keyOf = (c) => {
    let url;
    try { url = new URL(c.req.url); } catch { return c.req.path; }
    const parts = [];
    for (const key of [...new Set(url.searchParams.keys())].sort()) {
      if (!HTML_CACHE_QUERY_KEYS.has(key)) continue;
      for (const value of url.searchParams.getAll(key)) parts.push(`${encodeURIComponent(key)}=${encodeURIComponent(value)}`);
    }
    return parts.length ? `${url.pathname}?${parts.join('&')}` : url.pathname;
  };

  const cacheable = (c) => {
    if (!enabled || c.req.method !== 'GET') return false;
    if (NON_HTML_PATH_RE.test(c.req.path) || isImmutableAsset(c.req.path)) return false;
    // 任何后台会话（包括伪造的）都不走缓存：作者表单、CSRF、主题预览只属于这个浏览器。
    if (/(?:^|;\s*)blog_admin=/.test(c.req.header('cookie') ?? '')) return false;
    return true;
  };

  // 页面修订号只由会影响 HTML 的东西组成：DB 写入（文章/评论/设置/别名）、媒体变体、当前主题模板签名。
  function revisionOf(c) {
    let rev = c.get('pageRevision');
    if (rev === undefined) {
      let theme = null;
      try { theme = themes.active(); } catch { /* 主题错误由渲染层兜底 */ }
      rev = `${repo.changeStamp?.() ?? ''}|${mediaRevision(repo)}|${theme?.id ?? ''}:${theme?.signature ?? ''}`;
      c.set('pageRevision', rev);
    }
    return rev;
  }

  // 只刷新正文里的评论时间戳令牌；其它内容（包括 CSRF）原样返回。缓存 60 秒，令牌有效期 24 小时，安全边界不变。
  function refreshTokens(text) {
    return text.replace(TS_TOKEN_RE, (match, open, token, close) => {
      const payload = crypt.verify(token);
      if (!payload || payload.purpose !== 'comment-ts' || !Number.isInteger(payload.p)) return match;
      return open + crypt.sign({ purpose: 'comment-ts', ts: Date.now(), p: payload.p }, 24 * 3600) + close;
    });
  }

  // 压缩结果缓存在条目上：没有评论表单的页面（首页/列表/友圈/友链/固定页）正文在 TTL 内逐字节不变，
  // 命中时可以直接复用压缩字节，省掉整页 Brotli。带 ts 令牌的页面不行——令牌每次都要重签，
  // 压缩字节也就跟着变，只能照旧每次重压。
  const MIN_COMPRESS_BYTES = 1024;
  const ENCODINGS = ['br', 'gzip'];

  function compressOnce(body, encoding) {
    return encoding === 'br'
      ? brotliAsync(body, { params: { [zlibConstants.BROTLI_PARAM_QUALITY]: 5 } })
      : gzipAsync(body);
  }

  // 现压（令牌刷新过、或条目里没有缓存）：优先 Brotli，失败再退 gzip，都失败就发原文。
  async function compressNow(text, accepted) {
    const body = Buffer.from(text, 'utf8');
    if (body.length < MIN_COMPRESS_BYTES) return null;
    for (const encoding of ENCODINGS) {
      if (!acceptsEncoding(accepted, encoding)) continue;
      try { return { body: await compressOnce(body, encoding), encoding }; } catch { /* 换下一种 */ }
    }
    return null;
  }

  async function compressedFor(entry, accepted) {
    if (entry.body.length < MIN_COMPRESS_BYTES) return null;
    const body = Buffer.from(entry.body, 'utf8');
    for (const encoding of ENCODINGS) {
      if (!acceptsEncoding(accepted, encoding)) continue;
      const cached = entry.enc?.[encoding];
      if (cached) return { body: cached, encoding };
      let out;
      try { out = await compressOnce(body, encoding); } catch { continue; }
      // 有令牌的页面下次还得重签，缓存这份压缩字节没有意义。
      if (!entry.hasTokens) {
        (entry.enc ??= {})[encoding] = out;
        chars += out.length;   // 压缩副本也要计入内存预算（见 encBytes）
      }
      return { body: out, encoding };
    }
    return null;
  }

  async function respond(c, entry, cacheStatus = '') {
    const headers = new Headers(entry.headers);
    headers.set('ETag', `W/${entry.tag}`);
    headers.set('Cache-Control', 'no-cache, no-transform');
    headers.set('Vary', 'Accept-Encoding');
    const requestId = c.get('requestId');
    if (requestId) headers.set('X-Request-Id', requestId);
    if (cacheStatus) headers.set('X-Page-Cache', cacheStatus);

    // ETag 已经把令牌归一到小时档：304 不需要刷新令牌或压缩。
    if (ifNoneMatch(c, entry.tag)) {
      headers.delete('Content-Length');
      headers.delete('Content-Encoding');
      c.res = new Response(null, { status: 304, headers });
      return;
    }

    const text = cacheStatus === 'HIT' && entry.hasTokens ? refreshTokens(entry.body) : entry.body;
    // 与 hono/compress 同口径：小于 1KB 不压。优先 Brotli，不支持再回 gzip。
    // 令牌刷新过的正文与条目里的那份不同，必须现压；否则直接吃条目里缓存好的压缩字节。
    const fresh = text !== entry.body;
    const compressed = fresh
      ? await compressNow(text, c.req.header('accept-encoding') ?? '')
      : await compressedFor(entry, c.req.header('accept-encoding') ?? '');
    if (compressed) {
      headers.set('Content-Encoding', compressed.encoding);
      headers.set('Content-Length', String(compressed.body.length));
      c.res = new Response(compressed.body, { status: 200, headers });
      return;
    }
    const body = fresh ? Buffer.from(text, 'utf8') : Buffer.from(entry.body, 'utf8');
    headers.set('Content-Length', String(body.length));
    c.res = new Response(body, { status: 200, headers });
  }

  async function middleware(c, next) {
    const canCache = cacheable(c);
    const key = canCache ? keyOf(c) : '';
    const revision = canCache ? revisionOf(c) : '';
    if (canCache) {
      const hit = get(key, revision);
      if (hit) return respond(c, hit, 'HIT');
    }

    await next();
    if (c.req.method !== 'GET' || !c.res || c.res.status !== 200) return;
    const contentType = c.res.headers.get('Content-Type') ?? '';
    if (!contentType.includes('text/html')) return;

    const path = c.req.path;
    const adminCookie = /(?:^|;\s*)blog_admin=/.test(c.req.header('cookie') ?? '');
    // 后台/审核/退订页永远不缓存，保持原行为：后台会话 private, no-store，公开 token 页由安全头兜 no-store。
    if (path.startsWith('/admin') || path.startsWith('/moderate/') || path.startsWith('/unsubscribe/')) {
      if (adminCookie && path.startsWith('/admin')) c.header('Cache-Control', 'private, no-store');
      return;
    }
    if (adminCookie) { c.header('Cache-Control', 'private, no-store'); return; }
    if ((c.res.headers.get('Cache-Control') ?? '').includes('no-store')) return;
    // 任何会种 cookie 的 HTML 都不进共享缓存；直接交回原响应，避免重建 headers 时把 Set-Cookie 丢掉。
    if (c.res.headers.has('Set-Cookie')) return;

    let body;
    try { body = Buffer.from(await c.res.clone().arrayBuffer()); } catch { return; }
    const text = body.toString('utf8');
    // 令牌归一化只影响哈希：正文里仍是当次新签发的令牌，服务端 3 秒防抖检查不受影响。
    const stamp = Math.floor(Date.now() / 3600000);
    const hasTokens = text.includes('name="ts"');
    const sealed = hasTokens
      ? text.replace(/(name="ts" value=")[^"]*(")/g, `$1hb${stamp}$2`)
      : text;
    const tag = `"${crypto.createHash('sha1').update(sealed).digest('base64url')}"`;
    const headers = { 'Content-Type': contentType };
    const language = c.res.headers.get('Content-Language');
    if (language) headers['Content-Language'] = language;
    // hasTokens 决定压缩字节能不能在命中时复用（见 compressedFor）。
    const entry = { at: Date.now(), revision, tag, body: text, headers, hasTokens, enc: null };
    const cacheStatus = canCache ? 'MISS' : '';
    if (cacheStatus) set(key, entry);
    return respond(c, entry, cacheStatus);
  }

  return { middleware };
}

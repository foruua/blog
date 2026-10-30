import crypto from 'node:crypto';
import { envInt } from '../util/env.js';
import { acceptsEncoding, ifNoneMatch } from '../util/http.js';
import { parseReplyId } from '../util/validation.js';
import { compressBuffer, MIN_COMPRESS_BYTES } from '../util/compress.js';
import { ADMIN_COOKIE } from './cookies.js';
import { pageRevisionOf } from '../content/revision.js';

// 与 server.js 的静态资源清单解耦：调用方传入 isImmutableAsset 判定即可。
const NON_HTML_PATH_RE = /^\/(?:admin|moderate|unsubscribe|healthz|api|avatar|uploads|theme-assets)(?:$|\/)|^\/(?:feed\.xml|atom\.xml|feed\.json|sitemap\.xml|robots\.txt|site\.webmanifest|favicon\.ico)$/;
// 后台会话 cookie 名与 admin/auth.js 同源；用正则判断「有没有这个 cookie」，不解析值。
const ADMIN_COOKIE_RE = new RegExp(`(?:^|;\\s*)${ADMIN_COOKIE}=`);
// 只缓存能可靠归一化的查询参数：page/cpage 是页码，reply 是评论 id，kind 是归档筛选。
// q/before/c/partial 会改变正文且取值空间不设限，直接不缓存——
// 以前任意 ?q=、?before=、?page=999999 都各开一条 key，200 条随机请求就能把整页缓存冲掉。
const CACHEABLE_QUERY = new Set(['page', 'cpage', 'reply', 'kind']);
// 这些参数会改变正文且取值不受限：带它们就完全不进共享缓存，避免随机 q/before 把 200 条缓存冲掉。
// （抽屉时代的 panel/suffix 已无调用方；n 只承载旧 /notes/?n=<slug> 的 301，见下面的 legacyNoteQuery。）
const UNCACHEABLE_QUERY = new Set(['before', 'c', 'partial', 'q']);
// 旧 /notes/?n=<slug> 要按 slug 301 到正文页。共享缓存若命中列表页，路由根本不会跑，旧链接就退回列表了；
// 因此这条地址一律跳过缓存（n 的值不进键，进去只会开出无数条无意义键）。
const legacyNoteQuery = (c) => c.req.path === '/notes' && c.req.query('n') !== undefined;

/**
 * 匿名 HTML 页面缓存 + 弱 ETag + 自带 br/gzip。
 *
 * 页面默认发 `public, max-age=15, s-maxage=15, stale-while-revalidate=60, no-transform`：
 * 浏览器与 EdgeOne 可在 15 秒内直出，回访/前进后退不必回源；超时后仍用弱 ETag 校验。
 * 服务端匿名 HTML 缓存命中时直接回；内容/评论/设置/媒体/主题任何一处变了修订号就变。
 * 两个必须一起处理的点：
 *   1. 评论时间戳令牌每次渲染都不同，会把正文哈希冲掉——因此 ETag 不再取正文哈希，而是由
 *      修订号与缓存键派生；正文里的令牌随条目一起复用（见下）。
 *      代价是「至少 3 秒才填完」这条启发式检查在 TTL 内可以用旧令牌绕过——
 *      它本来也不是鉴权边界，机器人等 3 秒同样能过，不值得为它牺牲整页压缩复用。
 *   2. Cloudflare 会改写/重压 HTML 并丢掉源站 ETag；加 `no-transform` 才肯透传，而 Hono 的 compress()
 *      见这条头就不压了，所以 HTML 的 br/gzip 在这里自己做。
 */
export function createHtmlCache({
  repo, isImmutableAsset = () => false,
  ttlMs = envInt(process.env.HTML_CACHE_TTL_MS, 60_000, { min: 0, max: 60 * 60 * 1000 }),
  maxEntries = 200, maxChars = 8 * 1024 * 1024, maxBody = 2 * 1024 * 1024,
  // 页码只缓存到这个上限：路由会把超大页码 clamp 到最后一页，若每个页码都开一条键，
  // 200 个 ?page=随机数 就能把整页缓存冲掉，还顺带放大 CPU（每次都完整渲染 + Brotli）。
  maxPage = 200,
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
    // body 是 JS 字符串，直接 length 在中文页面上只有实际 UTF-8 字节的 1/3；记账必须按字节。
    chars -= (entry.bytes ?? Buffer.byteLength(entry.body, 'utf8')) + encBytes(entry);
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
    entry.bytes = Buffer.byteLength(entry.body, 'utf8');
    // 同一 key 的旧条目先删：新版本超过 maxBody 时不能继续把旧版本留在缓存里。
    drop(key);
    if (!enabled || entry.bytes > maxBody) return;
    while (cache.size >= maxEntries || chars + entry.bytes > maxChars) {
      const first = cache.keys().next();
      if (first.done) break;
      drop(first.value);
    }
    cache.set(key, entry);
    chars += entry.bytes;
  }

  // 缓存键只保留会改变正文、且能归一化到有限集合的查询参数。
  // 返回 null = 这条请求不缓存（含随机/深链参数），避免缓存被无限 key 冲掉。
  const keyOf = (c) => {
    let url;
    try { url = c.get?.('requestUrl') ?? new URL(c.req.url); } catch { return c.req.path; }
    // 路径也要归一：/p/%73lug/ 与 /p/slug/ 是同一个页面，用原始 pathname 会被编码出无数条键。
    // decodeURI 只解非保留字符（%2F 等保持原样），不会把路径段切分改变。
    let pathname = url.pathname;
    try { pathname = decodeURI(pathname); } catch { /* 坏转义保留原样，交给路由 404 */ }
    const parts = [];
    for (const key of new Set(url.searchParams.keys())) {
      if (UNCACHEABLE_QUERY.has(key)) return null;
      if (!CACHEABLE_QUERY.has(key)) continue;   // UTM 等无关参数：共享同一条缓存，不另开 key
      const raw = url.searchParams.get(key) ?? '';
      if (key === 'page' || key === 'cpage') {
        const n = Number.parseInt(raw, 10);
        // 页码越界不缓存：路由会 clamp 到最后一页，为它单独开键只会挤掉真实页面。
        if (!Number.isFinite(n) || n < 1 || n > maxPage) return null;
        parts.push(`${key}=${n}`);
      } else if (key === 'reply') {
        // 与路由共用严格口径（见 util/validation.js 的 parseReplyId）：解析不出就整条不缓存。
        // 绝不能「算成 0 就忽略」——那会让带非法 reply 的回复页落进裸路径键，污染所有读者。
        const n = parseReplyId(raw);
        if (n === null) return null;
        parts.push(`reply=${n}`);
      } else if (key === 'kind') {
        if (raw === 'post' || raw === 'note') parts.push(`kind=${raw}`);
      }
    }
    parts.sort();
    return parts.length ? `${pathname}?${parts.join('&')}` : pathname;
  };

  const cacheable = (c) => {
    if (!enabled || c.req.method !== 'GET') return false;
    if (legacyNoteQuery(c)) return false;
    if (NON_HTML_PATH_RE.test(c.req.path) || isImmutableAsset(c.req.path)) return false;
    // 任何后台会话（包括伪造的）都不走缓存：作者表单、CSRF、主题预览只属于这个浏览器。
    if (ADMIN_COOKIE_RE.test(c.req.header('cookie') ?? '')) return false;
    return true;
  };

  // 页面修订号只由会影响 HTML 的东西组成：DB 写入、媒体变体、主题模板签名（拼装口径见 content/revision.js）。
  function revisionOf(c) {
    let rev = c.get('pageRevision');
    if (rev === undefined) {
      rev = pageRevisionOf(repo);
      c.set('pageRevision', rev);
    }
    return rev;
  }

  // 压缩结果缓存在条目上：没有评论表单的页面（首页/列表/友圈/友链/固定页）正文在 TTL 内逐字节不变，
  // 命中时可以直接复用压缩字节，省掉整页 Brotli。带 ts 令牌的页面不行——令牌每次都要重签，
  // 压缩字节也就跟着变，只能照旧每次重压。
  const ENCODINGS = ['br', 'gzip'];

  function compressOnce(body, encoding) {
    return compressBuffer(body, encoding);
  }

  async function compressedFor(entry, accepted, key) {
    if ((entry.bytes ?? Buffer.byteLength(entry.body, 'utf8')) < MIN_COMPRESS_BYTES) return null;
    const body = Buffer.from(entry.body, 'utf8');
    for (const encoding of ENCODINGS) {
      if (!acceptsEncoding(accepted, encoding)) continue;
      const cached = entry.enc?.[encoding];
      if (cached) return { body: cached, encoding };
      let out;
      try { out = await compressOnce(body, encoding); } catch { continue; }
      // 压缩副本也计入内存预算：set() 只按正文长度放行，若再无条件挂上 br+gzip，
      // 实际占用会越过 maxChars；超预算时本次照常返回，只是不落缓存。
      // 关键：await 期间条目可能已被修订号变化或 LRU 淘汰（甚至压根没被 set 进去），
      // 这时挂副本等于把内存记在一个已经不在缓存里的对象上，chars 只增不减，
      // 攒够 maxChars 之后每次 set() 都要清空整个缓存 —— HTML 缓存长期处于失效状态。
      if (chars + out.length <= maxChars && cache.get(key) === entry) {
        (entry.enc ??= {})[encoding] = out;
        chars += out.length;   // 压缩副本也要计入内存预算（见 encBytes）
      }
      return { body: out, encoding };
    }
    return null;
  }

  // 页面在浏览器/边缘（EdgeOne）可直出的秒数。匿名页内容变化会 bump revision，但客户端拿到的副本
  // 在 max-age 内不会回源，所以别设大：默认 15 秒足够让回访与前进后退免掉一次 RTT。
  // 超时后回源校验；stale-while-revalidate 允许网络慢时先给旧副本、后台再刷新（最多再旧 4×max-age）。
  // 0 = 退回每次回源校验的 no-cache。静态资源仍由内容指纹 + immutable 长缓存。
  const maxAge = envInt(process.env.HTML_MAX_AGE_S, 15, { min: 0, max: 3600 });
  const pageCacheControl = maxAge > 0
    ? `public, max-age=${maxAge}, s-maxage=${maxAge}, stale-while-revalidate=${maxAge * 4}, stale-if-error=300, no-transform`
    : 'no-cache, no-transform';

  async function respond(c, entry, cacheStatus = '', key = '') {
    const headers = new Headers(entry.headers);
    headers.set('ETag', `W/${entry.tag}`);
    headers.set('Cache-Control', pageCacheControl);
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

    // 与 hono/compress 同口径：小于 1KB 不压。优先 Brotli，不支持再回 gzip。
    // 正文在 TTL 内逐字节不变（令牌也复用），直接吃条目里缓存好的压缩字节。
    const compressed = await compressedFor(entry, c.req.header('accept-encoding') ?? '', key);
    if (compressed) {
      headers.set('Content-Encoding', compressed.encoding);
      headers.set('Content-Length', String(compressed.body.length));
      c.res = new Response(compressed.body, { status: 200, headers });
      return;
    }
    const body = Buffer.from(entry.body, 'utf8');
    headers.set('Content-Length', String(body.length));
    c.res = new Response(body, { status: 200, headers });
  }

  async function middleware(c, next) {
    // 关闭缓存时必须完全透明：早期版本仍会在 next() 后重建 entry/重压正文/改 Cache-Control，
    // 让 HTML_CACHE_TTL_MS=0 看起来关不掉缓存。
    if (!enabled) return next();
    let canCache = cacheable(c);
    let key = canCache ? keyOf(c) : '';
    // 含不可归一化参数的请求不进缓存（见 keyOf）；仍正常渲染，只是不写共享缓存。
    if (key === null) { canCache = false; key = ''; }
    const revision = canCache ? revisionOf(c) : '';
    // 请求里带的 reply 与路由实际采用的回复不一致时（不存在、不属于本篇、未过审），
    // 渲染出来其实是「没有回复目标」的普通页面，不能写进共享缓存 —— 否则每条
    // ?reply=<任意数字> 都会占一个键，缓存瞬间被冲掉。
    const rawReply = canCache ? c.req.query('reply') : undefined;
    const requestedReply = rawReply === undefined ? undefined : parseReplyId(rawReply);
    if (canCache) {
      const hit = get(key, revision);
      if (hit) return respond(c, hit, 'HIT', key);
    }

    await next();
    if (c.req.method !== 'GET' || !c.res || c.res.status !== 200) return;
    const contentType = c.res.headers.get('Content-Type') ?? '';
    if (!contentType.includes('text/html')) return;

    const path = c.req.path;
    const adminCookie = ADMIN_COOKIE_RE.test(c.req.header('cookie') ?? '');
    // 后台/审核/退订页永远不缓存，保持原行为：后台会话 private, no-store，公开 token 页由安全头兜 no-store。
    if (path.startsWith('/admin') || path.startsWith('/moderate/') || path.startsWith('/unsubscribe/')) {
      if (adminCookie && path.startsWith('/admin')) c.header('Cache-Control', 'private, no-store');
      return;
    }
    if (adminCookie) { c.header('Cache-Control', 'private, no-store'); return; }
    // 不可归一化参数的匿名页：正常返回原响应，不重建/不压缩，也不写缓存。
    if (!canCache) return;
    // 带 reply 但路由没采纳（见上面 requestedReply 的说明）：正文其实与裸页面等价，
    // 不写共享缓存，也不发 public 缓存头，避免这条随机键被浏览器/边缘长期留着。
    if (requestedReply !== undefined && c.get('commentReplyId') !== requestedReply) return;
    if ((c.res.headers.get('Cache-Control') ?? '').includes('no-store')) return;
    // 任何会种 cookie 的 HTML 都不进共享缓存；直接交回原响应，避免重建 headers 时把 Set-Cookie 丢掉。
    if (c.res.headers.has('Set-Cookie')) return;

    let body;
    try { body = Buffer.from(await c.res.clone().arrayBuffer()); } catch { return; }
    const text = body.toString('utf8');
    // ETag 由「页面修订号 + 缓存键」派生，而不是正文哈希：正文里有 relativeDate()「N 分钟前」
    // 这类随时间窗变化的文案，按哈希会让 tag 跟着漂移，TTL 一过 304 几乎永不命中。
    // 用弱 ETag 表示「语义相同、字节可能不同」，正好符合这里的要求。
    const tag = `"${crypto.createHash('sha1').update(`${revision}|${key}`).digest('base64url')}"`;
    const headers = { 'Content-Type': contentType };
    const language = c.res.headers.get('Content-Language');
    if (language) headers['Content-Language'] = language;
    const entry = { at: Date.now(), revision, tag, body: text, headers, enc: null };
    set(key, entry);
    return respond(c, entry, 'MISS', key);
  }

  return { middleware };
}

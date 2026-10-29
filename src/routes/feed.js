import { Hono } from 'hono';
import crypto from 'node:crypto';
import { SITE } from '../config.js';
import { cleanExcerpt, esc, rfc822, formatDay, utcDate, decodeHtmlAttribute, pageUrl, postUrl, absUrl } from '../util/text.js';
import { ifNoneMatch, clientKey } from '../util/http.js';
import { createAntispam } from '../comments/antispam.js';

const cdata = (s) => `<![CDATA[${String(s ?? '').replace(/]]>/g, ']]]]><![CDATA[>')}]]>`;

// 条件请求校验值：Feed/sitemap 每次命中都重扫库，没它客户端只能整份重下；只取最新改动时间 + 条目数，本地比较不额外查库（内容真变了 updated_at 就变）。
// 时间必须先归一化再比：updated_at 是 SQLite 的 "YYYY-MM-DD HH:MM:SS"，published_at 是 "...T...Z"。
// 直接字符串比较时，同一天里空格 (0x20) 小于 T，updated_at 会永远输给 published_at，当天改文后 ETag 不变、
// 客户端一直 304。统一成 ISO 后再比，格式不同也不会漏更新。
const stampIso = (value) => {
  const d = utcDate(value ?? '');
  return Number.isNaN(d.getTime()) ? '' : d.toISOString();
};
const stampOf = (rows) => rows.reduce((newest, r) => {
  const t = stampIso(r.updated_at || r.published_at);
  return t > newest ? t : newest;
}, '');
// 同 server.js 静态资源那套：拆逗号、去 W/ 前缀、认 *（共用 util/http.js 的 ifNoneMatch）。
const notModified = ifNoneMatch;
// 日期兜底：published_at/updated_at 畸形时 Invalid Date.toISOString() 会抛 RangeError，一条脏数据就能让整个 Feed 500；解析不出退回当前时间。
const safeIso = (value, fallback = new Date()) => {
  if (value == null || value === '') return fallback.toISOString();
  const d = value instanceof Date ? value : new Date(value);
  return (Number.isNaN(d.getTime()) ? fallback : d).toISOString();
};
// RSS <pubDate> 同样要兜底：畸形日期会让 rfc822 输出 "Invalid Date" 字符串直接进 XML。
const safeRfc822 = (value) => rfc822(safeIso(value));
// 三个 Feed 的 ETag 只差前缀：内容指纹 + 条目数 + 渲染修订号。304 必须回带 ETag，故把响应一并算好。
// 渲染修订号单独算：全量重渲染保留 updated_at 后（见 db/repo.js 的 preserveUpdatedAt），正文 HTML
// 仍可能因渲染器/媒体变体变化而变；只靠时间戳会让 Feed 一直 304。
const conditionalOf = (c, tag, rows, renderRevision = '') => {
  const etag = `"${tag}-${stampOf(rows)}-${rows.length}-${renderRevision}"`;
  return { etag, cached: notModified(c, etag) ? c.body(null, 304, { ETag: etag }) : null };
};
// 内容地址只用 postUrl() 一个口径——以前自己拼 kind==='note'?'/n':'/p'，固定页会拼成 404 的 /p/<slug>/。
const urlOf = (p) => postUrl(p);

export function feedRoutes(repo) {
  const app = new Hono({ strict: false });

  // Feed/sitemap 是公开的高成本端点：30 秒内存缓存 + 每 IP 120 次/分钟。缓存键含归一化后的 limit，
  // 响应体/ETag 一起缓存；命中时连 XML 拼接和数据库读取都省掉。
  const responseCache = new Map();
  const FEED_CACHE_TTL = 30_000;
  const FEED_CACHE_MAX_ENTRIES = 24;
  const FEED_CACHE_MAX_BYTES = 8 * 1024 * 1024;
  let responseCacheBytes = 0;
  // 默认 20 篇；允许 ?limit= 覆盖，夹在 1–50，避免一次拉全站。原始 query 不能直接进 key：
  // `?limit=020`、`?limit=20`、`?limit=+20` 会各自开一个永久条目。
  const limitOf = (c) => {
    const n = Number(c.req.query('limit'));
    return Number.isInteger(n) && n > 0 ? Math.min(50, n) : 20;
  };
  const cacheKeyOf = (c) => (c.req.path === '/sitemap.xml'
    ? c.req.path
    : `${c.req.path}?limit=${limitOf(c)}`);
  function cacheDelete(key) {
    const old = responseCache.get(key);
    if (!old) return;
    responseCacheBytes -= old.bytes ?? Buffer.byteLength(old.body, 'utf8');
    responseCache.delete(key);
  }
  function cacheSet(key, entry) {
    cacheDelete(key);
    entry.bytes = Buffer.byteLength(entry.body, 'utf8');
    if (entry.bytes > FEED_CACHE_MAX_BYTES) return;
    while (responseCache.size >= FEED_CACHE_MAX_ENTRIES
      || responseCacheBytes + entry.bytes > FEED_CACHE_MAX_BYTES) {
      const first = responseCache.keys().next();
      if (first.done) break;
      cacheDelete(first.value);
    }
    responseCache.set(key, entry);
    responseCacheBytes += entry.bytes;
  }
  const feedLimit = createAntispam({ windowMs: 60_000, maxPerWindow: 120 });
  app.use('*', async (c, next) => {
    if (c.req.method !== 'GET') return next();
    const p = c.req.path;
    if (!['/feed.xml', '/atom.xml', '/feed.json', '/sitemap.xml'].includes(p)) return next();
    if (feedLimit.rateLimited(clientKey(c))) {
      c.header('Retry-After', '60');
      return c.text('请求过于频繁，请稍后再试。', 429);
    }
    const key = cacheKeyOf(c);
    // 有写入就必须重建：不能为了省一次查询让客户端 30 秒内一直收到旧 ETag。
    const stamp = typeof repo.contentStamp === 'function' ? repo.contentStamp() : (typeof repo.changeStamp === 'function' ? repo.changeStamp() : '');
    const hit = responseCache.get(key);
    if (hit && Date.now() - hit.at >= FEED_CACHE_TTL) cacheDelete(key);
    const fresh = responseCache.get(key);
    if (fresh && fresh.stamp === stamp) {
      if (fresh.etag && ifNoneMatch(c, fresh.etag)) return c.body(null, 304, { ETag: fresh.etag });
      return c.body(fresh.body, 200, { 'Content-Type': fresh.type, ETag: fresh.etag });
    }
    // 冷缓存（进程刚重启/条目过期）不能直接让路由走 304：那会把 304 发回客户端却不填充缓存，
    // 之后每个带旧 ETag 的请求仍然 304，缓存可能永远热不起来。先摘掉条件头渲染一份 200 存进去。
    if (c.req.header('if-none-match')) {
      const headers = new Headers(c.req.raw.headers);
      headers.delete('if-none-match');
      c.req.raw = new Request(c.req.raw, { headers });
    }
    await next();
    if (c.res.status !== 200) return;
    try {
      const body = await c.res.clone().text();
      // 读库到响应生成之间若发生过写入，这份 body 可能已经旧了：丢弃，别把旧内容记到新版本号下。
      const after = typeof repo.contentStamp === 'function' ? repo.contentStamp() : (typeof repo.changeStamp === 'function' ? repo.changeStamp() : '');
      if (after !== stamp) return;
      cacheSet(key, {
        at: Date.now(), body, etag: c.res.headers.get('ETag') ?? '',
        type: c.res.headers.get('Content-Type') ?? 'application/octet-stream',
        stamp,
      });
    } catch { /* 缓存失败不影响本次响应 */ }
  });
  const absoluteUrl = (value) => {
    try { return new URL(decodeHtmlAttribute(value), SITE.url + '/').href; } catch { return value; }
  };
  // srcset 是「URL 描述符, URL 描述符」：每个候选都要绝对化，否则阅读器按 Feed 地址解析会 404。
  const absoluteSrcset = (value) => String(value).split(',').map((part) => {
    const pieces = part.trim().split(/\s+/);
    const url = pieces.shift();
    return url ? [absoluteUrl(url), ...pieces].join(' ') : part;
  }).join(', ');
  const absoluteHtml = (html) => String(html ?? '').replace(/\b(href|src|srcset|data-full)="([^"]*)"/g, (_m, attr, value) => (
    `${attr}="${esc(attr === 'srcset' ? absoluteSrcset(value) : absoluteUrl(value))}"`
  ));
  const recent = (limit = 20) => repo.feed({ limit });
  // 内容没改但渲染结果可能变（渲染器升级、媒体变体重建）时，也要让 Feed 的 ETag 失效。
  // 站点身份/域名也参与：后台改站名、描述、作者或 SITE_URL 后，正文变了但文章时间戳没变，
  // 不把它们算进 ETag 会让带旧校验值的客户端一直 304，Feed 永远停在旧内容。
  const siteStamp = () => crypto.createHash('sha1')
    .update([SITE.url, SITE.identity, SITE.desc, SITE.lang, SITE.author].join('\n'))
    .digest('base64url');
  const renderStamp = () => `${repo.getSetting('content_pipeline_version') ?? ''}:${repo.getSetting('media_revision') ?? ''}:${siteStamp()}`;

  app.get('/feed.xml', (c) => {
    const posts = recent(limitOf(c));
    const { etag, cached } = conditionalOf(c, 'feed', posts, renderStamp());
    if (cached) return cached;
    const items = posts.map((p) => `    <item>
      <title>${esc(p.title)}</title>
      <link>${esc(absUrl(urlOf(p)))}</link>
      <guid isPermaLink="true">${esc(absUrl(urlOf(p)))}</guid>
      <pubDate>${safeRfc822(p.published_at)}</pubDate>
      <dc:creator>${esc(SITE.author || SITE.identity)}</dc:creator>
      <category>${p.kind === 'note' ? '笔记' : '文章'}</category>
      <description>${esc(p.description || cleanExcerpt(p.body_html, 280))}</description>
      <content:encoded>${cdata(absoluteHtml(p.body_html))}</content:encoded>
    </item>`).join('\n');

    const xml = `<?xml version="1.0" encoding="UTF-8"?>
<rss version="2.0" xmlns:atom="http://www.w3.org/2005/Atom" xmlns:content="http://purl.org/rss/1.0/modules/content/" xmlns:dc="http://purl.org/dc/elements/1.1/">
  <channel>
    <title>${esc(SITE.identity)}</title>
    <link>${esc(SITE.url)}/</link>
    <description>${esc(SITE.desc)}</description>
    <language>${esc(SITE.lang)}</language>
    <atom:link href="${esc(absUrl('/feed.xml'))}" rel="self" type="application/rss+xml"/>
    <lastBuildDate>${posts.length ? rfc822(stampOf(posts) || safeIso(new Date())) : rfc822(new Date())}</lastBuildDate>
${items}
  </channel>
</rss>`;
    return c.body(xml, 200, { 'Content-Type': 'application/rss+xml; charset=utf-8', ETag: etag });
  });

  app.get('/atom.xml', (c) => {
    const posts = recent(limitOf(c));
    const { etag, cached } = conditionalOf(c, 'atom', posts, renderStamp());
    if (cached) return cached;
    const entries = posts.map((p) => `  <entry>
    <title>${esc(p.title)}</title>
    <link href="${esc(absUrl(urlOf(p)))}"/>
    <id>${esc(absUrl(urlOf(p)))}</id>
    <updated>${safeIso(utcDate(p.updated_at ?? p.published_at))}</updated>
    <published>${safeIso(p.published_at)}</published>
    <summary>${esc(p.description || cleanExcerpt(p.body_html, 280))}</summary>
    <content type="html">${esc(absoluteHtml(p.body_html))}</content>
  </entry>`).join('\n');

    const xml = `<?xml version="1.0" encoding="UTF-8"?>
<feed xmlns="http://www.w3.org/2005/Atom" xml:lang="${esc(SITE.lang)}">
  <title>${esc(SITE.identity)}</title>
  <subtitle>${esc(SITE.desc)}</subtitle>
  <link href="${esc(SITE.url)}/"/>
  <link href="${esc(absUrl('/atom.xml'))}" rel="self"/>
  <id>${esc(SITE.url)}/</id>
  <updated>${posts.length ? safeIso(utcDate(stampOf(posts))) : new Date().toISOString()}</updated>
  <author><name>${esc(SITE.author || SITE.identity)}</name></author>
${entries}
</feed>`;
    return c.body(xml, 200, { 'Content-Type': 'application/atom+xml; charset=utf-8', ETag: etag });
  });

  app.get('/feed.json', (c) => {
    const posts = recent(limitOf(c));
    const { etag, cached } = conditionalOf(c, 'jsonfeed', posts, renderStamp());
    if (cached) return cached;
    return c.json({
      version: 'https://jsonfeed.org/version/1.1',
      title: SITE.identity,
      home_page_url: `${SITE.url}/`,
      feed_url: absUrl('/feed.json'),
      description: SITE.desc,
      language: SITE.lang,
      authors: [{ name: SITE.author || SITE.identity }],
      items: posts.map((p) => ({
        id: absUrl(urlOf(p)),
        url: absUrl(urlOf(p)),
        title: p.title,
        summary: p.description || cleanExcerpt(p.body_html, 280),
        content_html: absoluteHtml(p.body_html),
        date_published: safeIso(p.published_at),
        date_modified: safeIso(utcDate(p.updated_at ?? p.published_at)),
      })),
    }, 200, { ETag: etag });
  });

  app.get('/sitemap.xml', (c) => {
    // 一次查询同时拿到最近更新时间与全部已发布内容。
    const all = repo.allPublished();
    const pages = repo.pages();
    const etag = `"sitemap-${stampOf(all)}-${stampOf(pages)}-${all.length}-${pages.length}-${siteStamp()}"`;
    if (notModified(c, etag)) return c.body(null, 304, { ETag: etag });

    const newest = (rows) => stampOf(rows);
    const posts = all.filter((p) => p.kind === 'post');
    const notes = all.filter((p) => p.kind === 'note');
    // 年归档 /a/YYYY 也是可索引的入口页；以前只列了 /archive，年份页只能靠站内链接被发现。
    const yearLast = new Map();
    for (const p of all) {
      const year = formatDay(p.published_at).slice(0, 4);
      if (!year) continue;
      const at = stampIso(p.updated_at || p.published_at);
      if (!yearLast.has(year) || at > yearLast.get(year)) yearLast.set(year, at);
    }
    const urls = [
      { loc: '/', lastmod: newest(all) },
      { loc: '/posts/', lastmod: newest(posts) },
      { loc: '/notes/', lastmod: newest(notes) },
      { loc: '/friends/', lastmod: null },
      { loc: '/links/', lastmod: null },
      { loc: '/archive/', lastmod: newest(all) },
      ...[...yearLast].map(([year, lastmod]) => ({ loc: `/a/${year}`, lastmod })),
      // 固定页是 /<slug>，逐个列出——以前写死 /about，新增固定页就不进 sitemap。
      ...pages.map((p) => ({ loc: pageUrl(p.slug), lastmod: stampIso(p.updated_at || p.published_at) })),
      ...all.map((p) => ({ loc: urlOf(p), lastmod: stampIso(p.updated_at || p.published_at) })),
    ];
    const xml = `<?xml version="1.0" encoding="UTF-8"?>
<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">
${urls.map((u) => `  <url><loc>${esc(absUrl(u.loc))}</loc>${u.lastmod ? `<lastmod>${esc(u.lastmod)}</lastmod>` : ''}</url>`).join('\n')}
</urlset>`;
    return c.body(xml, 200, { 'Content-Type': 'application/xml; charset=utf-8', ETag: etag });
  });

  // /avatar/ 不让爬：按邮箱 md5 逐个回源，爬一遍等于放大上游请求，且头像本就是 alt="" 的装饰。
  app.get('/robots.txt', (c) => c.body(
    `User-agent: *\nAllow: /\nDisallow: /admin\nDisallow: /api/\nDisallow: /healthz\nDisallow: /moderate/\nDisallow: /avatar/\nDisallow: /search\n\nSitemap: ${absUrl('/sitemap.xml')}\n`,
    200, { 'Content-Type': 'text/plain; charset=utf-8' },
  ));

  return app;
}

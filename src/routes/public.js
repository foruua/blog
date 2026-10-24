import { Hono } from 'hono';
import { SITE, FRIENDS_PER_PAGE, FRIENDS_PER_SOURCE, LINKS_PER_PAGE } from '../config.js';
import { settings, heroImages, heroOverlay } from '../settings.js';
import { layout, listBlock, emptyPage, masthead, entriesBlock, moreLink, defaultOgImage } from '../render/layout.js';
import { notesStream, splitImages } from '../render/notes.js';
import { withLightbox } from '../render/lightbox.js';
import { heroBlock, heroPreload as heroPreloadTag } from '../render/hero.js';
import { tocHtml, pagerHtml, articleMain, articleJsonLd } from '../render/article.js';
import { archiveMain } from '../render/archive.js';
import { pageMain } from '../render/about.js';
import { searchMain } from '../render/search.js';
import { friendsStream } from '../render/friends.js';
import { linksBlock } from '../render/links.js';
import { esc, formatDay, formatWordCount, formatDayCn, readingMinutes, postUrl, pageUrl, contentUrl, kindPrefix, noteHref, cleanExcerpt, relativeDate, recentStartIso, utcDate, decodeHtmlAttribute, htmlAttr, absUrl } from '../util/text.js';
import { commentSection } from '../comments/view.js';
import { notePanel } from '../comments/panel.js';
import { threadOf } from '../../db/comments.js';
import { emailMd5 } from '../avatar/md5.js';
import { decryptEmail } from '../auth.js';
import { mediaRevision } from '../media/revision.js';
import { createAntispam } from '../comments/antispam.js';
import { clientIp } from '../util/http.js';


const shape = (p) => ({ ...p, day: formatDay(p.published_at) });

// 主题模板用的内容摘要：只给模板需要的纯数据，预渲染 HTML 留在 main / 各 *_html 字段里。
const themePost = (p) => ({
  id: p.id,
  slug: p.slug,
  kind: p.kind,
  title: p.title,
  url: contentUrl(p),
  datetime: p.published_at,
  date: formatDay(p.published_at),
  date_cn: formatDayCn(p.published_at),
  relative: relativeDate(p.published_at),
  excerpt: cleanExcerpt(p.body_head ?? p.body_html ?? '', 120),
  comments: Number(p.comments ?? 0),
  draft: Boolean(p.draft),
  lang: p.lang || '',
});

// 结构化数据/OG 只认 ISO 8601；SQLite 的 datetime() 是 "YYYY-MM-DD HH:MM:SS"，
// 直接塞进 article:modified_time 会被部分抓取工具当成非法日期。解析失败就不输出该字段。
const isoOf = (value) => {
  if (!value) return null;   // new Date(null) 是 1970，不能让空值污染结构化数据
  try { return utcDate(value).toISOString(); } catch { return null; }
};



// 图片信息的进程级缓存：路径自带内容哈希，同一路径的尺寸/变体在两次 media_revision 之间恒定。
// 以前是每个 <img> 一次 mediaByPath 点查（/notes 一页上百张图就是上百次，全靠请求级 memo 兜着不退到更早的层）。
// 现在按代际整块失效：revision 一变（上传/删除/重建变体）就清空，请求开始时读一次 revision 即可。
// 缓存放路由实例闭包里（而不是模块级）：同一进程起多个实例时各存各的，不会串到别人的 repo 上。
const MEDIA_CACHE_MAX = 4000;

// 刊头「最近 N 天」窗口：友圈与友链共用一个，各写一个早晚不一致。
const MAST_RECENT_DAYS = 30;

export function publicRoutes(repo, { comments, crypt, media = null, feeds = null, auth = null, links = null, search = null } = {}) {
  const app = new Hono({ strict: false });

  // 目录页统一用带尾斜杠的地址（/posts/、/notes/、/friends/、/links/、/archive/）。站内链接、canonical
  // 与 sitemap 都按这一套写；旧的无斜杠地址 301 过去，避免同一页被当成两个 URL。固定页（/about）与
  // 年归档（/a/2026）不在此列。
  const SLASH_SECTIONS = new Set(['/posts', '/notes', '/friends', '/links', '/archive']);
  app.use('*', async (c, next) => {
    // c.req.path 会被 Hono 归一化成不带尾斜杠；要判断原始地址必须读 URL.pathname。
    const url = new URL(c.req.url);
    if ((c.req.method === 'GET' || c.req.method === 'HEAD') && SLASH_SECTIONS.has(url.pathname)) {
      return c.redirect(`${url.pathname}/${url.search}`, 301);
    }
    await next();
  });

  // 检索实例（server.js 注入）；未注入给空壳（测试只关心页面骨架），parsed 与 parseQuery() 对齐。
  const NO_RESULT = { parsed: { text: '', terms: [], empty: true }, hits: [], total: 0, truncated: false };
  const searchOf = () => search ?? { query: () => NO_RESULT };
  // 检索是 O(全站正文) 的现算路径，给它一道独立限流；评论那套 5 次/10 分钟太紧，这里 60 次/分钟。
  const searchLimiter = createAntispam({ windowMs: 60 * 1000, maxPerWindow: 60 });
  // /links 每次请求都要聚合全部 approved 评论；没有限流时，大页码 + 多 IP 就能稳定放大 CPU。
  const linksLimiter = createAntispam({ windowMs: 60 * 1000, maxPerWindow: 60 });

  // 是否站主会话；按请求记忆化（一次渲染问好几遍，含三次 settings 查询），别重复做。
  const ownerOf = (c) => {
    let v = c.get('pubOwner');
    if (v === undefined) { v = Boolean(auth?.session(c)); c.set('pubOwner', v); }
    return v;
  };

  // —— 评论头像邮箱 md5：渲染时现算，不落库 ——
  // 库里邮箱只有密文；md5 是 Gravatar 公开口径，存下等于把可枚举的邮箱指纹写进库与备份，故现算不回填（博主头像取 SITE_EMAIL）。
  const authorMd5 = emailMd5(SITE.email);
  // 同一页常有多条同邮箱评论。AES-GCM 每次都换随机 IV，密文并不稳定；用稳定的 email_hash 做键，
  // 没有该列（旧调用/链接聚合）时再退回密文。上限兜底，避免长期运行无界增长。
  const avatarMd5Cache = new Map();
  const AVATAR_MD5_CACHE_MAX = 2000;
  const avatarMd5Of = (rowOrEnc) => {
    const enc = typeof rowOrEnc === 'string' ? rowOrEnc : rowOrEnc?.email_enc;
    if (!enc) return null;
    const key = (typeof rowOrEnc === 'object' && rowOrEnc?.email_hash) || enc;
    if (avatarMd5Cache.has(key)) return avatarMd5Cache.get(key);
    const email = decryptEmail(crypt, enc);
    const hash = email ? emailMd5(email) : null;
    if (avatarMd5Cache.size >= AVATAR_MD5_CACHE_MAX) avatarMd5Cache.delete(avatarMd5Cache.keys().next().value);
    avatarMd5Cache.set(key, hash);
    return hash;
  };
  const hydrateAvatar = (row) => {
    if (!row || row.avatar_md5 !== undefined) return row;
    row.avatar_md5 = row.is_author ? authorMd5 : avatarMd5Of(row);
    return row;
  };
  const withAvatars = (rows) => { for (const row of rows) hydrateAvatar(row); return rows; };
  const withAvatarTree = (nodes) => {
    for (const node of nodes) { hydrateAvatar(node); withAvatarTree(node.replies ?? []); }
    return nodes;
  };

  // 图片尺寸/候选来自 media 表（注入的 imageInfo）；未注入退回原图。缓存见文件头的 mediaCache。
  const mediaCache = new Map();
  let mediaCacheRev = -1;
  const mediaOf = (c, src) => {
    if (!media || !src) return null;
    let rev = c.get('pubMediaRev');
    if (rev === undefined) { rev = mediaRevision(repo); c.set('pubMediaRev', rev); }
    if (rev !== mediaCacheRev) { mediaCache.clear(); mediaCacheRev = rev; }
    if (!mediaCache.has(src)) {
      // 满了按插入序丢最老的一条（FIFO，不是 LRU）：路径自带内容哈希、命中率高，够用，不值得再维护访问序。
      if (mediaCache.size >= MEDIA_CACHE_MAX) mediaCache.delete(mediaCache.keys().next().value);
      mediaCache.set(src, media(src));
    }
    return mediaCache.get(src);
  };
  // 分享图：文章取正文首图（最大档变体），首页取封面首图；都没有就用站点默认图（见 layout.defaultOgImage）。
  const imgAttr = (tag, name) => decodeHtmlAttribute(htmlAttr(tag, name));
  function ogImageOf(c, post) {
    const tag = /<img\b[^>]*>/i.exec(post?.body_html ?? '')?.[0];
    if (!tag) return null;
    const src = imgAttr(tag, 'src');
    if (!src || /^data:/i.test(src)) return null;
    const info = mediaOf(c, src);
    const url = info?.full ?? info?.original ?? src;
    if (!url || /^data:/i.test(url)) return null;
    // 变体等比缩放，宽度就写在文件名里（…-w1280.webp），高度按原图比例折算；回原图时直接用库里的尺寸。
    // 别直接拿 info.width —— 那是原图宽度，变体封顶 2560，两者不等时会给出对不上的宽高。
    const width = Number(/-w(\d+)\.webp$/i.exec(url)?.[1] ?? 0) || Math.max(0, info?.width ?? 0);
    const height = width > 0 && info?.width > 0 && info?.height > 0
      ? Math.round((info.height * width) / info.width)
      : Math.max(0, info?.height ?? 0);
    // 正文里若已写了绝对地址（作者直接贴 https://…），absUrl() 会再拼一次站点前缀，分享图就坏了。
    const absolute = /^https?:\/\//i.test(url) ? url : absUrl(url);
    return { url: absolute, width, height, alt: imgAttr(tag, 'alt') || SITE.identity };
  }

  // publishedStats() 一次渲染被各要一次（首页 2 次）；缓存到请求上下文，最多查一次。
  const statsOf = (c) => {
    let cached = c.get('pubStats');
    if (!cached) { cached = repo.publishedStats(); c.set('pubStats', cached); }
    return cached;
  };

  // 评论总数一次渲染要两处：评论区与 JSON-LD 的 commentCount。同一条 SQL 别跑两遍。
  const countOfPost = (c, id) => {
    let cache = c.get('pubCounts');
    if (!cache) { cache = new Map(); c.set('pubCounts', cache); }
    if (!cache.has(id)) cache.set(id, comments.countOfPost(id));
    return cache.get(id);
  };

  // 后台设置项一次渲染会被问好几遍（每页条数、评论每页条数、首页条数）；按请求缓存解析结果，别重复查库。
  const settingOf = (c, key, compute) => {
    let cache = c.get('pubSettings');
    if (!cache) { cache = {}; c.set('pubSettings', cache); }
    if (!(key in cache)) cache[key] = compute();
    return cache[key];
  };
  const pageSizeOf = (c) => settingOf(c, 'pageSize', () => settings.pageSize(repo));
  const commentsPerPageOf = (c) => settingOf(c, 'commentsPerPage', () => settings.commentsPerPage(repo));
  const homeRecentOf = (c) => settingOf(c, 'homeRecent', () => settings.homeRecent(repo));
  // 首页「最近更新」与主题 data.recent 是同一批记录：只查一次，顺带批量补上评论数
  // （repo.recentEntries 不选 comments，主题若读 p.comments 会永远是 0）。
  const recentOf = (c) => {
    let rows = c.get('pubRecent');
    if (!rows) {
      const want = homeRecentOf(c);
      rows = want ? repo.recentEntries(want) : [];
      if (rows.length) {
        const counts = comments.countsOf(rows.map((row) => row.id));
        rows = rows.map((row) => ({ ...row, comments: counts.get(row.id) ?? 0 }));
      }
      rows = rows.map(shape);
      c.set('pubRecent', rows);
    }
    return rows;
  };
  // 首页封面：hero() 与 heroPreload() 各要一份，overlay 又是一次 settings 查询——都收进请求缓存。
  const heroImgsOf = (c) => settingOf(c, 'heroImages', () => heroImages(repo));
  const heroOverlayOf = (c) => settingOf(c, 'heroOverlay', () => heroOverlay(repo));

  function hero(c) {
    return heroBlock({
      stats: statsOf(c),
      imgs: heroImgsOf(c),
      overlay: heroOverlayOf(c),
      mediaOf: (src) => mediaOf(c, src),
      recentHtml: recent(c),
    });
  }

  function sectionStats(c, kind) {
    const row = statsOf(c).find((p) => p.kind === kind);
    if (!row) return [];
    const words = row.words;
    const first = formatDay(row.first).slice(0, 4), last = formatDay(row.last).slice(0, 4);
    const span = first !== last ? `${first}—${last}` : first;
    return [
      `<span><b>${row.n}</b> 篇</span>`,
      words ? `<span>约 ${formatWordCount(words)}</span>` : '',
      `<span class="mast-span">${esc(span)}</span>`,
    ].filter(Boolean);
  }

  function recent(c) {
    if (!homeRecentOf(c)) return '';
    const rows = recentOf(c);
    if (!rows.length) return '';
    return `    <section class="recent">
      <h2 class="recent-head">最近更新</h2>
${entriesBlock(rows, { relative: true })}
      <p class="pager-more"><a href="/archive/">全部 ${statsOf(c).reduce((n,p) => n+p.n, 0)} 篇 →</a></p>
    </section>`;
  }


  function paginate(c, { fetchPage, pathname, label, before: override, size = pageSizeOf(c) }) {
    const before = override === undefined ? (c.req.query('before') || null) : override;
    const rows = fetchPage(size + 1, before);
    const hasMore = rows.length > size;
    const list = rows.slice(0, size);
    const last = list.at(-1);
    const more = hasMore && last
      ? moreLink(`${pathname}?before=${encodeURIComponent(`${last.published_at}|${last.id}`)}`, `更早的${label}`)
      : '';
    return { list, more };
  }

  const emptyList = (mark, title) => `${masthead({ mark, title })}
${emptyPage('还没有内容', '还没有发布任何内容。<a href="/">回到首页</a>', 'p')}`;

  function listPage(c, { kind, title, mark, desc, active, pathname }) {
    const { list, more } = paginate(c, {
      fetchPage: (limit, before) => repo.list({ limit, before, kind }),
      pathname, label: kind === 'note' ? '笔记' : '文章',
    });
    const shaped = list.map(shape);
    const themeRows = shaped.map(themePost);
    const mast = list.length ? masthead({ mark, title, stats: sectionStats(c, kind) }) : '';
    // 同一份列表 HTML 只构建一次：以前 themeData.list_html 与 main 各调一次 listBlock，
    // 主题模式下等于把整页条目渲染两遍。
    const listHtml = list.length ? listBlock(shaped, { showKind: false }) : '';
    return c.html(layout({
      title: title === SITE.title ? '' : title,

      page: 'list',
      themeType: kind === 'note' ? 'notes' : 'posts',
      themeData: {
        kind,
        title,
        mark,
        posts: themeRows,
        // posts → home 的回退：home.liquid 通常读 data.recent，给同一批数据一个兼容别名。
        recent: themeRows,
        has_more: Boolean(more),
        more_html: more,
        masthead_html: mast,
        list_html: listHtml,
        empty: !list.length,
      },
      main: list.length
        ? `${mast}
${listHtml}
    ${more}`
        : emptyList(mark, title),
      active, canonical: pathname,
      desc,
    }));
  }

  // 首页封面是 LCP：在 <head> 里 preload 第一张的候选集，让浏览器解析到 body 之前就开抢。
  // imagesrcset/imagesizes 必须与正文那张 <img> 完全一致，浏览器才会挑同一档，不会白下两份。
  function heroPreload(c) {
    return heroPreloadTag({ imgs: heroImgsOf(c), mediaOf: (src) => mediaOf(c, src) });
  }

  app.get('/', (c) => {
    const homeMain = hero(c);
    const recentRows = recentOf(c);
    return c.html(layout({
      title: '',
      main: homeMain,
      active: 'home',
      canonical: '/',
      desc: SITE.desc,
      page: 'home',
      themeType: 'home',
      themeData: {
        hero_html: homeMain,
        hero: {
          images: heroImgsOf(c).map(({ path, w, h }) => ({ path, w, h })),
        },
        stats: statsOf(c),
        recent: recentRows.map(themePost),
        has_recent: recentRows.length > 0,
      },
      extraHead: heroPreload(c),
    }));
  });

  app.get('/posts', (c) => listPage(c, {
    kind: 'post', title: '文章', mark: 'Articles',
    desc: '长文。偶尔写，写就写透。',
    active: 'posts', pathname: '/posts/',
  }));

  /** 笔记流评论抽屉内里。首屏与 ?partial=comments&panel=note 回刷必须走同一段代码，否则抽屉会被回刷成内页那套评论区。 */
  function notePanelFor(c, p, { groups = null, idSuffix = '', flash = '', perPage = commentsPerPageOf(c) } = {}) {
    const on = p.comments_on !== 0;
    const rows = on ? (groups ?? comments.pageThreadsOf([p.id], perPage)).get(p.id) ?? [] : [];
    withAvatars(rows);
    const threads = threadOf(rows);

    const rest = Math.max(0, (rows[0]?.thread_count ?? threads.length) - perPage);
    const base = `/n/${encodeURIComponent(p.slug)}/`;
    return notePanel({
      post: p,
      thread: threads.slice(0, perPage),
      flash,
      replyBase: base,
      tsToken: crypt.sign({ purpose: 'comment-ts', ts: Date.now(), p: p.id }, 24 * 3600),
      idSuffix,
      asAuthor: ownerOf(c),
      csrf: auth?.csrfOf(c) ?? '',
      more: rest ? { href: `${base}#comments`, n: rest } : null,
    });
  }

  app.get('/notes', (c) => {


    const pageSize = pageSizeOf(c);
    const want = c.req.query('n');
    let before = c.req.query('before') || null;
    if (want) {
      const cursor = repo.noteCursor(want, pageSize);
      if (cursor !== undefined) before = cursor;
    }
    const { list, more } = paginate(c, {
      fetchPage: (limit, cursor) => repo.notes({ limit, before: cursor }),
      pathname: '/notes/', label: '笔记', before, size: pageSize,
    });

    // 评论抽屉不再随列表服务端渲染：每篇一次 pageThreadsOf + 一批头像解析，10 篇笔记就多出约 80KB
    // HTML（占整页 65%）。抽屉首次展开时由 app.js 取 ?partial=comments&panel=note&suffix=-<slug>。
    // 无 JS 时「评论」按钮仍是指向 /n/<slug>/#comments 的普通链接，不受影响。
    const noteRows = list.map((p) => {
      const { text, images: rawImages } = splitImages(p.body_html);
      // 画廊以静态预览兜底、按像素密度选候选；灯箱展示图取最大档变体。
      const images = rawImages.map((im) => {
        const info = mediaOf(c, im.src);
        return { ...im, thumb: info?.thumbnail ?? null, previewSrcset: info?.srcset ?? '',
          full: info?.full ?? im.src };
      });
      return {
        ...themePost(p),
        day: relativeDate(p.published_at),
        dayExact: formatDay(p.published_at),
        text,
        images,
        commentCount: p.comments,
      };
    });
    const stream = notesStream(noteRows);
    const notesMast = list.length ? masthead({ mark: 'Notes', title: '笔记', stats: sectionStats(c, 'note') }) : '';

    return c.html(layout({
      title: '笔记', active: 'notes',

      canonical: '/notes/',
      page: 'notes',
      themeType: 'notes',
      themeData: {
        kind: 'note',
        title: '笔记',
        mark: 'Notes',
        notes: noteRows,
        // notes → list 的回退：给只读 data.posts 的模板留一个同义字段。
        posts: noteRows,
        has_more: Boolean(more),
        more_html: more,
        masthead_html: notesMast,
        stream_html: stream,
        empty: !list.length,
      },
      desc: '还没长成文章的碎片、读书记录、临时想法。',
      main: list.length
        ? `${notesMast}
${stream}
    ${more}`
        : emptyList('Notes', '笔记'),
    }));
  });

  /** 评论区（三种 kind 共用）：分页、回复目标、令牌都按 post.id 算；回填地址取内容 URL。 */
  function commentBlockFor(c, post) {
    const perPage = commentsPerPageOf(c);
    const pages = Math.max(1, Math.ceil(comments.threadCount(post.id) / perPage));

    // 回复目标按 id 直接取，不要求正好在当前页——否则回复别页的评论时 prefill 不出对象，禁 JS 时点了没反应。
    const wantReply = Number(c.req.query('reply'));
    const target = Number.isInteger(wantReply) && wantReply > 0 ? comments.get(wantReply) : null;
    const replyTo = target && target.post_id === post.id && target.status === 'approved' ? target : null;

    let page = Math.min(pages, Math.max(1, Number.parseInt(c.req.query('cpage'), 10) || 1));
    if (replyTo) {
      const at = comments.threadPageOf({ postId: post.id, commentId: replyTo.id, limit: perPage });
      if (at) page = Math.min(pages, Math.max(1, at.page));
    }

    return commentSection({
      post,
      thread: withAvatarTree(comments.pageThreads(post.id, perPage, page)),
      count: countOfPost(c, post.id),
      flash: c.req.query('c') ?? '',
      replyTo,
      replyBase: contentUrl(post),
      page,
      pages,

      tsToken: crypt.sign({ purpose: 'comment-ts', ts: Date.now(), p: post.id }, 24 * 3600),
      asAuthor: ownerOf(c),
      csrf: auth?.csrfOf(c) ?? '',
    });
  }

  function postPage(c, kind) {
    // 不要再 decodeURIComponent：Hono 已解过一次，坏转义原样返回，再解抛 URIError，把 /p/100%25/ 变成 500 而非 404。
    const slug = c.req.param('slug');
    const post = repo.getPost(slug, kind);
    if (!post || post.draft) {

      const target = repo.findAlias(c.req.path);
      if (target) return c.redirect(contentUrl(target), 301);
      return notFound(c);
    }

    // 评论回刷只换评论区，不需要封面目录与上下篇（neighbours 是两条 SQL）；先判断再算。
    const wantPartial = c.req.query('partial') === 'comments';
    // 笔记抽屉回刷走自己这一路：抽屉与内页评论区是两套语法，回刷的必须与首屏同款，否则发完评论这块会悄悄换脸。
    if (wantPartial && post.kind === 'note' && c.req.query('panel') === 'note') {
      // 笔记流首屏不再内嵌每篇的评论抽屉（改首次展开时再取）。抽屉 id 要带上 -<slug>，
      // 否则同时开过两篇后，两份表单的 c-author/c-email/c-body 会在 DOM 里撞 id。
      const rawSuffix = String(c.req.query('suffix') ?? '');
      // slug 允许中文（slugify 保留 Han），后缀不能只认 ASCII；只排除会破坏 HTML 属性的字符。
      // slug 长度上限见 util/text.js 的 validateSlug（160 字符）；后缀上限也必须跟它一致，
      // 否则长 slug 的抽屉拿不到后缀，多篇同时开过时会和别的抽屉撞 DOM id。
      const idSuffix = /^-[-\p{L}\p{N}_]{1,160}$/u.test(rawSuffix) ? rawSuffix : '';
      return c.html(notePanelFor(c, post, { flash: c.req.query('c') ?? '', idSuffix }));
    }
    if (wantPartial) return c.html(commentBlockFor(c, post));

    const words = post.word_count ?? 0;
    // 阅读时长与「N 字」同源；只有空正文才拿到 0，那时整段不写。
    const mins = readingMinutes(words);
    const toc = tocHtml(post.toc);

    const { newer, older } = repo.neighbours(post);
    const commentBlock = commentBlockFor(c, post);

    const pager = pagerHtml({ newer, older });



    const note = post.kind === 'note';

    // 刊头等宽小字：等宽栈无中文字形（见 style.css 的 --mono），故「年/月/日」与数字落在中文字体上，整行不碎成两副面孔。
    const dayCn = formatDayCn(post.published_at);


    const bodyHtml = withLightbox(post.body_html, `${kindPrefix(post.kind)}-${post.slug}`, (src) => mediaOf(c, src));
    const main = articleMain({ post, words, mins, dayCn, toc, pager, commentBlock, bodyHtml });

    const pathname = postUrl(post);
    const publishedIso = isoOf(post.published_at);
    const modifiedIso = isoOf(post.updated_at);
    const og = ogImageOf(c, post) ?? defaultOgImage();
    const jsonLd = articleJsonLd({ post, pathname, og, commentCount: countOfPost(c, post.id), publishedIso, modifiedIso });
    return c.html(layout({
      title: post.title,
      desc: post.description || cleanExcerpt(post.body_html, 100),
      main,
      active: post.kind === 'note' ? 'notes' : 'posts',
      canonical: pathname,
      ogType: 'article',
      ogImage: og,
      lang: post.lang || '',
      themeType: note ? 'note' : 'post',
      themeData: {
        post: {
          // posts 表本身没有评论数列：单独补上，否则主题读 data.post.comments 永远是 0。
          ...themePost({ ...post, comments: countOfPost(c, post.id) }),
          description: post.description || '',
          body_html: bodyHtml,
          toc: Array.isArray(post.toc) ? post.toc : [],
          toc_html: toc,
          pager_html: pager,
          comments_html: commentBlock,
          words,
          reading_minutes: mins,
          day_cn: dayCn,
          published_at: post.published_at,
          updated_at: post.updated_at || '',
        },
        toc_html: toc,
        pager_html: pager,
        comments_html: commentBlock,
        body_html: bodyHtml,
        words,
        reading_minutes: mins,
        day_cn: dayCn,
      },
      jsonLd,
      extraHead: [
        publishedIso ? `<meta property="article:published_time" content="${esc(publishedIso)}">` : '',
        modifiedIso ? `<meta property="article:modified_time" content="${esc(modifiedIso)}">` : '',
      ].filter(Boolean).join('\n'),
    }));
  }

  app.get('/p/:slug', (c) => postPage(c, 'post'));
  app.get('/n/:slug', (c) => postPage(c, 'note'));


  app.get('/archive', (c) => {
    const archiveHtml = archiveMain(repo, c.req.query('kind'));
    return c.html(layout({
      title: '归档', active: 'archive', canonical: '/archive/',


      page: 'archive',
      themeType: 'archive',
      themeData: { archive_html: archiveHtml },
      desc: '全部文章与笔记，按年份整理。',
      main: archiveHtml,
    }));
  });

  // 「友圈」：抓回的文章按朋友分组铺开，未接入模块则 404。前台只读缓存数据；
  // 对外抓取由定时器/后台触发，别让匿名访问决定服务器何时向别人站点发请求。
  app.get('/friends', (c) => {
    if (!feeds) return notFound(c);

    const sources = feeds.listEnabled();
    const recentCount = feeds.countSince(recentStartIso(MAST_RECENT_DAYS));
    // 分页按「朋友」切，每页固定 FRIENDS_PER_PAGE；游标 ?before= 与 /posts /notes 同格式，坏游标在存储层回第一页、不会 500。
    const page = feeds.friendsPageFeeds({ perPage: FRIENDS_PER_PAGE, before: c.req.query('before') });
    const last = page.feeds[page.feeds.length - 1] ?? null;
    const items = last
      ? feeds.itemsForFeeds(page.feeds.map((f) => f.feedId), { perSource: FRIENDS_PER_SOURCE, before: page.cursor, until: last })
      : [];
    const nextHref = page.hasMore && last
      ? `/friends/?before=${encodeURIComponent(`${last.ts}|${last.feedId}`)}`
      : null;

    const friendsMain = `${masthead({
      mark: 'Friends', title: '友圈',
      stats: [
        `<span><b>${sources.length}</b> 个订阅</span>`,
        // 统计仅覆盖当前保留的条目，不代表对方站点窗口内的全部发布量。
        sources.length ? `<span>当前收录近 ${MAST_RECENT_DAYS} 天 ${recentCount} 篇</span>` : '',
      ].filter(Boolean),
    })}
${friendsStream({ items, sources: sources.length, nextHref })}`;
    return c.html(layout({
      title: '友圈', active: 'friends', canonical: '/friends/', page: 'friends',
      themeType: 'friends',
      themeData: {
        friends_html: friendsMain,
        sources: sources.length,
        recent_count: recentCount,
        next_href: nextHref || '',
        items,
      },
      desc: `朋友们的最近更新：${sources.length} 个站点的最新文章。`,
      main: friendsMain,
    }));
  });

  /** 「友链」：评论填过网址且通过审核的邻居，按留言条数排。名单是 comments 的派生态（approved + 有网址 + 非博主），故「谁在友链页上」永远与评论区对得上账——没有同步钩子就没有会漏的写入路径；唯一落库的是站点可达性（link_sites）。前台只读缓存，抓取/探测由定时器或后台触发；未接入模块则 404。 */
  app.get('/links', (c) => {
    if (!links) return notFound(c);
    const ip = clientIp(c) || 'unknown';
    if (linksLimiter.rateLimited(crypt?.ipHash ? crypt.ipHash(ip) : ip)) {
      return c.text('友链页请求过于频繁，请稍后再试。', 429, { 'Retry-After': '60' });
    }

    const perPage = LINKS_PER_PAGE;
    // 上限与后台 pageNumber() 同口径：直接拿巨大整数乘每页条数会把 OFFSET 变成非安全整数，
    // node:sqlite 会抛 datatype mismatch，匿名请求即可把 /links 打成 500。
    let page = Math.min(100000, Math.max(1, Number.parseInt(c.req.query('page'), 10) || 1));
    // 不再先跑一次 publicCount 来夹页：越界页走下面的「空页」分支，用同一条语句算出的 total 夹回来。
    // 常规页（包括第 2 页以后）因此只跑一次聚合；统计与「最近 N 天」都随列表一起返回。
    const recentSince = recentStartIso(MAST_RECENT_DAYS);
    let total = 0;
    let commentTotal = 0;
    let recentComments = 0;
    let rows = links.publicPage({ limit: perPage, offset: (page - 1) * perPage, recentSince });
    if (rows.length) {
      total = Number(rows[0].total) || 0;
      commentTotal = Number(rows[0].all_comments) || 0;
      recentComments = Number(rows[0].recent) || 0;
    } else {
      const agg = links.publicStats();
      total = Number(agg.links) || 0;
      commentTotal = Number(agg.comments) || 0;
      const lastPage = Math.max(1, Math.ceil(total / perPage));
      if (page !== lastPage) {
        page = lastPage;
        rows = links.publicPage({ limit: perPage, offset: (page - 1) * perPage, recentSince });
        if (rows.length) {
          total = Number(rows[0].total) || total;
          commentTotal = Number(rows[0].all_comments) || commentTotal;
          recentComments = Number(rows[0].recent) || 0;
        }
      }
      if (!rows.length) recentComments = total ? links.publicRecent(recentSince) : 0;
    }
    const pages = Math.max(1, Math.ceil(total / perPage));
    page = Math.min(pages, page);

    // 头像 md5 与评论区同口径：渲染时从邮箱密文现算，绝不落库。
    for (const row of rows) {
      row.avatar_md5 = avatarMd5Of(row);
    }

    const linksHtml = `${masthead({
      mark: 'Links', title: '友链',
      stats: [
        `<span><b>${total}</b> 位邻居</span>`,
        total ? `<span>最近 ${MAST_RECENT_DAYS} 天 ${recentComments} 条留言</span>` : '',
      ].filter(Boolean),
    })}
${linksBlock({ links: rows, nextHref: page < pages ? `/links/?page=${page + 1}` : null })}`;
    return c.html(layout({
      title: '友链', active: 'links', canonical: '/links/', page: 'links',
      themeType: 'links',
      themeData: {
        links_html: linksHtml,
        links: rows.map((row) => ({
          // publicPage() 的列名是 author / n / last_at：主题 API 沿用 name / comments / last_seen，
          // 在入口映射一次，别让主题作者去猜数据库列名。
          name: row.author || row.host,
          host: row.host,
          url: row.url,
          avatar: row.avatar_md5 ? `/avatar/${row.avatar_md5}?s=96` : '',
          comments: row.n ?? 0,
          last_seen: isoOf(row.last_at) ?? '',
          site_title: row.site_title || '',
        })),
        total,
        pages,
        page,
        recent_comments: recentComments,
      },
      desc: `来过这里的邻居：${total} 位，共 ${commentTotal} 条留言。`,
      main: linksHtml,
    }));
  });

  /** 固定页：content/pages/*.md → /<slug>。没有任何 slug 享有特权（/about 内容不在就 404）；勾了「允许评论」就有评论区，提交走 /<slug>/comment。 */
  function pageRoute(c) {
    const slug = c.req.param('slug');
    const page = repo.getPost(slug, 'page');
    if (!page) {
      const target = repo.findAlias(c.req.path);
      if (target && contentUrl(target) !== c.req.path) return c.redirect(contentUrl(target), 301);
      return notFound(c);
    }


    if (c.req.query('partial') === 'comments') return c.html(commentBlockFor(c, page));

    const mins = readingMinutes(page.word_count ?? 0);
    const stats = [
      page.word_count ? `<span>约 ${formatWordCount(page.word_count)}</span>` : '',
      mins ? `<span>约 ${mins} 分钟</span>` : '',
      page.updated_at ? `<span class="mast-span">更新于 ${esc(formatDayCn(page.updated_at))}</span>` : '',
    ].filter(Boolean);
    const commentBlock = commentBlockFor(c, page);
    const pageMainHtml = pageMain({

      title: page.title, html: page.body_html ?? '', mark: slug, stats, comments: commentBlock, lang: page.lang || '',
    });

    return c.html(layout({
      title: page.title,

      active: slug,
      canonical: pageUrl(slug),
      page: 'page',
      themeType: 'page',
      themeData: {
        page: {
          ...themePost({ ...page, comments: countOfPost(c, page.id) }),
          description: page.description || '',
          body_html: page.body_html ?? '',
          stats,
          comments_html: commentBlock,
        },
        comments_html: commentBlock,
        stats,
        page_html: pageMainHtml,
      },
      desc: page.description || cleanExcerpt(page.body_html ?? '', 100),
      ogImage: ogImageOf(c, page) ?? defaultOgImage(),
      lang: page.lang || '',
      main: pageMainHtml,
    }));
  }

  /** 全站检索：GET /search 独立检索页（零 JS 可用）。必须注册在下面的 /:slug 之前：它是单段路径，排后面会被固定页通配吃掉，/search 会去查一个叫 "search" 的固定页然后 404。 */
  app.get('/search', (c) => {
    const ip = clientIp(c) || 'unknown';
    const key = crypt?.ipHash ? crypt.ipHash(ip) : ip;
    if (searchLimiter.rateLimited(key)) {
      return c.text('检索过于频繁，请稍后再试。', 429, { 'Retry-After': '60' });
    }
    const q = (c.req.query('q') ?? '').slice(0, 200);
    const result = searchOf().query({ q });
    // 结果行与文章列表同构，右下角那枚「N 条评论」也得是真数：一条 IN 查询批量取，不逐篇点查。
    const counts = comments.countsOf(result.hits.map((h) => h.id));
    const searchHtml = searchMain({ q, result, counts });

    return c.html(layout({
      // 标题带检索词：浏览器历史里一眼能认出哪条是哪次搜索。
      title: result.parsed.text ? `检索：${result.parsed.text}` : '检索',
      main: searchHtml,
      active: 'search',
      canonical: '/search',
      page: 'search',
      themeType: 'search',
      themeData: {
        q,
        result,
        // Map 在 Liquid 里不好用；转成 { 文章 id: 已通过评论数 } 的普通对象。
        counts: Object.fromEntries(counts),
        search_html: searchHtml,
      },
      // 结果页不进索引：内容都能从别处到，进索引只会让搜索引擎拿到一堆近似重复的入口。
      noindex: true,
      desc: '按词检索全站的文章与笔记。',
    }));
  });

  app.get('/a/:year', (c) => {
    const year = c.req.param('year');
    if (!/^\d{4}$/.test(year)) return notFound(c);
    const posts = repo.publishedInYear(year).map((p) => shape(p));

    const yearMain = posts.length
      ? `${masthead({ mark: 'Archive', title: `${year} 年`, stats: [`<span><b>${posts.length}</b> 篇</span>`] })}
${listBlock(posts)}`
      : `${masthead({ mark: 'Archive', title: `${year} 年` })}
${emptyPage('这一年还没有内容', `换一年看看，或者去 <a href="/archive/">归档</a> 翻全部。`, 'p')}`;
    return c.html(layout({
      title: `${year} 年`, active: 'archive', canonical: `/a/${year}`,
      page: 'list',
      themeType: 'archive-year',
      themeData: {
        year,
        posts: posts.map(themePost),
        year_html: yearMain,
        // archive-year → archive 的回退：archive.liquid 通常读 data.archive_html。
        archive_html: yearMain,
        empty: !posts.length,
      },
      desc: `${year} 年的全部内容。`,
      main: yearMain,
    }));
  });


  app.get('/go/:name', (c) => {
    const name = c.req.param('name');   // 同上：路径参数已由 Hono 解码
    const post = repo.resolveWikiLink(name);


    if (post) {
      // 固定页有自己的固定路由（/about 那类），按文章拼 /p/<slug>/ 会 301 到必然 404 的地址。
      if (post.kind === 'page') return c.redirect(pageUrl(post.slug), 301);
      return c.redirect(post.kind === 'note' ? noteHref(post.slug) : postUrl(post), 301);
    }
    const goMain = emptyPage('还没有这一篇', `<a href="/">首页</a>`);
    return c.html(layout({
      title: `未找到：${name}`, noindex: true, canonical: '/go/',
      desc: '这个链接指向的内容还不存在。',
      page: 'go',
      themeType: 'go',
      themeData: { name, go_html: goMain },
      main: goMain,
    }), 404);
  });


  // 404 页与请求路径无关（固定标题/最近更新），整体渲染要两条 DB 查询 + 全模板；
  // `app.get('*', notFound)` 意味着任意扫路径流量都会落到这里，60s 单条缓存把放大系数封死。
  let notFoundCache = null;
  const NOT_FOUND_TTL_MS = 60_000;
  function notFound(c) {
    const hit = notFoundCache;
    if (hit && Date.now() - hit.at < NOT_FOUND_TTL_MS) return c.body(hit.body, 404);
    // 404 不只是一个死胡同：给搜索框与最近更新，把误入的人接回内容里。
    const recentRows = repo.recentEntries(3);
    const recentCounts = recentRows.length ? comments.countsOf(recentRows.map((row) => row.id)) : new Map();
    const recent = recentRows.map((row) => shape({ ...row, comments: recentCounts.get(row.id) ?? 0 }));
    const notFoundMain = `<article class="post post-empty post-404">
      <h1 class="post-empty-title">404</h1>
    </article>
    <form class="s-form post-404-search" action="/search" method="get" role="search">
      <div class="s-field">
        <label class="s-lbl" for="sQ404">检索词</label>
        <input class="s-input" id="sQ404" type="search" name="q" autocomplete="off" spellcheck="false">
        <button class="s-go" type="submit">检索</button>
      </div>
    </form>
${recent.length ? `    <section class="recent recent-404">
      <h2 class="recent-head">最近更新</h2>
${entriesBlock(recent, { relative: true })}
    </section>` : ''}`;
    const res = layout({
      title: '404', noindex: true, canonical: '/404',
      desc: '页面不存在。',
      page: '404',
      themeType: '404',
      themeData: { recent: recent.map(themePost), not_found_html: notFoundMain },
      main: notFoundMain,
    });
    notFoundCache = { at: Date.now(), body: res };
    return c.html(res, 404);
  }



  // 固定页通用路由必须排最后：前面所有具体路由先匹配，剩下的单段地址才轮到它，接不住的掉进下面的 404。
  app.get('/:slug', pageRoute);

  app.get('*', notFound);
  return app;
}

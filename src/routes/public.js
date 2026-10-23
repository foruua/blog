import { IMAGE_PLACEHOLDER, mediaFallback } from '../media/variants.js';
import { Hono } from 'hono';
import { SITE, FRIENDS_PER_PAGE, FRIENDS_PER_SOURCE, LINKS_PER_PAGE } from '../config.js';
import { settings, heroImages, heroMode, heroVideoMode, heroLayout, heroTone } from '../settings.js';
import { layout, listBlock, emptyPage, masthead, entriesBlock, moreLink, defaultOgImage } from '../render/layout.js';
import { notesStream, splitImages } from '../render/notes.js';
import { withLightbox } from '../render/lightbox.js';
import { EXPAND_ICON, HERO_IMAGE_SIZES } from '../render/icons.js';
import { isVideoSource, heroAspectOf } from '../media/video.js';
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
  // 首页封面：hero() 与 heroPreload() 各要一份，heroMode() 又多一次 settings 查询——都收进请求缓存。
  const heroImgsOf = (c) => settingOf(c, 'heroImages', () => heroImages(repo));
  const heroModeOf = (c) => settingOf(c, 'heroMode', () => heroMode(repo));
  const heroVideoModeOf = (c) => settingOf(c, 'heroVideoMode', () => heroVideoMode(repo));
  const heroLayoutOf = (c) => settingOf(c, 'heroLayout', () => heroLayout(repo));
  const heroToneOf = (c) => settingOf(c, 'heroTone', () => heroTone(repo));

  function hero(c) {
    const all = statsOf(c);
    const posts = all.find((p) => p.kind === 'post')?.n ?? 0;
    const notes = all.find((p) => p.kind === 'note')?.n ?? 0;
    const first = all.map((p) => p.first).sort()[0];
    const since = first ? formatDay(first).slice(0, 4) : String(new Date().getFullYear());

    const imgs = heroImgsOf(c);
    const heroAlt = SITE.identity;
    const heroLayoutKey = heroLayoutOf(c);
    const tone = heroToneOf(c);
    const hasCopy = (im) => Boolean(im.title || im.subtitle || (im.link && im.linkText));
    // 每张封面的文字层：位置/字号由版式类控制，内容完全来自首屏数据（无 JS 也能看到第一张）。
    const heroCopy = (im, active = false) => {
      const title = esc(im.title ?? '');
      const subtitle = esc(im.subtitle ?? '');
      const link = im.link && im.linkText ? String(im.link) : '';
      const empty = !title && !subtitle && !link;
      const kicker = heroLayoutKey === 'label' && subtitle ? `<span class="hero-copy-kicker">${subtitle}</span>` : '';
      const sub = subtitle && heroLayoutKey !== 'label' ? `<span class="hero-copy-sub">${subtitle}</span>` : '';
      const cta = link
        ? `<a class="hero-copy-link" href="${esc(link)}"${/^https?:\/\//i.test(link) ? ' target="_blank" rel="noopener"' : ''}>${esc(im.linkText)}</a>`
        : '';
      // 单图时标题是 <h1>，里面只能放 phrasing content：这里用 span（CSS 给 block 显示），
      // 别再换成 div/p —— 浏览器虽能渲染，HTML 校验和读屏的可访问名都会变。
      return `<span class="hero-copy hero-copy-${heroLayoutKey} hero-copy-${tone}${empty ? ' is-empty' : ''}${active ? ' is-active' : ''}"${active ? '' : ' aria-hidden="true"'}>
        ${empty ? '' : `<span class="hero-copy-inner">${kicker}${title ? `<span class="hero-copy-title">${title}</span>` : ''}${sub}${cta}</span>`}
      </span>`;
    };
    // 首页所有封面统一用「当前视频」的比例；没有视频时按 16:9。图片可能被裁切，但灯箱仍打开完整图。
    const heroAspect = heroAspectOf(imgs);
    const heroRatio = heroAspect.ratio;
    const heroArStyle = `--hero-ar: ${heroAspect.style}`;

    // 首屏图被 CSS 限在 480px 内，故 sizes 封顶 480——不写浏览器按 100vw 选，桌面端挑最大档，白下十倍字节。
    const slideAttrs = (im) => {
      const shot = mediaOf(c, im.path);
      const srcsetValue = shot?.srcset ? esc(shot.srcset) : '';
      // 宽高外补行内 aspect-ratio：只有属性时计算值是 `auto W / H`，懒加载审计认不出。
      // 比例统一取 heroRatio（当前视频），图片用 CSS object-fit: cover 裁切。
      const dims = im.w > 0 && im.h > 0
        ? ` width="${im.w}" height="${im.h}" style="aspect-ratio:${heroRatio}"`
        : '';
      const src = esc(shot?.preview ?? shot?.thumbnail ?? mediaFallback(im.path));
      // 非当前张的占位取候选集里最小的一档（240w）。5 张 slide 叠在同一个视口位置，loading=lazy
      // 不会生效；只放一张几 KB 的小图，等轮播要切到它时再由 app.js 换成正式 srcset。
      const tiny = shot?.srcset
        ? esc(shot.srcset.split(',')[0].trim().split(/\s+/)[0])
        : esc(shot?.thumbnail ?? mediaFallback(im.path));
      // 灯箱展示图取最大档变体（动画图由 shot.full 决定回原图）。
      const full = esc(shot?.full ?? im.path);
      return { src, srcsetValue, dims, full, tiny };
    };

    // 封面视频：auto = 静音循环自动播，点视频进灯箱；click = 停在首帧，点视频就地播放（带声音），
    // 右上角另有按钮进灯箱。两种模式都不影响轮播的切换逻辑。
    const videoMode = heroVideoModeOf(c);
    const clickMode = videoMode === 'click';
    const playBadge = clickMode
      ? '<span class="hero-play" aria-hidden="true"><svg viewBox="0 0 24 24" fill="currentColor"><path d="M8 5.5v13l11-6.5z"/></svg></span>'
      : '';
    const lightboxAttrs = (im) => ` data-lightbox="hero" data-media="video" data-full="${esc(im.path)}"`
      + `${im.w > 0 && im.h > 0 ? ` data-w="${im.w}" data-h="${im.h}"` : ''}`;
    const expandIcon = EXPAND_ICON;
    const videoTag = (im, { slide = false, active = false } = {}) => {
      const dims = im.w > 0 && im.h > 0 ? ` width="${im.w}" height="${im.h}"` : '';
      const playing = !clickMode && (!slide || active);
      const video = `<video class="hero-video" src="${esc(im.path)}"${dims}`
        + `${clickMode ? ' playsinline' : ' muted loop playsinline'}`
        + `${playing ? ' autoplay' : ''} preload="${clickMode ? (active || !slide ? 'metadata' : 'none') : (playing ? 'metadata' : 'none')}"`
        // 老内核（鸿蒙自带、X5/WebView）只认这个内联播放标记；脚本还会再补一次并显式 play()。
        + ' webkit-playsinline'
        + ` data-video-mode="${videoMode}"${clickMode ? '' : lightboxAttrs(im)} aria-label="${esc(heroAlt)}"></video>`;
      const expand = clickMode
        ? `<a class="hero-expand" href="${esc(im.path)}" target="_blank" rel="noopener"${lightboxAttrs(im)} aria-label="在灯箱中播放视频">${expandIcon}</a>`
        : '';
      const inner = `${video}${playBadge}${expand}`;
      return slide
        ? `<span class="hero-slide${active ? ' is-active' : ''}"${active ? '' : ' tabindex="-1" aria-hidden="true"'}>${inner}</span>`
        : `<span class="hero-media">${inner}</span>`;
    };

    let title;
    if (imgs.length === 1) {

      const im = imgs[0];
      // 单图/单视频也要 --hero-ar：相框与媒体的宽都按这套比例算死，不依赖文件有没有到（见 .hero-figure img）。
      const ar = ` style="${heroArStyle}"`;
      if (isVideoSource(im.path)) {
        title = `<h1 class="hero-title hero-figure"${ar}${hasCopy(im) ? '' : ` aria-label="${esc(heroAlt)}"`}>${videoTag(im, { active: true })}${heroCopy(im, true)}</h1>`;
      } else {
        const { src, srcsetValue, dims, full } = slideAttrs(im);
        title = `<h1 class="hero-title hero-figure"${ar}${hasCopy(im) ? '' : ` aria-label="${esc(heroAlt)}"`}><img src="${src}"${srcsetValue ? ` srcset="${srcsetValue}" sizes="${HERO_IMAGE_SIZES}"` : ''} data-full="${full}" data-lightbox="hero" alt="${esc(heroAlt)}"${dims} fetchpriority="high" decoding="async">${heroCopy(im, true)}</h1>`;
      }
    } else if (imgs.length > 1) {
      // 多图轮播：图叠在 .hero-track（CSS 只露第一张），控制条由 JS 揭开——没 JS 时只有一张安静封面，不会拿到按了没反应的按钮。
      const slides = imgs.map((im, i) => {
        if (isVideoSource(im.path)) return videoTag(im, { slide: true, active: i === 0 });
        const { src, srcsetValue, dims, full, tiny } = slideAttrs(im);
        const active = i === 0;
        // 第一张照常直出；其余只放 240w 小图 + data-src/data-srcset，由 app.js 在空闲或切换前升级。
        const source = active
          ? ` src="${src}"${srcsetValue ? ` srcset="${srcsetValue}" sizes="${HERO_IMAGE_SIZES}"` : ''} fetchpriority="high" decoding="async"`
          : ` src="${tiny}" data-src="${src}"${srcsetValue ? ` data-srcset="${srcsetValue}" sizes="${HERO_IMAGE_SIZES}"` : ''} loading="lazy" decoding="async"`;
        return `<img class="hero-slide${active ? ' is-active' : ''}"${source} data-full="${full}" data-lightbox="hero" alt="${esc(heroAlt)}"${dims}>`;
      }).join('');
      const dots = imgs.map((_, i) =>
        `<button type="button" class="hero-dot" aria-label="第 ${i + 1} 张" aria-pressed="${i ? 'false' : 'true'}"></button>`).join('');
      const copies = imgs.map((im, i) => heroCopy(im, i === 0)).join('');
      // 图幅比 --hero-ar 交给 CSS：轮播整层宽高必须由样式先算，不能等图片固有尺寸，否则 CSS 那条 width 失效、退回 auto。
      const ar = ` style="${heroArStyle}"`;
      title = `<div class="hero-carousel"${ar} data-hero-carousel data-hero-mode="${heroModeOf(c)}" role="group" aria-roledescription="图片轮播">
        <h1 class="hero-title hero-figure" aria-label="${esc(heroAlt)}"><span class="hero-track">${slides}</span></h1>
        ${copies ? `<div class="hero-copies">${copies}</div>` : ''}
        <div class="hero-ctrl" hidden><span class="hero-dots">${dots}</span>${heroModeOf(c) === 'auto'
          ? '<button type="button" class="hero-pause" data-hero-pause aria-label="暂停自动轮播" aria-pressed="false"><svg class="hero-pause-ico hero-pause-ico-pause" viewBox="0 0 12 12" aria-hidden="true"><path d="M4 2.3v7.4M8 2.3v7.4"/></svg><svg class="hero-pause-ico hero-pause-ico-play" viewBox="0 0 12 12" aria-hidden="true"><path d="M3.4 2.1 9.5 6l-6.1 3.9Z"/></svg></button>' : ''}</div>
      </div>`;
    } else {
      title = `<h1 class="hero-title">${esc(SITE.identity)}</h1>`;
    }

    const mark = SITE.mark && (imgs.length || SITE.title)
      ? `<p class="hero-mark">${esc(SITE.mark)}</p>`
      : '';
    return `    <section class="hero">
      ${mark}
      ${title}
      <p class="hero-meta">
        <a href="/posts/">${posts} 篇文章</a>
        <span class="sep">·</span>
        <a href="/notes/">${notes} 篇笔记</a>
        <span class="sep">·</span>
        <span>自 ${since} 年</span>
      </p>
${recent(c)}
    </section>`;
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
        list_html: list.length ? listBlock(shaped, { showKind: false }) : '',
        empty: !list.length,
      },
      main: list.length
        ? `${mast}
${listBlock(shaped, { showKind: false })}
    ${more}`
        : emptyList(mark, title),
      active, canonical: pathname,
      desc,
    }));
  }

  // 首页封面是 LCP：在 <head> 里 preload 第一张的候选集，让浏览器解析到 body 之前就开抢。
  // imagesrcset/imagesizes 必须与正文那张 <img> 完全一致，浏览器才会挑同一档，不会白下两份。
  function heroPreload(c) {
    const imgs = heroImgsOf(c);
    if (!imgs.length) return '';
    const shot = mediaOf(c, imgs[0].path);
    if (!shot?.srcset) return '';
    const href = esc(shot.preview ?? shot.thumbnail ?? IMAGE_PLACEHOLDER);
    const sizes = HERO_IMAGE_SIZES;
    return `<link rel="preload" as="image" href="${href}" imagesrcset="${esc(shot.srcset)}" imagesizes="${sizes}" fetchpriority="high">`;
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
          layout: heroLayoutOf(c),
          tone: heroToneOf(c),
          images: heroImgsOf(c).map(({ path, w, h, title, subtitle, link, linkText }) => ({
            path, w, h, title: title ?? '', subtitle: subtitle ?? '', link: link ?? '', linkText: linkText ?? '',
          })),
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
    const toc = post.toc?.length
      ? `      <details class="toc"><summary>目录（${post.toc.length} 节）</summary>
        <ol>${post.toc.map((t) => `<li class="lvl-${t.level}"><a href="#${esc(t.id)}">${esc(t.text)}</a></li>`).join('')}</ol>
      </details>`
      : '';

    const { newer, older } = repo.neighbours(post);
    const commentBlock = commentBlockFor(c, post);

    const neighbour = (p, label) => (p
      ? `<div${label === '下一篇' ? ' class="n"' : ''}><small>${label}</small><a href="${postUrl(p)}">${esc(p.title)}</a></div>`
      : '');
    const pager = (newer || older)
      ? `      <nav class="pager" aria-label="翻页">
${[neighbour(older, '上一篇'), neighbour(newer, '下一篇')].filter(Boolean).join('\n')}
      </nav>`
      : '';



    const note = post.kind === 'note';

    // 刊头等宽小字：等宽栈无中文字形（见 style.css 的 --mono），故「年/月/日」与数字落在中文字体上，整行不碎成两副面孔。
    const dayCn = formatDayCn(post.published_at);


    const bodyHtml = withLightbox(post.body_html, `${kindPrefix(post.kind)}-${post.slug}`, (src) => mediaOf(c, src));
    const main = `    <article class="post" data-kind="${note ? 'note' : 'post'}"${post.lang ? ` lang="${esc(post.lang)}"` : ''}>
      <header class="post-mast">
        <p class="pm-mark"><span class="pm-kind">${note ? '笔记' : '文章'}</span><span class="pm-sep" aria-hidden="true">·</span><time datetime="${esc(post.published_at)}">${esc(dayCn)}</time></p>
        <h1>${esc(post.title)}</h1>
        <p class="meta" title="${esc(formatDay(post.published_at))}" data-day="${esc(formatDay(post.published_at))}">${esc(relativeDate(post.published_at))} · ${words} 字${mins ? ` · 约 ${mins} 分钟` : ''}</p>
      </header>
${toc}
      <div class="prose">
${bodyHtml}
      </div>

${pager}
${commentBlock}
    </article>`;

    const pathname = postUrl(post);
    const publishedIso = isoOf(post.published_at);
    const modifiedIso = isoOf(post.updated_at);
    const og = ogImageOf(c, post) ?? defaultOgImage();
    const articleLd = {
      '@context': 'https://schema.org',
      '@type': 'BlogPosting',
      headline: post.title,
      description: cleanExcerpt(post.body_html, 160),
      url: `${SITE.url}${pathname}`,
      mainEntityOfPage: { '@type': 'WebPage', '@id': `${SITE.url}${pathname}` },
      inLanguage: post.lang || SITE.lang,
      author: { '@type': 'Person', name: SITE.author || SITE.identity },
      publisher: { '@type': 'Organization', name: SITE.identity, url: `${SITE.url}/`,
        logo: { '@type': 'ImageObject', url: `${SITE.url}/icon-512.png` } },
      articleSection: note ? '笔记' : '文章',
      commentCount: countOfPost(c, post.id),
      image: [og.url],
      ...(post.word_count ? { wordCount: post.word_count } : {}),
      ...(publishedIso ? { datePublished: publishedIso } : {}),
      ...(modifiedIso ? { dateModified: modifiedIso } : {}),
    };
    const breadcrumbLd = {
      '@context': 'https://schema.org',
      '@type': 'BreadcrumbList',
      itemListElement: [
        { '@type': 'ListItem', position: 1, name: '首页', item: `${SITE.url}/` },
        { '@type': 'ListItem', position: 2, name: note ? '笔记' : '文章', item: `${SITE.url}${note ? '/notes/' : '/posts/'}` },
        { '@type': 'ListItem', position: 3, name: post.title, item: `${SITE.url}${pathname}` },
      ],
    };
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
      jsonLd: [articleLd, breadcrumbLd],
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
      ? (typeof feeds.itemsForFeeds === 'function'
        ? feeds.itemsForFeeds(page.feeds.map((f) => f.feedId), { perSource: FRIENDS_PER_SOURCE, before: page.cursor, until: last })
        : feeds.itemsBySource({ perSource: FRIENDS_PER_SOURCE, before: page.cursor, until: last }))
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
    // 大页码先夹到最后一页：避免用 240 万 OFFSET 跑一次聚合，也避免“空页→统计→重查”的三次 CTE。
    // 第 1 页不额外查计数，常规访问成本与之前一致。
    if (page > 1 && typeof links.publicCount === 'function') {
      page = Math.min(page, Math.max(1, Math.ceil(Number(links.publicCount()) / perPage)));
    }
    let total = 0;
    let commentTotal = 0;
    // 正常页一次查询同时拿列表与刊头统计；只有越界页/空名单才再点查一次统计来夹页。
    let rows = links.publicPage({ limit: perPage, offset: (page - 1) * perPage });
    if (rows.length) {
      total = Number(rows[0].total) || 0;
      commentTotal = Number(rows[0].all_comments) || 0;
    } else {
      const agg = links.publicStats();
      total = Number(agg.links) || 0;
      commentTotal = Number(agg.comments) || 0;
      const lastPage = Math.max(1, Math.ceil(total / perPage));
      if (page !== lastPage) {
        page = lastPage;
        rows = links.publicPage({ limit: perPage, offset: (page - 1) * perPage });
        if (rows.length) {
          total = Number(rows[0].total) || total;
          commentTotal = Number(rows[0].all_comments) || commentTotal;
        }
      }
    }
    const pages = Math.max(1, Math.ceil(total / perPage));
    page = Math.min(pages, page);

    // 头像 md5 与评论区同口径：渲染时从邮箱密文现算，绝不落库。
    for (const row of rows) {
      row.avatar_md5 = avatarMd5Of(row);
    }

    // 刊头统计与「友圈」同形：第一格数页面上有几位，第二格是滚动 30 天窗口；没邻居时整行只剩第一格。
    const recentComments = total ? links.publicRecent(recentStartIso(MAST_RECENT_DAYS)) : 0;

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


  function notFound(c) {
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
    return c.html(layout({
      title: '404', noindex: true, canonical: '/404',
      desc: '页面不存在。',
      page: '404',
      themeType: '404',
      themeData: { recent: recent.map(themePost), not_found_html: notFoundMain },
      main: notFoundMain,
    }), 404);
  }



  // 固定页通用路由必须排最后：前面所有具体路由先匹配，剩下的单段地址才轮到它，接不住的掉进下面的 404。
  app.get('/:slug', pageRoute);

  app.get('*', notFound);
  return app;
}

// 首页封面（首屏大图 / 轮播 / 封面视频）与它的 preload 提示。
// 纯函数：数据、设置、媒体查询结果都由调用方传进来 —— 这里不碰 repo、不读请求上下文，
// 因此同一份标记可以被首页路由、主题预览与测试直接复用。markup 与拆分前逐字相同。
import { SITE } from '../config.js';
import { esc, formatDay } from '../util/text.js';
import { EXPAND_ICON, HERO_IMAGE_SIZES } from './icons.js';
import { IMAGE_PLACEHOLDER, mediaFallback } from '../media/variants.js';
import { isVideoSource, heroAspectOf } from '../media/video.js';

/**
 * 首页封面整块（含「最近更新」）。
 * @param {object} o
 * @param {Array} o.stats         publishedStats()：按 kind 汇总的 { kind, n, first, last, words }
 * @param {Array} o.imgs          封面图/视频列表（{ path, w, h, title, subtitle, link, linkText }）
 * @param {string} o.layoutKey    文字层版式（'label' 等）
 * @param {string} o.tone         文字层色调
 * @param {string} o.videoMode    封面视频行为：'auto' | 'click'
 * @param {string} o.mode         轮播模式：'auto' | 'manual'
 * @param {Function} o.mediaOf    路径 → 媒体变体信息（可为 null）
 * @param {string} o.recentHtml   「最近更新」区块（已渲染；空串则不占位）
 */
export function heroBlock({ stats = [], imgs = [], layoutKey = '', tone = '', videoMode = 'auto', mode = 'manual', mediaOf = () => null, recentHtml = '' }) {
  const posts = stats.find((p) => p.kind === 'post')?.n ?? 0;
  const notes = stats.find((p) => p.kind === 'note')?.n ?? 0;
  const first = stats.map((p) => p.first).sort()[0];
  const since = first ? formatDay(first).slice(0, 4) : String(new Date().getFullYear());

  const heroAlt = SITE.identity;
  const heroLayoutKey = layoutKey;
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
    const shot = mediaOf(im.path);
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
      // 画中画与远程播放是「系统另起一层播放器」的两条合法入口：鸿蒙自带浏览器在首帧还没解出来时
      // 会顺着它们把播放句柄交给系统播放器，于是视频叠在网页上方播，下载完也不交还。
      // 封面是装饰性的静音循环，关掉投屏/PiP 不损失可用性。
      + ' disablepictureinpicture disableremoteplayback'
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
    title = `<div class="hero-carousel"${ar} data-hero-carousel data-hero-mode="${mode}" role="group" aria-roledescription="图片轮播">
        <h1 class="hero-title hero-figure" aria-label="${esc(heroAlt)}"><span class="hero-track">${slides}</span></h1>
        ${copies ? `<div class="hero-copies">${copies}</div>` : ''}
        <div class="hero-ctrl" hidden><span class="hero-dots">${dots}</span>${mode === 'auto'
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
${recentHtml}
    </section>`;
}

/**
 * 首页封面是 LCP：在 <head> 里 preload 第一张的候选集，让浏览器解析到 body 之前就开抢。
 * imagesrcset/imagesizes 必须与正文那张 <img> 完全一致，浏览器才会挑同一档，不会白下两份。
 */
export function heroPreload({ imgs = [], mediaOf = () => null }) {
  if (!imgs.length) return '';
  const shot = mediaOf(imgs[0].path);
  if (!shot?.srcset) return '';
  const href = esc(shot.preview ?? shot.thumbnail ?? IMAGE_PLACEHOLDER);
  const sizes = HERO_IMAGE_SIZES;
  return `<link rel="preload" as="image" href="${href}" imagesrcset="${esc(shot.srcset)}" imagesizes="${sizes}" fetchpriority="high">`;
}

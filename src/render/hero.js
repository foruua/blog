// 首页封面（首屏大图 / 轮播）与它的 preload 提示。
// 纯函数：数据、设置、媒体查询结果都由调用方传进来 —— 这里不碰 repo、不读请求上下文，
// 因此同一份标记可以被首页路由、主题预览与测试直接复用。markup 与拆分前逐字相同。
import { SITE } from '../config.js';
import { esc } from '../util/text.js';
import { HERO_IMAGE_SIZES } from './icons.js';
import { IMAGE_PLACEHOLDER, mediaFallback } from '../media/variants.js';

/**
 * 首页封面整块（含「最近更新」）。
 * @param {object} o
 * @param {Array} o.stats         publishedStats()：按 kind 汇总的 { kind, n, first, last, words }
 * @param {Array} o.imgs          封面图列表（{ path, w, h }）
 * @param {string} o.overlay      蒙版文案（压在封面下缘渐变上，留空不渲染整层）
 * @param {Function} o.mediaOf    路径 → 媒体变体信息（可为 null）
 * @param {string} o.recentHtml   「最近更新」区块（已渲染；空串则不占位）
 * @param {string} o.toolsHtml    hero-meta 行尾的两枚工具（RSS / 配色，已渲染；空串则只剩统计）
 * @param {object} o.words        统计行的两个量词（后台「页面文案」可改，默认「篇文章 / 篇笔记」）
 */
export function heroBlock({ stats = [], imgs = [], overlay = '', mediaOf = () => null, recentHtml = '', toolsHtml = '', words = {} }) {
  const posts = stats.find((p) => p.kind === 'post')?.n ?? 0;
  const notes = stats.find((p) => p.kind === 'note')?.n ?? 0;
  // 量词由调用方给（站主可改），兜底与改造前逐字相同。esc：这是站主输入，不是代码里的常量。
  const postsWord = esc(String(words.posts ?? '篇文章'));
  const notesWord = esc(String(words.notes ?? '篇笔记'));

  const heroAlt = SITE.identity;
  // 蒙版文案：一条全局覆盖层（不分张），无 JS 也能看到。单图时在 <h1> 里，必须是 phrasing content：
  // 用 span（CSS 给 flex 显示），别换成 div/p —— 浏览器虽能渲染，HTML 校验和读屏语义都会变。
  const copy = String(overlay ?? '').trim()
    ? `<span class="hero-copy"><span class="hero-copy-inner">${esc(String(overlay).trim())}</span></span>`
    : '';
  const copyAria = copy ? '' : ` aria-label="${esc(heroAlt)}"`;
  // 首页所有封面统一按 16:9 取景；图片用 CSS object-fit: cover 裁切，灯箱仍打开完整图。
  const heroRatio = '16/9';
  const heroArStyle = '--hero-ar: 16 / 9';

  // 首屏图被 CSS 限在 480px 内，故 sizes 封顶 480——不写浏览器按 100vw 选，桌面端挑最大档，白下十倍字节。
  const slideAttrs = (im) => {
    const shot = mediaOf(im.path);
    const srcsetValue = shot?.srcset ? esc(shot.srcset) : '';
    // 宽高外补行内 aspect-ratio：只有属性时计算值是 `auto W / H`，懒加载审计认不出。
    // 比例统一取 16:9，图片用 CSS object-fit: cover 裁切。
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

  let title;
  if (imgs.length === 1) {
    const im = imgs[0];
    // 单图也要 --hero-ar：相框与图片的宽都按这套比例算死，不依赖文件有没有到（见 .hero-figure img）。
    const ar = ` style="${heroArStyle}"`;
    const { src, srcsetValue, dims, full } = slideAttrs(im);
    title = `<h1 class="hero-title hero-figure"${ar}${copyAria}><img src="${src}"${srcsetValue ? ` srcset="${srcsetValue}" sizes="${HERO_IMAGE_SIZES}"` : ''} data-full="${full}" data-lightbox="hero" alt="${esc(heroAlt)}"${dims} fetchpriority="high" decoding="async">${copy}</h1>`;
  } else if (imgs.length > 1) {
    // 多图轮播：图叠在 .hero-track（CSS 只露第一张），5 秒一张自动推进；无手动控制条。
    const slides = imgs.map((im, i) => {
      const { src, srcsetValue, dims, full, tiny } = slideAttrs(im);
      const active = i === 0;
      // 第一张照常直出；其余只放 240w 小图 + data-src/data-srcset，由 app.js 在空闲或切换前升级。
      const source = active
        ? ` src="${src}"${srcsetValue ? ` srcset="${srcsetValue}" sizes="${HERO_IMAGE_SIZES}"` : ''} fetchpriority="high" decoding="async"`
        : ` src="${tiny}" data-src="${src}"${srcsetValue ? ` data-srcset="${srcsetValue}" sizes="${HERO_IMAGE_SIZES}"` : ''} loading="lazy" decoding="async"`;
      return `<img class="hero-slide${active ? ' is-active' : ''}"${source} data-full="${full}" data-lightbox="hero" alt="${esc(heroAlt)}"${dims}>`;
    }).join('');
    // 图幅比 --hero-ar 交给 CSS：轮播整层宽高必须由样式先算，不能等图片固有尺寸，否则 CSS 那条 width 失效、退回 auto。
    const ar = ` style="${heroArStyle}"`;
    title = `<div class="hero-carousel"${ar} data-hero-carousel role="group" aria-roledescription="图片轮播">
        <h1 class="hero-title hero-figure" aria-label="${esc(heroAlt)}"><span class="hero-track">${slides}</span></h1>
        ${copy}
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
      <div class="hero-meta">
        <a href="/posts/">${posts} ${postsWord}</a>
        <span class="sep">·</span>
        <a href="/notes/">${notes} ${notesWord}</a>
        <span class="sep">·</span>
        ${toolsHtml}
      </div>
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

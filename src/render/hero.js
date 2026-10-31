// 首页封面（首屏大图 / 轮播）与它的 preload 提示。
// 纯函数：数据、设置、媒体查询结果都由调用方传进来 —— 这里不碰 repo、不读请求上下文，
// 因此同一份标记可以被首页路由、主题预览与测试直接复用。markup 与拆分前逐字相同。
import { SITE } from '../config.js';
import { esc } from '../util/text.js';
import { HERO_IMAGE_SIZES } from './icons.js';
import { IMAGE_PLACEHOLDER, mediaFallback } from '../media/variants.js';
import { isVideoSource } from '../media/video.js';

/**
 * 首页封面整块（含「最近更新」）。
 * @param {object} o
 * @param {Array} o.imgs          封面图列表（{ path, w, h }）
 * @param {string} o.overlay      蒙版文案（压在封面下缘渐变上，留空不渲染整层）
 * @param {Function} o.mediaOf    路径 → 媒体变体信息（可为 null）
 * @param {string} o.recentHtml   「最近更新」区块（已渲染；空串则不占位）
 * @param {string} o.toolsHtml    信息行（邮件 / GitHub / RSS / 配色，已渲染；空串则整行不占位）
 */
export function heroBlock({ imgs = [], overlay = '', mediaOf = () => null, recentHtml = '', toolsHtml = '' }) {

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

  // 封面视频：服务端已统一成 16:9 MP4，首帧海报存 media.thumbnail。视频直接播放原文件；
  // 海报同时用于 LCP、preload 与播放被拦截/卡住时的静态回退。
  const videoTag = (im, { slide = false, active = false } = {}) => {
    const shot = mediaOf(im.path);
    const poster = shot?.poster ?? shot?.thumbnail ?? '';
    const w = im.w > 0 ? im.w : Number(shot?.width) || 0;
    const h = im.h > 0 ? im.h : Number(shot?.height) || 0;
    const dims = w > 0 && h > 0 ? ` width="${w}" height="${h}" style="aspect-ratio:${heroRatio}"` : '';
    // 不写 autoplay：那会绕过「减弱动态效果 / 省流」判断，部分内核还会在脚本之前抢跑。
    // 起播统一交给 app.js 显式 play()（静音是前提），无 JS 时至少能看到首帧海报。
    // 单视频无限循环；轮播里播一遍就交给下一张（按视频时长推进），loop 由脚本再校准。
    const loop = !slide;
    return `<video class="hero-video" src="${esc(im.path)}"${dims}${poster ? ` poster="${esc(poster)}"` : ''}`
      + ` muted${loop ? ' loop' : ''} playsinline webkit-playsinline`
      + ` preload="${!slide || active ? 'metadata' : 'none'}" disablepictureinpicture disableremoteplayback`
      + ` data-lightbox="hero" data-media="video" data-full="${esc(im.path)}"`
      + `${poster ? ` data-poster="${esc(poster)}"` : ''}${w > 0 && h > 0 ? ` data-w="${w}" data-h="${h}"` : ''}`
      + ` data-alt="${esc(heroAlt)}"></video>`;
  };

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
    // 单图/单视频也要 --hero-ar：相框与媒体的宽都按这套比例算死，不依赖文件有没有到（见 .hero-figure img）。
    const ar = ` style="${heroArStyle}"`;
    if (isVideoSource(im.path)) {
      title = `<h1 class="hero-title hero-figure"${ar}${copyAria}>${videoTag(im, { active: true })}${copy}</h1>`;
    } else {
      const { src, srcsetValue, dims, full } = slideAttrs(im);
      title = `<h1 class="hero-title hero-figure"${ar}${copyAria}><img src="${src}"${srcsetValue ? ` srcset="${srcsetValue}" sizes="${HERO_IMAGE_SIZES}"` : ''} data-full="${full}" data-lightbox="hero" alt="${esc(heroAlt)}"${dims} fetchpriority="high" decoding="async">${copy}</h1>`;
    }
  } else if (imgs.length > 1) {
    // 图片/视频混合轮播：媒体叠在 .hero-track（CSS 只露第一张）；视频按自身时长推进，图片固定 5 秒。
    const slides = imgs.map((im, i) => {
      const active = i === 0;
      if (isVideoSource(im.path)) {
        return `<span class="hero-slide${active ? ' is-active' : ''}"${active ? '' : ' tabindex="-1" aria-hidden="true"'}>${videoTag(im, { slide: true, active })}</span>`;
      }
      const { src, srcsetValue, dims, full, tiny } = slideAttrs(im);
      // 第一张照常直出；其余只放 240w 小图 + data-src/data-srcset，由 app.js 在空闲或切换前升级。
      const source = active
        ? ` src="${src}"${srcsetValue ? ` srcset="${srcsetValue}" sizes="${HERO_IMAGE_SIZES}"` : ''} fetchpriority="high" decoding="async"`
        : ` src="${tiny}" data-src="${src}"${srcsetValue ? ` data-srcset="${srcsetValue}" sizes="${HERO_IMAGE_SIZES}"` : ''} loading="${dims ? 'lazy' : 'eager'}" decoding="async"`;
      return `<img class="hero-slide${active ? ' is-active' : ''}"${source} data-full="${full}" data-lightbox="hero" alt="${esc(heroAlt)}"${dims}>`;
    }).join('');
    // 图幅比 --hero-ar 交给 CSS：轮播整层宽高必须由样式先算，不能等图片固有尺寸，否则 CSS 那条 width 失效、退回 auto。
    const ar = ` style="${heroArStyle}"`;
    title = `<div class="hero-carousel"${ar} data-hero-carousel role="group" aria-roledescription="封面轮播">
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
${toolsHtml ? `      <div class="hero-meta">
        ${toolsHtml}
      </div>
` : ''}${recentHtml}
    </section>`;
}

/**
 * 首页封面是 LCP：在 <head> 里 preload 第一张的候选集，让浏览器解析到 body 之前就开抢。
 * imagesrcset/imagesizes 必须与正文那张 <img> 完全一致，浏览器才会挑同一档，不会白下两份。
 */
export function heroPreload({ imgs = [], mediaOf = () => null }) {
  if (!imgs.length) return '';
  const shot = mediaOf(imgs[0].path);
  // 视频不抢在解析前下整段 MP4：首屏 LCP 交给首帧海报，视频由 autoplay 自己按需拉流。
  if (isVideoSource(imgs[0].path)) {
    const poster = shot?.poster ?? shot?.thumbnail;
    return poster ? `<link rel="preload" as="image" href="${esc(poster)}" fetchpriority="high">` : '';
  }
  if (!shot?.srcset) return '';
  const href = esc(shot.preview ?? shot.thumbnail ?? IMAGE_PLACEHOLDER);
  const sizes = HERO_IMAGE_SIZES;
  return `<link rel="preload" as="image" href="${href}" imagesrcset="${esc(shot.srcset)}" imagesizes="${sizes}" fetchpriority="high">`;
}

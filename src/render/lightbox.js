import { mediaFallback } from '../media/variants.js';
import { esc, decodeHtmlAttribute, htmlAttr } from '../util/text.js';
import { EXPAND_ICON } from './icons.js';

/** 灯箱（点图看大图 / 点封面视频播放）。弹窗纯静态，交互全在 public/app.js（监听 [data-lightbox]、用 data-full 取展示图/视频、按 data-lightbox 串同组媒体翻页）；哪些媒体能点完全由标记决定。 */

export const lightboxHtml = `  <dialog class="lightbox" id="lightbox" aria-label="图片查看">
    <button type="button" class="lb-close" data-lb-close aria-label="关闭图片查看"><svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" aria-hidden="true"><path d="M4.4 4.4 11.6 11.6M11.6 4.4 4.4 11.6"/></svg></button>
    <button type="button" class="lb-nav lb-prev" data-lb-prev aria-label="上一张">‹</button>
    <img class="lb-img" alt="">
    <video class="lb-video" controls playsinline hidden></video>
    <button type="button" class="lb-nav lb-next" data-lb-next aria-label="下一张">›</button>
    <!-- 「第 3 / 12 张」由 app.js 的 lbShow() 改写，所以这里要是个 live region：
         翻页时视觉上看得到换了张，读屏不播报就等于什么都没发生。 -->
    <p class="lb-count" role="status" aria-live="polite"></p>
  </dialog>`;

const imgAlt = (tag) => decodeHtmlAttribute(/\balt="([^"]*)"/i.exec(tag)?.[1] ?? '');
const imgSrc = (tag) => decodeHtmlAttribute(/\bsrc="([^"]*)"/i.exec(tag)?.[1] ?? '');

// 存量正文由旧版渲染器写入：有 width/height 但无行内 aspect-ratio，只靠属性算出的比例是 auto W / H，会被懒加载审计判成「没设比例」（CLS）；就地补一条，与 markdown.js 同一套标记。
function withAspectRatio(tag) {
  if (/\baspect-ratio\s*:/i.test(tag)) return tag;
  const w = /\bwidth="(\d+)"/i.exec(tag)?.[1];
  const h = /\bheight="(\d+)"/i.exec(tag)?.[1];
  if (!w || !h) return tag;
  const style = /\bstyle="([^"]*)"/i.exec(tag)?.[1];
  return style === undefined
    ? tag.replace(/>$/, ` style="aspect-ratio:${w}/${h}">`)
    : tag.replace(/\bstyle="[^"]*"/i, `style="aspect-ratio:${w}/${h};${style}"`);
}

/** 给正文插图挂灯箱属性；正文视频再补一枚「灯箱播放」按钮。渲染页面时做，不写回数据库。@param group 同组标识（一般 p-<slug>）：翻页只在这一篇的图里走。 */
export function withLightbox(html, group, imageInfo) {
  const id = esc(group);
  const expandIcon = EXPAND_ICON;
  // 正文视频（<span class="prose-video"> 包着 <video controls>）自带控制条，不能抢它的点击；
  // 在右上角补一枚独立按钮进灯箱。组 id 与图片一致，混合翻页时顺序就是正文顺序。
  let out = String(html ?? '').replace(/<span class="prose-video">([\s\S]*?)<\/span>/gi, (whole, inner) => {
    if (/prose-video-expand|data-lightbox=/i.test(whole)) return whole;
    const src = decodeHtmlAttribute(/<source\b[^>]*\bsrc="([^"]*)"/i.exec(inner)?.[1] ?? '');
    if (!src) return whole;
    const videoTag = /<video\b[^>]*>/i.exec(inner)?.[0] ?? '';
    const alt = decodeHtmlAttribute(/\baria-label="([^"]*)"/i.exec(videoTag)?.[1] ?? '');
    const w = /\bwidth="(\d+)"/i.exec(videoTag)?.[1] ?? '';
    const h = /\bheight="(\d+)"/i.exec(videoTag)?.[1] ?? '';
    const label = esc(alt ? `在灯箱中播放：${alt}` : '在灯箱中播放视频');
    const button = `<a class="prose-video-expand" href="${esc(src)}" target="_blank" rel="noopener"`
      + ` data-lightbox="${id}" data-media="video" data-full="${esc(src)}"`
      + `${alt ? ` data-alt="${esc(alt)}"` : ''}${w && h ? ` data-w="${w}" data-h="${h}"` : ''}`
      + ` aria-label="${label}">${expandIcon}</a>`;
    return `<span class="prose-video">${inner}${button}</span>`;
  });
  return out.replace(/<img\b[^>]*>/gi, (tag, offset, whole) => {
    tag = withAspectRatio(tag);
    if (/\bdata-lightbox=/i.test(tag)) return tag;
    const full = htmlAttr(tag, 'data-full') || null;
    const source = full ? decodeHtmlAttribute(full) : imgSrc(tag);
    if (!source || /^data:/i.test(source)) return tag;
    // 旧渲染器可能已按旧语义写过 data-full/data-original：先清掉，末尾统一按新语义重写，免得出现两个 data-full。
    tag = tag.replace(/\sdata-(?:full|original)="[^"]*"/gi, '');

    // shown = 灯箱展示图（最大档 WebP 变体优先，动画图/无变体则是原图）；orig 只用于下面「作者是否把图片包在自己的链接里」的判断。
    let orig = source;
    let shown = source;
    if (imageInfo) {
      const info = imageInfo(source);
      orig = info?.original ?? source;
      shown = info?.full ?? orig;
      tag = tag.replace(/(\s)src="[^"]*"/i, (_match, space) => `${space}src="${esc(info?.preview ?? info?.thumbnail ?? mediaFallback(source))}"`)
        .replace(/\s(?:srcset|sizes)="[^"]*"/gi, '');
      if (info?.srcset) tag = tag.replace(/>$/, () => ` srcset="${esc(info.srcset)}" sizes="${esc(info.sizes ?? '100vw')}">`);
    }

    // 作者把图片包在别的链接里是刻意的，不该被灯箱抢走点击；包的是图片自己则照常进灯箱。
    const before = whole.slice(Math.max(0, offset - 400), offset);
    const linked = /<a\b[^>]*\shref="([^"]*)"[^>]*>\s*$/i.exec(before)?.[1];
    if (linked && ![source, orig, shown].includes(decodeHtmlAttribute(linked))) return tag;

    const alt = imgAlt(tag);
    const attrs = ` data-full="${esc(shown)}"${alt ? ` data-alt="${esc(alt)}"` : ''}`;
    // 只补数据，不补「我是个按钮」这类语义：role/tabindex/aria-label 由 decorateLightbox() 在脚本跑起来后补——写死会让关掉 JS 的读者拿到一串「按了没反应」的假按钮。
    return tag.replace(/>$/, () => ` data-lightbox="${id}"${attrs}>`);
  });
}

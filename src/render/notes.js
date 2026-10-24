import { mediaFallback } from '../media/variants.js';
import { esc, decodeHtmlAttribute, htmlAttr, noteHref, cleanExcerpt } from '../util/text.js';
import { dateBadge, commentLabel } from './layout.js';

export function splitImages(html) {
  const images = [];
  // 顺带带出渲染回填的 width/height，画廊照写一份：没尺寸时图片加载完才撑开高度，整条笔记流会被顶动（CLS）。
  const attr = (tag, name) => {
    const value = htmlAttr(tag, name);
    return /^\d+$/.test(value) ? value : null;
  };
  // 图片按文档顺序抽出来；属性值里允许出现被引号包住的 `>`（alt="a > b"），别让正则在这里提前截断标签。
  const MEDIA_RE = /<img\b(?:[^>"']|"[^"]*"|'[^']*')*>/gi;
  let text = String(html ?? '').replace(MEDIA_RE, (block) => {
    const src = decodeHtmlAttribute(htmlAttr(block, 'data-full') || htmlAttr(block, 'src'));
    const alt = decodeHtmlAttribute(/alt="([^"]*)"/i.exec(block)?.[1] ?? '');
    const width = attr(block, 'width');
    const height = attr(block, 'height');
    if (src) images.push({ src, alt, width, height });
    return '';
  });

  // 剥掉 <img> 会留下空的 <a href></a> 或空段落——不可见却能被 Tab/读屏触及，这里一并清掉。
  text = text.replace(/<a\b[^>]*>\s*<\/a>/gi, '');
  text = text.replace(/<p>\s*<\/p>/gi, '').replace(/\n{3,}/g, '\n\n').trim();
  return { text, images };
}

/* 列表最多铺 4 张；多的不占位，但必须在 DOM 里留数据——灯箱按 data-lightbox 在全文档收集同组节点，少一个就少一张（见 gallery() 的 offstage）。 */
const GALLERY_MAX = 4;

/* 图集。eager 只给首篇特写（第一张是 LCP 候选）；折叠行里的图一律 lazy。 */
const gallery = (images, slug, eager = false) => {
  if (!images.length) return '';
  const shown = images.slice(0, GALLERY_MAX);
  const rest = images.slice(GALLERY_MAX);
  const n = shown.length;
  /* 列数 = 铺出来的张数（CSS 按 data-count 定）；sizes 给浏览器挑 srcset，784 = 栏宽减格间距 .7rem 再除列数。 */
  const sizes = n === 1
    ? '(min-width: 832px) 784px, calc(100vw - 48px)'
    : n === 2
      ? '(max-width: 620px) calc((100vw - 59px) / 2), (min-width: 832px) 386px, calc((100vw - 59px) / 2)'
      : n === 3
        ? '(max-width: 620px) calc((100vw - 70px) / 3), (min-width: 832px) 254px, calc((100vw - 70px) / 3)'
        : '(max-width: 620px) calc((100vw - 59px) / 2), (min-width: 832px) 188px, calc((100vw - 82px) / 4)';
  /* 单图把原始比例写行内：单图档 CSS 是 aspect-ratio:auto（别被多图 3/2 硬裁），而 auto 只用固有尺寸；折叠行的图 lazy、解码前无固有尺寸，盒子会塌成两条 1px 边框（实测 784×2），行内比例盖过 auto 先占住地方。 */
  const solo = n === 1;
  const cells = shown.map((im, index) => {
    return `        <a class="gal-item" href="${esc(im.src)}" data-lightbox="${esc(slug)}"
           data-full="${esc(im.full ?? im.src)}"${im.alt ? ` data-alt="${esc(im.alt)}"` : ''}>
          <img src="${esc(im.thumb ?? mediaFallback(im.src))}" alt="${esc(im.alt)}"${im.previewSrcset ? ` srcset="${esc(im.previewSrcset)}" sizes="${sizes}"` : ''}${im.width && im.height ? ` width="${esc(im.width)}" height="${esc(im.height)}"` : ''}${solo && im.width && im.height ? ` style="aspect-ratio: ${esc(im.width)} / ${esc(im.height)}"` : ''} loading="${eager && index === 0 ? 'eager' : 'lazy'}" decoding="async">
        </a>`;
  }).join('\n');
  /* 第 5 张起不占位，只把灯箱要的数据挂在空 span 上；用 <span hidden> 而非 .gal-item，因为它不该可交互（decorateLightbox() 只认 img[data-lightbox]）。 */
  const offstage = rest.map((im) => `        <span hidden data-lightbox="${esc(slug)}" data-full="${esc(im.full ?? im.src)}"${im.alt ? ` data-alt="${esc(im.alt)}"` : ''}${im.width && im.height ? ` data-w="${esc(im.width)}" data-h="${esc(im.height)}"` : ''}></span>`).join('\n');
  return `      <div class="gallery" data-count="${n}">
${cells}${offstage ? `\n${offstage}` : ''}
      </div>`;
};

/* 评论抽屉。收起靠 inert + grid-template-rows:0fr 双重藏起来（前者不进 Tab/读不到，后者不占地方）。inert 服务端写上——没脚本时抽屉一直收着，那枚「评论」按钮就是去笔记页的兜底链接。每行各挂一份（抽屉 id c-<slug>、面板内 id 带 -<slug> 后缀），openDrawer 保证同时只开一个。
   面板不在这里渲染：列表页 10 篇笔记的抽屉曾占整页 65% 的 HTML。首次展开时 app.js 取 data-comments-url
   （服务端仍走 notePanelFor，带 suffix 保证多篇同时开过也不撞 id）；失败时退回 data-comments-page 的普通链接。 */
const drawer = (n) => {
  const page = `${noteHref(n.slug)}#comments`;
  const partial = `${noteHref(n.slug)}?partial=comments&panel=note&suffix=-${encodeURIComponent(n.slug)}`;
  return `      <div class="ncp-slot" id="c-${esc(n.slug)}" data-comments-slot data-comments-url="${esc(partial)}" data-comments-page="${esc(page)}" inert>
        <div class="ncp-mask"></div>
      </div>`;
};

/* —— 折叠行 —— 外壳是原生 <details>：收起是「日期+标题+正文头两行」，展开即全文 + 图集 + 就地评论抽屉。
   不带 name —— 多篇可以同时展开。互斥的代价是「开这一篇」必然「收那一篇」，两块高度反向同时变，
   被点的那一行会被顶走上百像素，只能靠逐帧补滚动去骗眼睛；放开之后每行只对自己的高度负责，
   补位、is-opening 预告帧、跨行竞态全都不需要了（收起侧还得留一个兜底定时器：transitionend 可能被跳过）。
   标题是 <h2>、不包链接（收起态点整行即展开）；评论链接移出 summary。 */

/* 收起露出的两行取多长。不是摘要，是正文开头的截断。150 字有讲究：栏宽 784px/16px 两行约装 90 字，超 150 必然溢出两行，省略号由 CSS -webkit-line-clamp 画；取满正文更差（DOM 塞两遍）。 */
const PEEK_CHARS = 150;

/* 一行折叠行。外层 <div class="nf">（竖线/分格线/节点）；里面 <details>（summary = 日期 + 纯文字标题 + 正文开头）；底部 <p class="nf-meta"> 放在 details 之外。这么拆是因为 Chrome 报「Interactive element inside of a <summary>」——summary 里的链接对键盘/辅助技术支持不一致，故标题不包 <a>（点它＝点整行）。 */
const foldRow = (n) => {
  const peek = n.text ? cleanExcerpt(n.text, PEEK_CHARS) : '';
  const day = String(n.dayExact ?? '');
  const dateHtml = day ? dateBadge(day) : '';
  const comments = commentLabel(n.commentCount);
  return `    <div class="nf" id="n-${esc(n.slug)}">
      <details class="nf-fold">
        <summary class="nf-sum">
          ${dateHtml}
          <h2 class="nf-title">${esc(n.title)}</h2>
${peek ? `          <span class="nf-peekwrap"><span class="nf-peek" aria-hidden="true">${esc(peek)}</span></span>\n` : ''}        </summary>
        <div class="nf-rollout">
        <div class="nf-panel">
          <div class="prose note-body">
${n.text}
          </div>
${gallery(n.images, n.slug)}
          <footer class="note-foot">
            <time class="nf-foot-rel" datetime="${esc(day)}">${esc(n.day ?? '')}</time><a class="note-cbtn" href="${noteHref(n.slug)}#comments"
               data-comments="${esc(n.slug)}" aria-expanded="false" aria-controls="c-${esc(n.slug)}">评论${n.commentCount ? ` <b class="n">${n.commentCount}</b>` : ''}</a>
          </footer>
${drawer(n)}
        </div>
        </div>
      </details>
      <p class="nf-meta"><span class="nf-meta-in"><time class="nf-rel" datetime="${esc(day)}">${esc(n.day ?? '')}</time><a class="nf-comments" href="${noteHref(n.slug)}#comments" data-nf-comments="${esc(n.slug)}">${esc(comments)}</a></span></p>
    </div>`;
};

/** 笔记列：每篇同一种折叠行；收起是日期+标题+正文头两行，点击展开全文+图集+就地评论抽屉。翻页与 ?n= 只换一批内容，外观不受起点影响。默认全部收起，不预展开首篇（脚本开合动画见 app.js 的 setupPage）。 */
export function notesStream(notes) {
  if (!notes.length) return '';
  return `    <div class="notes" data-kind="note">
${notes.map((n) => foldRow(n)).join('\n')}
    </div>`;
}

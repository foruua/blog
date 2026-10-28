import MarkdownIt from 'markdown-it';
import hljs from 'highlight.js/lib/common';
// common 预置 36 门语言；下面补的是自建/运维文章常贴、common 未打包的几门（注册一门约 1–3KB）。引全量包（193 门）要多花约 30ms 启动、约 10MB 内存。
import dockerfile from 'highlight.js/lib/languages/dockerfile';
import nginx from 'highlight.js/lib/languages/nginx';
import powershell from 'highlight.js/lib/languages/powershell';
import cmake from 'highlight.js/lib/languages/cmake';
import http from 'highlight.js/lib/languages/http';
import protobuf from 'highlight.js/lib/languages/protobuf';
import gradle from 'highlight.js/lib/languages/gradle';
import dart from 'highlight.js/lib/languages/dart';
import scala from 'highlight.js/lib/languages/scala';
import elixir from 'highlight.js/lib/languages/elixir';
import haskell from 'highlight.js/lib/languages/haskell';
import nix from 'highlight.js/lib/languages/nix';
import { mediaFallback } from '../media/variants.js';
import { anchorId, esc } from '../util/text.js';

for (const [name, def] of Object.entries({
  dockerfile, nginx, powershell, cmake, http, protobuf, gradle, dart, scala, elixir, haskell, nix,
})) hljs.registerLanguage(name, def);

const WIKI_RE_BRACKETS = 0x5B;

// 写了语言名且 highlight.js 认识才高亮，否则返回 ''。不写语言不猜：highlightAuto 会误判像代码的散文，且结果不再只由原文决定（body_html 入库，同正文在不同机器会不一致）。ignoreIllegals 兜住非法 token，抛出也只退回纯文本、不带出 500。
function highlightFence(code, lang) {
  if (!lang || !hljs.getLanguage(lang)) return '';
  try {
    return hljs.highlight(code, { language: lang, ignoreIllegals: true }).value;
  } catch {
    return '';
  }
}

/** @param imageInfo 正文图片的真实宽高与响应式候选：没尺寸要等图下完才知比例（顶动内容，CLS）；没变体则 736px 的栏会去下 2400px 原图。 */
export function createRenderer({ imageInfo } = {}) {
  const md = new MarkdownIt({
    html: false,
    linkify: true,
    breaks: false,

    typographer: true,
    highlight: highlightFence,
  });

  // 高亮结果里的 <span class="hljs-*"> 需要外层挂 hljs 类；markdown-it 只在 info 存在时才拼，故补 attrs 即可、不自己拼 <pre>（否则转义与 langPrefix 要各维护一份）。
  const baseFence = md.renderer.rules.fence;   // markdown-it 一定定义了 fence/image 规则，无需 ?? 兜底
  md.renderer.rules.fence = (tokens, idx, opts, env, self) => {
    const lang = (tokens[idx].info ?? '').trim().split(/\s+/)[0];
    if (lang && hljs.getLanguage(lang)) tokens[idx].attrJoin('class', 'hljs');
    // 复制按钮由 app.js 在浏览器里插：没 JS 就没有按钮，围栏输出与加高亮之前逐字相同（服务端别掺东西）。
    return baseFence(tokens, idx, opts, env, self);
  };

  const CJK = '\u3000-\u303f\u3400-\u4dbf\u4e00-\u9fff\uff00-\uffef';
  const CJK_QUOTE_RE = new RegExp(`(?<=[${CJK}])"([^"\n]{1,80}?)"(?=[${CJK}])`, 'g');
  md.core.ruler.push('cjk_smartquotes', (state) => {
    for (const token of state.tokens) {
      if (token.type !== 'inline') continue;
      for (const child of token.children ?? []) {
        if (child.type === 'text' && child.content.includes('"')) {
          child.content = child.content.replace(CJK_QUOTE_RE, '“$1”');
        }
      }
    }
  });

  md.inline.ruler.before('link', 'wikilink', (state, silent) => {
    const start = state.pos;
    if (state.src.charCodeAt(start) !== WIKI_RE_BRACKETS) return false;
    if (state.src.charCodeAt(start + 1) !== WIKI_RE_BRACKETS) return false;
    const end = state.src.indexOf(']]', start + 2);
    if (end < 0) return false;
    const label = state.src.slice(start + 2, end).trim();
    if (!label || label.includes('[') || label.includes(']') || label.length > 80) return false;

    if (!silent) {
      const token = state.push('wikilink', '', 0);
      token.content = label;
    }
    state.pos = end + 2;
    return true;
  });


  md.core.ruler.push('image_priority', (state) => {
    let chars = 0, seen = false;
    for (const token of state.tokens) {
      for (const child of token.children ?? []) {
        if (child.type === 'image') {
          if (!seen && chars < 400) child.meta = { ...child.meta, priority: true };
          seen = true;
        } else chars += child.content.length;
      }
    }
  });

  const baseImage = md.renderer.rules.image;
  md.renderer.rules.image = (tokens, idx, opts, env, self) => {
    const token = tokens[idx];
    if (token.meta?.priority) token.attrSet('fetchpriority', 'high');
    if (!token.attrGet('decoding')) token.attrSet('decoding', 'async');
    if (imageInfo) {
      const original = token.attrGet('src');
      const info = imageInfo(original);
      // data-full：灯箱展示图（最大档 WebP 变体优先，动画图/无变体回原图）。
      token.attrSet('data-full', info?.full ?? info?.original ?? original);
      token.attrSet('src', info?.preview ?? info?.thumbnail ?? mediaFallback(original));

      if (info?.width > 0 && info?.height > 0) {
        if (!token.attrGet('width')) token.attrSet('width', String(info.width));
        if (!token.attrGet('height')) token.attrSet('height', String(info.height));
      }
      if (info?.srcset && !token.attrGet('srcset')) {
        token.attrSet('srcset', info.srcset);
        token.attrSet('sizes', info.sizes ?? '100vw');
      }
    }
    // 宽高之外再补行内 aspect-ratio：只靠 width/height 属性算出的比例带 auto 前缀，懒加载审计判成「没设比例」（CLS）；行内写死才是各浏览器/工具都认的写法。
    const w = token.attrGet('width'), h = token.attrGet('height');
    if (w && h && !token.attrGet('style')) token.attrSet('style', `aspect-ratio:${w}/${h}`);
    // 没有尺寸的图不 lazy：lazy + 无比例一定会在加载时撑开布局，也会被审计判错。
    if (!token.attrGet('loading')) token.attrSet('loading', token.meta?.priority || !(w && h) ? 'eager' : 'lazy');
    return baseImage(tokens, idx, opts, env, self);
  };

  // 表格外套滚动容器：含长串/多列的单元格会把最小内容宽度顶到栏宽外，之前 overflow:hidden 直接裁掉、右侧划不到。不在 CSS 里给 table 设 display:block——那会让窄表格缩到内容宽。
  const baseTableOpen = md.renderer.rules.table_open
    ?? ((tokens, idx, opts, _env, self) => self.renderToken(tokens, idx, opts));
  md.renderer.rules.table_open = (tokens, idx, opts, env, self) =>
    `<div class="table-wrap">${baseTableOpen(tokens, idx, opts, env, self)}`;
  const baseTableClose = md.renderer.rules.table_close
    ?? ((tokens, idx, opts, _env, self) => self.renderToken(tokens, idx, opts));
  md.renderer.rules.table_close = (tokens, idx, opts, env, self) =>
    `${baseTableClose(tokens, idx, opts, env, self)}</div>`;

  md.renderer.rules.wikilink = (tokens, idx) => {
    const label = tokens[idx].content;
    return `<a class="wikilink" href="/go/${encodeURIComponent(label)}">${esc(label)}</a>`;
  };

  // 目录文字取渲染后的纯文本，锚点 id 仍由原文算——刻意分开：id 用 anchorId() 对标题整串哈希，跟着改会让分享出去的 /p/xxx/#h-1a2b3c 全失效。只有 text/code_inline/image 三类 token 带真文字。
  const HEADING_TEXT = new Set(['text', 'code_inline', 'image']);
  const headingLabel = (inline) => (inline?.children ?? [])
    .filter((t) => HEADING_TEXT.has(t.type))
    .map((t) => t.content)
    .join('')
    .replace(/\s+/g, ' ')
    .trim();

  md.core.ruler.push('anchors_and_toc', (state) => {
    const toc = [];
    const seen = new Map();
    for (let i = 0; i < state.tokens.length; i++) {
      const open = state.tokens[i];
      if (open.type !== 'heading_open') continue;
      const inline = state.tokens[i + 1];
      const text = (inline?.content ?? '').trim();
      if (!text) continue;

      let id = anchorId(text);
      const dup = seen.get(id) ?? 0;
      seen.set(id, dup + 1);
      if (dup > 0) id = `${id}-${dup}`;

      open.attrSet('id', id);
      const level = Number(open.tag.slice(1));
      if (level === 2 || level === 3) toc.push({ level, text: headingLabel(inline) || text, id });
    }
    state.env.toc = toc;
  });

  return {

    render(src) {
      const env = {};
      const html = md.render(String(src ?? ''), env);
      return { html, toc: env.toc ?? [] };
    },
  };
}

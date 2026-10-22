import MarkdownIt from 'markdown-it';
import { esc } from '../util/text.js';
import { AVATAR_MD5_RE } from '../avatar/md5.js';

const ALLOWED = new Set(['p', 'br', 'a', 'code', 'pre', 'em', 'strong', 'blockquote', 'ul', 'ol', 'li']);

const md = new MarkdownIt({
  html: false,
  linkify: false,
  breaks: true,
  typographer: false,
});

const TAG_RE = /<(\/?)([a-zA-Z][a-zA-Z0-9]*)([^>]*)>/g;

function sanitizeComment(html) {
  return String(html).replace(TAG_RE, (_m, slash, tag, attrs) => {
    const t = tag.toLowerCase();
    if (!ALLOWED.has(t)) return '';
    if (t === 'a' && !slash) {
      const href = /href="([^"]*)"/.exec(attrs)?.[1] ?? '';
      if (!/^https?:\/\//i.test(href)) return '<a>';
      return `<a href="${href}" rel="nofollow noopener ugc" target="_blank">`;
    }
    return `<${slash}${t}>`;
  });
}

// 渲染结果缓存：markdown-it + sanitize 对同一段正文是纯函数，结论恒定。文章页一次要渲染整串评论，
// /notes 一页十来个抽屉（每篇一份评论面板），但评论正文的重复度极高——同一条评论在换页、翻页、
// 抽屉开合之间被反复渲染。key 直接用正文本身：正文改了 key 就变，不需要按 id 失效。
// Map 的插入序当 LRU：命中时 delete+set 挪到队尾，超限删队首。上限按条数与单条长度双限，
// 免得一条几千字的巨评把整块内存占满。
const CACHE_MAX = 2000;
const CACHE_MAX_LEN = 4000;
const commentCache = new Map();

export function renderComment(src) {
  const text = String(src ?? '').trim();
  if (text.length > CACHE_MAX_LEN) return sanitizeComment(md.render(text));
  const hit = commentCache.get(text);
  if (hit !== undefined) {
    commentCache.delete(text);
    commentCache.set(text, hit);
    return hit;
  }
  const html = sanitizeComment(md.render(text));
  commentCache.set(text, html);
  if (commentCache.size > CACHE_MAX) commentCache.delete(commentCache.keys().next().value);
  return html;
}

// 头像：字母头像打底，有邮箱 md5 时盖一层本站反代的 Gravatar（/avatar/<md5>）。之所以"盖一层"而非
// 二选一：上游能否取到只有请求后才知道，服务端不该等也不能保证其存活；故字母永远先画，真头像加载
// 成功后盖住，没头像时返回 1×1 透明图让字母透出——无脚本/上游挂/图 404 都落到字母，不会碎图标。
export function avatar(name, size = 40, md5 = null) {
  const s = String(name ?? '').trim();
  const ch = [...(s || '?')][0].toUpperCase();
  let h = 0;
  for (const c of s) h = (h * 31 + c.codePointAt(0)) % 360;
  const letter = `<svg class="avatar" width="${size}" height="${size}" viewBox="0 0 40 40"`
    + ` aria-hidden="true" focusable="false" style="--av-h:${h}">`
    + '<circle cx="20" cy="20" r="19" fill="var(--av-bg)"/>'
    + '<text x="20" y="20.6" text-anchor="middle" dominant-baseline="central" '
    + 'font-size="16" font-weight="600" letter-spacing="0" fill="var(--av-fg)">' + esc(ch) + '</text></svg>';
  // md5 可能来自备份/外部导入的库，形状不对就当没有（别让它拼进 URL）
  if (!md5 || !AVATAR_MD5_RE.test(String(md5))) return letter;

  return `<span class="avatar-wrap">${letter}`
    + `<img class="avatar avatar-img" src="/avatar/${md5}" width="${size}" height="${size}" style="aspect-ratio:1"`
    + ' alt="" loading="lazy" decoding="async"></span>';
}

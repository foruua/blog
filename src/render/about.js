import { masthead } from './layout.js';
import { esc } from '../util/text.js';

/** 固定页前台版式：头部用全站 masthead()，正文随 .wrap，不带日期/目录/上下篇；评论区由调用方决定。 */
export function pageMain({ title, html, mark = 'Page', stats = [], empty = '', comments = '', lang = '' }) {
  const body = html
    ? `      <div class="prose">
${html}
      </div>`
    : `      <p class="page-empty">${empty || '这一页还没写。'}</p>`;

  // 正文语言交给 frontmatter 的 lang；没写就不加属性，继承 <html lang>。
  return `    <div class="page"${lang ? ` lang="${esc(lang)}"` : ''}>
${masthead({ mark, title, stats })}
${body}
${comments}
    </div>`;
}

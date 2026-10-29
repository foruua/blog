import { esc } from '../util/text.js';
import { safeHttpUrl } from '../util/url.js';

// 评论区表单/署名片段。字段与 autocomplete 只写一份，加字段、改一次行为都只动这里。

/** 嵌套缩进层数：第 2 层缩进，第 3 层起改用「@某人」标对象（评论区同口径）。 */
export const INDENT_DEPTH = 2;

/** 评论者名字：作者挂徽章；填了网址时名字是外链。className 由调用方传入。 */
export function authorName(c, { className = 'c-name', authorClass = '' } = {}) {
  const cls = authorClass ? `${className} ${authorClass}` : className;
  if (c.is_author) return `<b class="${cls}">${esc(c.author)}</b><span class="badge-author">作者</span>`;
  // 历史数据/备份导入可能带非 http(s) 网址；esc 只转义字符，挡不住 javascript: 协议。
  const website = safeHttpUrl(c.website);
  return website
    ? `<a class="${cls}" href="${esc(website)}" rel="nofollow noopener ugc" target="_blank">${esc(c.author)}</a>`
    : `<b class="${cls}">${esc(c.author)}</b>`;
}

/** 反垃圾蜜罐：绝对定位移出屏幕，正常访客看不见也填不到，自动脚本会填。 */
export const honeypot = (indent = '') => `${indent}<div class="c-hp" aria-hidden="true">
${indent}  <label>传真号码 <input type="text" name="hp_fax" tabindex="-1" autocomplete="off"></label>
${indent}</div>`;

/** 访客身份三栏（邮箱/昵称/网址）：默认走内页 c-grid/c-field。 */
export function identityFields({ blockClass = 'c-grid', fieldClass = 'c-field', indent = '' } = {}) {
  const field = (name, label, type, extra) => `${indent}  <p class="${fieldClass}">
${indent}    <label for="c-${name}">${label}</label>
${indent}    <input id="c-${name}" name="${name}" type="${type}" ${extra}>
${indent}  </p>`;
  return `${indent}<div class="${blockClass}">
${field('email', '邮箱', 'email', 'required maxlength="120" autocomplete="email"')}
${field('author', '昵称', 'text', 'required maxlength="40" autocomplete="name"')}
${field('website', '网址', 'url', 'maxlength="200" autocomplete="url"')}
${indent}</div>`;
}

import { decodeEntities } from './entities.js';

// HTML → 纯文本的唯一实现。友圈解析、全文检索、列表摘要与 cleanExcerpt 的差异只在四个开关上：
//   dropPre        整块丢掉 pre（摘要/检索不需要半截代码）
//   blockBoundaries 把块级闭合标签换成空格（否则 </p><p> 删掉会让前后词黏成一个不存在的词）
//   tagReplacement 行内标签替换成空格还是直接删（检索匹配用删，展示摘要用空格）
//   decodePasses   解码几轮实体（远端 feed 常见二次编码）
// 以前四处各写一遍，边界字符/实体解码的口径已经出现过细微分叉。
const DROPPED_WITH_PRE = /<(script|style|template|pre)\b[^>]*>[\s\S]*?<\/\1\s*>/gi;
const DROPPED_WITHOUT_PRE = /<(script|style|template)\b[^>]*>[\s\S]*?<\/\1\s*>/gi;
const BLOCK_END = /<\/(?:p|div|li|h[1-6]|tr|blockquote|section|article|dd|dt|pre|figcaption)>|<br\s*\/?>/gi;
const COMPLETE_TAG = /<\/?[A-Za-z][^>]*>/g;
// 未闭合的标签（远端 HTML 截断）也要吃掉，否则半截 `<a href="...` 会进摘要。
const UNCLOSED_TAG = /<\/?[A-Za-z][^>]*/g;

/**
 * @typedef {object} StripOptions
 * @property {boolean} [dropPre] 整块丢掉 pre
 * @property {boolean} [blockBoundaries] 块级闭合标签换成空格
 * @property {string} [tagReplacement] 行内标签替换成什么
 */

/**
 * @param {string} input
 * @param {StripOptions} [options]
 */
export function stripHtmlTags(input, {
  dropPre = false, blockBoundaries = false, tagReplacement = ' ',
} = {}) {
  let text = String(input ?? '');
  text = text.replace(dropPre ? DROPPED_WITH_PRE : DROPPED_WITHOUT_PRE, ' ');
  text = text.replace(/<!--[\s\S]*?-->/g, ' ');
  if (blockBoundaries) text = text.replace(BLOCK_END, ' ');
  text = text.replace(COMPLETE_TAG, tagReplacement);
  return text.replace(UNCLOSED_TAG, tagReplacement);
}

/**
 * @param {string} input
 * @param {StripOptions & { decodePasses?: number }} [options]
 */
export function htmlToPlainText(input, { decodePasses = 1, ...options } = {}) {
  let text = stripHtmlTags(input, options);
  for (let i = 0; i < Math.max(0, decodePasses); i++) text = decodeEntities(text);
  return text;
}

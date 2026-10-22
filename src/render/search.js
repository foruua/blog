import { esc, formatDay, snippetAround, highlightTerms } from '../util/text.js';
import { masthead, emptyPage, listBlock } from './layout.js';

/** 检索页（/search）：一个输入框 + 一个结果列表（每条带命中摘要），纯服务端渲染、零 JS。入口是页头/抽屉里的普通链接。
 *  结果列表**就是文章列表那一套**（listBlock/listItem）：编年轨、类型方章、摘要、元信息行（相对日期 + N 条评论）全同构，
 *  唯一不同的是摘要换成「以命中词为中心」的那段并高亮命中处。以前这里另写了一份 .s-hit/.s-tag 标记，
 *  与 .kind 那枚方章各自漂移（同色同底、边框/圆角/内距/字距全不一样）—— 合成一份，别再分叉。 */

// 命中摘要：以命中的词为中心截一段，命中处包 <mark>。highlightTerms 返回的是已转义 HTML，不能再 esc。
// 缩进与 leading() 的输出对齐（listItem 直接把它嵌在 <a class="e-main"> 里）。
const excerptHtml = (hit, terms) => {
  const snippet = snippetAround(hit.text, terms);
  return snippet ? `    <p class="excerpt">${highlightTerms(snippet, terms)}</p>` : '';
};

// 命中项 → 列表条目：字段名按 listItem 的口径补（day/published_at/comments），
// 评论数由调用方批量查好传进来（results 的 id 只有命中的那些）。
// 标题也要高亮：引擎的命中文本只有正文，只在标题里出现的词（例如搜「吐了」命中「…把我改吐了」）
// 若不高亮标题，整条结果看起来就和搜索词毫无关系。titleHtml 已转义，listItem 不再 esc。
const entryOf = (hit, terms, counts) => ({
  kind: hit.type,
  slug: hit.slug,
  title: hit.title,
  titleHtml: highlightTerms(hit.title, terms),
  day: formatDay(hit.ts),
  published_at: hit.ts,
  comments: counts.get(hit.id) ?? 0,
  excerpt: excerptHtml(hit, terms),
});

const searchForm = (q) => `    <form class="s-form" action="/search" method="get" role="search">
      <div class="s-field">
        <label class="s-lbl" for="sQ">检索词</label>
        <input class="s-input" id="sQ" type="search" name="q" value="${esc(q)}" autocomplete="off" spellcheck="false">
        <button class="s-go" type="submit">检索</button>
      </div>
    </form>`;

/** /search 的 <main>。无检索词时给空状态，不摆「零结果」列表（那会让人以为搜坏了）。栏头不报「命中 N 项」：数一数就在下面。 */
export function searchMain({ q = '', result, counts = new Map() }) {
  const head = `${masthead({ mark: 'Search', title: '检索' })}
${searchForm(q)}`;

  if (result.parsed.empty) {
    return `${head}
${emptyPage('输入一个词开始', '', 'p')}`;
  }
  if (!result.hits.length) {
    return `${head}
${emptyPage('没有匹配的内容', '换一个说法再试一次。', 'p')}`;
  }

  const more = result.truncated
    ? `\n\n    <p class="s-more">只显示最近 ${result.hits.length} 项，把词写具体些能收窄结果。</p>`
    : '';

  const entries = result.hits.map((h) => entryOf(h, result.parsed.terms, counts));

  return `${head}

${listBlock(entries, { excerptOf: (e) => e.excerpt })}${more}`;
}

// 内容页（文章 / 笔记）的标记与结构化数据。纯函数：帖子、字数、目录、上下篇、评论区 HTML 都由调用方备好，
// 这里只负责拼字符串 —— 路由层因此只剩取数与装配，标记本身能被单独测试。
import { SITE } from '../config.js';
import { esc, formatDay, postUrl, relativeDate, cleanExcerpt } from '../util/text.js';

/** 目录：有 toc 才出，序号由 CSS 计数器补零（不写进 HTML）。 */
export function tocHtml(toc) {
  if (!toc?.length) return '';
  return `      <details class="toc"><summary>目录（${toc.length} 节）</summary>
        <ol>${toc.map((t) => `<li class="lvl-${t.level}"><a href="#${esc(t.id)}">${esc(t.text)}</a></li>`).join('')}</ol>
      </details>`;
}

/** 上一篇 / 下一篇。neighbours 只返回同一文体内的相邻内容。 */
export function pagerHtml({ newer, older }) {
  const neighbour = (p, label) => (p
    ? `<div${label === '下一篇' ? ' class="n"' : ''}><small>${label}</small><a href="${postUrl(p)}">${esc(p.title)}</a></div>`
    : '');
  return (newer || older)
    ? `      <nav class="pager" aria-label="翻页">
${[neighbour(older, '上一篇'), neighbour(newer, '下一篇')].filter(Boolean).join('\n')}
      </nav>`
    : '';
}

/** 正文页主体：刊头 + 目录 + 正文 + 翻页 + 评论区。 */
export function articleMain({ post, words, mins, dayCn, toc, pager, commentBlock, bodyHtml }) {
  const note = post.kind === 'note';
  const day = formatDay(post.published_at);
  return `    <article class="post" data-kind="${note ? 'note' : 'post'}"${post.lang ? ` lang="${esc(post.lang)}"` : ''}>
      <header class="post-mast">
        <p class="pm-mark"><span class="pm-kind">${note ? '笔记' : '文章'}</span><span class="pm-sep" aria-hidden="true">·</span><time datetime="${esc(post.published_at)}">${esc(dayCn)}</time></p>
        <h1>${esc(post.title)}</h1>
        <p class="meta" title="${esc(day)}" data-day="${esc(day)}">${esc(relativeDate(post.published_at))} · ${words} 字${mins ? ` · 约 ${mins} 分钟` : ''}</p>
      </header>
${toc}
      <div class="prose">
${bodyHtml}
      </div>

${pager}
${commentBlock}
    </article>`;
}

/** BlogPosting + BreadcrumbList。只认 ISO 8601 的时间字段，解析失败就不写该键。 */
export function articleJsonLd({ post, pathname, og, commentCount, publishedIso, modifiedIso }) {
  const note = post.kind === 'note';
  const articleLd = {
    '@context': 'https://schema.org',
    '@type': 'BlogPosting',
    headline: post.title,
    description: cleanExcerpt(post.body_html, 160),
    url: `${SITE.url}${pathname}`,
    mainEntityOfPage: { '@type': 'WebPage', '@id': `${SITE.url}${pathname}` },
    inLanguage: post.lang || SITE.lang,
    author: { '@type': 'Person', name: SITE.author || SITE.identity },
    publisher: { '@type': 'Organization', name: SITE.identity, url: `${SITE.url}/`,
      logo: { '@type': 'ImageObject', url: `${SITE.url}/icon-512.png` } },
    articleSection: note ? '笔记' : '文章',
    commentCount,
    image: [og.url],
    ...(post.word_count ? { wordCount: post.word_count } : {}),
    ...(publishedIso ? { datePublished: publishedIso } : {}),
    ...(modifiedIso ? { dateModified: modifiedIso } : {}),
  };
  const breadcrumbLd = {
    '@context': 'https://schema.org',
    '@type': 'BreadcrumbList',
    itemListElement: [
      { '@type': 'ListItem', position: 1, name: '首页', item: `${SITE.url}/` },
      { '@type': 'ListItem', position: 2, name: note ? '笔记' : '文章', item: `${SITE.url}${note ? '/notes/' : '/posts/'}` },
      { '@type': 'ListItem', position: 3, name: post.title, item: `${SITE.url}${pathname}` },
    ],
  };
  return [articleLd, breadcrumbLd];
}

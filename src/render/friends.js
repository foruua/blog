import { esc, relativeDate, formatDay } from '../util/text.js';
import { moreLink } from './layout.js';

/** 前台「友圈」页主体：按朋友分组（一位朋友 = 一个订阅源一节，站名当标题）；显示条数固定为 FRIENDS_PER_SOURCE（3 条）。分组顺序就是列表顺序（首次出现的源在最前）＝ 最近更新的朋友在最上面。只有纯文本：对方 feed 的 HTML 已在解析层剥掉，标题/站名全部 esc——把别人的 HTML 注入自己页面等于让任意友站获得在本站执行脚本/钓鱼的能力；摘要也不渲染（summary 仍入库）。 */

const whenNode = (item) => (item.published_at
  ? `<time datetime="${esc(item.published_at)}" class="fcg-when" title="${esc(formatDay(item.published_at))}">${esc(relativeDate(item.published_at))}</time>`
  : '<span class="fcg-when" title="源的条目里没有可用的发布时间">时间未知</span>');

const itemRow = (item) => `          <li class="fcg-row"><a href="${esc(item.link)}" target="_blank" rel="noopener nofollow" title="${esc(item.title)}"><span class="fcg-t">${esc(item.title)}</span>${whenNode(item)}</a></li>`;


function siteSection(items) {
  const head = items[0];
  const name = head.feed_title || head.feed_site || '未知来源';

  const title = head.feed_site
    ? `<a href="${esc(head.feed_site)}" target="_blank" rel="noopener nofollow" title="去 ${esc(name)}">${esc(name)}</a>`
    : esc(name);

  const count = head.feed_total > items.length
    ? `最近 ${items.length} / ${head.feed_total} 篇`
    : `${head.feed_total} 篇`;

  return `      <article class="fcg-sec">
        <header class="fcg-head"><h2 class="fcg-name">${title}</h2><span class="fcg-n">${count}</span></header>
        <ul class="fcg-list">
${items.map(itemRow).join('\n')}
        </ul>
      </article>`;
}

export function friendsStream({ items = [], sources = 0, nextHref = null }) {
  if (!items.length) {
    return `    <section class="fc-stream">
      <p class="fc-empty">${sources
    ? '已经登记了订阅，但还没有抓到文章。可能是刚添加、对方订阅地址暂时打不开，或者站主还没点过「刷新全部」。'
    : '这里还没有内容 —— 站主可以先去后台「友圈」里添加几位朋友的博客地址。'}</p>
    </section>`;
  }


  const groups = new Map();
  for (const item of items) {
    const list = groups.get(item.feed_id);
    if (list) list.push(item);
    else groups.set(item.feed_id, [item]);
  }

  return `    <section class="fc-stream">
      <div class="fcg">
${[...groups.values()].map(siteSection).join('\n')}
      </div>
${nextHref ? `      ${moreLink(nextHref, '更早的更新')}\n` : ''}    </section>`;
}

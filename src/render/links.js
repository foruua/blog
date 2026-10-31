import { esc, formatDay, formatDateTime, dayParts } from '../util/text.js';
import { safeHttpUrl } from '../util/url.js';
import { avatar } from '../comments/render.js';
import { moreLink } from './layout.js';
import { COMMENT_ICO } from './icons.js';

/** 前台「友链」页：名片墙（一位一张卡）。名单是 comments 的派生态：评论填过网址、通过审核的人自然出现；对方站连续几轮探不通就自动隐藏、站回来又复原。身份用昵称 + 域名，不用对方的 <title>（可能是 JS 挑战页的「请稍候」，只能当悬停提示、不能认人）；域名是归并键。每项都是外链，一律 rel="nofollow noopener ugc" + target="_blank"：那是对方自己填的地址，非本站背书。 */

// 「最近 10 月 11 日」：底栏那格只放得下六个字；同年不写年，跨年才写。
const shortDay = (iso, thisYear) => {
  const day = formatDay(iso);
  if (!day) return '';
  const [y, m, d] = dayParts(day);
  return y === thisYear ? `${Number(m)} 月 ${Number(d)} 日` : `${y} 年 ${Number(m)} 月`;
};


const tipOf = (v) => {
  const head = v.site_title ? `去「${v.site_title}」 · ${v.host}` : `去 ${v.host}`;
  return head;
};




const emptyOf = () => `    <section class="lk-empty">
      <p>这一页还空着 —— 在评论区留下你的网站，审核通过后它就会出现在这里。</p>
    </section>`;

const moreOf = (nextHref) => (nextHref ? `\n    ${moreLink(nextHref, '查看更多')}` : '');


const cardOf = (v, thisYear) => {
  const href = safeHttpUrl(v.url);
  if (!href) return '';
  const name = v.author || v.host;
  const exact = v.last_at ? `${formatDateTime(v.last_at)} 的留言` : '';
  return `      <li><a class="lk-card" href="${esc(href)}" target="_blank" rel="noopener nofollow ugc" title="${esc(tipOf(v))}">
        <span class="lk-top"><span class="lk-face">${avatar(name, 40, v.avatar_md5)}</span><span class="lk-name">${esc(name)}</span></span>
        <span class="lk-host">${esc(v.host)}</span>
        <span class="lk-foot"><span class="lk-since"${exact ? ` title="${esc(exact)}"` : ''}><span class="lk-since-lbl">最近 </span>${esc(shortDay(v.last_at, thisYear))}</span><span class="lk-n">${COMMENT_ICO}<b>${v.n}</b><span class="sr-only"> 条</span></span></span>
      </a></li>`;
};

/** 友链页名单（名片墙）：空名单渲染空态而非空 <ul>——没有卡的墙是一条贴了边框的空白条。 */
export function linksBlock({ links = [], nextHref = null }) {
  const thisYear = formatDay(new Date().toISOString()).slice(0, 4);
  const cards = links.map((v) => cardOf(v, thisYear)).filter(Boolean);
  if (!cards.length) return emptyOf();
  return `    <ul class="lk-wall">
${cards.join('\n')}
    </ul>${moreOf(nextHref)}`;
}

import { esc, formatDay, monthCn } from '../util/text.js';
import { emptyPage, masthead, ledgerItem } from './layout.js';

function head({ total, posts, notes, years, kind }) {
  const oldest = years.at(-1);
  const newest = years[0];
  const span = years.length > 1 ? `${oldest}—${newest}` : newest;
  return masthead({
    mark: 'Archive',
    title: '归档',
    stats: [
      `<span><b>${total}</b> 篇</span>`,
      `<span><b>${posts}</b> 文章</span>`,
      `<span><b>${notes}</b> 笔记</span>`,

      span ? `<span class="mast-span">${esc(span)}</span>` : '',
    ].filter(Boolean),
    titleTools: `<nav class="arch-filter" aria-label="内容类型">${[['all', '全部'], ['post', '文章'], ['note', '笔记']].map(([v, label]) => `<a href="/archive/${v === 'all' ? '' : `?kind=${v}`}"${kind === v ? ' aria-current="page"' : ''}>${label}</a>`).join('')}</nav>`,
  });
}

// 月份组：原生 <details>，默认收起。不写 name——它是文档级互斥，会让所有年份的月份连坐，各月可自由多开。
const monthGroup = (key, items, open) => `        <details class="mgrp"${open ? ' open' : ''}>
          <summary class="mgrp-label"><span class="mgrp-name">${esc(monthCn(key.slice(5)))}</span><span class="mgrp-lead" aria-hidden="true"></span><span class="mgrp-count">${items.length} 篇</span></summary>
          <ul class="entries">
${items.map((p) => ledgerItem(p)).join('\n')}
          </ul>
        </details>`;

// 年份块：原生 <details>。年份不放「只看这一年」链接——<summary> 里塞交互元素对键盘/辅助技术支持不一致（Chrome 会告警）；年页 /a/<year>/ 仍在。
function yearBlock(year, list, open) {
  const groups = [];
  for (const p of list) {
    const key = p.day.slice(0, 7);
    if (groups.at(-1)?.key !== key) groups.push({ key, items: [] });
    groups.at(-1).items.push(p);
  }

  return `    <details class="chron" id="y${year}"${open ? ' open' : ''}>
      <summary class="chron-rail">
        <h2 class="chron-year">${esc(year)}</h2>
        <span class="chron-count">${list.length} 篇</span>
      </summary>
      <div class="chron-flow">
${groups.map((g, i) => monthGroup(g.key, g.items, open && i === 0)).join('\n')}
      </div>
    </details>`;
}

export function archiveMain(repo, rawKind = 'all') {
  const kind = ['post', 'note'].includes(rawKind) ? rawKind : 'all';
  const all = repo.archiveEntries()
    .filter((p) => p.kind === kind || kind === 'all')
    .map((p) => ({ ...p, day: formatDay(p.published_at) }))
    // 手改/导入的畸形日期 formatDay() 返回空串；不把它归进空年份（会渲染成「0 月」）。
    .filter((p) => p.day);

  const byYear = new Map();
  for (const p of all) {
    const y = p.day.slice(0, 4);
    if (!byYear.has(y)) byYear.set(y, []);
    byYear.get(y).push(p);
  }
  const years = [...byYear.keys()].sort().reverse();
  const posts = all.filter((p) => p.kind === 'post').length;

  // 空筛选也要出刊头 + 类型筛选：否则读者卡在这屏，找不到切回「全部」的入口。
  const headHtml = head({ total: all.length, posts, notes: all.length - posts, years, kind });
  if (!all.length) return `${headHtml}\n${emptyPage('归档', '还没有这类内容。<a href="/archive/">查看全部</a>', 'p')}`;


  return [
    headHtml,
    years.map((y, i) => yearBlock(y, byYear.get(y), i === 0)).join('\n'),
  ].filter(Boolean).join('\n');
}

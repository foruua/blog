import { csrfField, esc, initialMark as markOf, relWhen as when, relExact as exact } from '../../util/text.js';
import { safeHttpUrl } from '../../util/url.js';
import { failureLabel } from '../../util/failure.js';
import { FAIL_LIMIT } from '../../links/check.js';
import { adminLayout } from '../layout.js';
import { progressMarkup } from '../progress.js';

/** 后台「友链」页：看名单、纠正它。名单只读——是 comments 的派生态（评论填过网址且通过审核的站）；站主只能催检查、藏/放某个站。版式按处境分三段（在页面上 / 已撤下 / 已隐藏），只在行内留「上次没探通 / 还没查过」两种标记；判定口径见 src/links/check.js。三个计数由行本身数出来，不用 repo 聚合（聚合会把「既隐藏又已下线」同时算进两档，与眼睛看到的分段对不上）。 */


const GROUPS = [
  ['live', '在页面上', false],
  ['dead', '已撤下', true],
  ['hidden', '已隐藏', true],
];


const groupOf = (v) => (v.hidden ? 'hidden' : v.alive === 0 ? 'dead' : 'live');



// HTTP 拒绝/限流/服务异常表示已收到响应，不能拿历史 fail_count 把本轮「不明」展示成「没探通」。
const responseStatus = (v) => Number(v.last_error?.match(/HTTP (\d{3})\b/)?.[1]) || 0;
const uncertainResponse = (v) => {
  const status = responseStatus(v);
  return status > 0 && ![404, 410, 451].includes(status);
};


const tagOf = (v) => {
  if (uncertainResponse(v)) return '<span class="a-fl-tag" data-quiet>自动检查未能确认</span>';
  if (v.fail_count > 0) return '<span class="a-fl-tag">上次没探通</span>';
  if (!v.checked_at) return '<span class="a-fl-tag" data-quiet>还没查过</span>';
  return '';
};

function linkRow(v, csrf) {
  const state = groupOf(v);
  const name = v.author || v.host;
  const url = safeHttpUrl(v.url) ?? safeHttpUrl(`https://${v.host}/`) ?? '#';


  const bits = `最近检查 ${when(v.checked_at, '还没查过')}`;

  const tips = [
    v.site_title ? `对方标题「${v.site_title}」` : '',
    exact(v.checked_at) && `最近检查 ${exact(v.checked_at)}`,
  ].filter(Boolean).join(' · ');

  // 失败原因直接摊在行里（进这页多半就为看它）；只留一句标签 + 一句后果，完整报文在 title 里（见 src/util/failure.js）。
  const suffix = uncertainResponse(v)
    ? ' · 不计入撤下'
    : v.fail_count > 1 ? ` · 已连续 ${v.fail_count} / ${FAIL_LIMIT} 次` : '';
  const error = v.last_error
    ? `        <p class="a-warn a-fl-err" title="${esc(v.last_error)}">${esc(failureLabel(v.last_error))}${suffix}</p>\n`
    : '';


  const top = [
    `<a class="a-fl-name" href="${esc(url)}" target="_blank" rel="noopener nofollow">${esc(name)}</a>`,
    `<code class="a-fl-host">${esc(v.host)}</code>`,
    tagOf(v),
    `<span class="a-fl-meta" title="${esc(tips)}">${esc(bits)}</span>`,
  ].filter(Boolean).join('\n          ');


  return `      <li class="a-fl" data-state="${state}"${v.last_error ? ' data-error' : ''}>
        <span class="a-fl-mark" aria-hidden="true">${esc(markOf(name))}</span>
        <p class="a-fl-top">
          ${top}
        </p>
${error}        <div class="a-fl-ops">
          <form method="post" action="/admin/links/check">
            ${csrfField(csrf)}
            <input type="hidden" name="host" value="${esc(v.host)}">
            <button type="submit" class="a-btn-ghost">立即检查</button>
          </form>
          <form method="post" action="/admin/links/hide">
            ${csrfField(csrf)}
            <input type="hidden" name="host" value="${esc(v.host)}">
            <input type="hidden" name="on" value="${v.hidden ? '0' : '1'}">
            <button type="submit" class="a-btn-ghost">${v.hidden ? '放回页面' : '从前台隐藏'}</button>
          </form>
        </div>
      </li>`;
}

/** 一轮检查的进度条。首屏与轮询片段同一份模板；admin.js 每 1s 整块换掉，跑完再让 pjax 换整页。规则在 progress.js。 */
export function linksProgress(progress) {
  return progressMarkup(progress, {
    cls: 'a-links-progress', dataName: 'links-progress', endpoint: '/admin/links/check-progress',
    meter: 'a-links-meter', label: '检查中', unit: '个站',
  });
}

export function linksAdminPage({ rows = [], csrf, notice = '', progress = null }) {
  const total = rows.length;
  // 一轮跑着时按钮得禁用：后端会把并发的强制轮排队，点第二次只会白等；客户端照片段里的 data-running 同步它。
  const running = Boolean(progress?.running);

  const buckets = { live: [], dead: [], hidden: [] };
  for (const v of rows) buckets[groupOf(v)].push(v);

  // 计数卡三档永远都在，哪怕某档是 0（「0 个已撤下」本身有用：说明没有邻居关站）。零那档只调暗数字、不淡化整张卡，否则对比度审计会亮红灯。
  const tally = GROUPS
    .map(([key, label]) => `        <li${buckets[key].length ? '' : ' data-zero'}><b>${buckets[key].length}</b> <span>${label}</span></li>`)
    .join('\n');

  // 卡片顶行：左三格账目、右「立即检查全部」。名单为空时没有站可查，左边只留一格、右边不放（按不动的按钮只是噪音）。
  const tools = `    <div class="a-links-tools">
      <ul class="a-links-tally">
${total ? tally : '        <li data-zero><b>0</b> <span>还没人留下网址</span></li>'}
      </ul>
${total ? `      <form method="post" action="/admin/links/check-all" data-links-check-all>
        ${csrfField(csrf)}
        <button type="submit" class="a-btn-ghost"${running ? ' disabled' : ''}>立即检查全部</button>
      </form>
` : ''}    </div>
`;

  const groups = GROUPS
    .filter(([key]) => buckets[key].length)
    .map(([key, label, band]) => `      <section class="a-links-group${band ? '' : ' a-links-group-lead'}">
${band ? `        <h2 class="a-links-band">${label}<em>${buckets[key].length}</em></h2>\n` : ''}        <ul class="a-links">
${buckets[key].map((v) => linkRow(v, csrf)).join('\n')}
        </ul>
      </section>`)
    .join('\n');


  const body = `    <div class="a-card a-panel">
${tools}${linksProgress(progress)}
${total ? groups : `      <ul class="a-links">
        <li class="a-empty">有人在评论区留下网址、且那条评论通过审核之后，他的站就会出现在这里。</li>
      </ul>`}
    </div>`;

  return adminLayout({
    title: '友链', active: 'links', csrf, notice,
    sub: total ? `共 ${total} 个站` : '还没有人来过',
    kicker: '站点', page: 'is-links',
    body,
  });
}

import { csrfField, esc, initialMark as markOf, relWhen as when, relExact as exact } from '../../util/text.js';
import { safeHttpUrl } from '../../util/url.js';
import { failureLabel } from '../../util/failure.js';
import { adminLayout } from '../layout.js';
import { progressMarkup } from '../progress.js';
import { ICON_CLOSE } from '../../render/icons.js';

/** 后台「友圈」页：登记地址、看每个源的抓取状态。失败原因直接摊在行里，编辑字段收进 popover（声明式、零 JS）。「编辑」用 popover 而非 <details>：四个动作要并排；<summary> 要么嵌站名链接（Chrome 无障碍报「Interactive element inside of a <summary>」）、要么与表单绑死。 */

const STATE = {
  ok: ['a-pill a-pill-live', '正常'],
  failed: ['a-pill a-pill-err', '抓取失败'],
  never: ['a-pill a-pill-draft', '还没抓过'],
  off: ['a-pill a-pill-draft', '已停用'],
};

const stateOf = (f) => (!f.enabled ? 'off' : f.fail_count > 0 ? 'failed' : f.last_ok_at ? 'ok' : 'never');

const hostOf = (f) => {
  try { return new URL(f.url).host; } catch { return f.url; }
};



function feedRow(f, csrf, { page }) {
  const [pill, label] = STATE[stateOf(f)];
  const name = f.title || hostOf(f);
  const home = safeHttpUrl(f.site_url) ?? safeHttpUrl(f.url) ?? '';
  // 摆的是真正在抓的那个地址：只填站点主页的源，订阅地址是自动发现的（resolved_url），跟着配置值走就对不上账。
  const address = f.resolved_url || f.url;

  // 可见只留相对时间，精确时刻进 title；悬停多留「上次尝试」——它跟「最近成功」不是一回事，排障要看两者差距。
  const exactBits = [
    f.last_ok_at ? `最近成功 ${exact(f.last_ok_at)}` : '最近成功：从未成功',
    f.last_fetch_at && f.last_fetch_at !== f.last_ok_at ? `上次尝试 ${exact(f.last_fetch_at)}` : '',
  ].filter(Boolean).join(' · ');

  const error = f.last_error
    ? `          <p class="a-warn a-feed-err" title="${esc(f.last_error)}">${esc(failureLabel(f.last_error))}${f.fail_count > 1 ? ` · 已连续 ${f.fail_count} 次` : ''}</p>\n`
    : '';
  // 翻到第 N 页后，行内每个动作都要能把人送回第 N 页，否则删一个源就被弹回第一页。
  const back = page > 1 ? `          <input type="hidden" name="page" value="${page}">\n` : '';
  const editId = `feed-editor-${f.id}`;

  const tip = ['点这里编辑这个订阅源', address, exactBits].filter(Boolean).join(' · ');

  return `    <li class="a-feed" data-state="${stateOf(f)}"${f.last_error ? ' data-error' : ''}>
      <span class="a-feed-mark" aria-hidden="true">${esc(markOf(name))}</span>
      <p class="a-feed-top">
        ${home ? `<a class="a-feed-name" href="${esc(home)}" target="_blank" rel="noopener nofollow">${esc(name)}</a>` : `<span class="a-feed-name">${esc(name)}</span>`}
        <span class="${pill}">${label}</span>
        <button type="button" class="a-feed-meta a-feed-open" data-feed-open="${editId}" aria-haspopup="dialog" title="${esc(tip)}">最近成功 ${when(f.last_ok_at, '从未成功')}</button>
      </p>
${error}      <div class="a-feed-ops">
        <form method="post" action="/admin/feeds/${f.id}/refresh">
          ${csrfField(csrf)}
${back}          <button type="submit" class="a-btn-ghost">立即刷新</button>
        </form>
        <form method="post" action="/admin/feeds/${f.id}/toggle">
          ${csrfField(csrf)}
${back}          <button type="submit" class="a-btn-ghost">${f.enabled ? '停用' : '启用'}</button>
        </form>
        <form method="post" action="/admin/feeds/${f.id}/delete">
          ${csrfField(csrf)}
${back}          <button type="submit" class="a-btn-danger"
                  data-modal-ok="删除订阅源"
                  data-modal-title="删除这个订阅源？"
                  data-modal-body="${esc(name)}"
                  data-modal-note="它抓回来的文章会一并删掉，删的是本站的缓存，不会动对方站点。">删除</button>
        </form>
      </div>
      <dialog class="a-modal a-feed-editor" id="${editId}" aria-labelledby="${editId}-title">
        <form method="post" action="/admin/feeds/${f.id}/save">
          ${csrfField(csrf)}
${back}          <header class="a-media-dialog-head"><h2 id="${editId}-title">编辑订阅源</h2><button class="a-media-icon" type="button" data-feed-close aria-label="关闭编辑订阅源">${ICON_CLOSE}</button></header>
          <div class="a-feed-editor-body">
          <div class="a-field">
            <label for="f-url-${f.id}">地址</label>
            <input class="a-input" id="f-url-${f.id}" name="url" value="${esc(f.url)}" maxlength="500" spellcheck="false" autofocus>
          </div>
          <div class="a-grid2">
            <div class="a-field">
              <label for="f-title-${f.id}">站名</label>
              <input class="a-input" id="f-title-${f.id}" name="title" value="${esc(f.title)}" maxlength="60">
            </div>
            <div class="a-field">
              <label for="f-order-${f.id}">排序（小的在前）</label>
              <input class="a-input" id="f-order-${f.id}" name="sort_order" type="number" min="0" max="9999" value="${esc(f.sort_order)}">
            </div>
          </div>
          <p class="a-dim a-feed-editor-note">改地址会清掉已抓的旧条目，并按新地址重新抓。</p>
          </div>
          <div class="a-feed-editor-actions">
            <button type="button" class="a-btn-ghost" data-feed-close>取消</button>
            <button type="submit" class="a-btn">保存</button>
          </div>
        </form>
      </dialog>
    </li>`;
}


function pager({ page, lastPage, perPage, total, csrf }) {
  const step = (n, text, on) => (on
    ? `<a class="a-pager-btn" href="/admin/feeds?page=${n}">${text}</a>`
    : `<span class="a-pager-btn is-off">${text}</span>`);

  return `      <div class="a-feeds-pager">
        <span class="a-feeds-total">共 ${total} 个源</span>
        <form method="post" action="/admin/feeds/per" class="a-feeds-per">
          ${csrfField(csrf)}
          <label for="f-per">每页</label>
          <input class="a-input" id="f-per" name="per" type="number" min="5" max="100" value="${perPage}">
          <span class="a-dim">个源</span>
          <button type="submit" class="a-btn-ghost">应用</button>
        </form>
        <nav class="a-pager" aria-label="订阅源分页">
          ${step(page - 1, '上一页', page > 1)}
          <span class="a-pager-now">第 ${page} / ${lastPage} 页</span>
          ${step(page + 1, '下一页', page < lastPage)}
        </nav>
      </div>`;
}

// 「订阅未加入友圈的友链」三个渲染点：卡（动作 + 「查看」）、弹窗内容（进度 + 逐站结果，片段端点回它）、<dialog>。进度与结果收进弹窗（页面是静态快照，摊在外面站主会盯着不动的「7 / 9」以为卡死）；失败在最前。
const IMPORT_ORDER = { failed: 0, added: 1, skipped: 2 };
const IMPORT_MARK = { failed: '✗', added: '✓', skipped: '–' };
const IMPORT_HINT = '自动寻找 RSS / Atom；已订阅（含停用）、隐藏或已下线的站会跳过，找不到订阅源会列出原因。';
const IMPORT_CLOSE_ICON = ICON_CLOSE;
const IMPORT_FRAGMENT_URL = '/admin/feeds/subscribe-report';

// 入口按钮何时不能点：一轮还在跑 或 没有待订阅的站。admin.js 拿片段后照它补禁用态与文案（文案由服务端给，避免两处走样）。
const entryLabel = (pending) => (pending === 0 ? '友链都订阅过了' : `订阅未加入友圈的友链（${pending} 个）`);

export function importBlock({ importReport = null, pendingLinks = 0 }) {
  const running = Boolean(importReport?.running);
  const rows = (importReport?.results ?? [])
    .map((r, i) => [IMPORT_ORDER[r.state] ?? 9, i, r])
    .sort((a, b) => a[0] - b[0] || a[1] - b[1])
    .map(([, , r]) => r);
  const count = (state) => rows.filter((r) => r.state === state).length;
  const total = importReport?.total ?? 0;
  const done = importReport?.completed ?? 0;
  const pct = total ? Math.round((done / total) * 100) : 0;


  const stats = ['added', 'skipped', 'failed']
    .map((state) => `        <li data-state="${state}"><b>${count(state)}</b><span>${{ added: '新增', skipped: '跳过', failed: '失败' }[state]}</span></li>`)
    .join('\n');

  // 结果按状态分组，失败组永远在最前——要人搭理的只有没成功的那几个。
  const group = (state, label) => {
    const list = rows.filter((r) => r.state === state);
    if (!list.length) return '';
    return `      <section class="a-import-group" data-state="${state}">
        <h3 class="a-import-group-head"><span class="a-import-dot" aria-hidden="true"></span>${label} <b>${list.length}</b></h3>
        <ul class="a-import-list">
${list.map((r) => `          <li class="a-import-row" data-state="${esc(r.state)}"><span class="a-import-mk" aria-hidden="true">${IMPORT_MARK[r.state] ?? '·'}</span><code>${esc(r.host)}</code><span class="a-import-txt">${esc(r.detail)}</span></li>`).join('\n')}
        </ul>
      </section>
`;
  };
  const groups = [
    group('failed', '失败'),
    group('added', '新增'),
    group('skipped', '跳过'),
  ].join('');


  const progress = !importReport ? `      <p class="a-dim a-import-wait">正在读取进度…</p>
` : `      <p class="a-import-count" role="status"><span>${running ? '正在订阅' : '本轮已结束'} · ${done} / ${total} 个站</span><span class="a-import-meter" aria-hidden="true"><i style="width: ${pct}%"></i></span></p>
      <ul class="a-import-stats">
${stats}
      </ul>
`;


  const blank = importReport && !rows.length
    ? `      <p class="a-import-blank">${running ? '正在逐个检查这些站…' : '这一轮没有需要新增订阅的站。'}</p>\n`
    : '';

  return `    <div class="a-import" data-import="${IMPORT_FRAGMENT_URL}" data-running="${running ? '1' : '0'}"
         data-pending="${pendingLinks}" data-entry-label="${esc(entryLabel(pendingLinks))}">
${progress}${blank}${groups}    </div>`;
}

// 页面上那张卡只负责把人领进弹窗。跑过一轮后多一个「查看」（否则关掉弹窗就翻不到上轮）。没有待订阅的站时按钮禁用并改口，说明也收掉。
export function importEntry({ csrf, importReport = null, pendingLinks = 0 }) {
  const running = Boolean(importReport?.running);
  const empty = pendingLinks === 0;
  const view = importReport
    ? `        <button class="a-btn-ghost" type="button" data-import-view>${running ? '查看进度' : '查看上一次结果'}</button>\n`
    : '';
  return `    <div class="a-card a-panel">
      <div class="a-import-head">
        <form method="post" action="/admin/feeds/subscribe-links" data-import-start>
          ${csrfField(csrf)}
          <button class="a-btn-ghost" type="submit"${running || empty ? ' disabled' : ''}>${esc(entryLabel(pendingLinks))}</button>
        </form>
${view}${empty ? '' : `        <p class="a-dim">${IMPORT_HINT}</p>\n`}      </div>
    </div>`;
}

export function importDialog({ importReport = null, pendingLinks = 0 }) {
  return `    <dialog class="a-modal a-import-dialog" id="a-import-dialog" data-dismiss-outside aria-labelledby="a-import-dialog-title">
      <header class="a-media-dialog-head">
        <h2 id="a-import-dialog-title">订阅未加入友圈的友链</h2>
        <button class="a-media-icon" type="button" data-import-close aria-label="关闭">${IMPORT_CLOSE_ICON}</button>
      </header>
      <div class="a-import-dialog-body">
${importBlock({ importReport, pendingLinks })}      </div>
    </dialog>`;
}

/** 一轮抓取的进度条。首屏与轮询片段同一份模板；admin.js 每 1s 整块换掉，跑完再让 pjax 换整页。版面与「只管正在跑/跑完不留话」的规则在 progress.js。 */
export function feedsProgress(progress) {
  return progressMarkup(progress, {
    cls: 'a-feeds-progress', dataName: 'feeds-progress', endpoint: '/admin/feeds/refresh-progress',
    meter: 'a-feeds-meter', label: '刷新中', unit: '个源',
  });
}

export function feedsPage({
  rows = [], totals = {}, importReport = null, pendingLinks = null, csrf, badges, notice = '',
  page = 1, perPage = 20, lastPage = 1, addUrl = '', addTitle = '',
  progress = null,
}) {
  const list = rows.map((feed) => feedRow(feed, csrf, { page })).join('\n');
  const total = totals.sources ?? 0;
  const head = `已订阅 ${total} 个源`;
  const pageInput = page > 1 ? `          <input type="hidden" name="page" value="${page}">\n` : '';
  // 一轮跑着时按钮得禁用：后端会把并发的整轮刷新排队，点第二次只会白等；客户端照片段里的 data-running 同步它。
  const running = Boolean(progress?.running);

  const body = `    <h2 class="a-h2 a-h2-first">添加订阅源</h2>
    <div class="a-card a-panel a-feed-add">
      <form method="post" action="/admin/feeds/add" id="feed-add-form" class="a-feed-add-form">
        ${csrfField(csrf)}
        <div class="a-field">
          <label for="f-url">地址</label>
          <input class="a-input" id="f-url" name="url" required maxlength="500" spellcheck="false" value="${esc(addUrl)}">
        </div>
        <div class="a-field">
          <label for="f-title">站名</label>
          <input class="a-input" id="f-title" name="title" maxlength="60" value="${esc(addTitle)}">
        </div>
        <div class="a-field a-feed-add-go">
          <button type="submit" class="a-btn">添加并抓取</button>
        </div>
      </form>
    </div>

    <h2 class="a-h2">${esc(head)}</h2>
    ${pendingLinks !== null ? importEntry({ csrf, importReport, pendingLinks }) : ''}
    <div class="a-card a-panel">
      ${rows.length ? `<div class="a-feeds-bar">
        <div class="a-feeds-bar-ops">
          <form method="post" action="/admin/feeds/refresh" data-feeds-refresh>
            ${csrfField(csrf)}
${pageInput}            <button type="submit" class="a-btn-ghost"${running ? ' disabled' : ''}>刷新全部</button>
          </form>
          <form method="post" action="/admin/feeds/clear-items">
            ${csrfField(csrf)}
${pageInput}            <button type="submit" class="a-btn-ghost"
                    data-modal-ok="清空抓取结果"
                    data-modal-title="清空已抓取的文章？"
                    data-modal-body="所有源抓回来的条目都会被删掉，地址配置保留。"
                    data-modal-note="下次刷新（或点「刷新全部」）会重新抓回来。">清空抓取结果</button>
          </form>
        </div>
      </div>
${feedsProgress(progress)}
      <ul class="a-feeds">
${list}
      </ul>
${pager({ page, lastPage, perPage, total, csrf })}` : `      <ul class="a-feeds">
        <li class="a-empty">还没有添加任何地址。上面填一个博客的 RSS/Atom 地址试试。</li>
      </ul>`}
    </div>
${pendingLinks !== null ? importDialog({ importReport, pendingLinks }) : ''}`;

  return adminLayout({
    title: '友圈', active: 'feeds', csrf, badges, notice,
    sub: total ? `${total} 个源` : '还没加地址',
    page: 'is-feeds',
    body,
  });
}

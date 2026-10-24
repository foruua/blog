import { csrfField, esc, toLocalInput, contentUrl, nowIso } from '../../util/text.js';
import { adminLayout, shortTime } from '../layout.js';
import { pickerDialog } from './picker.js';



const writingDesk = ({ head = '', bodyMd = '' }) => `      <div class="a-writing">
${head}
        <p class="a-body-head" aria-hidden="true"><span>正文</span><em>Markdown</em></p>
        <div class="a-body">
          <label class="a-vh" for="f-body">正文 Markdown</label>
          <textarea class="a-textarea" id="f-body" name="body" rows="12" spellcheck="false"
            title="Tab 缩进；按 Esc 再按 Tab 可把焦点移出正文框">${esc(bodyMd)}</textarea>
        </div>
      </div>`;


const editorBar = ({ actions = '', state = '', danger = '' }) => `      <div class="a-bar">
        <div class="a-bar-actions">
${actions}
        </div>
        <div class="a-bar-state">
          <!-- 保存状态是纯文字变化（"已保存" / "保存失败" / 409 冲突），必须自己声明成 live region：
               屏读器不会因为一个 span 的文字变了就念出来，自动保存等于对读屏用户完全不可见。 -->
          <span class="a-save-state" id="a-save-state" role="status" aria-live="polite">${state}</span>
        </div>${danger ? `
        <div class="a-bar-danger">
${danger}
        </div>` : ''}
      </div>`;


const KIND_META = {
  post: { word: '文章', active: 'posts' },
  note: { word: '笔记', active: 'notes' },
  page: { word: '页面', active: 'pages' },
};

export function listPage({ pagination = '', posts, counts, commentCounts = {}, kind = 'post', csrf, badges, search = '', status = 'all', listPath = '/admin' }) {
  const meta = KIND_META[kind] ?? KIND_META.post;
  const kindWord = meta.word;

  const urlOf = (slug) => contentUrl({ kind, slug });

  const now = nowIso();
  const published = Math.max(0, (counts.total ?? 0) - (counts.drafts ?? 0) - (counts.scheduled ?? 0));

  const rows = posts.map((p) => {
    const state = p.missing_file ? '<span class="a-pill a-pill-draft">文件缺失</span>' : p.draft
      ? '<span class="a-pill a-pill-draft">草稿</span>'
      : (p.published_at && p.published_at > now)
        ? '<span class="a-pill a-pill-sched">定时</span>'
        : '<span class="a-pill a-pill-live">已发布</span>';
    const url = urlOf(p.slug);
    return `        <tr>
          <td>${state}</td>
          <td>
            <a class="a-title" href="/admin/edit/${p.id}">${esc(p.title || '(无标题)')}</a>${
              p.pending_comments ? ` <span class="a-pill a-pill-sched">${p.pending_comments} 待审</span>` : ''}
          </td>
          <td class="a-num a-hide-sm" data-label="评论">${p.comments || 0}</td>
          <td class="a-mono a-hide-sm" data-label="时间">${esc(shortTime(p.published_at))}</td>
          <td class="a-mono a-hide-sm" title="${esc(url)}">${esc(url)}</td>
        </tr>`;
  }).join('\n');

  // 手机端一级入口只有「内容」，三种文体用分段控件切换；桌面端隐藏（左侧导航已经分开）。
  const kindNav = `<nav class="a-seg" aria-label="内容类型">
${[['post', '文章', '/admin'], ['note', '笔记', '/admin/notes'], ['page', '页面', '/admin/pages']]
    .map(([k, label, href]) => `<a href="${href}"${k === kind ? ' aria-current="page"' : ''}>${label}</a>`).join('')}
    </nav>`;
  const fab = `<a class="a-fab" href="/admin/new?kind=${kind}" aria-label="写${kindWord}"><span aria-hidden="true">+</span></a>`;

  const body = `${kindNav}    <div class="a-strip a-strip-compact">
      <div><b>${counts.total ?? 0}</b><span>全部${kindWord}</span></div>
      <div><b>${published}</b><span>已发布</span></div>
      <div><b>${counts.drafts ?? 0}</b><span>草稿</span></div>
      <div><b>${counts.scheduled ?? 0}</b><span>定时待发</span></div>
      <div${commentCounts.pending ? ' class="a-warn"' : ''}><b>${commentCounts.pending ?? 0}</b><span>评论待审</span></div>
    </div>

    <form method="get" action="${esc(listPath)}" class="a-search a-content-search" role="search">
      <input class="a-input" name="q" value="${esc(search)}" placeholder="搜索标题或 slug" aria-label="搜索标题或 slug">
      <select class="a-select" name="status" aria-label="内容状态">${[["all", "全部状态"], ["published", "已发布"], ["draft", "草稿"], ["scheduled", "定时待发"]].map(([v, label]) => `<option value="${v}"${status === v ? ' selected' : ''}>${label}</option>`).join('')}</select>
      <button class="a-btn-ghost" type="submit">搜索</button>
      ${search || status !== 'all' ? `<a class="a-link" href="${esc(listPath)}">重置</a>` : ''}
    </form>
    <div class="a-card a-card-table">
      <table class="a-table a-table-posts">
        <caption class="a-vh">${esc(kindWord)}列表：状态、标题、评论数、时间与链接</caption>
        <thead><tr>
          <th scope="col">状态</th><th scope="col">标题</th>
          <th scope="col" class="a-num a-hide-sm">评论</th><th scope="col" class="a-hide-sm">时间</th><th scope="col">链接</th>
        </tr></thead>
        <tbody>
${rows || `        <tr><td colspan="5" class="a-empty">${
        search || status !== 'all'
          ? `没有匹配${search ? `「${esc(search)}」` : '当前状态'}的${kindWord}。<a class="a-link" href="${esc(listPath)}">清除搜索</a>`
          : `还没有${kindWord}。点右上角写${kindWord}。`}</td></tr>`}
        </tbody>
      </table>
    </div>${pagination}${fab}`;

  return adminLayout({
    title: kindWord,
    sub: `${counts.total ?? 0} 篇 · 草稿 ${counts.drafts ?? 0} · 定时 ${counts.scheduled ?? 0}`,
    active: meta.active, csrf, badges, page: 'is-content',

    actions: `<a class="a-btn" href="/admin/new?kind=${kind}">写${kindWord}</a>`,
    body,
  });
}

export function editorPage({ conflict = false, post, csrf, aliases = [], revisions = [], isNew = false, notice = '', badges }) {
  const dateValue = post.dateInput ?? (post.published_at ? toLocalInput(post.published_at) : toLocalInput(new Date().toISOString()));
  const now = nowIso();
  const meta = KIND_META[post.kind] ?? KIND_META.post;
  const deleteNoun = post.kind === 'page' ? '个页面' : `篇${meta.word}`;

  const chip = isNew
    ? `<span class="a-chip">新${meta.word}</span>`
    : post.draft
      ? '<span class="a-chip a-chip-draft">草稿</span>'
      : (post.published_at && post.published_at > now)
        ? `<span class="a-chip a-chip-sched">定时 · ${esc(shortTime(post.published_at))}</span>`
        : '<span class="a-chip a-chip-live">已发布</span>';

  const revRows = revisions.map((r) => `        <li>
          <time datetime="${esc(String(r.created_at))}">${esc(shortTime(r.created_at))}</time>
          <span>${esc(r.note)}</span>
          <a class="a-link" href="/admin/revision/${r.id}">查看</a>
          <form method="post" action="/admin/restore/${r.id}" class="a-inline">
            ${csrfField(csrf)}
            <button type="submit" class="a-link" data-modal-title="恢复这个历史版本？" data-modal-body="版本时间：${esc(shortTime(r.created_at))}" data-modal-note="当前标题和正文将被替换；恢复前会保留当前版本，便于再次恢复。" data-modal-ok="恢复此版本">恢复此版本</button>
          </form>
        </li>`).join('\n');

  const head = `          <div class="a-field">
            <label class="a-vh" for="f-title">标题</label>
            <input class="a-input" id="f-title" name="title" placeholder="${post.kind === 'note' ? '笔记标题' : post.kind === 'page' ? '页面标题' : '文章标题'}" value="${esc(post.title ?? '')}" required>
          </div>`;

  // 发布设置整块折叠；状态 chip 留在 summary 上——折起来也要看得见。
  const settings = `        <details class="a-fold a-editor-settings" id="a-settings">
          <summary>发布设置${chip}</summary>
          <div class="a-settings-grid">
            <div class="a-field">
              <label for="f-date">时间</label>
              <input class="a-input" id="f-date" type="datetime-local" step="1" name="date" value="${esc(dateValue)}">
            </div>
            <div class="a-field">
              <label for="f-slug">slug</label>
              <input class="a-input" id="f-slug" name="slug" value="${esc(post.slug ?? '')}">
            </div>
            <div class="a-field">
              <label for="f-kind">类型</label>
              <select class="a-select" id="f-kind" name="kind">
                ${[['post', '文章'], ['note', '笔记'], ['page', '页面']].map(([v, l]) =>
                  `<option value="${v}"${post.kind === v ? ' selected' : ''}>${l}</option>`).join('')}
              </select>
            </div>
            <div class="a-field a-field-checks">
              <label class="a-check"><input type="checkbox" name="draft" value="1"${post.draft ? ' checked' : ''}> <span>草稿（前台不可见）</span></label>
              <label class="a-check"><input type="checkbox" name="comments" value="1"${post.comments_on ? ' checked' : ''}> <span>允许评论</span></label>
            </div>
            <div class="a-field a-field-wide">
              <label for="f-desc">摘要</label>
              <input class="a-input" id="f-desc" name="description" maxlength="300" value="${esc(post.description ?? '')}">
            </div>
          </div>
        </details>`;

  // 删除单独挂最右——危险动作不挨着保存。
  const actions = `          <button type="submit" class="a-btn" name="action" value="save" data-saved="已保存" title="保存当前内容和发布设置">保存</button>
          <button type="submit" name="action" value="publish" class="a-btn-ghost" data-saved="已保存并发布" title="保存内容并发布；未来时间将定时发布">保存并发布</button>
          <button type="button" data-editor-preview class="a-btn-ghost">预览</button>
          <button type="button" id="a-upload-btn" class="a-btn-ghost">插入图片</button>
          <input type="file" id="a-file" accept="image/*" hidden>`;

  const danger = post.id ? `          <a class="a-btn-danger" href="/admin/delete/${post.id}"
            data-modal-action="/admin/delete/${post.id}"
            data-modal-title="删除这${deleteNoun}？"
            data-modal-body="《${esc(post.title)}》"
            data-modal-note="文件会移到 content/.trash/，不是从磁盘抹掉 —— 误删可以手工救回。"
            data-modal-ok="删除${meta.word}">删除</a>` : '';

  const body = `    <form method="post" action="/admin/save" id="editorForm"${conflict ? ' data-conflict="1"' : ''}>
      ${csrfField(csrf)}
      <input type="hidden" name="id" value="${esc(post.id ?? '')}">
      <input type="hidden" name="version" value="${esc(post.version ?? '')}">

${editorBar({ actions, state: isNew ? '尚未保存' : `已保存 · ${esc(shortTime(post.updated_at))}`, danger })}
      <div class="a-editor">
${writingDesk({ head, bodyMd: post.body_md ?? '' })}
${settings}
      </div>
    </form>

${pickerDialog()}
    <dialog class="a-modal a-editor-preview" data-dismiss-outside data-editor-preview-dialog aria-labelledby="editor-preview-title">
      <header class="a-media-dialog-head a-preview-head">
        <h2 id="editor-preview-title">内容预览</h2>
        <button type="button" class="a-media-icon" data-preview-close aria-label="关闭预览" autofocus><svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" aria-hidden="true"><path d="M4.4 4.4 11.6 11.6M11.6 4.4 4.4 11.6"/></svg></button>
      </header>
      <div class="a-preview-scroll">
        <article class="post a-preview-sheet">
          <h1 data-preview-title></h1>
          <div class="prose" data-preview-body></div>
        </article>
      </div>
    </dialog>

    <details class="a-fold">
      <summary>修订历史（${revisions.length}）${aliases.length ? ` · 旧链接 ${aliases.length} 条` : ''}</summary>
      <ul class="a-revs">
${revRows}
      </ul>
      ${aliases.length ? `<p class="a-dim">301 映射：${aliases.map((a) => `<code>${esc(a)}</code>`).join(' ')}</p>` : ''}
    </details>`;

  const kindWord = post.kind === 'note' ? '笔记' : post.kind === 'page' ? '页面' : '文章';

  const address = post.slug ? contentUrl(post) : '';

  return adminLayout({
    title: isNew ? '新建' : '编辑',
    kicker: kindWord,
    sub: address,
    page: 'is-editor',
    active: meta.active, csrf, badges, notice,
    actions: `<a class="a-back" href="${meta.active === 'notes' ? '/admin/notes' : meta.active === 'pages' ? '/admin/pages' : '/admin'}">← 内容列表</a>`,
    body,
  });
}

export function revisionPage({ revision, post, csrf, badges }) {
  const body = `    <p class="a-back-line"><a class="a-back" href="/admin/edit/${post.id}">← 回到编辑器</a></p>
    <div class="a-card a-panel">
      <div class="a-field"><label for="rv-title">标题</label><input class="a-input" id="rv-title" value="${esc(revision.title)}" readonly></div>
      <div class="a-field"><label for="rv-body">正文</label><textarea class="a-textarea" id="rv-body" rows="26" readonly>${esc(revision.body_md)}</textarea></div>
    </div>`;
  return adminLayout({
    title: '修订快照', sub: `${shortTime(revision.created_at)} · ${revision.note}`,
    active: (KIND_META[post.kind] ?? KIND_META.post).active, csrf, badges, body,
  });
}

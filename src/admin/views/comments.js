import { csrfField, esc, relativeDate, contentUrl } from '../../util/text.js';
import { safeHttpUrl } from '../../util/url.js';
import { adminLayout, shortTime } from '../layout.js';
import { renderComment } from '../../comments/render.js';
import { pagination } from '../../routes/admin/shared.js';

// mailto: 里保留 @ / +（很多客户端认），只转义会形成查询串或头字段的分隔符；旧库里可能还有这种地址。
const mailtoAddress = (email) => String(email ?? '').replace(/[%?&=#/;,:]/g, (ch) => encodeURIComponent(ch));

export function commentReplyPage({ comment, notice = '', csrf = '', badges = {} }) {
  const post = { kind: comment.post_kind, slug: comment.post_slug, title: comment.post_title };
  const url = contentUrl(post);
  const body = `    <p class="a-back-line"><a class="a-back" href="/admin/comments">← 回评论列表</a></p>

    <div class="a-card a-panel">
      <div class="a-quote">
        <p class="a-quote-head">
          <b>${esc(comment.author)}</b>${comment.is_author ? ' <span class="a-pill a-pill-live">作者</span>' : ''}
          <span class="a-dim">${esc(relativeDate(comment.created_at))}${
            comment.email ? ` · <a class="a-value-link" href="mailto:${esc(mailtoAddress(comment.email))}">${esc(comment.email)}</a>` : ''}</span>
        </p>
        <div class="a-quote-body">${renderComment(comment.body_md)}</div>
        <p class="a-quote-foot">来自《<a class="a-link" href="${esc(url)}" target="_blank">${esc(post.title ?? '')}</a>》</p>
      </div>

      <form method="post" action="/admin/comments/${comment.id}/reply">
        ${csrfField(csrf)}
        <div class="a-field">
          <label for="reply-body">以作者身份回复</label>
          <textarea id="reply-body" class="a-textarea" name="body" rows="6" required></textarea>
        </div>
        <p class="a-bar"><button class="a-btn" type="submit">发布回复</button></p>
      </form>
    </div>`;

  return adminLayout({
    title: '回复评论', sub: `回复 ${comment.author}`, active: 'comments', csrf, badges, notice, body,
  });
}

export function commentsPage({
  pending, recent, counts, csrf, notice = '', badges,
  pendingPage = 1, pendingPages = 1, recentPage = 1, recentPages = 1,
}) {

  const row = (c, prefix) => {
    const key = `${prefix}-${c.id}`;
    const site = safeHttpUrl(c.website);
    // 待审/垃圾/已删除的评论公开页不渲染（只有 approved 才出现），故回退到评论区锚点——否则会落在不存在的 #c<id> 上，停在文章顶部。
    const postTitle = c.post_title || c.post_slug || '';
    const postHref = postTitle
      ? `${contentUrl({ kind: c.post_kind, slug: c.post_slug })}${c.status === 'approved' ? `#c${c.id}` : '#comments'}`
      : '';
    return `        <tr>
          <td class="a-col-author">
            ${site
              ? `<b><a class="a-link" href="${esc(site)}" rel="nofollow noopener" target="_blank"
                   title="访问 ${esc(c.author)} 的网站：${esc(site)}">${esc(c.author)}</a></b>`
              : `<b>${esc(c.author)}</b>`}${c.is_author ? ' <span class="a-pill a-pill-live">作者</span>' : ''}
            <div class="a-dim"><time datetime="${esc(String(c.created_at))}"
              title="精确时间：${esc(shortTime(c.created_at))}">${esc(relativeDate(c.created_at))}</time></div>
            <div class="a-dim a-col-contact">${
              c.email
                ? `<a class="a-value-link" href="mailto:${esc(mailtoAddress(c.email))}" title="给 ${esc(c.author)} 回信">${esc(c.email)}</a>`
                : '<span title="这条评论提交时邮箱还不是必填项">—</span>'}</div>
          </td>
          <td class="a-dim a-col-body">${esc(c.body_md.slice(0, 200))}${c.body_md.length > 200 ? '…' : ''}</td>
          <td class="a-col-post" data-label="文章">${
            postHref
              ? `<a class="a-link" href="${esc(postHref)}" target="_blank" rel="noopener"
                   title="在《${esc(postTitle)}》里查看这条评论">${esc(postTitle)}</a>`
              : '<span class="a-dim">—</span>'}</td>
          <td class="a-ops">
            <a class="a-link" href="/admin/comments/${c.id}/reply" data-reply-toggle data-no-pjax
               aria-expanded="false" aria-controls="reply-row-${key}">回复</a>
            <form method="post" action="/admin/comments/${c.id}" class="a-inline">
              ${csrfField(csrf)}
              <button name="status" value="approved" class="a-link">通过</button>
              <button name="status" value="spam" class="a-link">垃圾</button>
              <button name="status" value="deleted" class="a-link"
                      data-modal-title="删除这条评论？"
                      data-modal-body="${esc(c.author)}：${esc(c.body_md.slice(0, 60))}"
                      data-modal-note="这是软删除，页面上不再显示；之后还能在列表里改回「通过」。"
                      data-modal-ok="删除评论">删除</button>
            </form>${

              c.status === 'deleted'
                ? `
            <a class="a-link a-link-danger" href="/admin/comments/${c.id}/purge"
               data-modal-action="/admin/comments/${c.id}/purge"
               data-modal-title="彻底删除这条评论？"
               data-modal-body="${esc(c.author)}：${esc(c.body_md.slice(0, 60))}"
               data-modal-note="数据库里这一行直接消失，没有还原入口；它的回复会一起删除。"
               data-modal-ok="彻底删除评论">彻底删除</a>`
                : ''}
          </td>
        </tr>
        <tr class="a-reply-row" id="reply-row-${key}" hidden>
          <td colspan="4">
            <form class="a-reply-form" method="post" action="/admin/comments/${c.id}/reply">
              ${csrfField(csrf)}
              <textarea class="a-textarea" name="body" rows="3" required
                aria-label="以作者身份回复 ${esc(c.author)}"></textarea>
              <p class="a-bar">
                <button class="a-btn" type="submit">发布回复</button>
                <button class="a-btn-ghost" type="button" data-reply-cancel="${c.id}">取消</button>
              </p>
            </form>
          </td>
        </tr>`;
  };

  const table = (rows, empty, prefix) => `    <div class="a-card a-card-table">
      <table class="a-table a-table-comments">
        <thead><tr><th class="a-col-author">作者</th><th class="a-col-body">内容</th><th class="a-col-post">文章</th><th class="a-ops">操作</th></tr></thead>
        <tbody>
${rows.length ? rows.map((c) => row(c, prefix)).join('\n') : `        <tr><td colspan="4" class="a-empty">${empty}</td></tr>`}
        </tbody>
      </table>
    </div>`;

  // 两列表各自翻页：待审是队列（老的在前）、最近评论是流水（新的在前）；翻待审时把最近评论那页原样带着走（preserve），别把人踢回第一页。
  const pager = (param, page, pages, preserve, label) => (pages > 1
    ? pagination('/admin/comments', page, page < pages, '', '', { hideSearch: true, param, preserve, label })
    : '');

  const body = `    <div class="a-strip a-strip-comments">
      <div${counts.pending ? ' class="a-warn"' : ''}><b>${counts.pending ?? 0}</b><span>待审核</span></div>
      <div><b>${counts.approved ?? 0}</b><span>已通过</span></div>
      <div><b>${counts.spam ?? 0}</b><span>垃圾</span></div>
      <div><b>${counts.deleted ?? 0}</b><span>已删除</span></div>
    </div>

    <h2 class="a-h2 a-h2-first">待审核</h2>
${table(pending, '没有待审的评论。', 'pending')}
${pager('pending', pendingPage, pendingPages, { recent: recentPage }, '待审核分页')}
    <h2 class="a-h2">最近评论</h2>
${table(recent, '还没有评论。', 'recent')}
${pager('recent', recentPage, recentPages, { pending: pendingPage }, '最近评论分页')}`;

  return adminLayout({
    title: '评论', sub: `待审 ${counts.pending ?? 0} · 已通过 ${counts.approved ?? 0}`,
    active: 'comments', csrf, badges, notice, body,
  });
}

export function commentPurgePage({ item, replies = 0, postUrl, csrf, badges }) {
  return adminLayout({
    title: '彻底删除评论', active: 'comments', csrf, badges,
    actions: '<a class="a-back" href="/admin/comments">← 取消，回评论列表</a>',
    body: `    <div class="a-card a-panel a-confirm">
      <p class="a-kicker">不可撤销</p>
      <p class="a-notice a-notice-plain">${esc(item.author)} · ${esc(shortTime(item.created_at))} · 当前状态：已删除（软删除）</p>
      <div class="prose a-quote"><p>${esc(item.body_md.slice(0, 600))}${item.body_md.length > 600 ? '…' : ''}</p></div>
      <p class="a-dim">来自 <a href="${esc(postUrl)}">${esc(item.post_title ?? '这篇文章')}</a></p>
      <p class="a-warn">彻底删除<b>不进回收站</b>：数据库里这一行直接消失，没有还原入口${replies ? `；它的 <b>${replies}</b> 条回复会一起删除` : ''}。</p>
      <form method="post" action="/admin/comments/${item.id}/purge">
        ${csrfField(csrf)}
        <p class="a-actions"><button type="submit" class="a-btn-danger a-btn-danger-solid">确认彻底删除</button></p>
      </form>
      <p class="a-dim">只是不想让它出现在页面上，用列表里的「删除」（软删除）就够了 —— 那一步可以随时改回「通过」。</p>
    </div>`,
  });
}


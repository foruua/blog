import { csrfField, esc, formatDateTime, relativeOrDay, contentUrl, commentAction } from '../util/text.js';
import { avatar, renderComment } from './render.js';
import { authorName, honeypot, identityFields, INDENT_DEPTH } from './fields.js';

const EMOJI = [
  ['😀', '开心'], ['😄', '大笑'], ['😁', '露齿笑'], ['😂', '笑哭'],
  ['🥹', '感动'], ['😊', '微笑'], ['😍', '喜爱'], ['🥰', '幸福'],
  ['😎', '酷'], ['🤔', '思考'], ['😅', '汗颜'], ['😭', '哭泣'],
  ['😮', '惊讶'], ['😴', '困了'], ['🤗', '拥抱'], ['🤩', '赞叹'],
  ['👍', '赞'], ['👏', '鼓掌'], ['🙌', '欢呼'], ['🙏', '感谢'],
  ['❤️', '红心'], ['💔', '心碎'], ['🎉', '庆祝'], ['✨', '闪亮'],
  ['🔥', '火热'], ['💯', '满分'], ['🌹', '玫瑰'], ['☕', '咖啡'],
  ['🤣', '笑翻了'], ['😉', '眨眼'], ['🙂', '浅笑'], ['🙃', '倒脸'],
  ['😇', '天使'], ['😘', '飞吻'], ['😋', '美味'], ['😜', '调皮'],
  ['🤪', '搞怪'], ['🤭', '偷笑'], ['🫣', '偷看'], ['🤫', '嘘'],
  ['🫡', '敬礼'], ['🤨', '疑惑'], ['😐', '无语'], ['🙄', '白眼'],
  ['😏', '得意'], ['😌', '放松'], ['😔', '低落'], ['🥺', '委屈'],
  ['😤', '不服气'], ['😡', '生气'], ['😱', '震惊'], ['😳', '脸红'],
  ['🥳', '派对'], ['🤯', '脑洞大开'], ['🫠', '融化'], ['🤓', '认真'],
  ['👋', '挥手'], ['👌', '好的'], ['✌️', '胜利'], ['🤞', '好运'],
  ['🤝', '握手'], ['💪', '加油'], ['🫶', '比心'], ['👀', '关注'],
  ['💖', '闪亮的心'], ['💕', '两颗心'], ['💗', '心动'], ['💙', '蓝心'],
  ['💚', '绿心'], ['💛', '黄心'], ['💜', '紫心'], ['🤍', '白心'],
  ['🌸', '樱花'], ['🍀', '四叶草'], ['🌈', '彩虹'], ['☀️', '阳光'],
  ['🌙', '月亮'], ['⭐', '星星'], ['🎈', '气球'], ['🎁', '礼物'],
  ['🍰', '蛋糕'], ['🍵', '茶'], ['📚', '读书'], ['🐱', '猫咪'],
];

// 触发键那枚笑脸是站里自己的图标语系（16×16 viewBox、stroke=currentColor、1.5、圆头），与灯箱关闭键、后台 a-ico 同一套。原来用 ☺ 文字字形（U+263A）：笔画与光学大小由系统字体决定，Windows/Android 上还可能被当彩色表情渲染——同一枚键三平台三种样子。
const FACE_ICON = '<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><circle cx="8" cy="8.1" r="6.1"/><path d="M5.6 9.6a3.1 3.1 0 0 0 4.8 0"/><path d="M6.15 6.35h.01M9.85 6.35h.01"/></svg>';

// 面板本体（80 枚按钮 ≈ 7.4KB）不再跟着每个评论表单走：/notes 一页十来个抽屉就是十份，光这一项占掉整页
// 四成体积。表单处只留触发键，面板改为整页一份 <template>，首次点开时由 app.js 克隆进对应的 .c-emoji。
// 无脚本时 .c-emoji 本来就被 CSS 收掉（style.css 的 html:not(.has-js)），所以这一改不影响降级行为。
export function emojiPicker() {
  return `<div class="c-emoji" data-emoji-picker>
          <button class="c-emoji-trigger" type="button" data-emoji-toggle aria-expanded="false" aria-label="选择表情">${FACE_ICON}</button>
        </div>`;
}

// 只有页面里真的存在表情触发键时才输出（layout 会先探测 main），首页/归档这类没有表单的页面不多背这 7KB。
export function emojiPanelTemplate() {
  return `<template data-emoji-tpl>
          <div class="c-emoji-panel" popover="auto" data-emoji-panel aria-label="常用表情">
          <div class="c-emoji-head"><span>常用表情</span><button type="button" data-emoji-close aria-label="关闭表情面板">×</button></div>
          <div class="c-emoji-grid" role="group" aria-label="选择表情">
            ${EMOJI.map(([emoji, label]) => `<button type="button" data-emoji="${emoji}" title="${label}" aria-label="${label}">${emoji}</button>`).join('')}
          </div>
          </div>
        </template>`;
}

export const FLASH = {
  ok: '评论已发布。',
  pending: '评论已提交，等待站主确认后显示。',
  bad: '提交失败：请检查昵称与内容是否填写完整。',
  'bad-email': '提交失败：请填写有效的邮箱地址（不会公开，仅用于显示头像）。',
  limited: '提交过于频繁，请稍后再试。',
  forbidden: '请求来源无效，请刷新页面后重试。',
  off: '本文已关闭评论。',
};

function commentBody(c, { replyBase = '', canReply = false, depth = 1, replyToAuthor = '' } = {}) {
  const who = authorName(c);

  const at = depth > INDENT_DEPTH && replyToAuthor
    ? `<span class="c-at">回复 <b>@${esc(replyToAuthor)}</b></span>`
    : '';
  const reply = canReply
    ? `<a class="c-reply" href="${esc(replyBase)}?reply=${c.id}#reply" data-reply="${c.id}" data-reply-author="${esc(c.author)}">回复</a>`
    : '';
  const kids = c.replies ?? [];
  // 版式参照 fatesinger（Hera 主题）的评论列表：三行竖排——头像+昵称一行、正文全宽、底部一行时间。「回复」
  // 不落底部而挂头部行右侧，鼠标设备悬停这条评论才显形（由 CSS @media (hover:hover) 管）。avatar 从 li 直接
  // 子挪进 .c-head；ul.c-replies 必须仍留在 .c-main 里——test-comments 的 T14a 靠 parentElement 三层链认归属。
  return `<li class="comment" id="c${c.id}">
  <div class="c-main">
    <p class="c-head">${avatar(c.author, 40, c.avatar_md5)}${who}${at}${reply}</p>
    <div class="c-body">${renderComment(c.body_md)}</div>
    <p class="c-foot"><time datetime="${esc(c.created_at)}" title="${esc(formatDateTime(c.created_at))}">${esc(relativeOrDay(c.created_at))}</time></p>
    ${kids.length ? `<ul class="c-replies ${depth < INDENT_DEPTH ? 'c-nest' : 'c-flush'}">${kids.map((r) => commentBody(r, { replyBase, canReply, depth: depth + 1, replyToAuthor: c.author })).join('')}</ul>` : ''}
  </div>
</li>`;
}

export function commentSection({ post, thread, count, flash, tsToken, replyTo = null, idSuffix = '', replyBase = '', page = 1, pages = 1, asAuthor = false, csrf = '', submissionId = '' }) {
  const notice = flash && FLASH[flash]
    ? `<p class="c-flash c-flash-${esc(flash)}">${esc(FLASH[flash])}</p>` : '';

  if (!post.comments_on) {
    return `<section class="comments" id="comments${idSuffix}" data-comments-section>
      <header class="c-top"><h2><span class="c-label">评论</span><b class="c-count">${count}</b></h2></header>
      <p class="c-closed">本文的评论已关闭。</p>
    </section>`;
  }

  const list = thread.length
    ? `<ul class="c-list">${thread.map((c) => commentBody(c, { replyBase, canReply: true })).join('')}</ul>`
    : '';

  const pager = pages > 1
    ? `        <nav class="c-pager" aria-label="评论分页">
          ${page > 1 ? `<a class="c-pager-btn" href="?cpage=${page - 1}#comments">← 更早</a>` : '<span class="c-pager-btn is-off">← 更早</span>'}
          <span class="c-pager-now">第 ${page} / ${pages} 页</span>
          ${page < pages ? `<a class="c-pager-btn" href="?cpage=${page + 1}#comments">更新 →</a>` : '<span class="c-pager-btn is-off">更新 →</span>'}
          ${page < pages ? `<a class="c-pager-last" href="?cpage=${pages}#comments">最新 →</a>` : ''}
        </nav>`
    : '';

  // 「取消回复」的兜底地址是"不带 ?reply 的同一页"：JS 在时会原地重置表单（见 public/app.js），禁用 JS 也能靠它
  // 退回写新评论——否则从文章页点了「回复某人」后无法反悔，只能刷新丢掉已写内容。
  const cancelHref = `${replyBase || contentUrl(post)}#comments`;

  // 评论表单的 autocomplete：邮箱 email、网址 url，昵称写 name 而非更贴切的 nickname——nickname 虽是 WHATWG
  // 标准 token，但 Chrome 自动填充不认它（DevTools 报 FormInputHasWrongButWellIntendedAutocompleteValueError
  // 且该栏真的不会被填充）。规范也建议优先用更宽的字段，故用 name。
  return `<section class="comments" id="comments${idSuffix}" data-comments-section>
      <header class="c-top">
        <h2><span class="c-label">评论</span><b class="c-count">${count}</b></h2>
${pager}
      </header>
      ${notice}
      ${list}
      <form class="c-form${asAuthor ? ' is-author' : ''}" action="${commentAction(post)}" method="post" data-comment-form data-slug="${esc(post.slug)}" data-cpage="${page}">
        <h3 id="reply${idSuffix}">
          <span data-reply-title>${replyTo ? `回复 ${esc(replyTo.author)}` : ''}</span>
          <a class="c-cancel-reply" href="${esc(cancelHref)}" data-cancel-reply data-no-pjax${replyTo ? '' : ' hidden'}>取消回复</a>
        </h3>
        <input type="hidden" name="ts" value="${esc(tsToken)}">
        <input type="hidden" name="submission_id" value="${esc(submissionId)}">

        <input type="hidden" name="parent" value="${replyTo ? replyTo.id : ''}" data-parent>
        ${asAuthor ? `<input type="hidden" name="as_author" value="1">${csrfField(csrf)}` : ''}

${honeypot('        ')}${asAuthor ? '' : identityFields({ idSuffix, indent: '        ' })}
        <p class="c-field">
          <label for="c-body${idSuffix}">内容</label>
          <textarea id="c-body${idSuffix}" name="body" rows="5" required maxlength="3000"></textarea>
        </p>
        <div class="c-actions">
          ${emojiPicker()}
          <button type="submit">发布评论</button>
        </div>
      </form>
    </section>`;
}

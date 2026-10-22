import { csrfField, esc, formatDateTime, relativeOrDay, commentAction } from '../util/text.js';
import { avatar, renderComment } from './render.js';
import { FLASH, emojiPicker } from './view.js';
import { authorName, honeypot, identityFields, INDENT_DEPTH } from './fields.js';

// 笔记流里那枚评论抽屉的内里。不复用内页的 commentSection()：内页那套为「读到底接着写」设计（通栏发丝线
// 起头、条目间横线、带标签卡片表单），抽屉则从笔记下方抽出、只占一屏一角、随时收回，故另起一套 `ncp-*`：
// 条目贴头像列排、不画横线（抽屉自有一圈边，再画线是两层框）；嵌套只缩进一层，靠头像列左侧细线把「这一串
// 是一段对话」串起来；撰写区不套卡片，改成两条发丝线夹出的写作带。唯一共享的是正文 markdown 排版（.c-body）
// 与署名/身份三栏（见 fields.js）。

// 缩进只给一层：第 2 层缩进，第 3 层起不再缩进、改在名字后用「@某人」标对象。抽屉比文章页窄，多缩一级就少一截可读宽度；@ 的对象取自 parent_id，精确而非猜。

function panelItem(c, { replyBase, depth = 1, replyTo = '' } = {}) {
  // 名字统一挂 .ncp-name：填了网址时名字是链接，要有自己的颜色，不能落回 --muted（那样填了网址反而比不填更弱）。
  const who = authorName(c, { className: 'ncp-name', authorClass: 'is-author' });

  const at = depth > INDENT_DEPTH && replyTo
    ? `<span class="ncp-at">@${esc(replyTo)}</span>`
    : '';
  const kids = c.replies ?? [];

  return `            <li class="ncp-c" id="c${c.id}">
              <span class="ncp-av">${avatar(c.author, 30, c.avatar_md5)}</span>
              <div class="ncp-c-main">
                <p class="ncp-line">${who}${at}<time datetime="${esc(c.created_at)}" title="${esc(formatDateTime(c.created_at))}">${esc(relativeOrDay(c.created_at))}</time><a class="ncp-reply" href="${esc(replyBase)}?reply=${c.id}#reply" data-reply="${c.id}" data-reply-author="${esc(c.author)}">回复</a></p>
                <div class="c-body">${renderComment(c.body_md)}</div>
${kids.length ? `                <ul class="ncp-kids${depth < INDENT_DEPTH ? ' is-nest' : ''}">
${kids.map((r) => panelItem(r, { replyBase, depth: depth + 1, replyTo: c.author })).join('\n')}
                </ul>
` : ''}              </div>
            </li>`;
}

export function notePanel({
  post, thread = [], flash = '', tsToken = '',
  replyBase = '', idSuffix = '', more = null, asAuthor = false, csrf = '', submissionId = '',
}) {
  const slug = esc(post.slug);
  const closed = post.comments_on === 0 || post.comments_on === false;

  const bar = `          <header class="ncp-bar">
            <p class="ncp-mark">回应</p>
            <button type="button" class="ncp-fold" data-close-comments>收起</button>
          </header>`;

  if (closed) {
    return `        <section class="ncp" id="comments${idSuffix}" data-comments-section data-slug="${slug}" aria-label="评论">
${bar}
          <p class="ncp-empty">这篇笔记的评论已关闭。</p>
        </section>`;
  }

  const notice = flash && FLASH[flash]
    ? `          <p class="ncp-flash ncp-flash-${esc(flash)}">${esc(FLASH[flash])}</p>\n` : '';

  // 一条评论都没有时这里什么都不放、直接进撰写区——删这句时内页那句一并删（同一句话只删一边等于没删）。抽屉头上已有「回应」标记行，不必再说"这里还没有人说话"。
  const body = thread.length
    ? `          <ul class="ncp-list">
${thread.map((c) => panelItem(c, { replyBase })).join('\n')}
          </ul>
`
    : '';

  // 撰写区：一行落款 + 不划线正文 + 收进纸里的发丝线 + 署名行。落款行默认空（不回复谁时整行由 CSS 收掉），故补一句 placeholder 接住（打字即消失、不进无障碍名）。
  return `        <section class="ncp" id="comments${idSuffix}" data-comments-section data-slug="${slug}" aria-label="评论">
${bar}
${notice}${body}          <form class="ncp-form${asAuthor ? ' is-author' : ''}" action="${commentAction(post)}" method="post" data-comment-form data-slug="${slug}">
            <p class="ncp-rt">
              <span class="ncp-rt-t" data-reply-title></span>
              <a class="ncp-cancel" href="${esc(`${replyBase}#comments`)}" data-cancel-reply data-no-pjax hidden>取消</a>
            </p>
            <input type="hidden" name="ts" value="${esc(tsToken)}">
            <input type="hidden" name="submission_id" value="${esc(submissionId)}">
            <input type="hidden" name="parent" value="" data-parent>
            ${asAuthor ? `<input type="hidden" name="as_author" value="1">${csrfField(csrf)}` : ''}
${honeypot('            ')}            <textarea class="ncp-body" id="c-body${idSuffix}" name="body" rows="3" required maxlength="3000"
                      aria-label="评论内容" placeholder="写一条评论"></textarea>
${asAuthor ? '' : identityFields({ blockClass: 'ncp-id', fieldClass: 'ncp-f', idSuffix, indent: '            ' })}
            <div class="ncp-actions">
              ${emojiPicker()}
              <p class="ncp-go"><button type="submit">发布评论</button></p>
            </div>
          </form>
${more ? `          <p class="ncp-more"><a href="${esc(more.href)}">还有 ${more.n} 个讨论串，去这篇笔记看 →</a></p>\n` : ''}        </section>`;
}

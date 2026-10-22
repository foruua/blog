import { SITE } from '../config.js';
import { formatDateTime, contentUrl } from '../util/text.js';
import { send, ownerEmail } from '../mail.js';
import { settings } from '../settings.js';
import { ownerCommentLetter, replyCommentLetter } from '../email/letters.js';
import { isMuted } from './subscribers.js';
import { signModeration } from './moderation.js';

// 评论相关邮件的唯一出口：notifyOwner（待审发「等你处理」；老读者免审/已直发发「已上线、可一键撤」）与
// notifyCommenter（作者回复了评论，提醒评论人）。前台审核链接（/moderate）与后台（/admin）共用。职责只有
// 「查数据 + 拼链接 + 投递」，信长什么样全在 src/email/letters.js；每封同时给 text 与 html（纯文本兜底、也是测试断言依据）。
export function createCommentNotifier({ repo, comments, crypt, mail = null }) {
  // 生产环境注入 mail-outbox；旧调用方（测试、单独挂载的模块）没有队列时退回立即投递，保持原语义。
  const queue = mail?.enqueue
    ? async (msg) => { mail.enqueue(msg); }
    : (msg) => send(msg).catch(() => {});

  // 评论分页后"去看这条评论"的链接必须带上所在页：锚点只在那页 HTML 里存在，落别页就是"跳过去什么也没有"。
  // 这条链接只配给已发布的评论：待审评论在公开页不渲染，`#c<id>` 指向不存在的锚点、点开只停在文章顶部。
  function commentUrl(post, postId, commentId) {
    const at = comments.threadPageOf({ postId, commentId, limit: settings.commentsPerPage(repo) });
    const page = at && at.page > 1 ? `?cpage=${at.page}` : '';
    // 地址口径只有 util/text.js 的 contentUrl() 一处。这里不要再手写 `kind === 'note' ? 'n' : 'p'`——漏掉固定页时
    // 《关于》这类页面的评论会被拼成 /p/about/，邮件里点开就是 404（固定页不在 /p/ 下）。
    const path = post ? contentUrl(post) : '/';
    return `${SITE.url}${path}${page}#c${commentId}`;
  }

  function notifyOwner(post, c, { live = false } = {}) {
    const to = ownerEmail();
    const row = comments.get(c.id);
    const ep = Number(repo.getSetting('admin_session_epoch') ?? 0);
    const link = (action) => `${SITE.url}/moderate/${signModeration(crypt, { id: c.id, nonce: row.moderation_nonce, epoch: ep, action })}`;
    const actions = [
      ...(live ? [] : [{ label: '批准发布', text: '批准', href: link('approve'), role: 'primary' }]),
      { label: '标为垃圾', text: '垃圾', href: link('spam'), role: 'ghost', tone: 'danger' },
      { label: '删除', text: '删除', href: link('delete'), role: 'ghost', tone: 'danger' },
      { label: '以作者身份回复', text: '回复', href: link('reply'), role: 'ghost' },
      ...(live ? [{ label: '查看这条评论', text: '查看', href: commentUrl(post, post.id, c.id), role: 'primary' }] : []),
    ];

    queue({
      to,
      ...ownerCommentLetter({
        postTitle: post.title,
        live,
        author: c.author,
        website: c.website,
        bodyMd: c.bodyMd,
        when: formatDateTime(row?.created_at),
        actions,
      }),
    }).catch(() => {});
  }

  const unsubLink = (hash, undo = false) =>
    `${SITE.url}/unsubscribe/${crypt.sign({ purpose: 'unsub', h: hash }, 365 * 24 * 3600)}${undo ? '?undo=1' : ''}`;

  function notifyCommenter(parentId, replyBody, postId, { author = '', byAuthor = true } = {}) {
    const parent = comments.parentEmail(parentId);
    const to = crypt.decrypt(parent?.email_enc);
    if (!to) return false;
    const hash = crypt.fingerprint(to);
    if (isMuted(repo, hash)) return false;   // 已退订：静默跳过，不打扰
    const post = comments.postOf(postId);
    const url = commentUrl(post, postId, parentId);
    const lead = byAuthor ? '收到了作者回复' : `有了新的回复（来自 ${author}）`;
    const unsub = unsubLink(hash);

    queue({
      to,
      ...replyCommentLetter({
        readerName: parent.author,
        postTitle: post?.title ?? '',
        lead,
        byAuthor,
        replier: author,
        bodyMd: replyBody,
        when: formatDateTime(new Date()),
        url,
        unsub,
      }),
      headers: {
        'List-Unsubscribe': `<${unsub}>`,
        'List-Unsubscribe-Post': 'List-Unsubscribe=One-Click',
      },
    }).catch(() => {});
    return true;
  }

  // 某评论「审核通过」时调用：若它是对别人的回复就通知被回复者。刻意放在通过之后而非提交时——否则任何人
  // 都能靠反复提交往别人邮箱灌信。
  function notifyApprovedReply(comment) {
    if (!comment || comment.is_author) return false;
    if (comment.status !== 'approved' || !comment.parent_id) return false;
    return notifyCommenter(comment.parent_id, comment.body_md, comment.post_id, {
      author: comment.author, byAuthor: false,
    });
  }

  return { notifyOwner, notifyCommenter, notifyApprovedReply };
}

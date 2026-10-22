import { SITE, ADMIN_PAGE_SIZE } from '../../config.js';
import { contentUrl } from '../../util/text.js';
import { commentsPage, commentPurgePage, commentReplyPage } from '../../admin/views/comments.js';
import { bodyOf, val, notice, notFoundPage, pageNumber } from './shared.js';
import { decryptEmail } from '../../auth.js';

/** 「评论」组：列表、以作者身份回复、软/彻底删除、状态流转。邮件通知走 notifier，刻意放在状态变更成功之后（失败不影响审核本身）。 */
export function registerCommentRoutes(app, { repo, comments, adminRepo, crypt, notifier = {} }, { ctx, withEmail }) {
  app.get('/admin/comments', (c) => {
    // 四档计数只聚合一次：counts 给页面，commentCounts 给角标。
    const counts = adminRepo.commentCounts();
    // 待审是处理队列、最近评论是流水，各自分页（?pending / ?recent），混一起只会打架；页数由计数算并把越界页码夹回最后一页（删掉最后一页唯一一条评论后页码会空）。
    const ps = ADMIN_PAGE_SIZE;
    const pendingPages = Math.max(1, Math.ceil((counts.pending ?? 0) / ps));
    // 最近评论列全部状态流水，总数是四档之和。
    const recentPages = Math.max(1, Math.ceil(Object.values(counts).reduce((n, v) => n + (v ?? 0), 0) / ps));
    const pendingPage = Math.min(pageNumber(c, 'pending'), pendingPages);
    const recentPage = Math.min(pageNumber(c, 'recent'), recentPages);
    return c.html(commentsPage(ctx(c, {
      pending: withEmail(adminRepo.pendingComments({ offset: (pendingPage - 1) * ps })),
      recent: withEmail(adminRepo.recentComments({ offset: (recentPage - 1) * ps })),
      pendingPage, pendingPages, recentPage, recentPages,
      counts, commentCounts: counts,
      notice: c.req.query('w') ?? '',
    })));
  });

  // —— 以作者身份回复 ——
  app.get('/admin/comments/:id/reply', (c) => {
    const raw = adminRepo.commentFull(c.req.param('id'));
    if (!raw) return notFoundPage(c, ctx, '这条评论已经不在了。', '评论不存在');
    return c.html(commentReplyPage(ctx(c, {
      comment: { ...raw, email: decryptEmail(crypt, raw.email_enc) },
      notice: c.req.query('w') ?? '',
    })));
  });

  app.post('/admin/comments/:id/reply', async (c) => {
    const id = Number(c.req.param('id'));
    const comment = adminRepo.commentFull(id);
    if (!comment) return notice(c, '/admin/comments', '✗ 这条评论已经不在了');
    const b = await bodyOf(c);
    const body = String(val(b, 'body') ?? '').trim().slice(0, 3000);
    if (!body) {
      return notice(c, `/admin/comments/${id}/reply`, '✗ 回复内容不能为空');
    }
    // 重新读取必须在事务里：评论可能在“打开回复页”和“提交”之间被删掉，直接 add 会撞外键。
    const replyId = repo.transaction(() => {
      const current = comments.get(comment.id);
      if (!current) return null;
      return comments.add({
        postId: current.post_id, parentId: current.id,
        author: SITE.author || '博主',
        emailHash: null, emailEnc: null, website: null,
        bodyMd: body, status: 'approved', ipHash: null, isAuthor: true,
      });
    });
    if (replyId === null) return notice(c, '/admin/comments', '✗ 这条评论已经不在了');
    try { notifier.notifyCommenter?.(comment.id, body, comment.post_id); } catch { /* 邮件失败不影响回复本身 */ }
    return notice(c, '/admin/comments', `✓ 已发布回复 #${replyId}`);
  });

  app.get('/admin/comments/:id/purge', (c) => {
    const item = adminRepo.commentFull(c.req.param('id'));
    if (!item) return notFoundPage(c, ctx, '这条评论已经不在了。');
    return c.html(commentPurgePage(ctx(c, {
      item,
      replies: adminRepo.repliesOf(item.id),
      postUrl: `${contentUrl({ kind: item.post_kind, slug: item.post_slug })}#comments`,
    })));
  });

  app.post('/admin/comments/:id/purge', (c) => {
    const item = adminRepo.commentFull(c.req.param('id'));
    if (!item) return notice(c, '/admin/comments', '✗ 这条评论已经不在了');
    const replies = adminRepo.repliesOf(item.id);
    adminRepo.purgeComment(item.id);
    const note = `✓ 已彻底删除：${item.author}${replies ? `（连同 ${replies} 条回复）` : ''}`;
    return notice(c, '/admin/comments', note);
  });

  app.post('/admin/comments/:id', async (c) => {
    const b = await bodyOf(c);
    const status = val(b, 'status');
    if (!['approved', 'spam', 'deleted', 'pending'].includes(status)) return c.redirect('/admin/comments', 303);
    const id = Number(c.req.param('id'));
    const was = adminRepo.commentFull(id)?.status;
    comments.setStatus(id, status);
    // 首次通过才通知被回复人（改来改去不重复发信）
    if (status === 'approved' && was && was !== 'approved') {
      try { notifier.notifyApprovedReply?.(adminRepo.commentFull(id)); } catch { /* 邮件失败不影响审核 */ }
    }
    return c.redirect('/admin/comments', 303);
  });
}

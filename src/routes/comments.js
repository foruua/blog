import { boundedBody, publicWriteRateLimit, clientKey, readBodyObject, sameOriginRequest } from '../util/http.js';
import { Hono } from 'hono';
import { SITE } from '../config.js';
import { esc, formatDateTime, contentUrl } from '../util/text.js';
import { safeHttpUrl, normalizeUserUrl } from '../util/url.js';
import { layout, emptyPage } from '../render/layout.js';
import { createAntispam, screenSubmission } from '../comments/antispam.js';
import { createReaderProbeLimiter, ipBucket } from '../comments/reader-limit.js';
import { renderComment } from '../comments/render.js';
import { createCommentNotifier } from '../comments/notify.js';
import { setMuted } from '../comments/subscribers.js';
import { signModeration } from '../comments/moderation.js';
import { commentsOpen, commentsModerateAll, commentsRateLimit } from '../settings.js';
import { externalWrite } from '../util/external-writes.js';
// 邮箱形状校验：除了控制字符，还要挡掉 URI 分隔符（?, &, =, #, / 等）——后台会把地址放进 mailto: 链接。
import { EMAIL_RE, hasControlChar } from '../util/validation.js';

// 评论提交只接受本站页面发起的请求；同源校验见 util/http.js 的 sameOriginRequest()。

// 外链 ≥3 就不再让「老读者免审」（退回人工审核）。数链接要同时看渲染后 HTML 与原始 markdown 并去重：只看原文，实体编码能骗过；只看 HTML，linkify 关着裸 URL 数出 0。
const LINK_LIMIT = 3;
const LINK_HREF_RE = /<a\b[^>]*\shref="(https?:\/\/[^"]+)"/gi;
const BARE_URL_RE = /https?:\/\/[^\s<>"'()[\]]+/gi;
const countLinks = (html, src) => {
  const uniq = new Set();
  for (const m of String(html ?? '').matchAll(LINK_HREF_RE)) uniq.add(m[1].toLowerCase());
  for (const m of String(src ?? '').matchAll(BARE_URL_RE)) uniq.add(m[0].toLowerCase());
  return uniq.size;
};

export function commentRoutes({ repo, comments, crypt, auth = null, notifier = createCommentNotifier({ repo, comments, crypt }), rateLimited = true }) {
  const app = new Hono({ strict: false });
  // 阈值走设置读取函数：后台把「每 10 分钟几条」改完之后立刻生效，不用重启进程。
  const antispam = createAntispam({ maxPerWindow: () => commentsRateLimit(repo) });
  // 邮箱查询按「单邮箱 / 单 IP 不同邮箱 / 全站新邮箱」三层限额，见 comments/reader-limit.js。
  const readerProbe = createReaderProbeLimiter();
  // 「回头客自动填充」只凭邮箱查最近一条已通过评论的昵称/网址——这些本就是评论区公开的信息，
  // 不再要求浏览器持有绑定同一邮箱的读者凭证。同源校验只挡浏览器跨站（curl 不带 Origin 照样进），
  // 批量探测靠下面 readerProbe 的三层限额：单靠按 IP 限流挡不住换 IP 的代理池。
  // Hono 的 app.route() 会把子应用 use('*') 中间件提升成父应用全局（任意路径 POST 都会跑到它），故必须逐个端点声明，否则评论限流会顺带限住后台保存等 POST。
  // 独立挂载（测试、单模块）时自己带一层限流；server.js 已有一层覆盖同样路径的全局限流，那时传 rateLimited: false，
  // 否则同一条请求会过两个独立计数桶，实际阈值取决于较严的那个，既难解释也多一次判断。
  if (rateLimited) {
    const writeLimit = publicWriteRateLimit();
    for (const path of ['/api/comments/reader', '/api/comments', '/p/:slug/comment', '/n/:slug/comment', '/:slug/comment', '/moderate/:token', '/unsubscribe/:token']) {
      app.use(path, writeLimit);
    }
  }

  app.use('*', boundedBody());

  const { notifyOwner, notifyCommenter, notifyApprovedReply } = notifier;

  const readPayload = (c) => readBodyObject(c);

  // 各审核/退订页共用的极简错误页：措辞/标题不同，但结构一致。
  const failPage = (c, title, message, status) => c.html(layout({
    title, noindex: true, main: `<article class="post"><h1>${esc(message)}</h1></article>`,
  }), status);


  externalWrite(app, '/api/comments/reader', async (c) => {
    c.header('Cache-Control', 'no-store');
    if (!sameOriginRequest(c)) return c.json({ profile: null }, 403);
    const payload = await readPayload(c);
    const email = String(payload.email ?? '').trim().toLowerCase();
    if (email.length > 120 || hasControlChar(email) || !EMAIL_RE.test(email)) {
      return c.json({ profile: null }, 400);
    }
    const hash = crypt.fingerprint(email);
    if (!hash) return c.json({ profile: null });
    const ip = clientKey(c);
    const verdict = readerProbe.check(hash, ipBucket(ip));
    if (verdict.limited) {
      // 429 只看「这个键这个窗口查了几次」，与邮箱是否存在无关，所以它本身不构成新的判据。
      c.header('Retry-After', String(verdict.retryAfter));
      console.log(`[comment] 邮箱查询限流 (${verdict.reason}) ip=${crypt.ipHash(ip)?.slice(0, 8) ?? '?'}`);
      return c.json({ profile: null }, 429);
    }
    return c.json({ profile: comments.readerProfile(hash) });
  });

  async function submit(c, slug, payload) {
    if (!sameOriginRequest(c)) return { code: 403, result: 'forbidden' };

    const post = repo.getAnyLive
      ? repo.getAnyLive(slug)
      : (repo.getPost(slug, 'post') ?? repo.getPost(slug, 'note') ?? repo.getPost(slug, 'page'));
    if (!post || post.draft) return { code: 404, result: 'notfound' };
    // 两种关闭：全站暂停（后台开关）与单篇关闭（作者在编辑器里决定）。分开回不同的 flash，
    // 否则读者在一篇本来开着的文章下会看到「本文已关闭评论」，以为是自己那篇出了问题。
    if (!commentsOpen(repo)) return { code: 403, result: 'pause' };
    if (!post.comments_on) return { code: 403, result: 'off' };

    const ipHash = crypt.ipHash(clientKey(c));

    // 令牌必须带 purpose：签名器通用，审核/退订 token 若无命名空间就可能被交叉复用（这里强校验，防止拿别的 token 充当反机器人时间戳）。
    const rawToken = crypt.verify(payload.ts);
    const elapsedToken = rawToken?.purpose === 'comment-ts' ? rawToken : null;
    const reason = elapsedToken?.p !== post.id ? 'wrong-post' : screenSubmission({ honeypot: payload.hp_fax, elapsedToken });
    if (reason) {
      console.log(`[comment] 静默丢弃 (${reason}) post=${post.slug} ip=${ipHash?.slice(0, 8)}`);
      return { code: 200, result: 'discarded' };
    }

    // 字段校验放在限流之前：格式没写对属「还没写完」，不该扣配额（也让缺邮箱稳定判 400 而非 429）；昵称 NFC 归一、控制字符换空格。
    const wantsAuthor = String(payload.as_author ?? '') === '1';
    // 作者身份不能只靠 cookie：同站子域也能带上 Lax cookie。要求后台 CSRF 令牌，
    // 未登录时仍按普通读者路径处理（与旧行为一致，as_author 被忽略）。
    if (wantsAuthor && auth?.session(c) && !auth.csrfOk(c, payload._csrf ?? c.req.header('x-csrf-token'))) {
      return { code: 403, result: 'forbidden' };
    }
    const asAuthor = wantsAuthor && Boolean(auth?.session(c));
    const author = asAuthor
      ? SITE.author || '博主'
      : String(payload.author ?? '').normalize('NFC').replace(/\p{Cc}/gu, ' ').trim().slice(0, 40);
    const bodyMd = String(payload.body ?? '').trim().slice(0, 3000);
    if (!author || !bodyMd) return { code: 400, result: 'bad' };
    let emailForInsert = null;   // 校验时顺手留下，下面插入复用，不再重新取一遍
    if (!asAuthor) {
      const email = String(payload.email ?? '').trim().slice(0, 120);
      if (hasControlChar(email) || !EMAIL_RE.test(email)) return { code: 400, result: 'bad-email' };
      emailForInsert = email;
    }
    // 同一次页面提交（双击/重试）用同一个 submission_id：重复到达直接返回已有结果。
    const rawSubmission = String(payload.submission_id ?? '').trim();
    const submissionId = /^[A-Za-z0-9_-]{8,64}$/.test(rawSubmission) ? rawSubmission : null;
    if (submissionId) {
      const existing = comments.bySubmission(post.id, submissionId);
      if (existing) return { code: 200, result: existing.status === 'approved' ? 'ok' : 'pending', id: existing.id, post };
    }


    if (!asAuthor && antispam.rateLimited(ipHash)) {
      console.log(`[comment] 限流拦截 post=${post.slug} ip=${ipHash?.slice(0, 8)}`);
      return { code: 429, result: 'limited' };
    }

    let parentId = null;
    const rawParent = Number(payload.parent);
    if (Number.isInteger(rawParent) && rawParent > 0) {
      const parent = comments.get(rawParent);

      if (parent && parent.post_id === post.id && parent.status === 'approved') {
        parentId = parent.id;
      }
    }


    if (asAuthor) {
      const id = comments.add({
        postId: post.id, parentId, author,
        emailHash: null, emailEnc: null, website: null,
        bodyMd, status: 'approved', isAuthor: true, submissionId,
      });
      if (parentId) notifyCommenter(parentId, bodyMd, post.id);
      return { code: 200, result: 'ok', id, post };
    }

    const email = emailForInsert;
    const website = normalizeUserUrl(payload.website);

    const emailHash = crypt.fingerprint(email);

    const trusted = comments.isKnown(author, emailHash) && !comments.hasSpam(emailHash)
      && countLinks(renderComment(bodyMd), bodyMd) < LINK_LIMIT;
    // 「全部先审」开着时连回头客也过一遍——防的是有人用长期账号攒信誉后一次性投放。
    const status = trusted && !commentsModerateAll(repo) ? 'approved' : 'pending';

    const id = comments.add({
      postId: post.id, parentId, author,
      emailHash, emailEnc: crypt.encrypt(email),
      website, bodyMd, status, isAuthor: false, submissionId,
    });

    if (status === 'pending') {
      notifyOwner(post, { id, author, bodyMd, website });
    } else {
      notifyOwner(post, { id, author, bodyMd, website }, { live: true });
      notifyApprovedReply(comments.get(id));
    }
    return { code: 200, result: status === 'pending' ? 'pending' : 'ok', id, post };
  }

  /** 一键退订：签名 token、无需登录，退订只记指纹、不删邮箱。刻意拆成「GET 只展示确认页 / POST 才生效」——邮件客户端与企业网关会预取链接，GET 直接生效用户还没点就被退订；POST 还要兼容 Gmail/Yahoo One-Click（只期望 2xx）。 */
  function readUnsub(c) {
    const payload = crypt.verify(c.req.param('token'));
    if (!payload || payload.purpose !== 'unsub' || !payload.h) {
      return {
        fail: c.html(layout({
          title: '链接无效', noindex: true,
          main: '<article class="post"><h1>链接无效或已过期</h1><p>这封邮件里的退订链接不能用了。</p></article>',
        }), 400),
      };
    }
    return { payload };
  }

  app.get('/unsubscribe/:token', (c) => {
    const r = readUnsub(c);
    if (r.fail) return r.fail;
    const undo = c.req.query('undo') === '1';
    const main = `    <article class="post">
      <h1>${undo ? '恢复回复提醒' : '退订回复提醒'}</h1>
      <p>${esc(undo
        ? '之后有人回复你的评论，还会给你发提醒邮件。'
        : '退订后不再发「有人回复了你的评论」这类提醒。你的邮箱不会从评论区删除（只有站主能看到），随时可以改回来。')}</p>
      <form method="post" action="/unsubscribe/${esc(c.req.param('token'))}${undo ? '?undo=1' : ''}">
        <p class="c-actions">
          <button type="submit">${undo ? '恢复提醒' : '确认退订'}</button>
          <a class="mod-link" href="/">算了</a>
        </p>
      </form>
    </article>`;
    return c.html(layout({ title: undo ? '恢复回复提醒' : '退订回复提醒', noindex: true, main }));
  });

  app.post('/unsubscribe/:token', async (c) => {
    // One-Click 邮件客户端通常没有 Origin，sameOriginRequest 会放行；浏览器跨站表单会被拒绝。
    if (!sameOriginRequest(c)) return c.text('请求来源无效', 403);
    const r = readUnsub(c);
    if (r.fail) return r.fail;
    const form = await c.req.formData().catch(() => null);
    const oneClick = form?.get('List-Unsubscribe') === 'One-Click';
    const undo = String(form?.get('undo') ?? '') === '1' || c.req.query('undo') === '1';
    await setMuted(repo, r.payload.h, !undo);

    if (oneClick) return c.body(null, 200);
    const token = esc(c.req.param('token'));
    const main = undo
      ? emptyPage('已恢复提醒',
        `${esc('之后有人回复你的评论，还会给你发提醒邮件。')} <a href="/">回首页</a>`)
      : emptyPage('已退订提醒',
        `${esc('不会再给你发「有人回复了你的评论」这类提醒了。你的邮箱没有从评论区删除（只有站主能看到），随时可以恢复：')} <a href="/unsubscribe/${token}?undo=1">恢复提醒</a>`);
    return c.html(layout({ title: undo ? '已恢复提醒' : '已退订提醒', noindex: true, main }));
  });

  app.post('/api/comments', async (c) => {
    const payload = await readPayload(c);
    const slug = String(payload.slug ?? '').trim();
    if (!slug) return c.json({ ok: false, error: 'missing-slug' }, 400);
    const r = await submit(c, slug, payload);
    if (r.result === 'discarded') return c.json({ ok: true, status: 'discarded' });

    const count = r.post ? comments.countOfPost(r.post.id) : undefined;
    const error = { bad: '请填写昵称和评论内容。', 'bad-email': '请填写有效的邮箱地址。' }[r.result];
    return c.json({ ok: r.code === 200, status: r.result, count, error }, r.code === 200 ? 200 : r.code);
  });

  // 无 JS 兜底：表单 POST 后 303 回内容锚点，结果放在 ?c= 里。
  const formComment = (prefix) => async (c) => {
    // 路径参数已由 Hono 解码，不要再 decodeURIComponent（坏转义会抛 URIError → 500）。
    const slug = c.req.param('slug');
    const r = await submit(c, slug, await readPayload(c));
    const flash = r.result === 'discarded' ? '' : r.result;
    // 回跳地址用内容自己的 URL（contentUrl）：笔记有 /n/<slug>/ 与固定页那种无前缀路由，
    // 按「URL 前缀 + slug」硬拼会对笔记 POST 拼出 404 页。拿不到 post 时才退回前缀拼法。
    const back = r.post
      ? contentUrl(r.post)
      : (prefix ? `/${prefix}/${encodeURIComponent(slug)}/` : `/${encodeURIComponent(slug)}`);
    return c.redirect(`${back}${flash ? `?c=${encodeURIComponent(flash)}` : ''}#comments`, 303);
  };
  app.post('/p/:slug/comment', formComment('p'));
  app.post('/n/:slug/comment', formComment('n'));

  app.post('/:slug/comment', formComment(''));


  function resolveModeration(c) {
    const payload = crypt.verify(c.req.param('token'));
    if (!payload || payload.purpose !== 'moderation' || payload.ep !== Number(repo.getSetting('admin_session_epoch') ?? 0)) {
      return { fail: failPage(c, '链接无效', '链接无效或已过期', 400) };
    }
    const comment = comments.get(payload.c);
    if (!comment) {
      return { fail: failPage(c, '评论不存在', '评论不存在', 404) };
    }
    if (payload.nonce !== comment.moderation_nonce) return { fail: c.text('审核链接已失效', 400) };
    return { payload, comment };
  }

  /** 审核页：payload.a 是邮件里被点的动作，排第一并标出，但仍要页面上再点一次才算数——邮件客户端会预取链接，直接生效可能误删评论。 */
  function moderatePage({ a: wanted }, comment, notice = '') {
    const post = comments.postOf(comment.post_id);
    const postHref = post ? `${contentUrl(post)}#comments` : '#';
    const rows = {
      pending: [['approve', '批准并显示'], ['spam', '标记为垃圾'], ['delete', '删除']],
      approved: [['spam', '标记为垃圾'], ['delete', '删除']],
      spam: [['approve', '误判，改为批准'], ['delete', '删除']],
      deleted: [['approve', '恢复并显示']],
    }[comment.status] ?? [];


    const suggested = rows.some(([action]) => action === wanted) ? wanted : '';
    const site = safeHttpUrl(comment.website);
    const ordered = suggested
      ? [...rows.filter(([action]) => action === suggested), ...rows.filter(([action]) => action !== suggested)]
      : rows;
    const suggestedLabel = rows.find(([action]) => action === suggested)?.[1] ?? '';

    const buttons = ordered.map(([action, label]) =>
      `<button type="submit" name="action" value="${action}">${esc(label)}${action === suggested ? '（邮件里点的）' : ''}</button>`).join('\n          ');

    const replyForm = comment.status === 'approved'
      ? `<h3>以作者身份回复</h3>
        <p class="c-field"><textarea name="body" rows="5"></textarea></p>
        <p class="c-actions"><button type="submit" name="action" value="reply">发布回复</button></p>`
      : '';

    const hint = suggested
      ? `<p class="meta">你在邮件里点的是「${esc(suggestedLabel)}」—— 确认请按第一个按钮；点错了就从其余里选。</p>`
      : '';

    return `
    <article class="post">
      <h1>站务 · 评论审核</h1>
      <p class="meta">${esc(comment.author)} · ${esc(formatDateTime(comment.created_at))} · 当前状态：${esc(comment.status)}</p>
      ${notice ? `<p class="c-flash c-flash-ok">${esc(notice)}</p>` : ''}
      ${hint}
      <div class="prose" style="margin-top:32px">
        <p>原文（Markdown 源）：</p>
        <pre class="mod-source"><code>${esc(comment.body_md)}</code></pre>
        <p>渲染效果：</p>
        <div class="c-body c-preview">${renderComment(comment.body_md)}</div>
        ${site ? `<p>网址：<a href="${esc(site)}" rel="nofollow noopener">${esc(site)}</a></p>` : ''}
      </div>
      <form method="post" class="mod-form">
        <p class="c-actions">
          ${buttons}
          <a class="mod-link" href="${esc(postHref)}">去看看文章</a>
        </p>
        ${replyForm}
      </form>
    </article>`;
  }

  app.get('/moderate/:token', (c) => {
    const r = resolveModeration(c);
    if (r.fail) return r.fail;

    return c.html(layout({ title: '评论审核', noindex: true, canonical: '/moderate', main: moderatePage(r.payload, r.comment, c.req.query('w') ?? '') }));
  });

  app.post('/moderate/:token', async (c) => {
    const r = resolveModeration(c);
    if (r.fail) return r.fail;
    const { payload, comment } = r;
    if (!sameOriginRequest(c)) return c.text('请求来源无效', 403);
    const form = await c.req.formData().catch(() => null);
    const action = String(form?.get('action') ?? '');
    const body = String(form?.get('body') ?? '').trim();

    // 动作执行后 moderation_nonce 被换掉（链接一次性），故续签一张再 303，站主接着点「删除」不失效；也顺带解决刷新重复提交。
    const back = (row, msg) => c.redirect(`/moderate/${encodeURIComponent(signModeration(crypt, {
      id: row.id, nonce: row.moderation_nonce,
      epoch: Number(repo.getSetting('admin_session_epoch') ?? 0), action: '',
    }))}?w=${encodeURIComponent(msg)}`, 303);

    if (action === 'reply') {
      if (!body) {
        return c.html(layout({ title: '评论审核', noindex: true, main: moderatePage(payload, comment, '') }), 400);
      }
      const replyId = repo.transaction(() => {
        // 校验与消费令牌、写入回复必须原子完成，不能重放旧链接。
        const current = comments.get(comment.id);
        if (!current || current.moderation_nonce !== comment.moderation_nonce || current.status !== 'approved') return null;
        const id = comments.add({
          postId: current.post_id, parentId: current.id, author: SITE.author || '博主',
          emailHash: null, emailEnc: null, website: null,
          bodyMd: body.slice(0, 3000), status: 'approved', isAuthor: true,
        });
        comments.setStatus(current.id, current.status);
        return id;
      });
      if (replyId === null) return c.text('审核链接已失效或评论不可回复', 409);
      notifyCommenter(comment.id, body, comment.post_id);
      return back(comments.get(comment.id), `已发布回复 #${replyId}`);
    }

    const map = { approve: 'approved', spam: 'spam', delete: 'deleted' };
    // action 来自表单：直接 map[action] 会顺着原型链取到 constructor/__proto__ 这类真值，随后被当状态写进 SQL。
    if (!Object.hasOwn(map, action)) {
      return c.html(layout({ title: '评论审核', noindex: true, main: moderatePage(payload, comment, '') }), 400);
    }
    const next = map[action];

    // 校验 nonce 与状态写入必须在同一事务里重做一次：否则同一封审核邮件被双击/两个标签页并发提交时，
    // 两个请求都能通过前面的检查，最后「删除」与「批准」互相覆盖。
    const changed = repo.transaction(() => {
      const current = comments.get(comment.id);
      if (!current || current.moderation_nonce !== comment.moderation_nonce) return null;
      comments.setStatus(comment.id, next);
      return { updated: comments.get(comment.id), was: current.status };
    });
    if (!changed) return c.text('审核链接已失效', 409);

    if (next === 'approved' && changed.was !== 'approved') notifyApprovedReply(changed.updated);
    return back(changed.updated, `已更新为「${next}」`);
  });


  return app;
}

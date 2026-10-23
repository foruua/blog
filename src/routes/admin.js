import { logError } from '../util/errors.js';
import { ADMIN_PAGE_SIZE, CONTENT_DIR } from '../config.js';
import fs from 'node:fs';
import path from 'node:path';
import { Hono } from 'hono';
import { esc, csrfField, slugify, validateSlug, wordCount, fromLocalInput, toIsoOffset, nowIso } from '../util/text.js';
import { adminLayout, loginPage } from '../admin/layout.js';
import { listPage, editorPage, revisionPage } from '../admin/views/content.js';
import { morePage } from '../admin/views/more.js';
import { planFilePath, readPostFront } from '../content/write.js';
import { commitPost, deleteWithFile } from '../content/commit.js';
import { boundedBody, publicWriteRateLimit, clientIp, sameOriginRequest } from '../util/http.js';
import { externalWrite, bodyOf, val, formBody, checked, pageNumber, pagination, makeShared, notice, notFoundPage } from './admin/shared.js';
import { registerSettingsRoutes } from './admin/settings.js';
import { registerMediaRoutes } from './admin/media.js';
import { registerCommentRoutes } from './admin/comments.js';
import { registerFeedRoutes } from './admin/feeds.js';
import { registerLinkRoutes } from './admin/links.js';
import { registerThemeRoutes } from './admin/themes.js';
import { safeInternalPath } from '../util/safe-path.js';

// 登录回跳地址：只认站内 /admin 开头且无控制字符——带 CR/LF 会拼出非法 Location 头（Hono 直接抛，登录变 500），
// 也是响应头注入面。规则与主题切换回跳共用 util/safe-path.js，避免两处各自漂移。
const adminRedirect = (to) => safeInternalPath(to, { prefix: '/admin', fallback: '/admin' });

/** 后台路由组装点：鉴权与登录、文章编辑（保存/自动保存/预览/修订/回滚）与各分组路由挂载。 */
export function adminRoutes({ repo, comments, adminRepo, crypt, auth, renderer, scheduleBackup = () => {}, notifier = {}, feeds = null, refresher = null, feedOptions = {}, links = null, linkChecker = null, themes = null, themeEngine = null, outbox = null, mutate = (fn) => fn(), rateLimited = true }) {
  const app = new Hono({ strict: false });
  // 登录限流：独立挂载（测试）时自己带一层；server.js 已有覆盖 /admin/login 的全局限流，那时传 rateLimited: false，
  // 否则一次登录要过两个独立计数桶，实际阈值取决于较严的那个。
  if (rateLimited) app.use('/admin/login', publicWriteRateLimit({ max: 30 }));
  // 子应用要能独立挂载（测试单独挂它），故保留自己一份；server.js 全局那份会先跑并置位 bodyBounded，这层随即短路，不重复读流。
  app.use('*', boundedBody());

  const guard = auth.requireOwner();
  // 只建一份 shared，评论组别再单独 makeShared。
  const shared = makeShared({ auth, adminRepo, crypt });
  const { ctx } = shared;

  app.use('/admin/*', async (c, next) => {
    const requestPath = c.req.path.replace(/\/+$/, '');
    if (requestPath === '/admin/login') return next();
    return guard(c, next);
  });

  registerSettingsRoutes(app, { repo, crypt, adminRepo, mutate, outbox }, { ctx });

  app.get('/admin/login', (c) => c.html(loginPage({
    configured: auth.configured(),
    to: c.req.query('to') ?? '/admin',
    notice: c.req.query('e') === 'limited' ? '尝试过于频繁，请 15 分钟后再试。'
      : c.req.query('e') === 'bad' ? '密码不正确。' : '',
  })));

  // 登录只读库 + 写 cookie，不写数据库；登记成 external write，避免 scrypt（N=32768，约 32MB/次）
  // 占住全局写队列把评论/保存/上传一起堵死。限流由 server.js 在读取请求体之前做一次，这里再留一份给独立挂载的测试。
  externalWrite(app, '/admin/login', async (c) => {
    // 登录 CSRF：攻击者无法替访客提交密码，但同源校验能挡住跨站表单把访客登进攻击者账号。
    // 无 Origin 的脚本/旧客户端仍放行，由密码与限流兜底。
    if (!sameOriginRequest(c)) return c.text('请求来源无效', 403);
    const form = await c.req.formData().catch(() => new FormData());
    const pw = String(form.get('password') ?? '');
    const to = String(form.get('to') ?? '/admin');
    const r = await auth.attemptLogin(c, pw, crypt.ipHash(clientIp(c)));
    if (r.ok) return c.redirect(adminRedirect(to), 303);
    return c.redirect(r.reason === 'rate-limited' ? '/admin/login?e=limited' : '/admin/login?e=bad', 303);
  });

  app.post('/admin/logout', (c) => { auth.logout(c); return c.redirect('/admin/login', 303); });

  async function savePost(c, { autosave = false } = {}) {
    const b = await bodyOf(c);
    const id = Number(val(b, 'id', '0')) || 0;
    const action = val(b, 'action', autosave ? 'autosave' : 'save');
    const existing = id ? adminRepo.get(id) : null;
    if (id && !existing) return { ok: false, error: '文章不存在', code: 404 };
    const version = val(b, 'version');
    if (existing && (!/^\d+$/.test(version) || Number(version) !== existing.version)) {
      return { ok: false, error: '文章已更新，请比较最新版本后再保存。你的输入已保留。', code: 409 };
    }

    const title = val(b, 'title').trim() || (autosave ? '(未命名草稿)' : '');
    if (!title) return { ok: false, error: '标题不能为空' };
    // 摘要只用于 description / 分享卡片；留空即回退正文首段，不写进 frontmatter。
    const description = val(b, 'description').trim().slice(0, 300);

    let slug = val(b, 'slug').trim();
    if (!slug) slug = slugify(title);
    else slug = slugify(slug);

    const kindRaw = val(b, 'kind', existing?.kind ?? 'post');
    const kind = ['post', 'note', 'page'].includes(kindRaw) ? kindRaw : 'post';
    const slugError = validateSlug(slug, kind);
    if (slugError) return { ok: false, error: slugError };

    // 撞 slug 只认内容仓库这一份：adminRepo 从来没有 getBySlug，以前的 `?.` 是个永远不会执行的兜底。
    const clash = repo.bySlug?.(slug);
    if (clash && clash.id !== (existing?.id ?? -1)) {
      return { ok: false, error: `slug「${slug}」已被《${clash.title}》占用，换一个` };
    }

    const bodyMd = formBody(b);
    const commentsOn = checked(b, 'comments');

    let publishedAt;
    try { publishedAt = fromLocalInput(val(b, 'date').trim()); }
    catch { return { ok: false, error: '发布时间格式无效' }; }
    let isDraft = checked(b, 'draft');
    if (action === 'publish') {
      publishedAt ??= nowIso();
      isDraft = false;
    }
    if (!publishedAt) isDraft = true;

    const { html, toc } = renderer.render(bodyMd);

    const filePath = planFilePath({ kind, slug, existingPath: existing?.file_path ?? null, existingKind: existing?.kind ?? kind });
    let previousFront = {}; let warning = '';
    try { previousFront = readPostFront(existing?.file_path); }
    catch { warning = '原文件元数据损坏，已保留原文件副本并重新生成'; }
    const front = {
      ...previousFront,
      title,
      slug,
      description: description || undefined,
      lang: existing?.lang ?? 'zh',
      date: publishedAt ? toIsoOffset(publishedAt) : undefined,
      draft: isDraft ? true : undefined,
      comments: commentsOn ? undefined : false,
    };

    let result;
    try {
      if (warning && existing?.file_path && fs.existsSync(existing.file_path)) {
        const recovery = path.join(CONTENT_DIR, '.trash', `front-${Date.now()}-${path.basename(existing.file_path)}`);
        fs.mkdirSync(path.dirname(recovery), { recursive: true }); fs.copyFileSync(existing.file_path, recovery);
      }
      result = commitPost({ repo, existing, filePath, front, body: bodyMd, commit: (w) => {
        const res = repo.upsertFromFile({
          id: existing?.id, slug, kind, title, description, bodyMd, bodyHtml: html, toc,
          lang: existing?.lang ?? 'zh', commentsOn, draft: isDraft, publishedAt,
          wordCount: wordCount(bodyMd), filePath: w.filePath, fileHash: w.hash, source: 'file',
        }, { force: true, expectedVersion: existing ? Number(version) : null });
        const last = adminRepo.lastRevision(res.id);
        const stale = !last || Date.now() - Date.parse(`${last.created_at.replace(' ', 'T')}Z`) > 120000;
        if (!autosave || (stale && (!last || last.body_md !== bodyMd || last.title !== title))) {
          adminRepo.addRevision(res.id, title, bodyMd, autosave ? 'autosave' : action === 'publish' ? 'publish' : 'manual');
        }
        return res;
      } });
    } catch (error) {
    // 界面不回显 error.message（fs/sqlite 异常带绝对路径与库内部细节），细节只进日志；409 冲突走上面的早退分支，不受影响。
      logError(error, c, 'admin.save-failed');
      return { ok: false, error: '保存失败，输入已保留，请重试。', code: error.status ?? 500 };
    }
    if (action === 'publish' && process.env.BACKUP_ON_PUBLISH !== 'false') scheduleBackup();
    return { ok: true, id: result.id, version: result.version, warning, action: result.action };
  }

  app.post('/admin/save', async (c) => {
    const r = await savePost(c);
    if (!r.ok) {
      const b = await bodyOf(c);
      const existing = adminRepo.get(Number(val(b, 'id')));
      // Keep the submitted version, so a second submit cannot silently overwrite a conflict.
      return c.html(editorPage({
        post: { ...existing, id: val(b, 'id'), version: val(b, 'version'), title: val(b, 'title'), slug: val(b, 'slug'),
          kind: val(b, 'kind'), body_md: formBody(b), published_at: null, dateInput: val(b, 'date'),
          draft: checked(b, 'draft') ? 1 : 0, comments_on: checked(b, 'comments') ? 1 : 0 },
        conflict: r.code === 409, isNew: !existing, ...ctx(c), notice: r.error,
      }), r.code ?? 400);
    }

    const msg = r.warning ? `?w=${encodeURIComponent(r.warning)}` : '';
    return c.redirect(`/admin/edit/${r.id}${msg}`, 303);
  });

  app.post('/admin/api/autosave', async (c) => {
    const r = await savePost(c, { autosave: true });
    if (!r.ok) return c.json({ ok: false, error: r.error }, r.code ?? 400);
    return c.json({ ok: true, id: r.id, version: r.version, savedAt: new Date().toISOString(), warning: r.warning });
  });

  externalWrite(app, '/admin/api/preview', async (c) => {
    const b = await bodyOf(c);
    const body = formBody(b);
    const { html, toc } = renderer.render(body);
    return c.json({ ok: true, html, toc });
  });

  app.get('/admin/api/post/:id', (c) => {
    const post = adminRepo.get(c.req.param('id'));
    return post ? c.json({ ok: true, post: { title: post.title, body_md: post.body_md, version: post.version } }) : c.json({ ok: false }, 404);
  });

  // 三种内容列表页共用：/admin、/admin/notes、/admin/pages。
  const LIST_PATH = { post: '/admin', note: '/admin/notes', page: '/admin/pages' };
  const contentList = (kind) => (c) => {
    const page = pageNumber(c); const search = (c.req.query('q') ?? '').slice(0, 100);
    const rawStatus = c.req.query('status');
    const status = ['draft', 'published', 'scheduled'].includes(rawStatus) ? rawStatus : 'all';
    const rows = adminRepo.listPage(kind, { page, search, status });
    // 待审数只算一次，同时喂页头角标与列表统计。
    const commentCounts = adminRepo.commentCounts();
    return c.html(listPage(ctx(c, {
      kind, posts: rows.slice(0, ADMIN_PAGE_SIZE), counts: adminRepo.counts(kind), commentCounts, search, status,
      listPath: LIST_PATH[kind] ?? '/admin',
      pagination: pagination(LIST_PATH[kind] ?? '/admin', page, rows.length > ADMIN_PAGE_SIZE, search,
        undefined, { hidePager: rows.length === 0, hideSearch: true, status }),
    })));
  };

  app.get('/admin', contentList('post'));
  app.get('/admin/notes', contentList('note'));
  app.get('/admin/pages', contentList('page'));

  // 手机底部标签的「更多」：友圈/友链/设置 + 看站点/退出。桌面端走左侧导航，这一页仍可直达。
  app.get('/admin/more', (c) => c.html(morePage({
    ...ctx(c),
    feedStats: feeds?.stats() ?? null,
    linkStats: links?.stats() ?? null,
  })));

  app.get('/admin/new', (c) => {
    const kind = ['post', 'note', 'page'].includes(c.req.query('kind') ?? '') ? c.req.query('kind') : 'post';
    return c.html(editorPage({
      post: { kind, draft: 1, comments_on: 1, body_md: '' },
      aliases: [], revisions: [], isNew: true, ...ctx(c),
    }));
  });

  app.get('/admin/edit/:id', (c) => {
    const p = adminRepo.get(c.req.param('id'));
    if (!p) return notFoundPage(c, ctx, '文章不存在。');
    return c.html(editorPage({
      post: { ...p },
      aliases: adminRepo.aliasesOf(p.id),
      revisions: adminRepo.revisions(p.id, 20),
      notice: c.req.query('w') ?? '',
      ...ctx(c),
    }));
  });

  app.get('/admin/delete/:id', (c) => {
    const p = adminRepo.get(c.req.param('id'));
    if (!p) return notFoundPage(c, ctx, '文章不存在。');
    return c.html(adminLayout({
      title: '确认删除', active: 'posts', ...ctx(c),
      actions: `<a class="a-back" href="/admin/edit/${p.id}">← 取消，回编辑器</a>`,
      body: `<p class="a-notice">《${esc(p.title)}》</p>
        <form method="post" action="/admin/delete/${p.id}">
          ${csrfField(auth.csrfOf(c))}
          <p class="a-actions"><button type="submit" class="a-btn">确认删除</button></p>
        </form>`,
    }));
  });

  app.post('/admin/delete/:id', (c) => {
    const p = adminRepo.get(c.req.param('id'));
    if (!p) return c.redirect('/admin', 303);

    try {
      deleteWithFile({ repo, file: p.file_path, trash: path.join(CONTENT_DIR, '.trash', `${Date.now()}-${path.basename(p.file_path ?? 'post')}`),
        remove: () => adminRepo.deletePost(p.id) });
    } catch (e) {
      // 同保存路径：不把 fs 原始 message（带绝对路径）塞进重定向 URL。
      logError(e, c, 'admin.delete-failed');
      return notice(c, `/admin/edit/${p.id}`, '删除失败，数据已保留（详情见服务端日志）');
    }
    return c.redirect('/admin', 303);
  });

  app.get('/admin/revision/:id', (c) => {
    const rev = adminRepo.revision(c.req.param('id'));
    if (!rev) return notFoundPage(c, ctx, '修订不存在。');
    const post = adminRepo.get(rev.post_id);
    return c.html(revisionPage({ revision: rev, post, ...ctx(c) }));
  });

  app.post('/admin/restore/:id', (c) => {
    const rev = adminRepo.revision(c.req.param('id'));
    if (!rev) return c.redirect('/admin', 303);
    const post = adminRepo.get(rev.post_id);
    if (!post) return c.redirect('/admin', 303);

    try {
      const { html, toc } = renderer.render(rev.body_md);
      commitPost({ repo, existing: post,
        filePath: post.file_path ?? planFilePath({ kind: post.kind, slug: post.slug }),
        front: { ...readPostFront(post.file_path), title: rev.title, slug: post.slug, date: post.published_at ? toIsoOffset(post.published_at) : undefined,
          lang: post.lang, draft: post.draft === 1 ? true : undefined, comments: post.comments_on === 1 ? undefined : false },
        body: rev.body_md,
        commit: (w) => {
          adminRepo.addRevision(post.id, post.title, post.body_md, 'pre-restore');
          return repo.upsertFromFile({ id: post.id, slug: post.slug, kind: post.kind, title: rev.title,
            description: post.description ?? '', bodyMd: rev.body_md, bodyHtml: html, toc, lang: post.lang,
            commentsOn: post.comments_on === 1, draft: post.draft === 1, publishedAt: post.published_at,
            wordCount: wordCount(rev.body_md), filePath: w.filePath, fileHash: w.hash, source: 'file' },
            { force: true, expectedVersion: post.version });
        },
      });
    } catch (err) {
      logError(err, c, 'admin.restore-failed');
      return notice(c, `/admin/edit/${post.id}`, '回滚失败，原内容未改动（详情见服务端日志）');
    }
    return notice(c, `/admin/edit/${post.id}`, '已回滚到该版本');
  });

  registerCommentRoutes(app, { repo, comments, adminRepo, crypt, notifier }, { ctx, withEmail: shared.withEmail });
  registerMediaRoutes(app, { repo, adminRepo, mutate }, { ctx });
  if (themes && themeEngine) registerThemeRoutes(app, { themes, engine: themeEngine, repo, mutate }, { ctx });
  if (feeds && refresher) registerFeedRoutes(app, { feeds, links, refresher, repo, mutate, ...feedOptions }, { ctx });
  // 与友圈同条件：两个模块都没接入（测试单独挂 adminRoutes 的老写法）时不出这一页。
  if (links && linkChecker) registerLinkRoutes(app, { links, linkChecker, repo }, { ctx });

  return app;
}

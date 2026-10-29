import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { acquireMaintenanceLock, createMutationQueue, createWriteBarrier } from './src/util/lock.js';
import { recoverWrites } from './src/content/commit.js';
import { isExternalWrite } from './src/util/external-writes.js';
import { logError } from './src/util/errors.js';
import { boundedBody, publicWriteRateLimit, clientKey } from './src/util/http.js';
import { createAntispam } from './src/comments/antispam.js';
import { createStaticFiles } from './src/http/static.js';
import { createHtmlCache } from './src/http/html-cache.js';
import { securityHeaders, errorPage } from './src/http/security.js';
import { Hono } from 'hono';
import { compress } from 'hono/compress';
import { serve } from '@hono/node-server';
import { open, close, sqliteVersion } from './db/driver.js';
import { migrate } from './db/migrate.js';
import { createRepo } from './db/repo.js';
import { setNavPages, setPaletteDefault, setNavSource } from './src/render/layout.js';
import { applySiteIdentity } from './src/site/identity.js';
import { navFormState } from './src/site/nav.js';
import { createSearch } from './src/search/index.js';
import { settings, KEYS } from './src/settings.js';
import { createCommentRepo } from './db/comments.js';
import { createAdminRepo } from './db/admin.js';
import { createFeedRepo } from './db/feeds.js';
import { createLinkRepo } from './db/links.js';
import { createRefresher, revalidateIfParserChanged, DEFAULT_INTERVAL_MS as FEED_INTERVAL_MS, DEFAULT_KEEP as FEED_KEEP } from './src/feeds/refresh.js';
import { createLinkChecker, DEFAULT_CHECK_INTERVAL_MS as LINK_INTERVAL_MS, MAX_PER_ROUND as LINK_PER_ROUND } from './src/links/check.js';
import { createCrypto } from './src/auth.js';
import { createRenderer } from './src/render/markdown.js';
import { syncContent } from './src/content/sync.js';
import { publicRoutes } from './src/routes/public.js';
import { feedRoutes } from './src/routes/feed.js';
import { commentRoutes } from './src/routes/comments.js';
import { adminRoutes } from './src/routes/admin.js';
import { createCommentNotifier } from './src/comments/notify.js';
import { createAdminAuth } from './src/admin/auth.js';
import { createAvatarCache } from './src/avatar/cache.js';
import { createKnownAvatars } from './src/avatar/known.js';
import { normalizeAvatar } from './src/avatar/image.js';
import { avatarRoutes } from './src/routes/avatar.js';
import { registerAssetRoutes } from './src/routes/assets.js';
import { DB_FILE, CONTENT_DIR, DATA_DIR, UPLOADS_DIR, PORT, HOST, SITE, configWarnings, AVATAR_DIR, AVATAR_UPSTREAMS, AVATAR_FETCH_SIZE, AVATAR_CACHE_MAX_FILES, THEMES_DIR, PUBLIC_DIR } from './src/config.js';
import { pruneTrash, pruneTrashDirs, TRASH_DERIVED_RETENTION_DAYS } from './src/util/trash.js';
import { envDurationMs } from './src/util/env.js';
import { initMail, deliver as deliverMail } from './src/mail.js';
import { createMailOutbox } from './src/mail-outbox.js';
import { createImageInfo } from './src/media/info.js';
import { mediaRevision } from './src/media/revision.js';
import { createBackupSummaryCache, isRecoverableBackup } from './src/backup.js';
import { createBackupScheduler } from './src/backup-scheduler.js';
import { createHealthMonitor } from './src/health.js';
import { createWatchdog } from './src/monitor.js';
import { resolveLogDir } from './src/log-rotate.js';
import { createBackgroundScheduler } from './src/bootstrap/background.js';
import { VERSIONED_ASSETS, assetVer, setThemeResolver, setThemeRenderer, setThemeErrorLogger, setLayoutDefault } from './src/render/layout.js';
import { createThemeRegistry } from './src/themes/registry.js';
import { createThemeEngine } from './src/themes/engine.js';
import { runWithThemeRequest, themeRequest, THEME_PREVIEW_COOKIE } from './src/themes/request.js';
import { recordThemeError } from './src/themes/errors.js';
import { getCookie } from 'hono/cookie';

// 「可长期缓存」的静态资源；清单直接 import 自 layout.js（与加 ?v= 的是同一数组，别再复制一份）。
const IMMUTABLE_ASSET_RE = new RegExp(`^/(${VERSIONED_ASSETS.map((f) => f.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('|')})$`);
const isImmutablePath = (p) => IMMUTABLE_ASSET_RE.test(p) || p.startsWith('/uploads/') || p.startsWith('/theme-assets/');

const t0 = process.hrtime.bigint();

// 日志目录必须与 scripts/rotate-logs.mjs 使用同一口径；~ 的展开放在 log-rotate.js 的 resolveLogDir()。
const logDir = process.env.BLOG_LOG_DIR ? resolveLogDir(process.env.BLOG_LOG_DIR) : undefined;
const isProd = process.env.NODE_ENV === 'production';
// 生产默认精简静态资源；测试/本地想看源码可设 SERVE_MINIFIED=0（scripts/_server.mjs 默认就是这么给的）。
const serveMinified = isProd && process.env.SERVE_MINIFIED !== '0';
if (serveMinified && !fs.existsSync(path.join(PUBLIC_DIR, '.build', 'manifest.json'))) {
  console.warn('[assets] 未找到 public/.build，生产将退回运行时精简；发布前建议运行 npm run build:assets');
}

const releaseLock = acquireMaintenanceLock([DB_FILE, CONTENT_DIR, UPLOADS_DIR], 'server');
const db = open(DB_FILE);
migrate(db);
const repo = createRepo(db);
const search = createSearch(db);

// 主题：所有主题统一放在 themes/，没有内置/用户两套目录。
// 必须始终有一个主题在用：启动时若 theme_active 缺失或指向已删除主题，自动切到第一个可用主题。
const themes = createThemeRegistry({
  themesDir: THEMES_DIR,
  getActive: () => settings.themeActive(repo),
  getOptions: (id) => repo.getSetting(`${KEYS.themeOptionsPrefix}${id}`) ?? '',
});
const themeEngine = createThemeEngine(themes);
function fallbackTheme() {
  themes.scan(true);
  return themes.defaultTheme();
}
function ensureActiveTheme() {
  const active = themes.active();
  if (active) return active;
  const first = fallbackTheme();
  if (first) repo.setSetting(KEYS.themeActive, first.id);
  return first;
}
ensureActiveTheme();
setThemeResolver(() => {
  const request = themeRequest();
  const preview = request?.preview ? themes.get(request.preview) : null;
  return preview ?? ensureActiveTheme();
});
setThemeRenderer((theme, opts) => themeEngine.render(theme, opts));
setThemeErrorLogger((error) => {
  // 回退是静默的，后台外观页要把「主题正在失败」摆出来，否则站主只会觉得主题没生效。
  recordThemeError(error);
  logError(error, null, 'theme.render-failed');
});

setNavPages(() => repo.pages());
setPaletteDefault(() => settings.paletteDefault(repo));
setLayoutDefault(() => settings.layoutDefault(repo));

// —— 站点身份 / 导航 ——
// 都在后台可改。SITE 是各处 import 的同一个对象，这里先按库里的值覆写一次（.env 只当出厂值），
// 后台保存后再调一次 applySiteIdentity() 就立刻生效，不需要重启进程。
const settingRead = (key) => repo.getSetting(key);
applySiteIdentity(settingRead);
setNavSource(() => navFormState(settingRead, repo.pages()));
const comments = createCommentRepo(db);
const adminRepo = createAdminRepo(db);
const feeds = createFeedRepo(db);
const links = createLinkRepo(db);
const crypt = createCrypto(db);
initMail({ getSetting: repo.getSetting, crypt });
// 发信队列：通知不再直接从请求里 fire-and-forget，SMTP 抖动时由队列退避重试；全局限流避免被评论洪水打爆邮箱。
// 队列表在同一个数据库里，随备份一起走；发送失败会保留在后台「设置」页可见。
const outbox = createMailOutbox({ db, deliver: deliverMail, log: (line) => console.log(line), crypt });
outbox.start();
const auth = createAdminAuth({ db, crypt });
const imageInfo = createImageInfo(adminRepo, { revisionOf: () => mediaRevision(repo) });
const renderer = createRenderer({ imageInfo });

// 评论头像：反代 + 本地缓存；访客只连本站（CSP 保持 img-src 'self'）；缓存在 data/ 下、不进备份。
const avatarCache = createAvatarCache({
  dir: AVATAR_DIR,
  upstreams: AVATAR_UPSTREAMS,
  size: AVATAR_FETCH_SIZE,
  maxFiles: AVATAR_CACHE_MAX_FILES,
  transform: normalizeAvatar,   // 镜像的图不合身（实测 50KB PNG）→ sharp 统一成小 WebP
  log: (line) => console.log(line),
});

void avatarCache.prune().then((n) => { if (n) console.log(`[avatar] 缓存清理了 ${n} 个最久未用的头像`); }).catch(() => {});

void avatarCache.probe().then((base) => {
  if (base) console.log(`[avatar] 上游可用：${base}`);
  else if (AVATAR_UPSTREAMS.length) console.error('[avatar] 所有上游都不通，评论头像暂时退化为字母头像');
}).catch(() => {});

recoverWrites(repo);
// 回收站只进不出：启动清一次超保留期的（在 CONTENT_DIR 内，不清会跟着备份变大）。
// 派生图（缩略图/变体）用更短的保留期：它们能由原图重建，没必要在 90 天里占几十 MB。
const prunedTrash = pruneTrash([
  path.join(DATA_DIR, '.trash', 'uploads'),
  path.join(CONTENT_DIR, '.trash'),
], { derivedMaxAgeMs: TRASH_DERIVED_RETENTION_DAYS * 86400000 });
if (prunedTrash.length) console.log(`[trash] 清理了 ${prunedTrash.length} 个过期回收站文件`);
// 主题回收站是整棵目录，用目录版清理；同样按文件名里的删除时刻算，认不出的留着。
const prunedThemeDirs = pruneTrashDirs([path.join(THEMES_DIR, '.trash')]);
if (prunedThemeDirs.length) console.log(`[trash] 清理了 ${prunedThemeDirs.length} 个过期主题`);
const sync = syncContent(repo, { renderer });

// 友圈定时抓取：FEED_REFRESH_MS=0 关闭；下限 5 分钟；后台跑、不进 mutate 队列，否则一轮占着队列会把评论堵死。
const feedRefreshMs = envDurationMs(process.env.FEED_REFRESH_MS, FEED_INTERVAL_MS, { min: 5 * 60 * 1000 });
const backgroundWrites = createWriteBarrier();
const refresher = createRefresher({ feeds, commit: backgroundWrites.run, log: (line) => console.log(line) });

// 友链健康检查：LINK_CHECK_MS=0 关闭；下限 30 分钟；一轮最多 LINK_PER_ROUND 个（最久未查优先）。
const linkCheckMs = envDurationMs(process.env.LINK_CHECK_MS, LINK_INTERVAL_MS, { min: 30 * 60 * 1000 });
const linkChecker = createLinkChecker({
  links, commit: backgroundWrites.run, log: (line) => console.log(line),
});

// 提取规则改过后库里是旧结果，条件请求会让它们一路 304 永不重算；版本号一变即作废所有 ETag/Last-Modified 并强制首轮全量重抓。
const parserChanged = revalidateIfParserChanged({
  feeds,
  settings: { get: (k) => repo.getSetting(k), set: (k, v) => repo.setSetting(k, v) },
  log: (line) => console.log(line),
});

const app = new Hono({ strict: false });
const mutate = createMutationQueue();
const backupSummary = createBackupSummaryCache();

// 预览主题只对已登录站主生效：?theme=<id> 优先，其次读短期 cookie。
// 访客即使伪造 cookie，没有后台会话也不会改变渲染主题。
app.use('*', (c, next) => {
  if (c.req.method !== 'GET' && c.req.method !== 'HEAD') return next();
  // 静态资源不参与主题预览；别让一个伪造/真实后台 cookie 让每个 css/js/图片都做一次会话解析。
  const p = c.req.path;
  if (p.startsWith('/avatar/') || isImmutablePath(p)) return next();
  let preview = '', previewName = '';
  try {
    if (auth.session(c)) {
      const wanted = c.req.query('theme') || getCookie(c, THEME_PREVIEW_COOKIE) || '';
      const theme = wanted ? themes.get(wanted) : null;
      if (theme) { preview = theme.id; previewName = theme.name; }
    }
  } catch { /* 预览解析失败不应影响正常页面 */ }
  return runWithThemeRequest({ preview, previewName }, () => next());
});

// —— 进程内看门狗 ——
// 出过事的场景是公网入口断开（进程活着、外部访问失败），这时任何「进程内探自己公网地址」的检查都能发现；
// 反过来进程真挂了，systemd 的 Restart 会在 3 秒后拉起，恢复后看门狗继续工作。
// 默认只在生产开，且默认 5 分钟一次；WATCHDOG_INTERVAL_MS=0 关闭。
const watchdogIntervalMs = envDurationMs(
  process.env.WATCHDOG_INTERVAL_MS,
  isProd ? 5 * 60 * 1000 : 0,
  { min: 60 * 1000 },
);
const WATCHDOG_MAX_AGE_SEC = Number(process.env.MONITOR_BACKUP_MAX_AGE_SEC ?? 48 * 3600) || 48 * 3600;
const WATCHDOG_REQUIRE_OFFSITE = process.env.MONITOR_REQUIRE_OFFSITE === 'true';

// 自动备份与健康检查各自成模块：server.js 只负责装配和接线路由，状态维护与重试策略都在模块内部。
// 备份失败时既要尽快重试，也要在 /healthz 和后台可见，不能只留一行日志。
const backupScheduler = createBackupScheduler({
  identity: SITE.identity,
  outbox, backgroundWrites, backupSummary, logError,
});
const { healthSnapshot, infraHealth, localHealth, diskStats } = createHealthMonitor({
  repo,
  dataDir: DATA_DIR,
  dbFile: DB_FILE,
  backupSummary,
  backupState: () => backupScheduler.state(),
  maxAgeSec: WATCHDOG_MAX_AGE_SEC,
  requireOffsite: WATCHDOG_REQUIRE_OFFSITE,
});

let closing = false;


const watchdog = createWatchdog({
  // 只探公网地址：localhost 的 SITE_URL 在开发环境没有意义。
  url: SITE.url.startsWith('https://') ? new URL('/healthz', SITE.url).href : null,
  token: process.env.MONITOR_TOKEN ?? '',
  intervalMs: watchdogIntervalMs,
  maxAgeSec: WATCHDOG_MAX_AGE_SEC,
  requireOffsite: WATCHDOG_REQUIRE_OFFSITE,
  checkLocal: localHealth,
  log: (line) => console.log(line),
  notify: async (result, { recovered }) => {
    const subject = recovered ? `[恢复] ${SITE.identity} 监控恢复正常` : `[告警] ${SITE.identity} 监控异常`;
    const text = [
      recovered ? '站点与备份已恢复正常。' : '站点或备份出现异常。',
      '',
      `原因：${result.reason}`,
      `地址：${result.url ?? SITE.url}`,
      `时间：${new Date().toISOString()}`,
      '',
      '（由站点内看门狗自动发出，状态变化时才会提醒。）',
    ].join('\n');
    const queued = await outbox.enqueue({ subject, text });
    if (!queued?.queued) console.log(JSON.stringify({ event: 'watchdog.mail-queued', reason: queued?.reason ?? 'unknown' }));
  },
});
// 备份调度、失败退避与 worker 生命周期都在 src/backup-scheduler.js（上文 createBackupScheduler）。

// 日志轮转：仅文件日志模式需要，systemd 部署走 journald。这里按小时看一眼大小，
// 超过阈值就 copytruncate，避免文件日志无限增长。
const logRotateMs = envDurationMs(
  process.env.LOG_ROTATE_INTERVAL_MS,
  isProd ? 3600 * 1000 : 0,
  { min: 60 * 1000 },
);
const logMaxMb = (() => {
  const n = Number(process.env.LOG_MAX_MB);
  return Number.isFinite(n) && n > 0 ? n : 5;
})();
const logKeep = (() => {
  const n = Number(process.env.LOG_KEEP);
  return Number.isInteger(n) && n >= 1 ? n : 5;
})();
const background = createBackgroundScheduler({
  db, refresher, linkChecker, feedRefreshMs, linkCheckMs, linkPerRound: LINK_PER_ROUND,
  parserChanged, logRotateMs, logDir, logMaxMb, logKeep, logError,
});
background.start();

// 传输层压缩：自动补 Vary: Accept-Encoding，并把强 ETag 降为弱 ETag——压缩字节随编码变，强弱区分关乎缓存正确性。
app.use('*', compress());

// 请求级派生值只算一次：路径归一化、URL 解析与静态资源判定在下面 6 个中间件/路由里都要用。
app.use('*', async (c, next) => {
  const path = c.req.path;
  const immutable = isImmutablePath(path);
  c.set('requestPath', path);
  c.set('pathKey', path.replace(/\/+$/, ''));
  c.set('isImmutableAsset', immutable);
  // 静态资源不读 URL 查询串；页面/接口才需要。避免一页十几个 CSS/JS/图片各构造一次 URL。
  if (!immutable) c.set('requestUrl', new URL(c.req.url));
  const id = crypto.randomUUID(); c.set('requestId', id); c.header('X-Request-Id', id);
  await next();
});

// settings 快照在请求入口校验一次（见 db/repo.js 的 refreshSettings）：一次 pragma 换掉一页 4–6 次点查。
// 静态资源不读 settings，跳过——一个页面十来个资源，别为它们各加一次往返。
app.use('*', async (c, next) => {
  if (!c.get('isImmutableAsset')) repo.refreshSettings();
  await next();
});
app.onError((error, c) => {
  logError(error, c);
  // 500 也要带安全头：以前头写在 next() 之后，处理器一抛错就不执行了。
  securityHeaders(c);
  // 出错路径走不到下面那层设 Cache-Control，避免中间层缓存 500。
  c.header('Cache-Control', 'no-store');
  // 浏览器打开页面时别回裸 JSON（用户会看到 {"ok":false,...}）；接口路径保持 JSON 契约。
  const path = c.req.path;
  const wantsHtml = (c.req.header('accept') ?? '').includes('text/html')
    && !path.startsWith('/admin/api')
    && !path.startsWith('/moderate/');
  if (wantsHtml) return c.html(errorPage(), 500);
  return c.json({ ok: false, error: '操作失败，请重试', requestId: c.get('requestId') }, 500);
});

// 基础安全头统一在响应返回前设一次；onError 里另设一次，覆盖处理器抛错、中间件来不及返回的路径。
app.use('*', async (c, next) => {
  await next();
  securityHeaders(c);

  const p = c.get('requestPath');
  if (p.startsWith('/moderate/') || p.startsWith('/unsubscribe/')) {
    c.header('Cache-Control', 'no-store');
    c.header('Referrer-Policy', 'no-referrer');
  }
  if (p.startsWith('/admin') && p !== '/admin.css' && p !== '/admin.js' && p !== '/admin-editor.js') {
    c.header('Cache-Control', 'no-store');
  }
  // 页面必须每次回源校验：被缓存后会一直引用旧指纹的 nav.js/style.css，改动到不了用户。
  if (!c.get('isImmutableAsset') && !c.res.headers.has('Cache-Control')) {
    c.header('Cache-Control', 'no-cache');
  }

  // 这里不发 Link: rel=preload（曾给 CF Early Hints 供料）：preload URL 带内容指纹，与边缘缓存错位有「preload 未被使用」警告且收益近零，别加回来。
});



// 匿名 HTML 缓存 / 弱 ETag / 自带 br+gzip 统一在 src/http/html-cache.js。
const htmlCache = createHtmlCache({ repo, themes, isImmutableAsset: isImmutablePath });
app.use('*', htmlCache.middleware);

// 后台写请求在鉴权守卫之前整块读入请求体：先挡掉未登录请求，避免匿名客户端用大请求体
// 打内存（普通表单 1MB、主题包 10MB；图片上传不限体积但走流式落盘）。登录 POST 例外
// （上限 4KB，必须能到达登录校验）。
app.use('*', async (c, next) => {
  const p = c.get('pathKey');
  const write = !['GET', 'HEAD', 'OPTIONS'].includes(c.req.method);
  if (write && p.startsWith('/admin') && p !== '/admin/login' && !auth.session(c)) {
    if (p.startsWith('/admin/api/')) return c.json({ ok: false, error: 'unauthorized' }, 401);
    return c.redirect(`/admin/login?to=${encodeURIComponent(p)}`, 303);
  }
  return next();
});
// 公开写路径的限流必须先于 boundedBody：否则一个注定 429 的评论请求仍会先被读进 32KB 内存、
// 再排进全局写队列。登录单独一份 30 次/分钟（scrypt 比评论贵得多）。
// 这份白名单同时是下面「只接受白名单写请求」守卫的判据，所以提到守卫之前声明。
const PUBLIC_WRITE_RE = /^(?:\/api\/comments(?:\/reader)?|\/(?:p|n)\/[^/]+\/comment|\/(?!admin(?:\/|$)|api(?:\/|$)|moderate(?:\/|$)|unsubscribe(?:\/|$))[^/]+\/comment|\/moderate\/[^/]+|\/unsubscribe\/[^/]+)$/;

// 不是后台、不在公开写白名单、也不是外部写入的写请求：根本没有任何路由会处理它，直接 405。
// 以前这类请求会先被 boundedBody 整块读进最多 1MB 请求体，再排进全局写队列串行执行，
// 最后才 404 —— 一个注定失败的匿名请求就能占住写队列，拖慢所有真实写入。
app.use('*', async (c, next) => {
  const method = c.req.method;
  if (method === 'GET' || method === 'HEAD' || method === 'OPTIONS') return next();
  const p = c.get('pathKey');
  if (p.startsWith('/admin') || PUBLIC_WRITE_RE.test(p) || isExternalWrite(p)) return next();
  c.header('Allow', 'GET, HEAD, OPTIONS');
  return c.text('Method Not Allowed', 405);
});

const publicWriteLimiter = publicWriteRateLimit();
const loginWriteLimiter = publicWriteRateLimit({ max: 30 });
app.use('*', async (c, next) => {
  const p = c.get('pathKey');
  if (p === '/admin/login') return loginWriteLimiter(c, next);
  if (PUBLIC_WRITE_RE.test(p)) return publicWriteLimiter(c, next);
  return next();
});
app.use('*', boundedBody());
app.use('*', async (c, next) => {
  // 外部 IO 与只读预览不占写队列；GET/HEAD/OPTIONS 直接放行，不必再匹配路径。
  const write = !['GET', 'HEAD', 'OPTIONS'].includes(c.req.method);
  if (write && !isExternalWrite(c.get('pathKey'))) return mutate(next);
  await next();
});

// 给监控用：不碰内容、不写库。库坏了只回 ok:false，不回 SQLite 错误码与堆栈；字段保持兼容。
// 备份年龄/异地状态属于内部信息：只有带 MONITOR_TOKEN 的请求能拿到完整字段，匿名只回存活状态。
const MONITOR_TOKEN = process.env.MONITOR_TOKEN ?? '';
// /healthz 会读库并校验备份摘要；匿名扫描不该无限打。120 次/分钟远高于正常探针频率。
const healthLimiter = createAntispam({ windowMs: 60_000, maxPerWindow: 120 });
function monitorAuthorized(c) {
  if (!MONITOR_TOKEN) return !isProd;   // 本地开发默认放行；生产必须显式配 token
  const given = Buffer.from(c.req.header('x-monitor-token') ?? '');
  const expected = Buffer.from(MONITOR_TOKEN);
  return given.length === expected.length && crypto.timingSafeEqual(given, expected);
}
app.get('/healthz', (c) => {
  if (healthLimiter.rateLimited(clientKey(c))) {
    c.header('Retry-After', '60');
    return c.json({ ok: false, error: 'too-many-requests' }, 429);
  }
  // 授权响应含备份/异地状态，绝不能被共享缓存当成匿名响应复用。
  c.header('Cache-Control', 'no-store');
  c.header('Vary', 'x-monitor-token');
  let ok = true;
  let healthReason = null;
  let posts = null;
  try { posts = repo.stats().published; } catch { ok = false; healthReason = '数据库读取失败'; }
  const uptimeSec = Math.round(process.uptime());
  // 篇数本来就在 Feed/sitemap 里公开；备份年龄与异地状态才是需要 token 的内部字段。
  // 匿名请求不跑 statfs / stat：监控与看门狗都会带 token，没必要让扫描器付这份成本。
  // 匿名只看数据库是否可读；磁盘/WAL/备份是否健康属于内部字段，由下面授权后的 infraHealth 判定。
  if (!monitorAuthorized(c)) return c.json({ ok, posts, uptimeSec }, ok ? 200 : 503);

  // 授权请求只取一次磁盘快照，infraHealth 与 healthSnapshot 共用，别为同一页 statfs 两遍。
  const disk = diskStats();
  const infra = infraHealth(disk);
  if (!infra.ok) { ok = false; healthReason = infra.reason; }
  const health = healthSnapshot(disk);
  // 磁盘/WAL/备份卡住与数据库读失败同级：外网探针与看门狗看到 ok:false 就该告警。
  // （三项判定已收敛进 infraHealth，与 localHealth 共用口径。）
  const base = { ok, posts, uptimeSec };

  const { last, recoverable } = backupSummary.get();
  let offsite = null;
  try { offsite = JSON.parse(repo.getSetting('backup_offsite_status') ?? 'null'); } catch { /* 未记录 */ }
  const body = {
    ...base,
    ...health,
    // 只给带 token 的探针：磁盘/WAL/备份任务卡住时，邮件和 webhook 里要能直接读到原因，
    // 而不是每封都只说「站点自检失败」。
    healthReason,
    backupNextRetryInSec: health.backupNextRetryAt ? Math.max(0, Math.round((Date.parse(health.backupNextRetryAt) - Date.now()) / 1000)) : null,
    latestRecoverableBackupAgeSec: recoverable ? Math.max(0, Math.round((Date.now() - Date.parse(recoverable.createdAt)) / 1000)) : null,
    backupComplete: Boolean(last && isRecoverableBackup(last)),
    offsiteBackup: offsite,
    backupAgeSec: last?.createdAt ? Math.round((Date.now() - Date.parse(last.createdAt)) / 1000) : null,
  };
  return c.json(body, ok ? 200 : 503);
});

if (!isProd) {
  app.use('*', async (c, next) => {
    const s = process.hrtime.bigint();
    await next();
    const ms = Number(process.hrtime.bigint() - s) / 1e6;
    console.log(JSON.stringify({ event: 'request', requestId: c.get('requestId'), status: c.res.status, method: c.req.method, path: c.req.path.startsWith('/moderate/') ? '/moderate/[redacted]'
      : c.req.path.startsWith('/unsubscribe/') ? '/unsubscribe/[redacted]' : c.req.path, ms: Number(ms.toFixed(1)) }));
  });
}

const { sendFile } = createStaticFiles({ repo, assetVer });

for (const file of VERSIONED_ASSETS) app.get('/' + file, (c) => sendFile(c, '/' + file, { minify: serveMinified && /\.(?:css|js)$/.test(file) }));

registerAssetRoutes(app, { sendFile, themes, auth, assetVer, repo });


// 只给已审核评论出现过的邮箱 md5 回源；任意 hash 不再能消耗上游预算/做枚举。
const knownAvatars = createKnownAvatars({
  comments, crypt, siteEmail: () => SITE.email, log: (line) => console.log(line),
});
// 启动时预热“已知邮箱”集合；重建分批让出事件循环，不阻塞监听。
void knownAvatars.refresh?.();
app.route('/', avatarRoutes(avatarCache, { isKnown: knownAvatars }));


const commentNotifier = createCommentNotifier({ repo, comments, crypt, mail: outbox });
app.route('/', adminRoutes({
  repo, comments, adminRepo, crypt, auth, renderer, scheduleBackup: backupScheduler.schedule, notifier: commentNotifier,
  feeds, refresher, mutate,
  links, linkChecker,
  themes, themeEngine,
  outbox,
  feedOptions: { keep: FEED_KEEP },
  // 上面那层全局限流已经覆盖 /admin/login 与公开写路径，子应用不再各建一份计数桶。
  rateLimited: false,
}));
app.route('/', commentRoutes({ repo, comments, crypt, auth, notifier: commentNotifier, rateLimited: false }));
app.route('/', feedRoutes(repo));
app.route('/', publicRoutes(repo, {
  comments, crypt, media: imageInfo, auth, search,
  feeds, links,
}));

const server = serve({
  fetch: app.fetch, port: PORT, hostname: HOST,
  // 源站躲在 Nginx 反向代理后面：Node 默认 5s keep-alive 会让空闲连接很快断开、后续回源重新建连。
  // 拉长到 75s，headersTimeout 在其之上留出余量（Node 要求 headersTimeout > keepAliveTimeout）。
  serverOptions: { keepAliveTimeout: 75000, headersTimeout: 80000 },
}, (info) => {
  const actualPort = info?.port ?? PORT;
  const bootMs = Number(process.hrtime.bigint() - t0) / 1e6;
  const postStats = repo.stats();
  const feedStats = feeds.stats();

  const feedLine = feedStats.sources
    ? `  友圈      ${feedStats.sources} 个源 · ${feedStats.items} 篇文章 · ${feedRefreshMs ? `每 ${Math.round(feedRefreshMs / 60000)} 分钟刷新一次` : '自动刷新已关闭'}\n`
    : '';

  const linkStats = links.stats();
  const linkMins = Math.round(linkCheckMs / 60000);
  const linkEvery = linkMins >= 60 ? `${(linkMins / 60).toFixed(linkMins % 60 ? 1 : 0)} 小时` : `${linkMins} 分钟`;
  const linkLine = linkStats.total
    ? `  友链      ${linkStats.total} 个站 · ${linkStats.shown} 个在页面上 · ${linkCheckMs ? `每 ${linkEvery} 查一次` : '自动检查已关闭'}\n`
    : '';

  console.log(`
  ${SITE.title} · 单栏极简博客
  ────────────────────────────────────────────
  地址      http://${HOST}:${actualPort}
  数据库    ${path.relative(process.cwd(), DB_FILE)}
  驱动      node:sqlite ${sqliteVersion(db)}（内置，零原生依赖）
  内容      ${sync.total} 个文件 → 新增 ${sync.inserted} / 更新 ${sync.updated} / 删除 ${sync.removed}${sync.errors.length ? ` / 错误 ${sync.errors.length}` : ''}
  已发布    ${postStats.published} 篇（草稿 ${postStats.drafts}）
  评论      ${Object.entries(comments.counts()).map(([k, v]) => `${k} ${v}`).join(' · ') || '暂无'}
${feedLine}${linkLine}  后台      ${auth.configured() ? `已设密码 → ${HOST === '0.0.0.0' ? SITE.url : `http://${HOST}:${actualPort}`}/admin` : '⚠ 未设密码，先跑 node scripts/set-password.mjs'}
  冷启动    ${bootMs.toFixed(1)} ms    常驻内存 ${(process.memoryUsage().rss / 1048576).toFixed(1)} MB
  ────────────────────────────────────────────
`);
  for (const e of sync.errors) console.error(`  [content] ✗ ${e}`);
  for (const w of configWarnings()) console.error(`  [config] ⚠ ${w}`);

  if (watchdogIntervalMs > 0) {
    watchdog.start();
    console.log(`  监控      ${SITE.url.startsWith('https://') ? `${SITE.url}/healthz` : '仅本地备份'} · 每 ${Math.round(watchdogIntervalMs / 60000)} 分钟`);
  }

});

for (const sig of ['SIGINT', 'SIGTERM']) {
  process.on(sig, () => {
    if (closing) return;
    closing = true;
    background.stop();
    watchdog.stop();
    outbox.stop();
    // 先把备份 worker 停掉并等它退出，再关主库/释放维护锁；否则另一个实例可能在 worker 仍写备份时启动。
    const workerDone = backupScheduler.stop();
    console.log('\n[server] 正在退出，合并 WAL…');
    // 主动断开空闲 keep-alive 连接（nginx 回源常驻连接默认要等 75s 空闲超时），
    // 否则几乎必然先撞 15s 兜底强退：drain 顺序形同虚设，且兜底不等备份 worker 就释放锁。
    server.closeIdleConnections?.();
    server.close(() => {
      // 等 HTTP 连接都结束后再 drain：避免一个刚进来的请求在 drain 之后又启动新的后台轮次。
      // 后台任务（友圈/友链/发信、看门狗）可能正处在「网络已返回、还没落库」的窗口里，
      // 必须等它们结束，否则会在 close(db) 之后写 markOk/markFail/markSent。
      const backgroundDone = (async () => {
        await Promise.allSettled([watchdog.drain?.()]);
        await Promise.allSettled([refresher.drain?.(), linkChecker.drain?.()]);
        await outbox.drain?.();
      })();
      void Promise.allSettled([workerDone, backgroundDone]).finally(() => {
        close(db); releaseLock();
        console.log('[server] 已安全停止');
        process.exit(0);
      });
    });

    // 网络探针最长可能等满抓取超时；给后台任务一个比 HTTP 关闭更宽的兜底，仍避免永久卡住。
    setTimeout(() => { close(db); releaseLock(); process.exit(0); }, 15000).unref();
  });
}

import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { Worker } from 'node:worker_threads';
import { acquireMaintenanceLock, createMutationQueue, createWriteBarrier } from './src/util/lock.js';
import { recoverWrites } from './src/content/commit.js';
import { isExternalWrite } from './src/util/external-writes.js';
import { logError } from './src/util/errors.js';
import { boundedBody, ifNoneMatch, publicWriteRateLimit, clientIp } from './src/util/http.js';
import { createAntispam } from './src/comments/antispam.js';
import { createStaticFiles, MIME } from './src/http/static.js';
import { createHtmlCache } from './src/http/html-cache.js';
import { esc } from './src/util/text.js';
import { Hono } from 'hono';
import { compress } from 'hono/compress';
import { serve } from '@hono/node-server';
import { open, close, sqliteVersion } from './db/driver.js';
import { migrate } from './db/migrate.js';
import { createRepo } from './db/repo.js';
import { setNavPages, setPaletteDefault } from './src/render/layout.js';
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
import { DB_FILE, CONTENT_DIR, DATA_DIR, UPLOADS_DIR, PORT, HOST, SITE, configWarnings, AVATAR_DIR, AVATAR_UPSTREAMS, AVATAR_FETCH_SIZE, AVATAR_CACHE_MAX_FILES, THEMES_DIR, PUBLIC_DIR } from './src/config.js';
import { pruneTrash, pruneTrashDirs, TRASH_DERIVED_RETENTION_DAYS } from './src/util/trash.js';
import { envInt, envDurationMs } from './src/util/env.js';
import { initMail, deliver as deliverMail } from './src/mail.js';
import { createMailOutbox } from './src/mail-outbox.js';
import { createImageInfo } from './src/media/info.js';
import { createBackupSummaryCache, latestRecoverableBackup, isRecoverableBackup } from './src/backup.js';
import { createWatchdog } from './src/monitor.js';
import { rotateLogsAsync, resolveLogDir } from './src/log-rotate.js';
import { THEME_BOOT as PUBLIC_THEME_BOOT, VERSIONED_ASSETS, assetVer, setThemeResolver, setThemeRenderer, setThemeErrorLogger } from './src/render/layout.js';
import { THEME_BOOT as ADMIN_THEME_BOOT } from './src/admin/layout.js';
import { createThemeRegistry, isSafeRelative } from './src/themes/registry.js';
import { createThemeEngine } from './src/themes/engine.js';
import { runWithThemeRequest, themeRequest, THEME_PREVIEW_COOKIE } from './src/themes/request.js';
import { recordThemeError } from './src/themes/errors.js';
import { getCookie } from 'hono/cookie';

// 「可长期缓存」的静态资源；清单直接 import 自 layout.js（与加 ?v= 的是同一数组，别再复制一份）。
const IMMUTABLE_ASSET_RE = new RegExp(`^/(${VERSIONED_ASSETS.map((f) => f.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('|')})$`);
const isImmutablePath = (p) => IMMUTABLE_ASSET_RE.test(p) || p.startsWith('/uploads/') || p.startsWith('/theme-assets/');

// CSP：script-src 只放行自身脚本与内联引导的 sha256（前台/后台共用同一常量，Set 去重）——主题/配色必须在 <head>（外链会闪白）；style-src 需 unsafe-inline。
const INLINE_SCRIPT_HASHES = [...new Set([PUBLIC_THEME_BOOT, ADMIN_THEME_BOOT])]
  .map((src) => `'sha256-${crypto.createHash('sha256').update(src, 'utf8').digest('base64')}'`);
const CSP = [
  "default-src 'self'",
  "base-uri 'self'",
  "object-src 'none'",
  "img-src 'self' data:",
  "font-src 'self'",
  "style-src 'self' 'unsafe-inline'",
  `script-src 'self' ${INLINE_SCRIPT_HASHES.join(' ')}`,
  "connect-src 'self'",
  "form-action 'self'",
  "frame-ancestors 'none'",
].join('; ');

// 渲染抛错时给浏览器一张能读的错页。刻意不套 layout()：那要读库取导航，库坏了会二次抛错。
// 接口（/admin/api、/moderate、fetch）仍回 JSON，见 onError。
const ERROR_PAGE = `<!doctype html>
<html lang="${SITE.lang}">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<meta name="robots" content="noindex">
<title>出了点问题 · ${esc(SITE.title || SITE.identity)}</title>
<style>
:root{color-scheme:light dark}
body{margin:0;min-height:100vh;display:grid;place-items:center;padding:2rem;background:#faf8f4;color:#2b2b2b;
  font:16px/1.75 ui-sans-serif,system-ui,-apple-system,"Segoe UI","PingFang SC","Microsoft YaHei",sans-serif}
main{max-width:32rem}
h1{margin:0 0 .6rem;font-size:1.4rem;letter-spacing:.02em}
p{margin:0 0 1.2rem;color:#6b6b6b}
a{color:inherit}
@media (prefers-color-scheme:dark){body{background:#151413;color:#e8e4dc}p{color:#9a948a}}
</style>
</head>
<body><main>
<h1>出了点问题</h1>
<p>这一页暂时打不开，稍后刷新试试。</p>
<p><a href="/">回到首页</a></p>
</main></body>
</html>`;

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
const imageInfo = createImageInfo(adminRepo);
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
// 磁盘/WAL 的硬阈值：磁盘满会同时坏掉 SQLite、上传和备份；WAL 异常膨胀通常意味着长事务或检查点失败。
// 默认 512MB 对个人站点足够宽，环境变量可覆盖（设 0 = 不按该项判定，健康检查仍会返回数值）。
const HEALTH_MIN_DISK_FREE_BYTES = envInt(process.env.HEALTH_MIN_DISK_FREE_BYTES, 512 * 1024 * 1024, { min: 0, max: 1024 ** 4 });
const HEALTH_MAX_WAL_BYTES = envInt(process.env.HEALTH_MAX_WAL_BYTES, 512 * 1024 * 1024, { min: 0, max: 1024 ** 4 });
const HEALTH_BACKUP_TIMEOUT_SEC = envInt(process.env.HEALTH_BACKUP_TIMEOUT_SEC, 20 * 60, { min: 60, max: 24 * 3600 });

// 备份状态：失败时既要尽快重试，也要在 /healthz 和后台可见，不能只留一行日志。
let backupLastError = null;
let backupLastAttemptAt = null;
let backupNextRetryAt = null;
let backupStartedAt = null;
let backupRetryStep = 0;
let backupRetryDelayMs = null;
let backupAlertedAt = 0;
let backupRunFailed = false;
const BACKUP_RETRY_STEPS = [5 * 60 * 1000, 15 * 60 * 1000, 60 * 60 * 1000, 6 * 3600 * 1000];
let backupQueued = false;
let backupWorker = null;
let closing = false;

function diskStats() {
  const out = { diskFreeBytes: null, diskTotalBytes: null, dbBytes: null, dbWalBytes: null };
  try {
    const s = fs.statfsSync(DATA_DIR);
    out.diskFreeBytes = Number(s.bavail) * Number(s.bsize);
    out.diskTotalBytes = Number(s.blocks) * Number(s.bsize);
  } catch { /* 平台不支持 statfs 时只返回 null，不阻断健康检查 */ }
  try { out.dbBytes = fs.statSync(DB_FILE).size; } catch { /* 数据库刚被移走 */ }
  try { out.dbWalBytes = fs.statSync(`${DB_FILE}-wal`).size; } catch { out.dbWalBytes = 0; }
  return out;
}

function healthSnapshot() {
  return {
    ...diskStats(),
    backupWorkerState: backupWorker ? 'running' : (backupQueued ? 'queued' : 'idle'),
    backupLastError,
    backupLastAttemptAt,
    backupNextRetryAt,
    backupStartedAt: backupStartedAt ? new Date(backupStartedAt).toISOString() : null,
    rssBytes: process.memoryUsage().rss,
  };
}

// 本地部分直接读库，不必绕 HTTP 一圈；公网可达性才必须走网络。
function localHealth() {
  try { repo.stats(); } catch { return { ok: false, reason: '数据库读取失败' }; }
  const disk = diskStats();
  if (HEALTH_MIN_DISK_FREE_BYTES > 0 && Number.isFinite(disk.diskFreeBytes) && disk.diskFreeBytes < HEALTH_MIN_DISK_FREE_BYTES) {
    return { ok: false, reason: `磁盘剩余空间不足：${Math.round(disk.diskFreeBytes / 1048576)}MB < ${Math.round(HEALTH_MIN_DISK_FREE_BYTES / 1048576)}MB` };
  }
  if (HEALTH_MAX_WAL_BYTES > 0 && Number.isFinite(disk.dbWalBytes) && disk.dbWalBytes > HEALTH_MAX_WAL_BYTES) {
    return { ok: false, reason: `SQLite WAL 过大：${Math.round(disk.dbWalBytes / 1048576)}MB > ${Math.round(HEALTH_MAX_WAL_BYTES / 1048576)}MB` };
  }
  if (backupStartedAt && Date.now() - backupStartedAt > HEALTH_BACKUP_TIMEOUT_SEC * 1000) {
    return { ok: false, reason: '备份任务运行时间过长' };
  }
  const { recoverable } = backupSummary.get();
  if (!recoverable) return { ok: false, reason: '没有可完整恢复的备份' };
  const age = Math.round((Date.now() - Date.parse(recoverable.createdAt)) / 1000);
  if (!Number.isFinite(age) || age > WATCHDOG_MAX_AGE_SEC) return { ok: false, reason: '可恢复备份已过期' };
  if (WATCHDOG_REQUIRE_OFFSITE) {
    let offsite = null;
    try { offsite = JSON.parse(repo.getSetting('backup_offsite_status') ?? 'null'); } catch { /* 未记录 */ }
    const elapsed = (Date.now() - Date.parse(offsite?.checkedAt)) / 1000;
    if (offsite?.state !== 'ok' || !Number.isFinite(elapsed) || elapsed > WATCHDOG_MAX_AGE_SEC || elapsed < -60)
      return { ok: false, reason: '异地备份未成功或已过期' };
  }
  return { ok: true, reason: '本地检查正常' };
}


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
function notifyBackupFailure(reason) {
  if (backupAlertedAt && Date.now() - backupAlertedAt < 6 * 3600 * 1000) return;
  backupAlertedAt = Date.now();
  const queued = outbox.enqueue({
    subject: `[告警] ${SITE.identity} 自动备份失败`,
    text: [
      '站点自动备份失败。',
      '',
      `原因：${reason}`,
      `时间：${new Date().toISOString()}`,
      backupNextRetryAt ? `下次重试：${backupNextRetryAt}` : '',
      '',
      '本地备份与异地备份都会受影响；请登录后台「设置」查看发信队列，或在服务器上检查 backup 日志。',
    ].filter(Boolean).join('\n'),
  });
  if (!queued?.queued) {
    // 入队失败（库暂时不可写等）就别把“已告警”钉死，下一轮失败再试。
    backupAlertedAt = 0;
    console.log(JSON.stringify({ event: 'backup.alert-queued-failed', reason: queued?.reason ?? 'unknown' }));
  }
}

function recordBackupFailure(reason) {
  if (backupRunFailed) return;
  backupRunFailed = true;
  backupLastAttemptAt = new Date().toISOString();
  backupLastError = { at: backupLastAttemptAt, reason: String(reason ?? 'unknown').slice(0, 300) };
  backupRetryStep = Math.min(backupRetryStep + 1, BACKUP_RETRY_STEPS.length);
  backupRetryDelayMs = BACKUP_RETRY_STEPS[backupRetryStep - 1] ?? BACKUP_RETRY_STEPS.at(-1);
  backupNextRetryAt = new Date(Date.now() + backupRetryDelayMs).toISOString();
  notifyBackupFailure(backupLastError.reason);
}

function scheduleBackup(delayMs = 0) {
  if (backupQueued || closing) return;
  backupQueued = true;

  // 不占全局写队列：备份的一致性由 SQLite 的 VACUUM INTO + 文件树 mtime 校验保证，评论/设置这类
  // 只写库的操作不该排队等整次备份；文章/上传/主题变更会触发快照失败并在 worker 里重试。
  setTimeout(() => {
    if (closing) { backupQueued = false; return; }
    backupStartedAt = Date.now();
    backupRunFailed = false;
    let worker;
    try { worker = new Worker(new URL('./src/backup-worker.js', import.meta.url)); }
    catch (error) {
      // 起不来必须立刻放标志位，否则自动备份会被永久静默关闭；同时按失败处理，避免只留一行日志。
      backupQueued = false;
      backupStartedAt = null;
      console.error(JSON.stringify({ event: 'backup.failed', code: error.code ?? 'WORKER_START' }));
      recordBackupFailure(`备份 worker 启动失败（${error.code ?? 'WORKER_START'}）`);
      const retry = backupRetryDelayMs;
      backupRetryDelayMs = null;
      if (retry) scheduleBackup(retry);
      return;
    }
    backupWorker = worker;
    let resumeBackgroundWrites = () => {};
    try { resumeBackgroundWrites = backgroundWrites.pause(); }
    catch (error) {
      // 屏障已存在（另一个后台写还在飞）：本次跳过，别让同步异常从定时器里炸掉进程。
      backupQueued = false;
      backupWorker = null;
      backupStartedAt = null;
      logError(error, null, 'backup.barrier');
      void worker.terminate();
      return;
    }
    let released = false;
    const releaseWrites = () => { if (!released) { released = true; resumeBackgroundWrites(); } };
    // 自检 + 异地 rsync 允许 15 分钟；给 worker 留足余量，别再 3 分钟就把上传中的异地备份杀掉。
    const timer = setTimeout(() => {
      console.error(JSON.stringify({ event: 'backup.timeout' }));
      recordBackupFailure('备份超时（15 分钟）');
      void worker.terminate();
    }, 15 * 60 * 1000);
    worker.on('message', (message) => {
      backupSummary.invalidate();
      if (message.event === 'backup.local-ready') releaseWrites();
      if (message.event === 'backup.completed') {
        backupLastError = null;
        backupLastAttemptAt = new Date().toISOString();
        backupNextRetryAt = null;
        backupRetryStep = 0;
        backupRetryDelayMs = null;
        backupAlertedAt = 0;
      } else if (message.event === 'backup.failed') {
        recordBackupFailure(message.reason ?? message.code ?? '备份失败');
      } else if (message.event === 'backup.incomplete') {
        recordBackupFailure(message.reason ?? '备份不完整');
      }
      console.log(JSON.stringify(message));
    });
    worker.on('error', (error) => {
      if (!closing) recordBackupFailure(`备份 worker 异常（${error?.code ?? 'WORKER_FAILED'}）`);
      console.error(JSON.stringify({ event: 'backup.failed', code: error.code ?? 'WORKER_FAILED', message: String(error?.message ?? '').slice(0, 300) }));
    });
    worker.on('exit', (code, signal) => {
      clearTimeout(timer);
      backupQueued = false;
      backupWorker = null;
      backupStartedAt = null;
      releaseWrites();
      // worker 自己崩溃/被 SIGKILL 时不会走 message 分支；这里兜住，否则失败会被静默吞掉。
      if (!closing && !backupRunFailed && (code !== 0 || signal)) recordBackupFailure(`备份 worker 退出（${signal ?? code}）`);
      const retry = backupRetryDelayMs;
      backupRetryDelayMs = null;
      if (retry && !closing) scheduleBackup(retry);
    });
  }, Math.max(0, Number(delayMs) || 0)).unref();
}
const autoBackupOn = process.env.BACKUP_ON_PUBLISH !== 'false';
const backupIntervalMs = Math.max(60000, Number(process.env.BACKUP_INTERVAL_MS) || 6 * 3600000);
const backupInterval = setInterval(scheduleBackup, backupIntervalMs);
backupInterval.unref();
if (!autoBackupOn) clearInterval(backupInterval);

let backupCatchup = null;
if (autoBackupOn) {
  const lastBackup = latestRecoverableBackup();
  const lastAgeMs = lastBackup?.createdAt ? Date.now() - Date.parse(lastBackup.createdAt) : null;
  if (lastAgeMs === null || lastAgeMs >= backupIntervalMs) {
    const delay = Math.min(90000, Math.max(5000, Math.round(backupIntervalMs / 20)));
    backupCatchup = setTimeout(scheduleBackup, delay);
    backupCatchup.unref();
    console.log(JSON.stringify({ event: 'backup.catchup', lastAgeSec: lastAgeMs === null ? null : Math.round(lastAgeMs / 1000), delayMs: delay }));
  }
}

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
const logRotateTimer = logRotateMs > 0 ? setInterval(() => {
  void rotateLogsAsync({ dir: logDir, maxBytes: logMaxMb * 1024 * 1024, keep: logKeep })
    .then((result) => {
      if (result.rotated.length) console.log(JSON.stringify({ event: 'logs.rotated', files: result.rotated.length, removed: result.removed.length }));
    })
    .catch((error) => console.error(JSON.stringify({ event: 'logs.rotate-failed', code: error?.code ?? 'INTERNAL' })));
}, logRotateMs) : null;
logRotateTimer?.unref();

// 定时器回调里刷新/检查会在返回 Promise 前同步读库：DB 临时错误若直接抛出，会变成未捕获异常
// 从 setInterval 回调里终止进程。统一接住同步异常与 Promise 拒绝。
const kickFeedRefresh = (options) => {
  try { void refresher.refreshAll(options).catch((error) => logError(error, null, 'feeds.background-failed')); }
  catch (error) { logError(error, null, 'feeds.background-failed'); }
};
const kickLinkCheck = (options) => {
  try { void linkChecker.checkAll(options).catch((error) => logError(error, null, 'links.background-failed')); }
  catch (error) { logError(error, null, 'links.background-failed'); }
};

let feedInterval = null;
let feedBoot = null;

if (feedRefreshMs > 0) {
  feedInterval = setInterval(() => kickFeedRefresh(), feedRefreshMs);
  feedInterval.unref();
  // 启动后等 20 秒再首刷：先让索引落定，刚部署完常有人在看，别让首刷抢带宽。
  feedBoot = setTimeout(() => kickFeedRefresh({ force: parserChanged }), 20000);
  feedBoot.unref();
}

let linkInterval = null;
let linkBoot = null;
if (linkCheckMs > 0) {
  linkInterval = setInterval(() => kickLinkCheck({ intervalMs: linkCheckMs, limit: LINK_PER_ROUND }), linkCheckMs);
  linkInterval.unref();

  linkBoot = setTimeout(() => kickLinkCheck({ limit: LINK_PER_ROUND }), 40000);
  linkBoot.unref();
}

// 传输层压缩：自动补 Vary: Accept-Encoding，并把强 ETag 降为弱 ETag——压缩字节随编码变，强弱区分关乎缓存正确性。
app.use('*', compress());

app.use('*', async (c, next) => {
  const id = crypto.randomUUID(); c.set('requestId', id); c.header('X-Request-Id', id);
  await next();
});

// settings 快照在请求入口校验一次（见 db/repo.js 的 refreshSettings）：一次 pragma 换掉一页 4–6 次点查。
// 静态资源不读 settings，跳过——一个页面十来个资源，别为它们各加一次往返。
app.use('*', async (c, next) => {
  const p = c.req.path;
  if (!isImmutablePath(p)) repo.refreshSettings();
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
  if (wantsHtml) return c.html(ERROR_PAGE, 500);
  return c.json({ ok: false, error: '操作失败，请重试', requestId: c.get('requestId') }, 500);
});

// 基础安全头；供正常响应与 onError 共用。
function securityHeaders(c) {
  c.header('X-Content-Type-Options', 'nosniff');
  c.header('Referrer-Policy', 'strict-origin-when-cross-origin');
  c.header('X-Frame-Options', 'DENY');
  c.header('Content-Security-Policy', CSP);
  // 仅 https 时发 HSTS（否则首次访问可被 SSL-strip 降级）；不带 preload（上列表难撤回）。
  if (SITE.url.startsWith('https')) c.header('Strict-Transport-Security', 'max-age=31536000; includeSubDomains');

  c.header('Permissions-Policy', 'camera=(), microphone=(), geolocation=(), payment=(), usb=()');
}

app.use('*', async (c, next) => {
  securityHeaders(c);   // 先设一次：boundedBody 提前返回的 413/408 也能带上
  await next();
  securityHeaders(c);   // 再设一次：下游用 c.body(..., headers) 新建 Response 时不会被顶掉

  const p = c.req.path;
  if (p.startsWith('/moderate/') || p.startsWith('/unsubscribe/')) {
    c.header('Cache-Control', 'no-store');
    c.header('Referrer-Policy', 'no-referrer');
  }
  if (p.startsWith('/admin') && p !== '/admin.css' && p !== '/admin.js' && p !== '/admin-editor.js') {
    c.header('Cache-Control', 'no-store');
  }
  // 页面必须每次回源校验：被缓存后会一直引用旧指纹的 nav.js/style.css，改动到不了用户。
  const isImmutableAsset = isImmutablePath(p);
  if (!isImmutableAsset && !c.res.headers.has('Cache-Control')) {
    c.header('Cache-Control', 'no-cache');
  }

  // 这里不发 Link: rel=preload（曾给 CF Early Hints 供料）：preload URL 带内容指纹，与边缘缓存错位有「preload 未被使用」警告且收益近零，别加回来。
});



// 匿名 HTML 缓存 / 弱 ETag / 自带 br+gzip 统一在 src/http/html-cache.js。
const htmlCache = createHtmlCache({ repo, themes, crypt, isImmutableAsset: isImmutablePath });
app.use('*', htmlCache.middleware);

// 后台写请求在鉴权守卫之前整块读入请求体：先挡掉未登录请求，避免匿名客户端用大请求体
// 打内存（普通表单 1MB、主题包 10MB；图片上传不限体积但走流式落盘）。登录 POST 例外
// （上限 4KB，必须能到达登录校验）。
app.use('*', async (c, next) => {
  const p = c.req.path.replace(/\/+$/, '');
  const write = !['GET', 'HEAD', 'OPTIONS'].includes(c.req.method);
  if (write && p.startsWith('/admin') && p !== '/admin/login' && !auth.session(c)) {
    if (p.startsWith('/admin/api/')) return c.json({ ok: false, error: 'unauthorized' }, 401);
    return c.redirect(`/admin/login?to=${encodeURIComponent(p)}`, 303);
  }
  return next();
});
// 公开写路径的限流必须先于 boundedBody：否则一个注定 429 的评论请求仍会先被读进 32KB 内存、
// 再排进全局写队列。登录单独一份 30 次/分钟（scrypt 比评论贵得多）。
const PUBLIC_WRITE_RE = /^(?:\/api\/comments(?:\/reader)?|\/(?:p|n)\/[^/]+\/comment|\/[^/]+\/comment|\/moderate\/[^/]+|\/unsubscribe\/[^/]+)$/;
const publicWriteLimiter = publicWriteRateLimit();
const loginWriteLimiter = publicWriteRateLimit({ max: 30 });
app.use('*', async (c, next) => {
  const p = c.req.path.replace(/\/+$/, '');
  if (p === '/admin/login') return loginWriteLimiter(c, next);
  if (PUBLIC_WRITE_RE.test(p)) return publicWriteLimiter(c, next);
  return next();
});
app.use('*', boundedBody());
app.use('*', async (c, next) => {
  // 外部 IO 与只读预览不占写队列；GET/HEAD/OPTIONS 直接放行，不必再匹配路径。
  const write = !['GET', 'HEAD', 'OPTIONS'].includes(c.req.method);
  if (write && !isExternalWrite(c.req.path.replace(/\/+$/, ''))) return mutate(next);
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
  if (healthLimiter.rateLimited(clientIp(c) || 'unknown')) {
    c.header('Retry-After', '60');
    return c.json({ ok: false, error: 'too-many-requests' }, 429);
  }
  // 授权响应含备份/异地状态，绝不能被共享缓存当成匿名响应复用。
  c.header('Cache-Control', 'no-store');
  c.header('Vary', 'x-monitor-token');
  let ok = true;
  let posts = null;
  try { posts = repo.stats().published; } catch { ok = false; }
  const uptimeSec = Math.round(process.uptime());
  // 篇数本来就在 Feed/sitemap 里公开；备份年龄与异地状态才是需要 token 的内部字段。
  // 匿名请求不跑 statfs / stat：监控与看门狗都会带 token，没必要让扫描器付这份成本。
  if (!monitorAuthorized(c)) return c.json({ ok, posts, uptimeSec }, ok ? 200 : 503);

  const health = healthSnapshot();
  // 磁盘/WAL/备份卡住与数据库读失败同级：外网探针与看门狗看到 ok:false 就该告警。
  if (HEALTH_MIN_DISK_FREE_BYTES > 0 && Number.isFinite(health.diskFreeBytes) && health.diskFreeBytes < HEALTH_MIN_DISK_FREE_BYTES) ok = false;
  if (HEALTH_MAX_WAL_BYTES > 0 && Number.isFinite(health.dbWalBytes) && health.dbWalBytes > HEALTH_MAX_WAL_BYTES) ok = false;
  if (health.backupStartedAt && Date.now() - Date.parse(health.backupStartedAt) > HEALTH_BACKUP_TIMEOUT_SEC * 1000) ok = false;
  const base = { ok, posts, uptimeSec };

  const { last, recoverable } = backupSummary.get();
  let offsite = null;
  try { offsite = JSON.parse(repo.getSetting('backup_offsite_status') ?? 'null'); } catch { /* 未记录 */ }
  const body = {
    ...base,
    ...health,
    backupNextRetryInSec: backupNextRetryAt ? Math.max(0, Math.round((Date.parse(backupNextRetryAt) - Date.now()) / 1000)) : null,
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

// 主题资源：/theme-assets/<id>/<相对路径>。只允许截图和 assets/ 下的文件，路径由 registry.assetPath 校验。
// 激活主题对所有访客可用；未激活主题只有站主（预览/后台截图）能取，避免把半成品主题公开。
app.get('/theme-assets/*', async (c) => {
  const raw = c.req.path.slice('/theme-assets/'.length);
  const slash = raw.indexOf('/');
  if (slash <= 0) return c.notFound();
  let id, rel;
  try {
    id = decodeURIComponent(raw.slice(0, slash));
    rel = decodeURIComponent(raw.slice(slash + 1));
  } catch { return c.notFound(); }
  const theme = themes.get(id);
  if (!theme) return c.notFound();
  // 别在这里 list(true)：每张主题截图都会触发一次全量扫描（重新 walk 所有主题模板并 stat）。
  // activeId()/defaultTheme() 都走 registry 的 TTL 缓存，扫描时机仍由后台页面控制。
  const activeId = themes.activeId() || themes.defaultTheme()?.id || '';
  const isActive = id === activeId;
  // 未激活主题的资源只给站主看：公共缓存不能存，否则 CDN/浏览器可能把预览中的半成品主题
  // 或后台截图当成公开资源发给匿名访客。
  if (!isActive) {
    const isOwner = Boolean(auth.session(c));
    if (!isOwner) return c.notFound();
  }
  if (!isSafeRelative(rel)) return c.notFound();
  const file = themes.assetPath(theme, rel);
  if (!file) return c.notFound();
  let stat;
  try { stat = await fs.promises.stat(file); } catch { return c.notFound(); }
  if (!stat.isFile()) return c.notFound();
  // 外层 compress() 会按 Accept-Encoding 改变字节；弱 ETag 才与「同一主题资源的不同编码」匹配。
  const etag = `W/"${stat.size.toString(16)}-${stat.mtimeMs.toString(16)}"`;
  const requestedV = c.req.query('v');
  const versioned = Boolean(requestedV && requestedV === themes.assetVersion(theme, rel, file));
  const cacheControl = isActive
    ? (versioned ? 'public, max-age=31536000, immutable' : 'public, max-age=300')
    : 'private, no-store';
  if (ifNoneMatch(c, etag)) return c.body(null, 304, { ETag: etag, 'Cache-Control': cacheControl });
  const headers = {
    'Content-Type': MIME[path.extname(file).toLowerCase()] ?? 'application/octet-stream',
    ETag: etag,
    'Cache-Control': cacheControl,
  };
  if (c.req.method === 'HEAD') return c.body(null, 200, headers);
  return c.body(await fs.promises.readFile(file), 200, headers);
});

app.get('/uploads/*', (c) => sendFile(c, c.req.path, { root: UPLOADS_DIR, prefix: '/uploads' }));
app.get('/favicon.ico', (c) => c.body(null, 204));

// PWA 清单动态生成：图标 URL 带内容指纹，换图后 manifest 里的引用也跟着换；
// 清单本身只发 no-cache（下方默认中间件也会这么兜），浏览器每次校验一次，几十字节。
app.get('/site.webmanifest', (c) => {
  const icon = (file) => `/${file}?v=${assetVer(file)}`;
  const manifest = {
    id: '/',
    name: SITE.identity,
    short_name: SITE.title || SITE.identity,
    description: SITE.desc,
    lang: SITE.lang,
    start_url: '/',
    scope: '/',
    display: 'standalone',
    background_color: '#faf8f4',
    theme_color: '#faf8f4',
    icons: [
      { src: icon('icon-192.png'), sizes: '192x192', type: 'image/png' },
      { src: icon('icon-512.png'), sizes: '512x512', type: 'image/png' },
      { src: icon('icon-maskable-512.png'), sizes: '512x512', type: 'image/png', purpose: 'maskable' },
    ],
  };
  return c.body(JSON.stringify(manifest), 200, {
    'Content-Type': 'application/manifest+json; charset=utf-8',
    'Cache-Control': 'no-cache',
  });
});


// 只给已审核评论出现过的邮箱 md5 回源；任意 hash 不再能消耗上游预算/做枚举。
const knownAvatars = createKnownAvatars({
  comments, crypt, siteEmail: SITE.email, log: (line) => console.log(line),
});
// 启动时预热“已知邮箱”集合；重建分批让出事件循环，不阻塞监听。
void knownAvatars.refresh?.();
app.route('/', avatarRoutes(avatarCache, { isKnown: knownAvatars }));


const commentNotifier = createCommentNotifier({ repo, comments, crypt, mail: outbox });
app.route('/', adminRoutes({
  repo, comments, adminRepo, crypt, auth, renderer, scheduleBackup, notifier: commentNotifier,
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
    clearInterval(backupInterval);
    if (feedInterval) clearInterval(feedInterval);
    if (feedBoot) clearTimeout(feedBoot);
    if (linkInterval) clearInterval(linkInterval);
    if (linkBoot) clearTimeout(linkBoot);
    if (backupCatchup) clearTimeout(backupCatchup);
    if (logRotateTimer) clearInterval(logRotateTimer);
    watchdog.stop();
    outbox.stop();
    // 先把备份 worker 停掉并等它退出，再关主库/释放维护锁；否则另一个实例可能在 worker 仍写备份时启动。
    const workerDone = backupWorker ? backupWorker.terminate().catch(() => {}) : Promise.resolve();
    console.log('\n[server] 正在退出，合并 WAL…');
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

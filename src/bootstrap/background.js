import { rotateLogsAsync } from '../log-rotate.js';
import { optimize } from '../../db/driver.js';

// 定时轮次的生命周期：友圈刷新、友链探活、日志轮转与 SQLite optimize。
// server.js 只负责算间隔、装配依赖与在退出时 stop()，具体定时器与同步异常兜底都在这里，
// 免得关闭流程又漏掉某个句柄。
export function createBackgroundScheduler({
  db,
  refresher,
  linkChecker,
  feedRefreshMs = 0,
  linkCheckMs = 0,
  linkPerRound = Infinity,
  parserChanged = false,
  logRotateMs = 0,
  logDir,
  logMaxMb = 5,
  logKeep = 5,
  log = console.log,
  logError = () => {},
}) {
  let feedInterval = null;
  let feedBoot = null;
  let linkInterval = null;
  let linkBoot = null;
  let logRotateTimer = null;
  let dbOptimizeTimer = null;

  // 定时器回调里刷新/检查会在返回 Promise 前同步读库：DB 临时错误若直接抛出，
  // 会变成未捕获异常从 setInterval 回调里终止进程。统一接住同步异常与 Promise 拒绝。
  const kickFeedRefresh = (options) => {
    try { void refresher.refreshAll(options).catch((error) => logError(error, null, 'feeds.background-failed')); }
    catch (error) { logError(error, null, 'feeds.background-failed'); }
  };
  const kickLinkCheck = (options) => {
    try { void linkChecker.checkAll(options).catch((error) => logError(error, null, 'links.background-failed')); }
    catch (error) { logError(error, null, 'links.background-failed'); }
  };

  function start() {
    if (feedRefreshMs > 0) {
      feedInterval = setInterval(() => kickFeedRefresh(), feedRefreshMs);
      feedInterval.unref();
      // 启动后等 20 秒再首刷：先让索引落定，刚部署完常有人在看，别让首刷抢带宽。
      feedBoot = setTimeout(() => kickFeedRefresh({ force: parserChanged }), 20000);
      feedBoot.unref();
    }

    if (linkCheckMs > 0) {
      linkInterval = setInterval(() => kickLinkCheck({ intervalMs: linkCheckMs, limit: linkPerRound }), linkCheckMs);
      linkInterval.unref();
      linkBoot = setTimeout(() => kickLinkCheck({ limit: linkPerRound }), 40000);
      linkBoot.unref();
    }

    if (logRotateMs > 0) {
      logRotateTimer = setInterval(() => {
        void rotateLogsAsync({ dir: logDir, maxBytes: logMaxMb * 1024 * 1024, keep: logKeep })
          .then((result) => {
            if (result.rotated.length) log(JSON.stringify({ event: 'logs.rotated', files: result.rotated.length, removed: result.removed.length }));
          })
          .catch((error) => console.error(JSON.stringify({ event: 'logs.rotate-failed', code: error?.code ?? 'INTERNAL' })));
      }, logRotateMs);
      logRotateTimer.unref();
    }

    // SQLite 长期运行维护：PRAGMA optimize 在没有过期统计时几乎零成本，每天跑一次让查询计划跟上数据变化。
    // 关闭时 db/driver.js 的 close() 也会再跑一次。定时器不阻止进程退出。
    dbOptimizeTimer = setInterval(() => optimize(db), 24 * 3600 * 1000);
    dbOptimizeTimer.unref();
  }

  function stop() {
    if (feedInterval) clearInterval(feedInterval);
    if (feedBoot) clearTimeout(feedBoot);
    if (linkInterval) clearInterval(linkInterval);
    if (linkBoot) clearTimeout(linkBoot);
    if (logRotateTimer) clearInterval(logRotateTimer);
    if (dbOptimizeTimer) clearInterval(dbOptimizeTimer);
    feedInterval = feedBoot = linkInterval = linkBoot = logRotateTimer = dbOptimizeTimer = null;
  }

  return { start, stop };
}

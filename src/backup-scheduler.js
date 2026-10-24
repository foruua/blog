import { Worker } from 'node:worker_threads';
import { envDurationMs } from './util/env.js';
import { latestRecoverableBackup } from './backup.js';

// 自动备份调度：定时/发布触发、失败退避重试、worker 生命周期与健康状态都收在这里。
// server.js 只负责创建、把 schedule 交给后台路由、退出时 stop()，健康检查从 state() 读字段。
const RETRY_STEPS = [5 * 60 * 1000, 15 * 60 * 1000, 60 * 60 * 1000, 6 * 3600 * 1000];

export function createBackupScheduler({
  identity,
  outbox,
  backgroundWrites,
  backupSummary,
  logError,
  env = process.env,
}) {
  let lastError = null;
  let lastAttemptAt = null;
  let nextRetryAt = null;
  let startedAt = null;
  let retryStep = 0;
  let retryDelayMs = null;
  let alertedAt = 0;
  let runFailed = false;
  let queued = false;
  let worker = null;
  let closed = false;

  function notifyFailure(reason) {
    if (alertedAt && Date.now() - alertedAt < 6 * 3600 * 1000) return;
    alertedAt = Date.now();
    const queuedMail = outbox.enqueue({
      subject: `[告警] ${identity} 自动备份失败`,
      text: [
        '站点自动备份失败。',
        '',
        `原因：${reason}`,
        `时间：${new Date().toISOString()}`,
        nextRetryAt ? `下次重试：${nextRetryAt}` : '',
        '',
        '本地备份与异地备份都会受影响；请登录后台「设置」查看发信队列，或在服务器上检查 backup 日志。',
      ].filter(Boolean).join('\n'),
    });
    if (!queuedMail?.queued) {
      // 入队失败（库暂时不可写等）就别把“已告警”钉死，下一轮失败再试。
      alertedAt = 0;
      console.log(JSON.stringify({ event: 'backup.alert-queued-failed', reason: queuedMail?.reason ?? 'unknown' }));
    }
  }

  function recordFailure(reason) {
    if (runFailed) return;
    runFailed = true;
    lastAttemptAt = new Date().toISOString();
    lastError = { at: lastAttemptAt, reason: String(reason ?? 'unknown').slice(0, 300) };
    retryStep = Math.min(retryStep + 1, RETRY_STEPS.length);
    retryDelayMs = RETRY_STEPS[retryStep - 1] ?? RETRY_STEPS.at(-1);
    nextRetryAt = new Date(Date.now() + retryDelayMs).toISOString();
    notifyFailure(lastError.reason);
  }

  function schedule(delayMs = 0) {
    if (queued || closed) return;
    queued = true;

    // 不占全局写队列：备份的一致性由 SQLite 的 VACUUM INTO + 文件树 mtime 校验保证，评论/设置这类
    // 只写库的操作不该排队等整次备份；文章/上传/主题变更会触发快照失败并在 worker 里重试。
    setTimeout(() => {
      if (closed) { queued = false; return; }
      startedAt = Date.now();
      runFailed = false;
      let current;
      try { current = new Worker(new URL('./backup-worker.js', import.meta.url)); }
      catch (error) {
        // 起不来必须立刻放标志位，否则自动备份会被永久静默关闭；同时按失败处理，避免只留一行日志。
        queued = false;
        startedAt = null;
        console.error(JSON.stringify({ event: 'backup.failed', code: error.code ?? 'WORKER_START' }));
        recordFailure(`备份 worker 启动失败（${error.code ?? 'WORKER_START'}）`);
        const retry = retryDelayMs;
        retryDelayMs = null;
        if (retry) schedule(retry);
        return;
      }
      worker = current;
      let resumeBackgroundWrites = () => {};
      try { resumeBackgroundWrites = backgroundWrites.pause(); }
      catch (error) {
        // 屏障已存在（另一个后台写还在飞）：本次跳过，别让同步异常从定时器里炸掉进程。
        queued = false;
        worker = null;
        startedAt = null;
        logError(error, null, 'backup.barrier');
        void current.terminate();
        return;
      }
      let released = false;
      const releaseWrites = () => { if (!released) { released = true; resumeBackgroundWrites(); } };
      // 自检 + 异地 rsync 允许 15 分钟；给 worker 留足余量，别再 3 分钟就把上传中的异地备份杀掉。
      const timer = setTimeout(() => {
        console.error(JSON.stringify({ event: 'backup.timeout' }));
        recordFailure('备份超时（15 分钟）');
        void current.terminate();
      }, 15 * 60 * 1000);
      current.on('message', (message) => {
        backupSummary.invalidate();
        if (message.event === 'backup.local-ready') releaseWrites();
        if (message.event === 'backup.completed') {
          lastError = null;
          lastAttemptAt = new Date().toISOString();
          nextRetryAt = null;
          retryStep = 0;
          retryDelayMs = null;
          alertedAt = 0;
        } else if (message.event === 'backup.failed') {
          recordFailure(message.reason ?? message.code ?? '备份失败');
        } else if (message.event === 'backup.incomplete') {
          recordFailure(message.reason ?? '备份不完整');
        }
        console.log(JSON.stringify(message));
      });
      current.on('error', (error) => {
        if (!closed) recordFailure(`备份 worker 异常（${error?.code ?? 'WORKER_FAILED'}）`);
        console.error(JSON.stringify({ event: 'backup.failed', code: error.code ?? 'WORKER_FAILED', message: String(error?.message ?? '').slice(0, 300) }));
      });
      current.on('exit', (code, signal) => {
        clearTimeout(timer);
        queued = false;
        worker = null;
        startedAt = null;
        releaseWrites();
        // worker 自己崩溃/被 SIGKILL 时不会走 message 分支；这里兜住，否则失败会被静默吞掉。
        if (!closed && !runFailed && (code !== 0 || signal)) recordFailure(`备份 worker 退出（${signal ?? code}）`);
        const retry = retryDelayMs;
        retryDelayMs = null;
        if (retry && !closed) schedule(retry);
      });
    }, Math.max(0, Number(delayMs) || 0)).unref();
  }

  const autoOn = env.BACKUP_ON_PUBLISH !== 'false';
  // 0 = 关闭自动备份，与 FEED_REFRESH_MS 等其它间隔约定一致；min 只约束非零值。
  const intervalMs = envDurationMs(env.BACKUP_INTERVAL_MS, 6 * 3600000, { min: 60000 });
  const interval = autoOn ? setInterval(() => schedule(), intervalMs) : null;
  interval?.unref();

  // 启动补做：只要「启动后不到一个间隔又重启」，纯 setInterval 就永远排不上。
  let catchup = null;
  if (autoOn) {
    const lastBackup = latestRecoverableBackup();
    const lastAgeMs = lastBackup?.createdAt ? Date.now() - Date.parse(lastBackup.createdAt) : null;
    if (lastAgeMs === null || lastAgeMs >= intervalMs) {
      const delay = Math.min(90000, Math.max(5000, Math.round(intervalMs / 20)));
      catchup = setTimeout(schedule, delay);
      catchup.unref();
      console.log(JSON.stringify({ event: 'backup.catchup', lastAgeSec: lastAgeMs === null ? null : Math.round(lastAgeMs / 1000), delayMs: delay }));
    }
  }

  function stop() {
    closed = true;
    if (interval) clearInterval(interval);
    if (catchup) clearTimeout(catchup);
    return worker ? worker.terminate().catch(() => {}) : Promise.resolve();
  }

  return {
    schedule,
    stop,
    state: () => ({ running: Boolean(worker), queued, startedAt, lastError, lastAttemptAt, nextRetryAt }),
  };
}

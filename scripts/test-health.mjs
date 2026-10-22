#!/usr/bin/env node
// /healthz 的授权字段：磁盘、数据库/WAL、备份 worker 状态与最近错误；匿名请求不泄露这些内部信息。
import './_test-env.mjs';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createChecker, waitFor } from './_check.mjs';
import { startServer } from './_server.mjs';

const { check, report } = createChecker();
const baseEnv = {
  FEED_REFRESH_MS: '0',
  LINK_CHECK_MS: '0',
  WATCHDOG_INTERVAL_MS: '0',
  HEALTH_MIN_DISK_FREE_BYTES: '0',
};
const srv = await startServer({
  isolateDb: true,
  env: { ...baseEnv, MONITOR_TOKEN: 'health-test-token' },
});

try {
  const auth = await fetch(`${srv.base}/healthz`, { headers: { 'x-monitor-token': 'health-test-token' } });
  const body = await auth.json();
  check('T1 带 token 的 /healthz 返回 200', auth.status === 200 && body.ok === true, `${auth.status} ${JSON.stringify(body).slice(0, 120)}`);
  check('T2 返回磁盘剩余/总量', Number.isFinite(body.diskFreeBytes) && Number.isFinite(body.diskTotalBytes)
    && body.diskFreeBytes > 0 && body.diskTotalBytes > 0, `${body.diskFreeBytes} / ${body.diskTotalBytes}`);
  check('T3 返回数据库与 WAL 大小', Number.isFinite(body.dbBytes) && body.dbBytes > 0
    && Number.isFinite(body.dbWalBytes) && body.dbWalBytes >= 0, `${body.dbBytes} / ${body.dbWalBytes}`);
  check('T4 返回备份 worker 状态', ['idle', 'queued', 'running'].includes(body.backupWorkerState), String(body.backupWorkerState));
  check('T5 暂无失败时不伪造错误', body.backupLastError === null, JSON.stringify(body.backupLastError));
  check('T6 没有可恢复备份时如实返回 null', body.latestRecoverableBackupAgeSec === null, String(body.latestRecoverableBackupAgeSec));

  const anon = await fetch(`${srv.base}/healthz`);
  const anonBody = await anon.json();
  check('T7 匿名请求仍可用，但不含磁盘/备份内部字段',
    anon.status === 200 && typeof anonBody.ok === 'boolean' && anonBody.diskFreeBytes === undefined
    && anonBody.backupLastError === undefined && anonBody.latestRecoverableBackupAgeSec === undefined,
    JSON.stringify(anonBody));
} finally {
  await srv.stop();
}

// 备份失败：worker 起不来/快照失败时要进健康字段并安排重试，而不是只留一行日志。
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'blog-health-backup-'));
const blocker = path.join(root, 'blocker');
fs.writeFileSync(blocker, 'not a directory');
const broken = await startServer({
  isolateDb: true,
  env: {
    ...baseEnv,
    MONITOR_TOKEN: 'health-test-token',
    BACKUP_ON_PUBLISH: 'true',
    BACKUP_INTERVAL_MS: '60000',
    BACKUP_DIR: path.join(blocker, 'backups'),
  },
});
try {
  const health = await waitFor(async () => {
    const r = await fetch(`${broken.base}/healthz`, { headers: { 'x-monitor-token': 'health-test-token' } });
    const b = await r.json();
    return b.backupLastError ? b : null;
  }, { timeoutMs: 15000, stepMs: 250 });
  check('T8 备份失败后 /healthz 暴露 backupLastError',
    Boolean(health?.backupLastError?.reason), JSON.stringify(health?.backupLastError));
  check('T9 失败后安排了下次重试', Number(health?.backupNextRetryInSec) > 0, String(health?.backupNextRetryInSec));
  check('T10 失败后 worker 不再处于 running', ['idle', 'queued'].includes(health?.backupWorkerState), String(health?.backupWorkerState));
} finally {
  await broken.stop();
  fs.rmSync(root, { recursive: true, force: true });
}

process.exit(report() ? 1 : 0);

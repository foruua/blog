import fs from 'node:fs';
import { envInt } from './util/env.js';
import { offsiteStale } from './monitor.js';

// 健康检查口径：/healthz、进程内看门狗共用同一份实现，避免两处漂移。
// 备份年龄/异地新鲜度不在这里判——/healthz 只回报字段、由探针侧判，本地检查（localHealth）才有完整语义。
export function createHealthMonitor({
  repo, dataDir, dbFile, backupSummary, backupState, maxAgeSec, requireOffsite,
}) {
  // 磁盘/WAL 的硬阈值：磁盘满会同时坏掉 SQLite、上传和备份；WAL 异常膨胀通常意味着长事务或检查点失败。
  // 默认 512MB 对个人站点足够宽，环境变量可覆盖（设 0 = 不按该项判定，健康检查仍会返回数值）。
  const minDiskFreeBytes = envInt(process.env.HEALTH_MIN_DISK_FREE_BYTES, 512 * 1024 * 1024, { min: 0, max: 1024 ** 4 });
  const maxWalBytes = envInt(process.env.HEALTH_MAX_WAL_BYTES, 512 * 1024 * 1024, { min: 0, max: 1024 ** 4 });
  const backupTimeoutSec = envInt(process.env.HEALTH_BACKUP_TIMEOUT_SEC, 20 * 60, { min: 60, max: 24 * 3600 });

  function diskStats() {
    const out = { diskFreeBytes: null, diskTotalBytes: null, dbBytes: null, dbWalBytes: null };
    try {
      const s = fs.statfsSync(dataDir);
      out.diskFreeBytes = Number(s.bavail) * Number(s.bsize);
      out.diskTotalBytes = Number(s.blocks) * Number(s.bsize);
    } catch { /* 平台不支持 statfs 时只返回 null，不阻断健康检查 */ }
    try { out.dbBytes = fs.statSync(dbFile).size; } catch { /* 数据库刚被移走 */ }
    try { out.dbWalBytes = fs.statSync(`${dbFile}-wal`).size; } catch { out.dbWalBytes = 0; }
    return out;
  }

  function healthSnapshot() {
    const backup = backupState();
    return {
      ...diskStats(),
      backupWorkerState: backup.running ? 'running' : (backup.queued ? 'queued' : 'idle'),
      backupLastError: backup.lastError,
      backupLastAttemptAt: backup.lastAttemptAt,
      backupNextRetryAt: backup.nextRetryAt,
      backupStartedAt: backup.startedAt ? new Date(backup.startedAt).toISOString() : null,
      rssBytes: process.memoryUsage().rss,
    };
  }

  function infraHealth() {
    const disk = diskStats();
    if (minDiskFreeBytes > 0 && Number.isFinite(disk.diskFreeBytes) && disk.diskFreeBytes < minDiskFreeBytes) {
      return { ok: false, reason: `磁盘剩余空间不足：${Math.round(disk.diskFreeBytes / 1048576)}MB < ${Math.round(minDiskFreeBytes / 1048576)}MB` };
    }
    if (maxWalBytes > 0 && Number.isFinite(disk.dbWalBytes) && disk.dbWalBytes > maxWalBytes) {
      return { ok: false, reason: `SQLite WAL 过大：${Math.round(disk.dbWalBytes / 1048576)}MB > ${Math.round(maxWalBytes / 1048576)}MB` };
    }
    const startedAt = backupState().startedAt;
    if (startedAt && Date.now() - startedAt > backupTimeoutSec * 1000) {
      return { ok: false, reason: '备份任务运行时间过长' };
    }
    return { ok: true, reason: '基础设施正常' };
  }

  // 本地部分直接读库，不必绕 HTTP 一圈；公网可达性才必须走网络。
  function localHealth() {
    try { repo.stats(); } catch { return { ok: false, reason: '数据库读取失败' }; }
    const infra = infraHealth();
    if (!infra.ok) return infra;
    const { recoverable } = backupSummary.get();
    if (!recoverable) return { ok: false, reason: '没有可完整恢复的备份' };
    const age = Math.round((Date.now() - Date.parse(recoverable.createdAt)) / 1000);
    if (!Number.isFinite(age) || age > maxAgeSec) return { ok: false, reason: '可恢复备份已过期' };
    if (requireOffsite) {
      let offsite = null;
      try { offsite = JSON.parse(repo.getSetting('backup_offsite_status') ?? 'null'); } catch { /* 未记录 */ }
      if (offsiteStale(offsite, maxAgeSec)) return { ok: false, reason: '异地备份未成功或已过期' };
    }
    return { ok: true, reason: '本地检查正常' };
  }

  return { healthSnapshot, infraHealth, localHealth };
}

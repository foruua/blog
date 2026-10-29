import path from 'node:path';
import { parentPort, workerData } from 'node:worker_threads';
import { open } from '../db/driver.js';
import { DB_FILE } from './config.js';
import { maybeAutoBackup, verifyBackupLite, finalizeBackup, recordOffsiteResult, latestRecoverableBackup } from './backup.js';
import { uploadBackup } from './util/process.js';
const db = open(DB_FILE);
const { force = false, offsiteOnly = false } = workerData ?? {};
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
// 不再独占写队列后，备份期间的一次文章保存/上传会让文件树校验失败；隔几秒重试，而不是等下一轮 6 小时。
async function localBackup() {
  for (let attempt = 0; ; attempt++) {
    try { return await maybeAutoBackup(db, { force }); }
    catch (error) {
      if (attempt >= 2 || !/并发写入|内容文件发生变化|SQLITE_BUSY|database is locked|ENOENT|ENOTDIR|EACCES|EPERM|EBUSY/i.test(String(error?.message ?? ''))) throw error;
      await sleep(5000);
    }
  }
}
try {
  if (offsiteOnly) {
    // 上一次本地快照已经成功，只是异地推送失败：只补推最新一份，避免每 5 分钟重做一次 VACUUM + 打包。
    // 没有本地快照阶段，立刻放开后台写屏障，别让一次异地 rsync 卡住友圈刷新。
    parentPort.postMessage({ event: 'backup.local-ready' });
    const last = latestRecoverableBackup();
    if (!last) throw new Error('异地备份失败：没有可恢复的备份可补推');
    // latestRecoverableBackup() 来自 listBackups，只带 name/dir；uploadBackup/recordOffsiteResult 需要文件路径。
    const assetsName = last.assetsName ?? `${last.name}.assets.json.gz`;
    const backup = {
      ...last,
      gzFile: path.join(last.dir, `${last.name}.db.gz`),
      assetsFile: path.join(last.dir, assetsName),
      manifestFile: path.join(last.dir, `${last.name}.json`),
    };
    const remote = await uploadBackup(backup);
    recordOffsiteResult(db, backup, remote);
    if (!remote.ok) throw new Error('异地备份失败：' + remote.reason);
    parentPort.postMessage({ event: 'backup.completed', bytes: last.gzBytes ?? 0, ms: 0, offsite: !remote.skipped });
  } else {
    const result = await localBackup();
    if (result.backup) {
      // 快照与内容归档已经落盘，写队列可以放了；自检只读备份文件，放到队列外做，
      // 别让解压/哈希校验继续堵住评论和保存。
      parentPort.postMessage({ event: 'backup.local-ready' });
      const name = path.basename(result.backup.gzFile).replace('.db.gz', '');
      const checked = await verifyBackupLite(name);
      if (!checked.ok) throw new Error(`备份自检失败：${(checked.reasons ?? []).join('；')}`);
      // 只有自检通过后才标 verified 并 prune：坏包不能在此之前挤掉旧的好备份。
      finalizeBackup(name);
      if (!checked.manifest.complete) {
        // 缺失附件等只影响完整性，不把文件删掉：本地仍可用于人工提取；不往异地推残缺包。
        parentPort.postMessage({ event: 'backup.incomplete', reason: '备份缺少文件，未上传异地' });
      } else {
        const remote = await uploadBackup(result.backup);
        recordOffsiteResult(db, result.backup, remote);
        if (!remote.ok) throw new Error('异地备份失败：' + remote.reason);
        parentPort.postMessage({ event: 'backup.completed', bytes: result.backup.gzBytes, ms: result.backup.ms, offsite: !remote.skipped });
      }
    } else parentPort.postMessage({ event: 'backup.skipped', reason: result.skipped });
  }
} catch (error) { parentPort.postMessage({ event: 'backup.failed', reason: error.message }); }
finally {
  // 直接关连接，不走 driver 的 close()：后者会跑 wal_checkpoint(TRUNCATE)，那要拿写锁并等主线程
  // 的读者退出 —— 在 worker 里等于把主线程的写入卡住。checkpoint 交给主线程自己做。
  try { db.close(); } catch { /* 关不掉也不影响 worker 退出 */ }
}

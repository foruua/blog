import path from 'node:path';
import { parentPort } from 'node:worker_threads';
import { open, close } from '../db/driver.js';
import { DB_FILE } from './config.js';
import { maybeAutoBackup, verifyBackupLite, finalizeBackup, recordOffsiteResult } from './backup.js';
import { uploadBackup } from './util/process.js';
const db = open(DB_FILE);
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
// 不再独占写队列后，备份期间的一次文章保存/上传会让文件树校验失败；隔几秒重试，而不是等下一轮 6 小时。
async function localBackup() {
  for (let attempt = 0; ; attempt++) {
    try { return await maybeAutoBackup(db); }
    catch (error) {
      if (attempt >= 2 || !/并发写入|内容文件发生变化|SQLITE_BUSY|database is locked|ENOENT|ENOTDIR|EACCES|EPERM|EBUSY/i.test(String(error?.message ?? ''))) throw error;
      await sleep(5000);
    }
  }
}
try {
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
} catch (error) { parentPort.postMessage({ event: 'backup.failed', reason: error.message }); }
finally { close(db); }

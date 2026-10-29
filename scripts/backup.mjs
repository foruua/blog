import { parseFlags } from './_cli.mjs';
import { acquireMaintenanceLock } from '../src/util/lock.js';

import path from 'node:path';
import { uploadBackup } from '../src/util/process.js';
import { open, close } from '../db/driver.js';
import { DB_FILE, CONTENT_DIR, UPLOADS_DIR } from '../src/config.js';
import { snapshot, listBackups, verifyBackupLite, DEFAULT_DIR, DEFAULT_KEEP, recordOffsiteResult, isRecoverableBackup } from '../src/backup.js';

const { has, opt } = parseFlags();

const DIR = opt('--dir') ?? DEFAULT_DIR;
const REMOTE = opt('--remote') ?? process.env.BACKUP_REMOTE ?? '';
const HOOK = opt('--hook') ?? process.env.BACKUP_HOOK ?? '';

const kb = (n) => `${(n / 1024).toFixed(1)}KB`;

if (has('--list')) {
  const rows = listBackups(DIR);
  console.log(`备份目录 ${DIR} —— 共 ${rows.length} 份`);
  for (const r of rows) {
    const age = ((Date.now() - Date.parse(r.createdAt)) / 3600000).toFixed(1);
    console.log(`  ${r.name}  ${kb(r.gzBytes).padStart(9)}  文章 ${r.counts?.posts ?? '?'}  评论 ${r.counts?.comments ?? '?'}  ${age}h 前  [${r.label}]  ${isRecoverableBackup(r) ? '完整归档' : '不具备完整恢复资格'}`);
  }
  process.exit(0);
}

// 以前直接 Number()：`--keep abc` 得 NaN，snapshot/prune 当成不清理、命令还报成功，备份就悄悄堆到写满磁盘。
const KEEP_RAW = opt('--keep') ?? process.env.BACKUP_KEEP ?? String(DEFAULT_KEEP);
const KEEP = Number(KEEP_RAW);
if (!Number.isInteger(KEEP) || KEEP < 0) {
  console.error(`✗ --keep 需要一个非负整数（0 表示不清理），收到：${KEEP_RAW}`);
  process.exit(2);
}

console.log(`\n备份 ${DB_FILE}`);
console.log('─'.repeat(52));

// 主题目录在应用根下，生产环境归 root 只读；服务自身的自动备份也不锁它。
// 手动备份要求先停服，DB 锁已经能阻止服务并发写，别为了主题锁把发布流程卡死。
// 返回值故意不接：这把锁要持有到进程退出——下面的 recordOffsiteResult（若有 --remote/--hook）
// 也得在锁内写。别「修复」成用完即 release，否则异地状态写入就不在锁保护里了。
acquireMaintenanceLock([DB_FILE, CONTENT_DIR, UPLOADS_DIR], 'backup');
const db = open(DB_FILE);
let result;
try {
  result = await snapshot(db, { dir: DIR, keep: KEEP, label: opt('--label') ?? 'manual' });
} finally {
  close(db);
}
console.log(`  ✓ 快照完成        ${kb(result.dbBytes)} 原始 → ${kb(result.gzBytes)} gzip  （${result.ms}ms）`);
console.log(`  ✓ 压缩前 sha256   ${result.sha256.slice(0, 32)}…`);
console.log(`  ✓ 行数           文章 ${result.counts.posts} / 已发布 ${result.counts.published} / 评论 ${result.counts.comments} / 修订 ${result.counts.revisions}`);
console.log(`  ✓ 文件            ${result.gzFile}`);
console.log(`  ✓ 内容、附件与主题 ${result.assetsFile}（${result.assetFiles} 个文件，主题 ${result.themeFiles ?? 0} 个）`);

// 手动备份也只做流式自检：整包 gunzip 进内存在大站点上会把进程顶到 GB 级。
const v = await verifyBackupLite(path.basename(result.gzFile).replace(/\.db\.gz$/, ''), { dir: DIR });
if (!v.ok || !result.complete) {
  console.error(`  ✗ 备份自检失败：${v.reasons.join('；') || '归档跳过软链或缺失文件'}`);
  process.exit(1);
}
console.log('  ✓ 自检通过        sha256 与大小一致，可解压');

if (result.pruned) console.log(`  ✓ 清理旧备份      移除 ${result.pruned} 个文件（保留最近 ${KEEP} 份）`);

const remote = await uploadBackup(result, { remote: REMOTE, hook: HOOK });
const statusDb = open(DB_FILE);
try { recordOffsiteResult(statusDb, result, remote); } finally { close(statusDb); }
const offsiteOk = remote.ok;
if (remote.skipped) console.log('  · 本地备份完成，未配置异地备份');
else console.log(offsiteOk ? '  ✓ 完整备份已同步异地' : '  ✗ 异地同步失败或超时');

console.log('─'.repeat(52));
console.log(offsiteOk ? '  备份完成\n' : '  本地备份完成，但异地同步有问题\n');
process.exit(offsiteOk ? 0 : 1);

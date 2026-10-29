import path from 'node:path';
import crypto from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import { DB_FILE, CONTENT_DIR, UPLOADS_DIR, DATA_DIR } from '../src/config.js';
import { acquireMaintenanceLock } from '../src/util/lock.js';
import { obsoleteMediaPlan } from '../src/media/cleanup.js';
import { mediaFile } from '../src/media/paths.js';
import { moveFile } from '../src/content/commit.js';
import { atomicWrite } from '../src/util/files.js';

const apply = process.argv.includes('--apply');
const release = apply ? acquireMaintenanceLock([DB_FILE, CONTENT_DIR, UPLOADS_DIR], 'cleanup-media') : () => {};
const db = new DatabaseSync(DB_FILE, { readOnly: true });
try {
  const plan = obsoleteMediaPlan(db, { contentDir: CONTENT_DIR, uploadsDir: UPLOADS_DIR });
  console.log(`${apply ? '回收' : '待回收'} ${plan.length} 个旧派生文件，共 ${(plan.reduce((n, f) => n + f.bytes, 0) / 1048576).toFixed(2)}MiB`);
  for (const item of plan) console.log(`  ${item.path}`);
  if (apply && plan.length) {
    const stamp = `${Date.now()}-${crypto.randomUUID()}`;
    const trashDir = path.join(DATA_DIR, '.trash', 'uploads');
    const manifest = { createdAt: new Date().toISOString(), files: plan.map((item, index) => ({
      ...item, trash: path.join(trashDir, `${stamp}-${index}.derived-${path.basename(item.path)}`),
    })) };
    // 先持久化原地址映射；中断时仍可按映射找回已经移动的文件。
    const manifestFile = path.join(DATA_DIR, 'cleanup-media', stamp + '.json');
    atomicWrite(manifestFile, JSON.stringify(manifest, null, 2));
    let failedMoves = 0;
    for (const item of manifest.files) {
      try { moveFile(mediaFile(item.path), item.trash); }
      catch (error) { failedMoves++; console.error(`移动失败：${item.path}（${error.code ?? error.message}）`); }
    }
    console.log(`已移入回收站；恢复映射：${manifestFile}`);
    // cron/运维链路上「部分失败」不能被当成成功：让调用方看到非零退出码。
    if (failedMoves) { console.error(`✗ ${failedMoves} 个文件移动失败`); process.exitCode = 1; }
  }
} finally { db.close(); release(); }

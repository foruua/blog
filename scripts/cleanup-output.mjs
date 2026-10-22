import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { moveFile } from '../src/content/commit.js';
import { atomicWrite } from '../src/util/files.js';
import { staleOutputPlan } from '../src/util/output.js';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../output');
const daysIndex = process.argv.indexOf('--days');
const daysRaw = daysIndex < 0 ? '30' : process.argv[daysIndex + 1];
if (!/^\d+$/.test(daysRaw ?? '') || Number(daysRaw) < 1) {
  console.error('--days 需要正整数');
  process.exit(2);
}
const files = staleOutputPlan(root, { maxAgeMs: Number(daysRaw) * 86400000 });
console.log(`超过 ${daysRaw} 天的截图与测试日志：${files.length} 个，${(files.reduce((n, f) => n + f.bytes, 0) / 1048576).toFixed(2)}MiB`);
for (const file of files) console.log('  ' + file.path);
if (process.argv.includes('--apply') && files.length) {
  const trash = path.join(root, '.trash', `${Date.now()}-${crypto.randomUUID()}`);
  atomicWrite(path.join(trash, 'manifest.json'), JSON.stringify({ createdAt: new Date().toISOString(), files }, null, 2));
  for (const file of files) {
    const source = path.join(root, file.path);
    let stat;
    try { stat = fs.lstatSync(source); } catch { continue; }   // 扫描到移动之间被清理/替换
    if (!stat.isFile() || stat.size !== file.bytes || stat.mtimeMs !== file.mtimeMs) continue;
    try { moveFile(source, path.join(trash, file.path)); }
    catch (error) { console.error(`移动失败：${file.path}（${error.code ?? error.message}）`); }
  }
  console.log(`已移入 ${trash}；压缩归档、部署产物与符号链接保留。`);
}

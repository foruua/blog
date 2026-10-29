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
// output/.trash 是本脚本自己建的归档目录；staleOutputPlan 跳过「.」开头目录，
// 以前每跑一次 --apply 就往里留一份，永远没人清。这里按目录 mtime 单独回收。
const trashRoot = path.join(root, '.trash');
const trashDirs = (() => {
  let entries;
  try { entries = fs.readdirSync(trashRoot, { withFileTypes: true }); } catch { return []; }
  const cutoff = Date.now() - Number(daysRaw) * 86400000;
  return entries.filter((e) => e.isDirectory())
    .map((e) => path.join(trashRoot, e.name))
    .filter((dir) => {
      try { return fs.statSync(dir).mtimeMs < cutoff; } catch { return false; }
    });
})();
console.log(`超过 ${daysRaw} 天的截图与测试日志：${files.length} 个，${(files.reduce((n, f) => n + f.bytes, 0) / 1048576).toFixed(2)}MiB`);
for (const file of files) console.log('  ' + file.path);
if (trashDirs.length) console.log(`output/.trash 中超过 ${daysRaw} 天的归档：${trashDirs.length} 个`);
if (process.argv.includes('--apply') && (files.length || trashDirs.length)) {
  for (const dir of trashDirs) {
    try { fs.rmSync(dir, { recursive: true, force: true }); console.log(`  已删除归档 ${path.relative(root, dir)}`); }
    catch (error) { console.error(`归档删除失败：${path.relative(root, dir)}（${error.code ?? error.message}）`); }
  }
  if (files.length) {
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
}

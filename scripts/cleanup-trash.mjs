// 回收站清理：默认只列清单，--apply 才真删。只动 .trash，不碰数据库、正文与上传目录，
// 因此服务运行时也能跑；启动时的自动清理（server.js）与本脚本共用 src/util/trash.js 的口径。
//
//   npm run cleanup:trash                     # 列清单（原图 90 天，派生图 7 天）
//   npm run cleanup:trash -- --derived        # 所有可再生的缩略图/变体都列入（不论年龄）
//   npm run cleanup:trash -- --days 30        # 原图保留期改成 30 天
//   npm run cleanup:trash -- --legacy         # 认不出删除时刻的历史文件按 mtime 算
//   npm run cleanup:trash -- --apply          # 执行删除
import fs from 'node:fs';
import path from 'node:path';
import { DATA_DIR, CONTENT_DIR, THEMES_DIR } from '../src/config.js';
import {
  TRASH_RETENTION_DAYS, TRASH_DERIVED_RETENTION_DAYS,
  scanTrash, trashPlan, scanTrashDirs, trashDirPlan,
} from '../src/util/trash.js';

const args = process.argv.slice(2);
const apply = args.includes('--apply');
const allDerived = args.includes('--derived');
const legacy = args.includes('--legacy');

const daysArg = (() => {
  const inline = args.find((a) => a.startsWith('--days='));
  const spaced = args.indexOf('--days');
  if (!inline && spaced < 0) return null;
  const raw = inline ? inline.slice('--days='.length)
    : (args[spaced + 1] && !args[spaced + 1].startsWith('--') ? args[spaced + 1] : null);
  if (raw == null) {
    console.error('--days 需要一个大于等于 0 的数字');
    process.exit(2);
  }
  const n = Number(raw);
  if (!Number.isFinite(n) || n < 0) {
    console.error('--days 需要大于等于 0 的数字');
    process.exit(2);
  }
  return n;
})();

const keepDays = daysArg ?? TRASH_RETENTION_DAYS;
const derivedMs = allDerived ? 0 : TRASH_DERIVED_RETENTION_DAYS * 86400000;
const roots = [path.join(DATA_DIR, '.trash', 'uploads'), path.join(CONTENT_DIR, '.trash')];
// 主题回收站放的是目录（themes/.trash/<id>-<时间戳>），文件扫描器看不到，单独走目录版。
const themeRoots = [path.join(THEMES_DIR, '.trash')];

const all = scanTrash(roots);
const plan = trashPlan(roots, {
  maxAgeMs: keepDays * 86400000,
  includeLegacy: legacy,
  derivedMaxAgeMs: derivedMs,
});
const themeAll = scanTrashDirs(themeRoots);
const themePlan = trashDirPlan(themeRoots, { maxAgeMs: keepDays * 86400000, includeLegacy: legacy });
const planned = new Set(plan.map((item) => item.path));
const kept = all.filter((item) => !planned.has(item.path));
const mb = (bytes) => `${(bytes / 1048576).toFixed(1)} MiB`;
const sizeOf = (list) => list.reduce((n, item) => n + item.bytes, 0);
const countOf = (list, derived) => list.filter((item) => item.derived === derived).length;

console.log(`回收站：${roots.map((root) => path.relative(process.cwd(), root)).join('、')}`);
console.log(`保留期：原图 ${keepDays} 天${allDerived ? '；派生图 全部清理（--derived）' : `；派生图 ${TRASH_DERIVED_RETENTION_DAYS} 天`}${legacy ? '；历史文件按 mtime' : ''}`);
console.log(`当前：${all.length} 个文件，${mb(sizeOf(all))}（原图 ${countOf(all, false)} 个 / 派生图 ${countOf(all, true)} 个）`);
console.log(`待删：${plan.length} 个文件，${mb(sizeOf(plan))}（原图 ${countOf(plan, false)} 个 / 派生图 ${countOf(plan, true)} 个）`);
if (kept.length) console.log(`保留：${kept.length} 个文件，${mb(sizeOf(kept))}`);
if (themeAll.length) console.log(`主题回收站：${themeAll.length} 个，待删 ${themePlan.length} 个（保留期 ${keepDays} 天）`);

if (!plan.length && !themePlan.length) {
  console.log('没有到期文件。');
} else if (!apply) {
  console.log('这是预演；确认后加 --apply 执行。');
} else {
  let removed = 0, bytes = 0;
  for (const item of plan) {
    try {
      fs.rmSync(item.path, { force: true });
      removed++; bytes += item.bytes;
    } catch (error) {
      console.error(`删除失败：${item.path}（${error.code ?? error.message}）`);
    }
  }
  let removedThemes = 0;
  for (const item of themePlan) {
    try { fs.rmSync(item.path, { recursive: true, force: true }); removedThemes++; }
    catch (error) { console.error(`删除失败：${item.path}（${error.code ?? error.message}）`); }
  }
  console.log(`已删除 ${removed} 个文件，释放 ${mb(bytes)}。`);
  if (removedThemes) console.log(`已删除 ${removedThemes} 个过期主题。`);
  // 部分失败也要让 cron 看到：失败文件下次重扫还在，退出码 0 会掩盖回收失败。
  const failed = (plan.length - removed) + (themePlan.length - removedThemes);
  if (failed) { console.error(`✗ ${failed} 个条目删除失败`); process.exitCode = 1; }
}

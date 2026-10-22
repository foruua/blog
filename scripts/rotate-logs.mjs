#!/usr/bin/env node
// 日志轮转 CLI。逻辑在 src/log-rotate.js —— 服务进程里也按同样的口径每小时跑一次
// （launchd 装不上时靠它兜底），这里只是把它包成一条命令。
//
// 用法：node scripts/rotate-logs.mjs [--dir <目录>] [--max-mb 5] [--keep 5] [--dry-run]
import path from 'node:path';
import { rotateLogs, rotateLogsAsync, resolveLogDir } from '../src/log-rotate.js';

const argv = process.argv.slice(2);
const opt = (flag, fallback) => {
  const i = argv.indexOf(flag);
  return i >= 0 && argv[i + 1] && !argv[i + 1].startsWith('--') ? argv[i + 1] : fallback;
};

const dirArg = opt('--dir', null);
const dir = dirArg ? path.resolve(dirArg) : resolveLogDir();
const maxMb = Number(opt('--max-mb', process.env.LOG_MAX_MB ?? 5));
const keepRaw = Number(opt('--keep', process.env.LOG_KEEP ?? 5));
if (!Number.isFinite(maxMb) || maxMb <= 0) {
  console.error('✗ --max-mb 必须是正数'); process.exit(2);
}
if (!Number.isInteger(keepRaw) || keepRaw < 1) {
  console.error('✗ --keep 必须是大于等于 1 的整数'); process.exit(2);
}
const maxBytes = Math.max(64 * 1024, maxMb * 1024 * 1024);
const keep = keepRaw;
const dryRun = argv.includes('--dry-run');

let result;
try {
  // dry-run 不落盘，走同步版即可；真正轮转用流式 gzip，避免 CLI 把大日志整块读进内存。
  result = dryRun
    ? rotateLogs({ dir, maxBytes, keep, dryRun: true })
    : await rotateLogsAsync({ dir, maxBytes, keep });
} catch (error) {
  console.error(`✗ ${error.message}`);
  process.exit(1);
}

if (result.missing) {
  console.error(`✗ 日志目录不存在：${dir}`);
  process.exit(1);
}
for (const item of result.rotated) {
  const size = `${(item.size / 1048576).toFixed(1)}MB`;
  console.log(dryRun
    ? `· 会轮转 ${item.name}（${size}）→ ${path.basename(item.target)}`
    : `✓ ${item.name} ${size} → ${path.basename(item.target)}`);
}
for (const name of result.removed) console.log(`${dryRun ? '· 会删除' : '−'} ${name}`);
console.log(result.rotated.length ? `轮转完成：${result.rotated.length} 个文件` : '无需轮转');

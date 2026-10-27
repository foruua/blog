import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import zlib from 'node:zlib';
import { pipeline } from 'node:stream/promises';

// launchd 用 O_APPEND 打开日志文件并一直持有 fd，所以不能用「改名 + 新建」那一套——
// 改名后进程还在往旧 inode 里写，新文件永远不会出现。这里用 copytruncate：先复制、再原地清空，
// fd 不变、追加位置回到 0，进程完全无感。代价是复制与截断之间新写入的少量日志会丢，这是
// copytruncate 的固有取舍（要零丢失得让进程配合 reopen，launchd 场景做不到）。

const DEFAULT_LOG_DIR = path.join(os.homedir(), '.local/share/blog-hosting');
const ROTATED_RE = /^(.*)-\d{8}-\d{6}-\d{3}Z\.log\.gz$/;

// 服务与 CLI 共用同一口径；path.resolve() 不展开 ~，这里补上。
export function resolveLogDir(raw = process.env.BLOG_LOG_DIR) {
  const text = String(raw ?? '').trim();
  if (!text) return DEFAULT_LOG_DIR;
  return path.resolve(text.replace(/^~(?=$|\/)/, os.homedir()));
}

// 扫描本轮要看的 .log：只返回真实文件，读不到的直接跳过（并发删除/权限）。
function logFiles(dir) {
  const out = [];
  for (const name of fs.readdirSync(dir).sort()) {
    if (!name.endsWith('.log')) continue;
    const file = path.join(dir, name);
    try { out.push({ name, file, size: fs.statSync(file).size }); } catch { /* 下一轮再看 */ }
  }
  return out;
}

// 同一 base 前缀的 gz 只保留最近 keep 份；按文件名里的时间戳排序。
function pruneRotated(dir, keep, { dryRun = false, removed = [] } = {}) {
  const groups = new Map();
  for (const name of fs.readdirSync(dir)) {
    const match = ROTATED_RE.exec(name);
    if (!match) continue;
    if (!groups.has(match[1])) groups.set(match[1], []);
    groups.get(match[1]).push(name);
  }
  for (const names of groups.values()) {
    for (const stale of names.sort().reverse().slice(keep)) {
      if (dryRun) { removed.push(stale); continue; }
      try { fs.rmSync(path.join(dir, stale), { force: true }); removed.push(stale); } catch { /* 删不掉下次再试 */ }
    }
  }
  return removed;
}

export function rotateLogs({
  dir = DEFAULT_LOG_DIR, maxBytes = 5 * 1024 * 1024, keep = 5, dryRun = false, now = new Date(),
} = {}) {
  if (!fs.existsSync(dir)) return { rotated: [], removed: [], missing: true };
  const stamp = now.toISOString().replace(/[-:]/g, '').replace('.', '-').replace('T', '-');
  const rotated = [];

  for (const { name, file, size } of logFiles(dir)) {
    if (size < maxBytes) continue;

    const target = path.join(dir, `${name.replace(/\.log$/, '')}-${stamp}.log.gz`);
    if (dryRun) { rotated.push({ name, size, target }); continue; }
    try {
      // CLI 的 dry-run 与同步兜底不跑在请求路径上：日志量级是 MB 级，读进内存再 gzip 足够。
      const raw = fs.readFileSync(file);
      fs.writeFileSync(target, zlib.gzipSync(raw), { mode: 0o600 });
      fs.truncateSync(file, 0);
      rotated.push({ name, size: raw.length, target });
    } catch (error) {
      try { fs.rmSync(target, { force: true }); } catch { /* 清掉半成品 */ }
      throw new Error(`${name} 轮转失败：${error.message}`, { cause: error });
    }
  }

  const removed = pruneRotated(dir, keep, { dryRun });
  return { rotated, removed, missing: false };
}

/** 服务进程用：流式 gzip，避免一次 readFile + gzipSync 把大日志读进内存并阻塞事件循环。 */
export async function rotateLogsAsync({
  dir = DEFAULT_LOG_DIR, maxBytes = 5 * 1024 * 1024, keep = 5, now = new Date(),
} = {}) {
  if (!fs.existsSync(dir)) return { rotated: [], removed: [], missing: true };
  const stamp = now.toISOString().replace(/[-:]/g, '').replace('.', '-').replace('T', '-');
  const rotated = [];
  for (const { name, file, size } of logFiles(dir)) {
    if (size < maxBytes) continue;
    const target = path.join(dir, `${name.replace(/\.log$/, '')}-${stamp}.log.gz`);
    try {
      await pipeline(fs.createReadStream(file), zlib.createGzip({ level: 6 }), fs.createWriteStream(target, { mode: 0o600 }));
      fs.truncateSync(file, 0);
      rotated.push({ name, size, target });
    } catch (error) {
      try { fs.rmSync(target, { force: true }); } catch { /* 清掉半成品 */ }
      throw new Error(`${name} 轮转失败：${error.message}`, { cause: error });
    }
  }
  const removed = pruneRotated(dir, keep);
  return { rotated, removed, missing: false };
}

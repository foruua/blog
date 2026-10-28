import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';

export function syncDirectory(dir) {
  // Windows 无法打开目录句柄；文件 fsync 与原子替换仍然执行。
  if (process.platform === 'win32') return;
  const fd = fs.openSync(dir, 'r');
  try { fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
}

// 写文件并把数据本身刷到存储介质（目录项由调用方 syncDirectory 负责）。
export function writeFileDurable(file, data, mode = 0o600) {
  const fd = fs.openSync(file, 'w', mode);
  try {
    fs.writeFileSync(fd, data);
    fs.fsyncSync(fd);
  } finally { fs.closeSync(fd); }
}

export function ensureDurableDirectory(dir, mode = 0o700) {
  const missing = [];
  for (let current = path.resolve(dir); !fs.existsSync(current); current = path.dirname(current)) missing.push(current);
  fs.mkdirSync(dir, { recursive: true, mode });
  for (const created of missing.reverse()) syncDirectory(path.dirname(created));
}

// journal 和内容共用：先持久化文件，再替换目录项，再持久化目录。
export function atomicWrite(file, data, mode = 0o600) {
  const dir = path.dirname(file);
  ensureDurableDirectory(dir);
  const tmp = path.join(dir, `.tmp-${crypto.randomUUID()}`);
  let fd;
  try {
    fd = fs.openSync(tmp, 'wx', mode);
    fs.writeFileSync(fd, data);
    fs.fsyncSync(fd);
    fs.closeSync(fd); fd = undefined;
    fs.renameSync(tmp, file);
    syncDirectory(dir);
  } finally {
    if (fd !== undefined) fs.closeSync(fd);
    fs.rmSync(tmp, { force: true });
  }
}

export function durableRemove(file) {
  fs.rmSync(file, { force: true });
  syncDirectory(path.dirname(file));
}

import fs from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';

const connections = new Map();
export function assertDatabaseClosed(file) {
  if (connections.get(path.resolve(file))) throw new Error('恢复前必须关闭所有数据库连接');
}

// WAL 下 NORMAL 是常规选择：应用崩溃不会丢已提交事务，只可能在 OS/断电时丢最后一个 checkpoint 之后的事务；
// 换来的是每次提交不再强制 fsync。个人博客这一档取舍划算。
export function open(file) {
  // 目录跟着数据库一起收紧到 0700：库里是评论邮箱密文、SMTP 密码与会话密钥，
  // 默认 0755 会让同机其他用户列目录名（备份/上传子目录一并暴露）。已存在的目录不改权限——
  // 那是运维自己的选择，别替人改。
  fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  const db = new DatabaseSync(file);
  db.__file = file;
  connections.set(path.resolve(file), (connections.get(path.resolve(file)) ?? 0) + 1);

  try {
    fs.chmodSync(file, 0o600);
    db.exec(`
      PRAGMA journal_mode = WAL;
      PRAGMA foreign_keys = ON;
      PRAGMA busy_timeout = 5000;
      PRAGMA synchronous = NORMAL;
      PRAGMA mmap_size = 268435456;
      PRAGMA cache_size = -16000;
    `);
  } catch (error) {
    db.close();
    const key = path.resolve(file), n = (connections.get(key) ?? 1) - 1;
    if (n) connections.set(key, n); else connections.delete(key);
    throw error;
  }
  return db;
}

export function close(db) {
  // shutdown 的 server.close 回调与 5 秒兜底可能各调一次；重复 close 不能把引用计数减穿。
  if (db.__closed) return;
  db.__closed = true;
  try { db.exec('PRAGMA wal_checkpoint(TRUNCATE)'); } catch {  }
  try {
    db.close();
  } finally {
    // 即便 db.close() 抛错（例如重复关闭）也要减引用计数，否则 assertDatabaseClosed 会永久挡住恢复。
    const key = path.resolve(db.__file);
    const n = (connections.get(key) ?? 1) - 1;
    if (n) connections.set(key, n); else connections.delete(key);
  }
}

export const sqliteVersion = (db) => (db.__sqliteVersion ??= db.prepare('SELECT sqlite_version() AS v').get().v);

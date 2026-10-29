// 打印当前数据库的结构版本（schema_version 表的最大 version），供发布脚本比较「部署前后结构有没有变」。
// 只用只读连接：发布流程里服务可能正停着，这个脚本不该创建/迁移任何东西。
// 输出约定：成功打数字；数据库不存在打 0；读不出来打 unknown（调用方据此跳过自动回滚，而不是猜）。
import fs from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import { DB_FILE } from '../src/config.js';

const file = process.env.DB_FILE ?? DB_FILE;

if (!fs.existsSync(file)) {
  console.log(0);
  process.exit(0);
}

let db;
try {
  db = new DatabaseSync(file, { readOnly: true });
  const row = db.prepare('SELECT MAX(version) AS v FROM schema_version').get();
  const version = Number(row?.v);
  console.log(Number.isFinite(version) ? version : 0);
} catch {
  console.log('unknown');
} finally {
  try { db?.close(); } catch { /* 只读连接关不掉也不影响输出 */ }
}

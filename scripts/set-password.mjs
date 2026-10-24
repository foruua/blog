import { acquireMaintenanceLock } from '../src/util/lock.js';

import fs from 'node:fs';
import readline from 'node:readline';
import { open, close } from '../db/driver.js';
import { migrate } from '../db/migrate.js';
import { hashPassword, verifyPassword, clearPassword } from '../src/admin/auth.js';
import { DB_FILE, CONTENT_DIR, UPLOADS_DIR } from '../src/config.js';

/* 密码只从**终端交互输入**或**标准输入**来，不接受命令行参数：`npm run set-password -- '明文密码'` 会写进 shell 历史、还在 `ps` 里对本机任何用户可见 —— 密码进 argv 就等于进了共享日志。
   自动化就喂标准输入：printf '%s' "$NEW_PASSWORD" | npm run set-password。用法：npm run set-password（交互输入两次）/ printf '%s' "$PW" | npm run set-password / npm run set-password -- --clear（清除密码）。 */
const args = process.argv.slice(2);
const extra = args.filter((a) => a !== '--clear');
if (extra.length) {
  console.error(`✗ 不接受的参数：${extra.join(' ')}`);
  console.error('  设置密码：npm run set-password（交互输入，或从标准输入读一行）');
  console.error('  清除密码：npm run set-password -- --clear');
  process.exit(1);
}
const clearing = args.includes('--clear');

// 维护锁放到读完密码之后再拿：交互输入可能停留几分钟，别让“还没写任何东西”的提示阶段把站点维护锁住。
function openLocked() {
  acquireMaintenanceLock([DB_FILE, CONTENT_DIR, UPLOADS_DIR], 'set-password');
  const db = open(DB_FILE);
  migrate(db, { log: () => {} });
  return db;
}

function ask(prompt) {
  if (!process.stdin.isTTY) throw new Error("请在交互终端输入密码；自动化请从标准输入喂：printf '%s' \"$PW\" | npm run set-password");
  return new Promise((resolve, reject) => {
    process.stdout.write(prompt); let answer = '';
    process.stdin.setRawMode(true); process.stdin.resume();
    const done = () => { process.stdin.off('data', onData); process.stdin.setRawMode(false); process.stdin.pause(); process.stdout.write('\n'); };
    const onData = (chunk) => {
      for (const char of chunk.toString()) {
        if (char === '\u0003') { done(); reject(new Error('已取消')); return; }
        if (char === '\r' || char === '\n') { done(); resolve(answer); return; }
        if (char === '\u007f' || char === '\b') answer = [...answer].slice(0, -1).join('');
        else if (char >= ' ') answer += char;
      }
    };
    process.stdin.on('data', onData);
  });
}

if (clearing) {
  const db = openLocked();
  clearPassword(db);

  // 只在真的删掉时才说已删除：以前无条件打印，文件本来就不在也照样报。
  let removed = false;
  try { fs.unlinkSync(new URL('../.admin-password.txt', import.meta.url)); removed = true; } catch { }
  console.log('✓ 已清除后台密码。后台现在无法登录，重新设置即可恢复。');
  if (removed) console.log('  已删除 .admin-password.txt（里面的密码已失效，留着会误导）');
  close(db);
  process.exit(0);
}

/* 不是交互终端（管道 / 重定向）时读一行 —— 让自动化有路可走，又不必把密码写进 argv。 */
async function readStdinLine() {
  const rl = readline.createInterface({ input: process.stdin, terminal: false });
  for await (const line of rl) { rl.close(); return line; }
  return '';
}

let password;
if (process.stdin.isTTY) {
  password = await ask('新密码：');
  const again = await ask('再输一次：');
  if (password !== again) {
    console.error('✗ 两次输入不一致');
    process.exit(1);
  }
} else {
  password = await readStdinLine();
}

if (!password || password.length < 8) {
  console.error('✗ 密码至少 8 位');
  process.exit(1);
}

if (password !== password.trim()) {
  console.error('✗ 密码首尾不能有空白字符（空格 / 制表符 / 换行）');
  process.exit(1);
}

const db = openLocked();
db.exec('BEGIN IMMEDIATE');
try {
  db.prepare(`INSERT INTO settings(key,value) VALUES('admin_password_hash',?) ON CONFLICT(key) DO UPDATE SET value=excluded.value`).run(hashPassword(password));
  db.prepare(`INSERT INTO settings(key,value) VALUES('admin_session_epoch','1') ON CONFLICT(key) DO UPDATE SET value=CAST(value AS INTEGER)+1`).run();
  db.exec('COMMIT');
} catch (e) { db.exec('ROLLBACK'); throw e; }

const stored = db.prepare(`SELECT value FROM settings WHERE key='admin_password_hash'`).get()?.value;
if (!verifyPassword(password, stored)) {
  console.error('✗ 写入后校验失败：库里的哈希与本密码不匹配，请重试');
  close(db);
  process.exit(1);
}

// Remove legacy plaintext copies instead of persisting another credential.
fs.rmSync(new URL('../.admin-password.txt', import.meta.url), { force: true });
console.log('✓ 密码已更新（scrypt 哈希入库 · 校验通过，不保存明文密码）');
console.log(`  所有旧会话已失效（session epoch 已递增）`);
console.log(`  后台入口：${process.env.SITE_URL ?? 'http://127.0.0.1:8787'}/admin`);
console.log(`  密码长度：${password.length}（首尾无空白）`);
close(db);

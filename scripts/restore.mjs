import { parseFlags } from './_cli.mjs';
import { acquireMaintenanceLock } from '../src/util/lock.js';

import fs from 'node:fs';
import path from 'node:path';
import readline from 'node:readline';
import { open, close } from '../db/driver.js';
import { migrate, LATEST_SCHEMA_VERSION } from '../db/migrate.js';
import { DB_FILE, DATA_DIR, CONTENT_DIR, UPLOADS_DIR, THEMES_DIR } from '../src/config.js';
import { listBackups, isRecoverableBackup, verifyBackup, restoreBackup, snapshot, DEFAULT_DIR } from '../src/backup.js';

const { argv, opt } = parseFlags();
if (argv.includes('--help')) {
  console.log('用法：npm run restore -- [--dir <目录>] [--from <备份名>] [--with-themes] [--allow-root] [--yes]\n'
    + '恢复前须停止服务；默认选择最新完整备份。\n'
    + '  默认只恢复数据库、内容与附件，不动 themes/（它是部署产物，且生产上归 root）。\n'
    + '  --with-themes  连主题一起恢复（需要 themes/ 的父目录可写）。\n'
    + '  --allow-root   允许以 root 执行（默认拒绝：还原出来的文件会全部归 root，服务随后读写不了）。');
  process.exit(0);
}
const DIR = opt('--dir') ?? process.env.BACKUP_DIR ?? DEFAULT_DIR;
const FROM = opt('--from');
const YES = argv.includes('--yes');
const WITH_THEMES = argv.includes('--with-themes');

// 以 root 恢复会把 db/内容/附件全部写成 root 所有，服务进程（blog 用户）随后读写失败，
// 而且这种失败要到下一次写入才暴露。要这么做必须显式承认风险。
if (process.getuid?.() === 0 && !argv.includes('--allow-root')) {
  console.error('✗ 不要以 root 执行恢复：还原出来的数据库与文件会全部归 root，服务进程随后读写不了。\n'
    + '  请用运行服务的账号执行；确实需要 root 时加 --allow-root，并在恢复后自行 chown。');
  process.exit(2);
}

// 主题目录在应用根下，生产环境归 root 只读；恢复前已停服，DB 锁足够互斥。
acquireMaintenanceLock(WITH_THEMES ? [DB_FILE, CONTENT_DIR, UPLOADS_DIR, THEMES_DIR] : [DB_FILE, CONTENT_DIR, UPLOADS_DIR], 'restore');
const backups = listBackups(DIR);
if (!backups.length) {
  console.error(`✗ ${DIR} 里没有可用备份`);
  process.exit(1);
}
const target = FROM ? backups.find((b) => b.name === FROM) : backups.find(isRecoverableBackup);
if (!target) {
  console.error(`✗ 找不到备份 ${FROM}。现有：${backups.map((b) => b.name).join(', ')}`);
  process.exit(1);
}

console.log('\n恢复');
console.log('─'.repeat(52));
console.log(`  来源     ${target.name}`);
console.log(`  时间     ${target.createdAt}（${((Date.now() - Date.parse(target.createdAt)) / 3600000).toFixed(1)} 小时前）`);
console.log(`  内容     文章 ${target.counts?.posts} / 已发布 ${target.counts?.published} / 评论 ${target.counts?.comments}`);

const v = verifyBackup(target.name, { dir: DIR });
process.once('exit', () => { if (v.dbPath) fs.rmSync(path.dirname(v.dbPath), { recursive: true, force: true }); });
if (!v.ok) {
  console.error(`✗ 备份校验失败，拒绝恢复：${v.reasons.join('；')}`);
  process.exit(1);
}
if (!v.bundle || v.manifest.complete === false || v.manifest.skippedLinks?.length) {
  console.error('✗ 备份不完整或未包含全部内容与附件，不能执行完整恢复');
  process.exit(1);
}
// 必须在覆盖现场之前判断：恢复完再发现“备份比程序新”会把站点留在不兼容状态（虽留有 pre-restore，
// 但需要人工回滚）。清单里的 schemaVersion 是现成的。
const backupSchema = Number(v.manifest?.schemaVersion ?? 0);
if (backupSchema > LATEST_SCHEMA_VERSION) {
  console.error(`✗ 备份的数据库 schema 版本（${backupSchema}）高于当前程序（${LATEST_SCHEMA_VERSION}）；请先升级代码再恢复。`);
  process.exit(1);
}
console.log('  ✓ 数据库、内容与附件完整性校验通过');

if (!YES) {
  // stdin 被关掉时（CI、`< /dev/null`、管道）readline.question 永不 resolve、`npm run restore` 静默挂死 —— 宁可明确报错也不要装死。
  if (!process.stdin.isTTY) {
    console.error('✗ 当前不是交互终端。确认要恢复请加 --yes（例：npm run restore -- --yes）');
    process.exit(2);
  }
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  const answer = await new Promise((r) => rl.question(`\n  将恢复数据库、内容与附件${WITH_THEMES ? '与主题' : ''}。当前状态会先另存一份。继续？(yes/no) `, r));
  rl.close();
  if (answer.trim().toLowerCase() !== 'yes') { console.log('  已取消。'); process.exit(0); }
}

try {
  const exists = fs.existsSync(DB_FILE);
  const db = open(exists ? DB_FILE : path.join(path.dirname(v.dbPath), 'pre-state.db'));
  let before;
  try {
    if (!exists) migrate(db, { log() {} });
    // keep: 0 = 不清理。保底快照不应顺手删掉正在恢复的源备份/其他旧备份。
    before = await snapshot(db, { dir: DIR, keep: 0, label: 'pre-restore', allowMissingFiles: true });
  } finally { close(db); }
  console.log(`  ✓ 当前状态已另存 ${path.basename(before.gzFile)}（label=pre-restore）`);
  if (!before.complete) console.log('  · 当前内容目录已有文件缺失，保底备份保留原数据库与所有残存文件');
} catch (err) {
  // SQL 快照失败时保留原始状态；不要求损坏的数据库仍能执行 SQL。
  // mkdtemp 也在守卫内：备份目录不可写时走下面的友好报错，而不是裸堆栈。
  let raw = null;
  try {
    raw = fs.mkdtempSync(path.join(DIR, 'pre-restore-raw-'));
    fs.chmodSync(raw, 0o700);
    const sources = { database: DB_FILE, wal: DB_FILE + '-wal', shm: DB_FILE + '-shm',
      content: CONTENT_DIR, uploads: UPLOADS_DIR, themes: THEMES_DIR, journal: path.join(DATA_DIR, '.write-journal') };
    for (const [name, source] of Object.entries(sources)) {
      if (!fs.existsSync(source)) continue;
      if (path.resolve(raw).startsWith(path.resolve(source) + path.sep)) throw new Error('保底目录不能位于被复制目录内部', { cause: err });
      fs.cpSync(source, path.join(raw, name), { recursive: true, dereference: false, preserveTimestamps: true, verbatimSymlinks: true });
    }
    fs.writeFileSync(path.join(raw, 'manifest.json'), JSON.stringify({ createdAt: new Date().toISOString(),
      reason: err.message, sources, note: '原始取证副本；不是可自动恢复的完整快照' }, null, 2), { mode: 0o600 });
    console.log(`  ✓ SQL 快照不可用，原始文件已保留至 ${raw}`);
  } catch (copyError) {
    console.error(`✗ 无法保留当前原始状态，拒绝恢复：${copyError.message}`);
    process.exit(1);
  }
}

const restored = restoreBackup(v, { dbFile: DB_FILE, contentDir: CONTENT_DIR, uploadsDir: UPLOADS_DIR, themesDir: THEMES_DIR, lockHeld: true, withThemes: WITH_THEMES });
console.log('  ✓ Markdown 和上传文件已还原');
if (!restored.themesDir && Array.isArray(v.bundle.themes)) console.log('  · 主题未恢复（默认不动 themes/；需要时加 --with-themes）');
console.log(`  ✓ 已写入 ${DB_FILE}（${(fs.statSync(DB_FILE).size / 1024).toFixed(1)}KB）`);

const check = open(DB_FILE);
let schemaVersion = 0;
try { schemaVersion = Number(check.prepare('SELECT MAX(version) AS v FROM schema_version').get()?.v ?? 0); } catch { /* 极老备份没有 schema_version：交给 migrate 建表 */ }
if (schemaVersion > LATEST_SCHEMA_VERSION) {
  close(check);
  console.error(`✗ 备份的数据库 schema 版本（${schemaVersion}）高于当前程序（${LATEST_SCHEMA_VERSION}）；请先升级代码再恢复。`);
  process.exit(1);
}
if (schemaVersion < LATEST_SCHEMA_VERSION) migrate(check, { log: () => {} });
const integrity = check.prepare('PRAGMA integrity_check').get().integrity_check;
const posts = check.prepare('SELECT COUNT(*) AS n FROM posts').get().n;
close(check);
console.log(integrity === 'ok'
  ? `  ✓ integrity_check = ok，文章 ${posts} 篇`
  : `  ✗ integrity_check = ${integrity} —— 恢复结果有问题`);

console.log('─'.repeat(52));
console.log('  下一步：重启服务（npm start），并跑一次恢复演练确认全链路\n');
fs.rmSync(path.dirname(v.dbPath), { recursive: true, force: true });
process.exit(integrity === 'ok' ? 0 : 1);

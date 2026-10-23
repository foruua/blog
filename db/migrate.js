import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { websiteHost } from '../src/util/url.js';

const DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), 'migrations');

function migrationFiles() {
  return fs.readdirSync(DIR).filter((f) => f.endsWith('.sql')).map((name) => {
    const version = Number(name.split('_')[0]);
    if (!Number.isInteger(version)) throw new Error(`迁移文件名不合规: ${name}`);
    return { name, version };
  });
}
export const LATEST_SCHEMA_VERSION = migrationFiles().reduce((max, item) => Math.max(max, item.version), 0);

// URL.hostname 的 IDN 形态不是稳定的：不同 Node/ICU 版本可能给 punycode 或 Unicode。旧库上
// SQL 回填（023/034）会把两种写法分到两条友链；这里在迁移后用与运行时同一个 websiteHost() 重算一次。
// 版本号写进 settings，老库只付一次全表扫描，新库为空表直接跳过。
const WEBSITE_HOST_JS_KEY = 'website_host_js_version';
const WEBSITE_HOST_JS_VERSION = '2';

function normalizeWebsiteHosts(db, log) {
  let current = null;
  try {
    current = db.prepare('SELECT value FROM settings WHERE key = ?').get(WEBSITE_HOST_JS_KEY)?.value ?? null;
  } catch { return; }
  if (current === WEBSITE_HOST_JS_VERSION) return;

  const rows = db.prepare('SELECT id, website, website_host FROM comments').all();
  const update = db.prepare('UPDATE comments SET website_host = ? WHERE id = ?');
  const save = db.prepare(`INSERT INTO settings(key, value) VALUES(?, ?)
    ON CONFLICT(key) DO UPDATE SET value = excluded.value`);
  let changed = 0;
  db.exec('BEGIN');
  try {
    for (const row of rows) {
      const host = websiteHost(row.website);
      if ((host ?? null) !== (row.website_host ?? null)) {
        update.run(host, row.id);
        changed++;
      }
    }
    save.run(WEBSITE_HOST_JS_KEY, WEBSITE_HOST_JS_VERSION);
    db.exec('COMMIT');
  } catch (err) {
    db.exec('ROLLBACK');
    throw new Error(`website_host 归一失败，已回滚: ${err.message}`, { cause: err });
  }
  if (changed) log(`[migrate] 已归一 ${changed} 条评论的站点键`);
}

export function migrate(db, { log = console.log } = {}) {
  db.exec(`CREATE TABLE IF NOT EXISTS schema_version (
    version    INTEGER PRIMARY KEY,
    name       TEXT NOT NULL,
    applied_at TEXT NOT NULL DEFAULT (datetime('now'))
  )`);
  // 迁移内容哈希：SQLite 只记版本号，历史迁移被人改过不会有任何提示 —— 已应用的库不重跑，
  // 新库却按改后的内容建表，两边的 schema 会悄悄分叉。这里记下首跑时的内容，之后对不上就告警。
  const versionColumns = new Set(db.prepare('PRAGMA table_info(schema_version)').all().map((c) => c.name));
  if (!versionColumns.has('checksum')) db.exec('ALTER TABLE schema_version ADD COLUMN checksum TEXT');
  const storedChecksums = new Map(
    db.prepare('SELECT version, checksum FROM schema_version').all().map((r) => [r.version, r.checksum]),
  );

  const done = new Set(db.prepare('SELECT version FROM schema_version').all().map(r => r.version));
  if (done.has(1) && !done.has(12) && !done.has(13)) {
    const columns = new Set(db.prepare('PRAGMA table_info(posts)').all().map((c) => c.name));
    if (!columns.has('version') || !columns.has('missing_file')) {
      throw new Error('旧迁移链尚未完成：请先用压平前的迁移升级到版本 12，再运行当前版本');
    }
  }
  // 按文件名解析出的版本号排序（非文件名字符串）：后者依赖三位零填充，迁移破千后 '1000_x.sql' < '999_x.sql' 会乱序。
  const files = migrationFiles().sort((a, b) => a.version - b.version);
  // 同版本号出现在两个文件里（合并冲突/复制）时直接拒绝，别等主键冲突报一个难懂的错。
  const seenVersions = new Set();
  for (const { name, version } of files) {
    if (seenVersions.has(version)) throw new Error(`迁移版本号重复：${version}（${name}）`);
    seenVersions.add(version);
  }

  db.exec('PRAGMA foreign_keys = OFF');
  let applied = 0;
  try {
    for (const { name: file, version } of files) {
      const sql = fs.readFileSync(path.join(DIR, file), 'utf8');
      const checksum = crypto.createHash('sha256').update(sql).digest('hex');
      if (done.has(version)) {
        const stored = storedChecksums.get(version);
        if (!stored) {
          // 老库第一次跑到这里：把当前文件内容记成基线，之后再改就比对得出来。
          db.prepare('UPDATE schema_version SET checksum = ? WHERE version = ?').run(checksum, version);
        } else if (stored !== checksum) {
          log(`[migrate] ⚠ 迁移 ${file} 与记录的内容不一致（历史迁移被改过）：已应用的库不会重跑，新建库会按改后的内容建表`);
        }
        continue;
      }

      db.exec('BEGIN');
      try {
        db.exec(sql);
        if (db.prepare('PRAGMA foreign_key_check').all().length) {
          throw new Error('出现了悬挂的外键引用');
        }
        db.prepare('INSERT INTO schema_version(version, name, checksum) VALUES(?, ?, ?)').run(version, file, checksum);
        db.exec('COMMIT');
        done.add(version);
        log(`[migrate] 已应用 ${file}`);
        applied++;
      } catch (err) {
        db.exec('ROLLBACK');
        throw new Error(`迁移 ${file} 失败，已回滚: ${err.message}`, { cause: err });
      }
    }
  } finally {
    db.exec('PRAGMA foreign_keys = ON');
  }
  normalizeWebsiteHosts(db, log);
  if (!applied) log(`[migrate] 无需迁移（当前版本 ${Math.max(0, ...done)}）`);
  return applied;
}

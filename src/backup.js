import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';
import crypto from 'node:crypto';
import { pipeline } from 'node:stream/promises';
import { Readable, Transform, Writable } from 'node:stream';
import { acquireMaintenanceLock } from './util/lock.js';
import { assertDatabaseClosed, sqliteVersion } from '../db/driver.js';
import { DatabaseSync } from 'node:sqlite';
import { DATA_DIR, DB_FILE, CONTENT_DIR, UPLOADS_DIR, THEMES_DIR } from './config.js';
import { expandMediaPaths } from './media/variants.js';
import { atomicWrite, syncDirectory, writeFileDurable } from './util/files.js';
import { safeRelativeFsPath as safeRelative } from './util/safe-path.js';

export const DEFAULT_DIR = path.resolve(process.env.BACKUP_DIR ?? path.join(DATA_DIR, 'backups'));
const tempRoot = () => process.env.BLOG_TMP_DIR ?? process.env.TMPDIR ?? '/tmp';

// 保留份数。默认值即唯一入口：常驻服务、脚本、maybeAutoBackup 全走它——以前只有脚本读 BACKUP_KEEP，
// 服务里的定时自动备份永远用 7，配了也白配。
const KEEP_RAW = process.env.BACKUP_KEEP;
const KEEP_ENV = KEEP_RAW == null || KEEP_RAW.trim() === '' ? NaN : Number(KEEP_RAW);
export const DEFAULT_KEEP = Number.isInteger(KEEP_ENV) && KEEP_ENV >= 0 ? KEEP_ENV : 7;

const sqlStr = (p) => `'${String(p).replace(/'/g, "''")}'`;

function ensureDir(dir) {
  // 只给新建目录设权限；已存在的目录可能是共享挂载/NFS，强制 chmod 700 会直接破坏运维权限。
  const existed = fs.existsSync(dir);
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  if (!existed) fs.chmodSync(dir, 0o700);
  return dir;
}

// 进程被 SIGKILL/部署重启时，snapshot 的 finally 不会执行；这些隐藏临时文件永远不会被 prune 匹配到。
function cleanStaleTemps(dir, maxAgeMs = 6 * 3600 * 1000, now = Date.now()) {
  let names;
  try { names = fs.readdirSync(dir); } catch { return 0; }
  let removed = 0;
  for (const name of names) {
    if (!/^\.blog-.*\.(?:tmp\.db|assets\.tmp)$/.test(name) && !/^\.tmp-[A-Za-z0-9-]+$/.test(name)) continue;
    const file = path.join(dir, name);
    try {
      if (now - fs.statSync(file).mtimeMs < maxAgeMs) continue;
      fs.rmSync(file, { recursive: true, force: true }); removed++;
    } catch { /* 下次再清 */ }
  }
  return removed;
}

function stamp(date = new Date()) {
  return date.toISOString().replace(/[-:]/g, '').replace('.', '-').replace('T', '-');
}

function countsOf(db) {
  const one = (sql) => { try { return db.prepare(sql).get().n; } catch { return null; } };
  return {
    posts: one('SELECT COUNT(*) AS n FROM posts'),
    comments: one('SELECT COUNT(*) AS n FROM comments'),
    media: one('SELECT COUNT(*) AS n FROM media'),
    revisions: one('SELECT COUNT(*) AS n FROM revisions'),
    // 友圈表（015/016 才建）：旧备份没这两张表，one() 返回 null，不会让历史产物校验失败。
    feeds: one('SELECT COUNT(*) AS n FROM feeds'),
    feedItems: one('SELECT COUNT(*) AS n FROM feed_items'),
    published: one("SELECT COUNT(*) AS n FROM posts WHERE draft = 0 AND kind IN ('post','note')"),
  };
}

// 上限与允许上传的体积对齐：此前 128MB 总量/32MB 单文件会让正常媒体站点的自动备份永久失败。
// 384MB 而不是 512MB：资产包是一整个 base64 JSON，恢复时 JSON.parse 的字符串上限约 512M 字符，
// base64 又膨胀 4/3，512MB 的原文件已经越过那条线 —— 备份能写出来、自检也说「可恢复」，
// 真到要恢复时却抛 ERR_STRING_TOO_LONG。留出 JSON 结构与转义余量，把默认值压到 384MB。
const MAX_BACKUP_BYTES = Math.min(4 * 1024 * 1024 * 1024, Math.max(1024 * 1024, Number(process.env.MAX_BACKUP_BYTES) || 384 * 1024 * 1024));
// 资产包 JSON 文本的硬上限（字符数）。这是对上面那条内存/解析约束的直接护栏：即便站主把
// MAX_BACKUP_BYTES 调大，超过这里也立刻失败并说清原因，而不是产出一份永远恢复不了的备份。
const MAX_BUNDLE_CHARS = 400 * 1024 * 1024;
const MAX_BACKUP_FILE_BYTES = Math.min(MAX_BACKUP_BYTES, Math.max(1024 * 1024, Number(process.env.MAX_BACKUP_FILE_BYTES) || 256 * 1024 * 1024));
// 写流关掉 fd 不等于数据已经落盘：清单里写着 verified 之前，归档文件本身也必须 fsync，
// 否则断电后可能留下「清单完好、gz 截断」的半份备份。
async function syncPath(file) {
  const fh = await fs.promises.open(file, 'r');
  try { await fh.sync(); } finally { await fh.close(); }
}
async function compress(source, destination) {
  const hash = crypto.createHash('sha256'); let bytes = 0;
  const measure = new Transform({ transform(chunk, _encoding, callback) {
    bytes += chunk.length;
    if (bytes > MAX_BACKUP_BYTES * 2) { callback(new Error('备份归档超过大小上限')); return; }
    hash.update(chunk); callback(null, chunk);
  } });
  await pipeline(source, measure, zlib.createGzip({ level: 6 }), fs.createWriteStream(destination, { mode: 0o600 }));
  await syncPath(destination);
  return { sha256: hash.digest('hex'), bytes, fileBytes: fs.statSync(destination).size };
}
// Finder / Windows 留下的元数据文件：不属于站点内容，却会被逐份备份进包、再推到异地。
// 以前 content/.DS_Store、uploads/2026/.DS_Store 就混在里面，恢复时又被原样还原。
const JUNK_FILES = new Set(['.DS_Store', 'Thumbs.db', 'desktop.ini', '.localized']);

// 备份包是普通文件的扁平归档，装不下符号链接。以前遇软链直接抛错、整份备份永久挂掉；现在跳过并记进
// 清单（skippedLinks）：备份照常完成，哪些路径没进包看得见，恢复时也不会以为"文件都在"。
function inventory(root, skippedLinks = null) {
  const files = [];
  if (!fs.existsSync(root)) return files;
  const walk = (dir) => {
    let entries;
    try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
    for (const entry of entries) {
      const file = path.join(dir, entry.name);
      if (entry.isSymbolicLink()) {
        if (skippedLinks) skippedLinks.push(path.relative(root, file).split(path.sep).join('/'));
        continue;
      }
      // 回收站不进备份：它是「已删除、等保留期到点销毁」的暂存区，恢复时不该被一起带回来。
      if (entry.isDirectory()) {
        if (entry.name === '.trash') continue;
        walk(file);
      }
      else if (entry.isFile()) {
        if (JUNK_FILES.has(entry.name)) continue;
        // 并发删除/改名会让 stat 在 readdir 与 stat 之间失败；跳过这一条，别让整轮备份因此失败。
        let stat;
        try { stat = fs.statSync(file); } catch { continue; }
        files.push({ file, path: path.relative(root, file).split(path.sep).join('/'), bytes: stat.size, mtime: stat.mtimeMs });
      }
    }
  };
  walk(root); return files.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
}

// 并发检测的廉价戳：文件内容变动由归档时逐文件 (bytes, mtime) 校验兜住（见 archive()），这里只捕捉
// 「目录结构变了」（增删改名→目录 mtime 变），只遍历目录，比再跑一遍 inventory 便宜。
function dirStamp(root) {
  const out = [];
  if (!fs.existsSync(root)) return out;
  const walk = (dir) => {
    try {
      out.push(`${path.relative(root, dir)}:${fs.statSync(dir).mtimeMs}`);
      for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
        // 回收站、主题安装临时目录与覆盖安装的替换目录都不进备份，它们内部的变化也不该让备份失败。
        if (entry.isDirectory() && entry.name !== '.trash' && !entry.name.startsWith('.install-') && !entry.name.startsWith('.replace-') && !entry.name.startsWith('.upload-')) {
          walk(path.join(dir, entry.name));
        }
      }
    } catch { /* 并发删除：让调用方用“文件树变了”重试 */ }
  };
  walk(root);
  return out.sort();
}
export async function snapshot(db, { dir = DEFAULT_DIR, keep = DEFAULT_KEEP, label = 'manual', contentDir = CONTENT_DIR, uploadsDir = UPLOADS_DIR, themesDir = THEMES_DIR, allowMissingFiles = false, verify = true } = {}) {
  ensureDir(dir);
  cleanStaleTemps(dir);
  const t0 = Date.now();
  const base = `blog-${stamp()}-${crypto.randomBytes(3).toString('hex')}`;
  const tmpDb = path.join(dir, `.${base}.tmp.db`);
  // 资产包先写到临时名，算出内容哈希后再改成 <sha>.assets.json.gz（见下方）。同一份内容只落一次盘，
  // 后续备份直接复用——rsync 按「名字 + 大小 + mtime」判重，复用即等于零传输。
  const assetsTmp = path.join(dir, `.${base}.assets.tmp`);
  const gzFile = path.join(dir, `${base}.db.gz`), manifestFile = path.join(dir, `${base}.json`);
  let assetsFile = null, createdAssets = false, complete = false;
  try {
    const skippedLinks = [];
    const contentStamp = dirStamp(contentDir), uploadsStamp = dirStamp(uploadsDir), themesStamp = dirStamp(themesDir);
    // `.md.before-fix` 是 front-matter 修复时留下的原稿副本，不属于站点内容；不归档可避免长期累积近一倍体积。
    const content = inventory(contentDir, skippedLinks).filter((file) => !file.path.endsWith('.md.before-fix'));
    const uploads = inventory(uploadsDir, skippedLinks);
    // 主题回收站、安装临时目录与覆盖安装的替换目录不属于「已安装主题」，不进完整备份。
    const themeFiles = inventory(themesDir, skippedLinks).filter((file) =>
      !file.path.startsWith('.trash/') && !file.path.split('/')[0].startsWith('.install-')
      && !file.path.split('/')[0].startsWith('.replace-') && !file.path.startsWith('.upload-'));
    const allFiles = [...content, ...uploads, ...themeFiles];
    if (skippedLinks.length) console.warn(JSON.stringify({ event: 'backup.skipped-symlinks', count: skippedLinks.length, sample: skippedLinks.slice(0, 5) }));
    const total = allFiles.reduce((n,f) => n+f.bytes, 0);
    if (total > MAX_BACKUP_BYTES || allFiles.some((f) => f.bytes > MAX_BACKUP_FILE_BYTES)) throw new Error('内容、附件与主题超过备份大小上限');
    db.exec(`VACUUM INTO ${sqlStr(tmpDb)}`); fs.chmodSync(tmpDb, 0o600);
    if (fs.statSync(tmpDb).size + total > MAX_BACKUP_BYTES) throw new Error('数据库、内容及附件总大小超过备份上限');
    const missingFiles = []; const postFiles = {};
    let counts, schemaVersion;
    const indexed = new DatabaseSync(tmpDb, { readOnly: true });
    try {
      counts = countsOf(indexed); schemaVersion = indexed.prepare('SELECT MAX(version) AS v FROM schema_version').get().v;
      // schema 一次备份内不会变：这两句原先写在逐行循环里，每条记录都要重跑一遍 PRAGMA
      const hasMissingColumn = indexed.prepare('PRAGMA table_info(posts)').all().some((c) => c.name === 'missing_file');
      const mediaHasThumb = indexed.prepare('PRAGMA table_info(media)').all().some((c) => c.name === 'thumbnail');
      const postsQuery = hasMissingColumn
        ? 'SELECT id, source, file_path, missing_file FROM posts WHERE file_path IS NOT NULL'
        : 'SELECT id, source, file_path, 0 AS missing_file FROM posts WHERE file_path IS NOT NULL';
      const contentPaths = new Set(content.map((f) => f.path)), uploadPaths = new Set(uploads.map((f) => f.path));
      for (const row of indexed.prepare(postsQuery).all()) {
        const relative = path.relative(path.resolve(contentDir), path.resolve(row.file_path)).split(path.sep).join('/');
        if (!safeRelative(relative)) throw new Error(`文章文件不在内容目录中：${row.file_path}`);
        if (row.source === 'file' && !contentPaths.has(relative)) {
          // Quarantined missing-file records are intentionally recoverable without the source file.
          if (!row.missing_file && !allowMissingFiles) throw new Error(`文章文件缺失，无法生成完整备份：${row.file_path}`);
          if (!row.missing_file) missingFiles.push(relative);
        }
        postFiles[row.id] = relative;
      }
      const mediaHasVariants = indexed.prepare('PRAGMA table_info(media)').all().some((c) => c.name === 'variants');
      const mediaQuery = `SELECT path, ${mediaHasThumb ? 'thumbnail' : 'NULL AS thumbnail'}, ${mediaHasVariants ? 'variants' : 'NULL AS variants'} FROM media`;
      for (const row of indexed.prepare(mediaQuery).all()) for (const mediaPath of expandMediaPaths(row)) {
        const relative = mediaPath.startsWith('/uploads/') ? mediaPath.slice(9) : null;
        if (!safeRelative(relative)) throw new Error('无效的附件路径');
        if (!uploadPaths.has(relative)) {
          // 显式快照（手动/演练）保持严格；自动备份由 maybeAutoBackup 传 allowMissingFiles，
          // 记入 missingFiles（complete=false），避免一个缺失派生文件让整轮备份永久失败。
          if (!allowMissingFiles) throw new Error(`附件缺失：${mediaPath}`);
          missingFiles.push(`uploads/${relative}`);
        }
      }
    } finally { indexed.close(); }
    const database = await compress(fs.createReadStream(tmpDb), gzFile);
    // 一次只流一个文件：大文件（几十 MB）不再整块 readFile + base64 成两三份内存副本。
    // 同时在这里数着资产包 JSON 的字符数：这是恢复端 JSON.parse 能不能吃下的唯一判据，
    // 流式自检只校验 gzip 与 sha256，看不出「包完好但解析不了」。
    async function* archive() {
      let bundleChars = 0;
      const emit = (text) => {
        bundleChars += text.length;
        if (bundleChars > MAX_BUNDLE_CHARS) {
          throw new Error(`内容与附件超过单个资产包上限（约 ${Math.round(MAX_BUNDLE_CHARS / 1048576)}M 字符）：`
            + '恢复时会因 JSON 解析长度上限而失败。请清理附件或拆分站点，不要依赖这份备份');
        }
        return text;
      };
      yield emit('{"version":1,"content":[');
      for (const [index, files, key] of [[0, content, 'content'], [1, uploads, 'uploads'], [2, themeFiles, 'themes']]) {
        if (index) yield emit(`],"${key}":[`);
        for (let i = 0; i < files.length; i++) {
          const file = files[i];
          if (i) yield emit(',');
          yield emit(`{"path":${JSON.stringify(file.path)},"data":"`);
          const hash = crypto.createHash('sha256');
          let bytes = 0;
          let carry = Buffer.alloc(0);
          for await (const chunk of fs.createReadStream(file.file)) {
            bytes += chunk.length;
            hash.update(chunk);
            const buf = carry.length ? Buffer.concat([carry, chunk]) : chunk;
            const complete = buf.length - (buf.length % 3);
            if (complete) yield emit(buf.subarray(0, complete).toString('base64'));
            carry = buf.subarray(complete);
          }
          if (carry.length) yield emit(carry.toString('base64'));
          const stat = fs.statSync(file.file);
          if (bytes !== file.bytes || stat.mtimeMs !== file.mtime) throw new Error('备份期间内容文件发生变化，请重试');
          yield emit(`","sha256":"${hash.digest('hex')}"}`);
        }
      }
      yield emit('],"postFiles":' + JSON.stringify(postFiles) + '}');
    }
    // 资产包按内容哈希命名：内容没变就复用旧文件，名字、大小、mtime 三者都不变，
    // rsync 才会真的跳过这 30 多 MB；换名之后每份备份都得整包重传。
    const assets = await compress(Readable.from(archive()), assetsTmp);
    const assetsName = `${assets.sha256.slice(0, 32)}.assets.json.gz`;
    assetsFile = path.join(dir, assetsName);
    // 同名旧文件也校验一次大小：磁盘错误/手工覆盖留下的截断包若被直接复用，清单会指向永远
    // 校验不过的资产，自动备份随后卡死，还很难看出原因。
    let reusable = false;
    try { reusable = fs.statSync(assetsFile).size === assets.fileBytes; } catch { /* 不存在就新建 */ }
    if (reusable) fs.rmSync(assetsTmp, { force: true });
    else { fs.rmSync(assetsFile, { force: true }); fs.renameSync(assetsTmp, assetsFile); createdAssets = true; }
    // 只校验「文件树」是否在快照期间变化。评论、设置、登录只写数据库：VACUUM INTO 已经给出一个
    // 一致的数据库时间点，没必要因为它们把整次备份判失败（那会逼着备份长时间持有全局写队列）。
    // 文章保存/上传/主题安装会改目录 mtime，仍必须重试，否则数据库里的 postFiles 可能与文件对不上。
    if (JSON.stringify(dirStamp(contentDir)) !== JSON.stringify(contentStamp) || JSON.stringify(dirStamp(uploadsDir)) !== JSON.stringify(uploadsStamp)
      || JSON.stringify(dirStamp(themesDir)) !== JSON.stringify(themesStamp)) throw new Error('备份期间内容文件发生变化，请重试');
    const manifest = { formatVersion: 2, complete: !missingFiles.length && !skippedLinks.length, verified: false,
      missingFiles, skippedLinks,
      assetsName, assetsSha256: assets.sha256, assetsBytes: assets.bytes, assetFiles: allFiles.length, themeFiles: themeFiles.length,
      createdAt: new Date().toISOString(), label, dbBytes: database.bytes, gzBytes: fs.statSync(gzFile).size,
      sha256: database.sha256, schemaVersion, counts, sqliteVersion: sqliteVersion(db) };
    // 清单最后写且必须原子：否则进程在写一半时被杀，prune 会把这份其实可用的备份族当坏清单删掉。
    // verified 先写 false：自检通过前，这份备份不能参与 isRecoverableBackup / 看门狗判断，也不能触发 prune。
    atomicWrite(manifestFile, JSON.stringify(manifest, null, 2) + '\n');
    if (verify) {
      const checked = await verifyBackupLite(base, { dir });
      if (!checked.ok) throw new Error(`备份自检失败：${checked.reasons.join('；')}`);
      manifest.verified = true;
      atomicWrite(manifestFile, JSON.stringify(manifest, null, 2) + '\n');
    }
    complete = true;
    // 自动备份走 verify:false（自检在写队列之外做）；未验证前不允许 prune，避免坏包挤掉好包。
    return { ...manifest, gzFile, manifestFile, assetsFile, ms: Date.now()-t0, pruned: verify ? prune(dir, keep) : 0 };
  } finally {
    fs.rmSync(tmpDb, { force: true });
    fs.rmSync(assetsTmp, { force: true });
    if (!complete) {
      for (const file of [gzFile, manifestFile]) fs.rmSync(file, { force: true });
      // 复用的资产包可能还被别的备份引用着，只有本次新建的才跟着删。
      if (createdAssets && assetsFile) fs.rmSync(assetsFile, { force: true });
    }
  }
}

/**
 * 验证完成后的收尾：把清单标成 verified 并执行保留策略。
 * 自动备份把 snapshot(verify:false) 放在写屏障内，等 verifyBackupLite 结束后再调用这里，
 * 这样“坏包”不会在验证前把好包 prune 掉。
 */
export function finalizeBackup(name, { dir = DEFAULT_DIR, keep = DEFAULT_KEEP } = {}) {
  if (!/^blog-[A-Za-z0-9-]+$/.test(name)) throw new Error('备份名称无效');
  const manifestFile = path.join(dir, `${name}.json`);
  const manifest = JSON.parse(fs.readFileSync(manifestFile, 'utf8'));
  manifest.verified = true;
  atomicWrite(manifestFile, JSON.stringify(manifest, null, 2) + '\n');
  return { manifest, pruned: prune(dir, keep) };
}

// 一份完整备份是「族」：<name>.db.gz + <name>.json + 资产包。资产包自 033 起按内容哈希命名并被多份
// 备份共享（旧备份仍是 <name>.assets.json.gz），所以它不参与族清理，改由 prune 末尾按引用计数回收。
// 以前 prune 只遍历 listBackups()（要求 .db.gz 与 .json 同时在），写一半的、被手删清单的产物会永远堆积；
// 现在按族清，保留最近 keep 份完整备份。
const FAMILY_SUFFIXES = ['.db.gz', '.assets.json.gz', '.json'];
const ASSETS_NAME_RE = /^(?:[a-f0-9]{32}|blog-[A-Za-z0-9-]+)\.assets\.json\.gz$/;
// 资产包按内容哈希命名后被多份备份共享；清单还没落盘的这十几秒里它属于「孤儿」，不能被误回收。
const ASSETS_GRACE_MS = 10 * 60 * 1000;

// 清单里记的是裸文件名（assetsName）；更早的备份没有这个字段，按 <name>.assets.json.gz 推导。
const assetsNameOf = (backup) => {
  const name = backup?.assetsName ?? (backup?.name ? `${backup.name}.assets.json.gz` : '');
  return ASSETS_NAME_RE.test(name) ? name : '';
};

function backupFamilies(dir) {
  const families = new Map();
  let names;
  try { names = fs.readdirSync(dir); } catch { return families; }
  for (const name of names) {
    const suffix = FAMILY_SUFFIXES.find((s) => name.endsWith(s));
    if (!suffix) continue;                        // .tmp.db 之类的中间产物由 snapshot 的 finally 收拾
    const base = name.slice(0, -suffix.length);
    if (!/^blog-[A-Za-z0-9-]+$/.test(base)) continue;   // 哈希命名的资产包落在这里被跳过，交给引用计数
    if (!families.has(base)) families.set(base, []);
    families.get(base).push(name);
  }
  return families;
}

function prune(dir, keep = DEFAULT_KEEP) {
  if (!Number.isFinite(keep) || keep <= 0) return 0;
  const backups = listBackups(dir);
  const kept = backups.filter(isRecoverableBackup).slice(0, keep);
  const keepNames = new Set(kept.map((b) => b.name));
  const partial = backups.find((b) => !isRecoverableBackup(b));
  if (partial) keepNames.add(partial.name);
  const removed = [];
  for (const [base, files] of backupFamilies(dir)) {
    if (keepNames.has(base)) continue;
    for (const name of files) {
      try { fs.unlinkSync(path.join(dir, name)); removed.push(name); } catch { /* 删不掉就算了，别让备份因为清理失败而报错 */ }
    }
  }

  // 资产包回收：只删「没有被任何保留备份引用」的。共享是这里的核心收益，删错一份就等于毁掉一批备份。
  const referenced = new Set();
  for (const backup of backups) {
    if (!keepNames.has(backup.name)) continue;
    const name = assetsNameOf(backup);
    if (name) referenced.add(name);
  }
  let names;
  try { names = fs.readdirSync(dir); } catch { return removed.length; }
  const now = Date.now();
  for (const name of names) {
    if (!name.endsWith('.assets.json.gz') || referenced.has(name)) continue;
    const file = path.join(dir, name);
    try {
      if (now - fs.statSync(file).mtimeMs < ASSETS_GRACE_MS) continue;
      fs.unlinkSync(file); removed.push(name);
    } catch { /* 同上 */ }
  }
  return removed.length;
}

export function listBackups(dir = DEFAULT_DIR) {
  if (!fs.existsSync(dir)) return [];
  return fs.readdirSync(dir)
    .filter((f) => f.endsWith('.db.gz'))
    .map((f) => f.replace(/\.db\.gz$/, ''))
    .filter((name) => fs.existsSync(path.join(dir, `${name}.json`)))
    .sort()
    .reverse()
    .map((name) => {
      try {
        const file = path.join(dir, `${name}.json`);
        if (fs.statSync(file).size > 1024 * 1024) throw new Error('清单过大');
        const manifest = JSON.parse(fs.readFileSync(file, 'utf8'));
        return { ...manifest, name, dir };
      } catch { console.warn(JSON.stringify({ event: 'backup.invalid-manifest', name })); return null; }
    }).filter(Boolean);
}

// 健康检查只做轻量结构检查；drill/restore 仍须完整解压、校验哈希和数据库。
export function isRecoverableBackup(backup) {
  // verified === false 表示“已落盘但尚未通过 sha256/integrity_check 自检”；老清单没有这个字段，按已验证处理。
  if (!backup || backup.verified === false || backup.complete !== true || backup.formatVersion < 2
      || backup.skippedLinks?.length || backup.missingFiles?.length
      || !Number.isFinite(Date.parse(backup.createdAt)) || !/^[a-f0-9]{64}$/.test(backup.sha256 ?? '')
      || !/^[a-f0-9]{64}$/.test(backup.assetsSha256 ?? '') || !/^blog-[A-Za-z0-9-]+$/.test(backup.name ?? '')) return false;
  const assetsName = assetsNameOf(backup);
  if (!assetsName) return false;
  try {
    const dbFile = fs.statSync(path.join(backup.dir, `${backup.name}.db.gz`));
    const assetsFile = fs.statSync(path.join(backup.dir, assetsName));
    return [dbFile, assetsFile].every((stat) => stat.isFile() && stat.size > 0);
  } catch { return false; }
}
export const latestRecoverableBackup = (dir = DEFAULT_DIR) => listBackups(dir).find(isRecoverableBackup) ?? null;

export function createBackupSummaryCache({ dir = DEFAULT_DIR, ttlMs = 30000, now = Date.now, list = listBackups } = {}) {
  let cached = null, expires = 0, directoryStamp;
  return {
    invalidate() { cached = null; },
    get() {
      let stamp;
      try { stamp = fs.statSync(dir).mtimeMs; } catch { stamp = null; }
      if (!cached || now() >= expires || stamp !== directoryStamp) {
        cached = list(dir); directoryStamp = stamp; expires = now() + ttlMs;
      }
      return { last: cached[0], recoverable: cached.find(isRecoverableBackup) };
    },
  };
}
export function recordOffsiteResult(db, result, remote) {
  const status = { name: path.basename(result.gzFile).replace('.db.gz', ''), checkedAt: new Date().toISOString(),
    state: remote.skipped ? 'not-configured' : remote.ok ? 'ok' : 'failed' };
  db.prepare('INSERT INTO settings(key,value) VALUES(?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value')
    .run('backup_offsite_status', JSON.stringify(status));
}


// 清单文件很小；损坏/超限都按「读不到清单」处理。两个校验入口共用同一套读取规则。
function readManifestFile(file) {
  try {
    if (fs.statSync(file).size > 1024 * 1024) throw new Error('清单过大');
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch { return null; }
}

// 两个校验入口的 sha/大小比较文案不同，但判定规则相同：清单缺字段时跳过（兼容旧备份）。
function digestReasons(expectedSha, expectedBytes, actual, label) {
  const reasons = [];
  if (expectedSha && actual.sha256 !== expectedSha) reasons.push(`${label} sha256 不匹配`);
  if (expectedBytes && actual.bytes !== expectedBytes) reasons.push(`${label} 大小不匹配`);
  return reasons;
}

/**
 * 自动备份用的轻量自检：流式 gunzip + 哈希/大小校验 + 数据库 integrity_check，
 * 不把整包 base64 JSON 读进内存。手动恢复仍走 verifyBackup()（需要 bundle）。
 */
export async function verifyBackupLite(name, { dir = DEFAULT_DIR } = {}) {
  const reasons = [];
  if (!/^blog-[A-Za-z0-9-]+$/.test(name)) return { ok: false, reasons: ['备份名称无效'] };
  const gz = path.join(dir, `${name}.db.gz`), mf = path.join(dir, `${name}.json`);
  if (!fs.existsSync(gz) || !fs.existsSync(mf)) return { ok: false, reasons: ['备份文件不完整'] };
  const manifest = readManifestFile(mf);
  if (!manifest) return { ok: false, reasons: ['备份清单损坏'] };

  const tmpRoot = tempRoot();
  const tmp = fs.mkdtempSync(path.join(tmpRoot, 'blog-lite-verify-'));
  const dbOut = path.join(tmp, 'blog.db');
  const hashed = async (file, out = null, limit = MAX_BACKUP_BYTES) => {
    const hash = crypto.createHash('sha256');
    let bytes = 0;
    const sink = out ? fs.createWriteStream(out, { mode: 0o600 }) : new Writable({ write(_c, _e, cb) { cb(); } });
    await pipeline(fs.createReadStream(file), zlib.createGunzip(), new Transform({
      transform(chunk, _encoding, cb) {
        bytes += chunk.length;
        if (bytes > limit) { cb(new Error('备份解压后超过大小上限')); return; }
        hash.update(chunk); cb(null, chunk);
      },
    }), sink);
    return { sha256: hash.digest('hex'), bytes };
  };
  try {
    const db = await hashed(gz, dbOut);
    reasons.push(...digestReasons(manifest.sha256, manifest.dbBytes, db, '数据库'));
    const check = new DatabaseSync(dbOut, { readOnly: true });
    try { if (check.prepare('PRAGMA integrity_check').get().integrity_check !== 'ok') reasons.push('数据库 integrity_check 失败'); }
    finally { check.close(); }
    if (manifest.formatVersion >= 2) {
      const assetsName = assetsNameOf({ ...manifest, name });
      if (!assetsName) reasons.push('清单未记录资产包名');
      else {
        const assets = await hashed(path.join(dir, assetsName), null, MAX_BACKUP_BYTES * 2);
        reasons.push(...digestReasons(manifest.assetsSha256, manifest.assetsBytes, assets, '资产包'));
      }
    }
    return { ok: reasons.length === 0, reasons, manifest };
  } catch (error) {
    return { ok: false, reasons: [`备份校验失败：${error.message}`], manifest };
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
}

// ⚠ 仅限脚本/恢复流程调用（restore.mjs / restore-drill.mjs / test-*）：同步 gunzip + 整包读进内存
// （上限 MAX_BACKUP_BYTES×2）。绝不能挂到 admin 路由或任何请求路径——那会秒级阻塞事件循环；
// 请求路径一律走流式的 verifyBackupLite（见上）。
export function verifyBackup(name, { dir = DEFAULT_DIR, workDir } = {}) {
  const reasons = [];
  if (!/^blog-[A-Za-z0-9-]+$/.test(name)) return { ok: false, reasons: ['备份名称无效'] };
  const gz = path.join(dir, `${name}.db.gz`);
  const mf = path.join(dir, `${name}.json`);
  if (!fs.existsSync(gz)) reasons.push(`缺少 ${gz}`);
  if (!fs.existsSync(mf)) reasons.push(`缺少 ${mf}`);
  if (reasons.length) return { ok: false, reasons };

  const manifest = readManifestFile(mf);
  if (!manifest) return { ok: false, reasons: ['备份清单损坏'] };

  let raw;
  try {
    raw = zlib.gunzipSync(readBounded(gz), { maxOutputLength: MAX_BACKUP_BYTES });
  } catch (err) {
    return { ok: false, reasons: [...reasons, `无法解压（文件损坏或被截断）：${err.message}`], manifest };
  }
  const sha256 = crypto.createHash('sha256').update(raw).digest('hex');
  if (manifest.sha256 && sha256 !== manifest.sha256) {

    reasons.push(`sha256 不匹配（manifest ${manifest.sha256.slice(0, 12)}… ≠ 实际 ${sha256.slice(0, 12)}…）`);
  }
  if (manifest.dbBytes && raw.length !== manifest.dbBytes) {
    reasons.push(`大小不匹配（manifest ${manifest.dbBytes} ≠ 实际 ${raw.length}）`);
  }

  const out = path.join(workDir ?? fs.mkdtempSync(path.join(tempRoot(), 'blog-verify-')), `${name}.db`);
  fs.mkdirSync(path.dirname(out), { recursive: true });
  const rawBytes = raw.length;
  fs.writeFileSync(out, raw, { mode: 0o600 });
  // 数据库解压结果已经落盘；先释放再解资产包，避免同时驻留两份大 Buffer。
  raw = null;
  try {
    const check = new DatabaseSync(out, { readOnly: true });
    try {
      if (check.prepare('PRAGMA integrity_check').get().integrity_check !== 'ok') reasons.push('数据库 integrity_check 失败');
    } finally { check.close(); }
  } catch (err) { reasons.push(`无法打开数据库：${err.message}`); }
  let bundle = null;
  if (manifest.formatVersion >= 2) {
    // 资产包名以清单为准：新备份是内容哈希（多份共享），旧备份是 <name>.assets.json.gz。
    const assetsName = assetsNameOf({ ...manifest, name });
    try {
      if (!assetsName) throw new Error('清单未记录资产包名');
      const assetRaw = zlib.gunzipSync(readBounded(path.join(dir, assetsName)), { maxOutputLength: MAX_BACKUP_BYTES * 2 });
      if (digest(assetRaw) !== manifest.assetsSha256 || assetRaw.length !== manifest.assetsBytes) {
        throw new Error('内容与附件的 sha256 或大小不匹配');
      }
      bundle = JSON.parse(assetRaw);
      validateBundle(bundle);
    } catch (err) { reasons.push(`内容与附件校验失败：${err.message}`); }
  }
  if (reasons.length && !workDir) fs.rmSync(path.dirname(out), { recursive: true, force: true });
  return { ok: reasons.length === 0, reasons, dbPath: out, bundle, manifest, bytes: rawBytes };
}

export async function maybeAutoBackup(db, { dir = DEFAULT_DIR, keep = DEFAULT_KEEP, minIntervalMs = 10 * 60 * 1000, maxBytes = 64 * 1024 * 1024 } = {}) {
  const size = fs.existsSync(dbFileOf(db)) ? fs.statSync(dbFileOf(db)).size : 0;
  if (size > maxBytes) return { skipped: `数据库 ${(size / 1048576).toFixed(1)}MB 超过自动备份上限，请改用 cron` };

  const last = latestRecoverableBackup(dir);
  if (last) {
    const age = Date.now() - Date.parse(last.createdAt);
    if (age < minIntervalMs) return { skipped: `距上次备份仅 ${Math.round(age / 1000)}s，跳过` };
  }
  // 自动备份容忍单个附件缺失（清单会标 complete=false），否则一个坏派生文件就让备份永久停摆。
  // 自检放在 snapshot 之后、写队列之外（见 backup-worker.js）；在验证通过前先标 verified=false，不 prune。
  return { backup: await snapshot(db, { dir, keep, label: 'publish', allowMissingFiles: true, verify: false }) };
}

function dbFileOf(db) {
  return db.__file ?? DB_FILE;
}

const digest = (buf) => crypto.createHash('sha256').update(buf).digest('hex');
// 归档成员路径的词法校验：import 顶部引自 util/safe-path.js（与 themes/registry.js 共用一份）。

function readBounded(file) {
  if (fs.statSync(file).size > MAX_BACKUP_BYTES * 2) throw new Error('备份文件超过大小上限');
  return fs.readFileSync(file);
}

function validateBundle(bundle) {
  if (bundle?.version !== 1 || !Array.isArray(bundle.content) || !Array.isArray(bundle.uploads)
      || (bundle.themes !== undefined && !Array.isArray(bundle.themes))
      || !bundle.postFiles || typeof bundle.postFiles !== 'object') throw new Error('无效的文件归档');
  // themes 是后加的可选分组：旧备份没有它，恢复时保留现有主题目录不动。
  for (const group of [bundle.content, bundle.uploads, bundle.themes ?? []]) {
    const paths = new Set();
    for (const file of group) {
      if (!safeRelative(file.path) || paths.has(file.path) || typeof file.data !== 'string') throw new Error('无效或重复的文件路径');
      const raw = Buffer.from(file.data, 'base64');
      if (raw.toString('base64') !== file.data || digest(raw) !== file.sha256) throw new Error(`文件校验失败：${file.path}`);
      paths.add(file.path);
    }
    for (const name of paths) {
      const parts = name.split('/');
      while (parts.length > 1) {
        parts.pop();
        if (paths.has(parts.join('/'))) throw new Error('文件与目录路径冲突');
      }
    }
  }
  for (const [id, name] of Object.entries(bundle.postFiles)) {
    if (!/^\d+$/.test(id) || !safeRelative(name)) throw new Error('无效的文章路径映射');
  }
}

export function restoreBackup(verified, { dbFile, contentDir = CONTENT_DIR, uploadsDir = UPLOADS_DIR, themesDir = THEMES_DIR, journalDir = path.join(path.resolve(dbFile) === path.resolve(DB_FILE) ? DATA_DIR : path.dirname(dbFile), '.write-journal'), lockHeld = false, withThemes = false }) {
  assertDatabaseClosed(dbFile);
  // 主题默认不恢复：恢复要在 themesDir 的父目录（生产上是归 root 的 /srv/blog）里 mkdtemp 再整目录替换，
  // 普通账号写不进去；改用 root 执行又会把还原出来的数据库/内容一并变成 root 所有，服务随后读写失败。
  // 主题本来就是部署产物（随代码走），没必要每次恢复都动它 —— 需要时显式 --with-themes。
  const restoreThemes = withThemes === true && Array.isArray(verified?.bundle?.themes);
  const resources = [dbFile, contentDir, uploadsDir];
  if (restoreThemes) resources.push(themesDir);
  const release = lockHeld ? () => {} : acquireMaintenanceLock(resources, 'restore');
  try {
    return restoreUnlocked(verified, { dbFile, contentDir, uploadsDir, themesDir, journalDir, withThemes: restoreThemes });
  } finally { release(); }
}
// 恢复用 mkdtemp 在各目标父目录旁暂存整棵副本；SIGKILL/断电时 finally 不会执行。
// 启动/下次恢复时按 7 天保留期清掉这类孤儿，避免它们永久占盘并成为旧内容副本。
function cleanStaleRestoreTemps(targets, maxAgeMs = 7 * 86400000) {
  const parents = new Set(targets.map((target) => path.dirname(path.resolve(target))));
  const cutoff = Date.now() - maxAgeMs;
  for (const dir of parents) {
    let entries;
    try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { continue; }
    for (const entry of entries) {
      if (!entry.name.startsWith('.blog-restore-') && !entry.name.includes('.pre-restore-')) continue;
      const file = path.join(dir, entry.name);
      try {
        if (fs.statSync(file).mtimeMs < cutoff) fs.rmSync(file, { recursive: true, force: true });
      } catch { /* 删不掉就留给下一次 */ }
    }
  }
}

function restoreUnlocked(verified, { dbFile, contentDir, uploadsDir, themesDir, journalDir, withThemes = false }) {
  if (!verified.ok) throw new Error(`备份校验失败：${verified.reasons.join('；')}`);
  if (verified.manifest?.complete === false || verified.manifest?.skippedLinks?.length) throw new Error('该保底备份缺失文件或跳过软链，只可用于提取原数据库与残存文件');
  if (!verified.bundle) throw new Error('旧备份不含 Markdown 和附件，不能完整恢复；请先补齐内容备份');
  validateBundle(verified.bundle);
  // 主题是后加的分组：旧备份没有 themes、或调用方没要（默认）时，不动现有主题目录。
  const groups = [[contentDir, verified.bundle.content], [uploadsDir, verified.bundle.uploads]];
  if (withThemes && Array.isArray(verified.bundle.themes)) groups.push([themesDir, verified.bundle.themes]);
  const targets = [dbFile, ...groups.map(([dir]) => dir), journalDir].map((p) => path.resolve(p));
  for (let i = 0; i < targets.length; i++) for (let j = i + 1; j < targets.length; j++) {
    if (targets[i] === targets[j] || targets[i].startsWith(targets[j] + path.sep) || targets[j].startsWith(targets[i] + path.sep)) {
      throw new Error('数据库、内容、附件与主题的恢复路径不能重叠');
    }
  }
  cleanStaleRestoreTemps(targets);
  const stages = [];
  const moved = [];
  const journalIndex = targets.length - 1;
  try {
    for (const target of targets) {
      fs.mkdirSync(path.dirname(target), { recursive: true });
      stages.push(fs.mkdtempSync(path.join(path.dirname(target), '.blog-restore-')));
    }
    const stagedDb = path.join(stages[0], 'blog.db');
    fs.copyFileSync(verified.dbPath, stagedDb);
    for (const [index, [, group]] of groups.entries()) {
      for (const file of group) {
        const dest = path.join(stages[index + 1], file.path);
        fs.mkdirSync(path.dirname(dest), { recursive: true });
        // 文件数据和目录项都要落盘：rename 只保证目录项，断电后可能留下空文件。
        writeFileDurable(dest, Buffer.from(file.data, 'base64'));
      }
    }
    const db = new DatabaseSync(stagedDb);
    try {
      db.exec('PRAGMA journal_mode = DELETE; BEGIN');
      const hasMissing = db.prepare('PRAGMA table_info(posts)').all().some((c) => c.name === 'missing_file');
      const rows = db.prepare(hasMissing
        ? 'SELECT id, source, file_path, missing_file FROM posts WHERE file_path IS NOT NULL'
        : 'SELECT id, source, file_path, 0 AS missing_file FROM posts WHERE file_path IS NOT NULL').all();
      // 内容路径预先建成 Set、UPDATE 预先 prepare：几千篇文章时避免 O(文章 × 文件) 扫描与逐行重新编译。
      const contentPaths = new Set(verified.bundle.content.map((file) => file.path));
      const updatePath = db.prepare('UPDATE posts SET file_path = ? WHERE id = ?');
      for (const row of rows) {
        const relative = verified.bundle.postFiles[row.id];
        if (!relative || (row.source === 'file' && !row.missing_file && !contentPaths.has(relative))) {
          throw new Error(`文章 #${row.id} 缺少对应文件`);
        }
        updatePath.run(path.join(targets[1], relative), row.id);
      }
      db.exec('COMMIT');
    } finally { db.close(); }
    const replacements = [[targets[journalIndex], null],
      ...groups.map(([dir], index) => [dir, stages[index + 1]]),
      // hot rollback journal 若不一起移走，下一次打开新库时 SQLite 可能把旧事务回滚进刚恢复的数据库。
      [targets[0] + '-journal', null], [targets[0] + '-wal', null], [targets[0] + '-shm', null],
      [targets[0], stagedDb]];
    for (const [target, stage] of replacements) {
      const entry = { target, old: null, installed: false };
      moved.push(entry);
      if (fs.existsSync(target)) {
        const previous = `${target}.pre-restore-${crypto.randomBytes(6).toString('hex')}`;
        fs.renameSync(target, previous);
        entry.old = previous;
      }
      if (stage) { fs.renameSync(stage, target); entry.installed = true; }
    }
    // rename 只保证目录项变了；对父目录 fsync 才能让“替换已完成”在断电后仍成立。
    for (const dir of new Set(replacements.map(([target]) => path.dirname(target)))) {
      try { syncDirectory(dir); } catch { /* 平台不支持/权限受限时不阻断恢复 */ }
    }
  } catch (err) {
    for (const entry of moved.reverse()) {
      if (entry.installed) fs.rmSync(entry.target, { recursive: true, force: true });
      if (entry.old) fs.renameSync(entry.old, entry.target);
    }
    throw err;
  } finally {
    for (const stage of stages) fs.rmSync(stage, { recursive: true, force: true });
  }
  // 恢复成功后连旧写日志一起清：里面是旧文章的 base64 全文，留着只会永久占空间并多一份内容副本。
  // 清理失败不能反过来把已生效的恢复报成失败。
  for (const entry of moved) if (entry.old) {
    try { fs.rmSync(entry.old, { recursive: true, force: true }); }
    catch (error) { console.warn(JSON.stringify({ event: 'restore.cleanup-failed', code: error?.code ?? 'INTERNAL' })); }
  }
  return {
    dbFile: targets[0], contentDir: targets[1], uploadsDir: targets[2],
    ...(groups.length > 2 ? { themesDir: targets[3] } : {}),
  };
}

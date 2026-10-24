import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { DATA_DIR, CONTENT_DIR, UPLOADS_DIR, OUTPUT_DIR } from '../config.js';
import { atomicWrite, durableRemove, syncDirectory, ensureDurableDirectory } from '../util/files.js';
import { writePostFile } from './write.js';

const journalDir = path.join(DATA_DIR, '.write-journal');

// 取“最近存在的祖先”的真实路径，再接回尚不存在的尾部。用于在目标文件还没创建时也能解析父目录软链。
function realPathOfNearest(file) {
  let current = path.resolve(file);
  const tail = [];
  while (!fs.existsSync(current)) {
    const parent = path.dirname(current);
    tail.unshift(path.basename(current));
    if (parent === current) break;
    current = parent;
  }
  return path.join(fs.realpathSync(current), ...tail);
}

// 只比较 path.resolve 的前缀挡不住软链：content/posts 若是指向站外的软链，写入会逃出受管根。
// 这里同时检查字面路径、父目录真实路径，并拒绝目标本身是软链。
function assertWithin(file, roots, message) {
  const resolved = path.resolve(file);
  const root = roots.map((r) => path.resolve(r)).find((r) => resolved.startsWith(r + path.sep));
  if (!root) throw new Error(message);
  const realRoot = realPathOfNearest(root);
  const realParent = realPathOfNearest(path.dirname(resolved));
  if (realParent !== realRoot && !realParent.startsWith(realRoot + path.sep)) throw new Error(message);
  try {
    if (fs.lstatSync(resolved).isSymbolicLink()) throw new Error(message);
  } catch (error) {
    if (error.code !== 'ENOENT') throw error;
  }
}
const assertPath = (file) => assertWithin(file, [CONTENT_DIR], '文件不在内容目录内');
// moveFile 是通用的（内容文件→回收站、上传文件→回收站），两个受管根都接受。逐调用点自行拼路径，
// 这里再挡一道：将来有不谨慎的调用方传了穿越路径，也逃不出内容与数据目录。
const MANAGED_ROOTS = [CONTENT_DIR, UPLOADS_DIR, DATA_DIR, OUTPUT_DIR];
const assertManagedPath = (file) => assertWithin(file, MANAGED_ROOTS, '文件不在受管目录内');
function restoreFiles(entries) {
  // 全部预检成功后才恢复，避免坏条目造成半份日志被执行。
  for (const entry of entries) {
    if (!entry || typeof entry.file !== 'string') throw new Error('无效的日志路径');
    assertPath(entry.file);
    if (entry.data !== null && (typeof entry.data !== 'string'
      || Buffer.from(entry.data, 'base64').toString('base64') !== entry.data)) throw new Error('无效的日志内容');
  }
  for (const { file, data } of entries) {
    if (data === null) { if (fs.existsSync(file)) durableRemove(file); }
    else {
      atomicWrite(file, Buffer.from(data, 'base64'));
    }
  }
}
function quarantine(journal, suffix) {
  try { fs.renameSync(journal, `${journal}.${suffix}`); } catch { /* 挪不动就原地留着，下一次启动再报一次 */ }
}

// 启动恢复必须"坏也坏得起"：单份日志有问题只隔离它自己、绝不抛错——否则 server.js 会在 boot 阶段永久 crash-loop。
export function recoverWrites(repo, { log = console } = {}) {
  if (!fs.existsSync(journalDir)) return 0;
  let recovered = 0;
  const names = fs.readdirSync(journalDir).filter((n) => n.endsWith('.json')).sort();
  for (const name of names) {
    const journal = path.join(journalDir, name);
    let data;
    try {
      data = JSON.parse(fs.readFileSync(journal, 'utf8'));
      if (!data || typeof data !== 'object' || typeof data.key !== 'string' || !Array.isArray(data.entries)) {
        throw new Error('日志结构不完整');
      }
    } catch (error) {
      log.error(JSON.stringify({ event: 'journal.corrupt', file: name, code: error.code ?? 'PARSE' }));
      quarantine(journal, 'corrupt');
      continue;
    }
    if (repo.getSetting(data.key)) {
      durableRemove(journal);            // 已提交：日志只是没来得及清掉
      repo.deleteSetting(data.key);
      continue;
    }
    try {
      restoreFiles(data.entries);
      recovered++;
    } catch (error) {
      log.error(JSON.stringify({ event: 'journal.restore-failed', file: name, code: error.code ?? 'RESTORE' }));
      quarantine(journal, 'failed');
      continue;
    }
    durableRemove(journal); repo.deleteSetting(data.key);
  }
  // 原子写留下的半截临时文件（进程在 rename 前后被杀）永远是垃圾，直接清掉。
  for (const name of fs.readdirSync(journalDir).filter((n) => n.includes('.tmp-'))) {
    fs.rmSync(path.join(journalDir, name), { force: true });
  }
  // crash 兜底：durableRemove(journal) 与 deleteSetting 之间被杀，会留下没有日志文件对应的孤儿键；
  // 上面的循环只按文件驱动，永远碰不到它们——随保存事故缓慢累积，这里顺带清掉。
  // 被隔离（.corrupt/.failed）的日志键一并清：恢复以文件为准，隔离件仍留在磁盘上供人工检查。
  if (typeof repo.settingKeysLike === 'function') {
    for (const key of repo.settingKeysLike('write_journal:')) {
      const journalFile = path.join(journalDir, `${key.slice('write_journal:'.length)}.json`);
      if (fs.existsSync(journalFile)) continue;
      try { repo.deleteSetting(key); } catch { /* 清不掉就留给下一次启动 */ }
    }
  }
  return recovered;
}

// The durable journal reconciles a process crash between filesystem and SQLite commits.
export function commitPost({ repo, existing, filePath, front, body, commit }) {
  assertPath(filePath);
  const files = [...new Set([filePath, existing?.file_path].filter(Boolean))];
  const entries = files.map((file) => { assertPath(file); return { file, data: fs.existsSync(file) ? fs.readFileSync(file).toString('base64') : null }; });
  if (filePath !== existing?.file_path && fs.existsSync(filePath)) throw new Error('目标文件已经存在');
  ensureDurableDirectory(journalDir);
  const key = `write_journal:${crypto.randomUUID()}`;
  const journal = path.join(journalDir, key.split(':')[1] + '.json');
  atomicWrite(journal, JSON.stringify({ key, entries }));
  let written;
  try {
    written = writePostFile({ filePath, front, body });
    if (existing?.file_path && existing.file_path !== filePath) durableRemove(existing.file_path);
    const result = repo.transaction(() => { const out = commit(written); repo.setSetting(key, 'committed'); return out; });
    try { durableRemove(journal); repo.deleteSetting(key); } catch (e) { console.warn('[content] 保存已提交，恢复日志待下次启动清理：' + e.code); }
    return result;
  } catch (e) {
    restoreFiles(entries);
    durableRemove(journal);
    throw e;
  }
}

export function moveFile(from, to, { overwrite = false } = {}) {
  assertManagedPath(from);
  assertManagedPath(to);
  if (!overwrite && fs.existsSync(to)) throw new Error(`目标文件已存在：${path.basename(to)}`);
  ensureDurableDirectory(path.dirname(to));
  try { fs.renameSync(from, to); syncDirectory(path.dirname(to)); if (path.dirname(to) !== path.dirname(from)) syncDirectory(path.dirname(from)); }
  catch (e) {
    if (e.code !== 'EXDEV') throw e;
    fs.copyFileSync(from, to, fs.constants.COPYFILE_EXCL);
    const fd = fs.openSync(to, 'r');
    try { fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
    syncDirectory(path.dirname(to));
    try {
      const hash = (p) => crypto.createHash('sha256').update(fs.readFileSync(p)).digest('hex');
      if (hash(from) !== hash(to)) throw new Error('跨盘移动校验失败', { cause: e });
      durableRemove(from);
    } catch (error) { fs.rmSync(to, { force: true }); throw error; }
  }
}
export function deleteWithFiles({ repo, files, remove }) {
  const moved = [];
  try {
    for (const { file, trash } of files) if (file && fs.existsSync(file)) { moveFile(file, trash); moved.push({ file, trash }); }
    repo.transaction(remove);
    return moved.length > 0;
  } catch (e) {
    // 回滚时原路径可能已被外部重新创建：宁可保留现有文件，也不要覆盖它。
    for (const item of moved.reverse()) { try { moveFile(item.trash, item.file); } catch { /* 保留可恢复的回收站副本 */ } }
    throw e;
  }
}
export function deleteWithFile({ repo, file, trash, remove }) {
  return deleteWithFiles({ repo, files: [{ file, trash }], remove });
}

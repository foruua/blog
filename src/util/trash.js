import fs from 'node:fs';
import path from 'node:path';

// 保留期（天）：TRASH_KEEP_DAYS 覆盖，非法值回落到 90。
const envDays = Number(process.env.TRASH_KEEP_DAYS);
export const TRASH_RETENTION_DAYS = Number.isFinite(envDays) && envDays > 0 ? envDays : 90;

// 派生图（缩略图 / 响应式变体）不进恢复主路径：能还原的是原图，派生图随时可重新生成。
// 故用更短的保留期，默认 7 天；0 表示下次启动即清。
const envDerivedRaw = process.env.TRASH_DERIVED_KEEP_DAYS;
const envDerivedDays = envDerivedRaw == null || envDerivedRaw.trim() === '' ? NaN : Number(envDerivedRaw);
export const TRASH_DERIVED_RETENTION_DAYS = Number.isFinite(envDerivedDays) && envDerivedDays >= 0 ? envDerivedDays : 7;

const STAMP_RE = /^(?:front-)?(\d{13})-/;

/** 缩略图或响应式变体：写入回收站时必须带 `.derived-` 标记（见 media 删除与 cleanup-media），
 *  不能再靠文件名后缀猜——原图恰好叫 x.w640.webp 时会被误判成派生图、按 7 天销毁。 */
const isTrashDerived = (name) => /\.derived-[^/]*\.webp$/i.test(name);

/** 扫描回收站（不递归，与写入侧一致：文件都平铺在 .trash/<子目录> 下）。 */
export function scanTrash(roots) {
  const entries = [];
  for (const root of roots) {
    let list;
    try { list = fs.readdirSync(root, { withFileTypes: true }); } catch { continue; }
    for (const entry of list) {
      if (!entry.isFile()) continue;
      const abs = path.join(root, entry.name);
      let stat;
      try { stat = fs.lstatSync(abs); } catch { continue; }   // 扫描期间被别的进程清掉
      if (!stat.isFile()) continue;                            // 不跟随软链
      const stamped = Number(STAMP_RE.exec(entry.name)?.[1]);
      entries.push({
        path: abs,
        name: entry.name,
        bytes: stat.size,
        mtimeMs: stat.mtimeMs,
        deletedAt: Number.isFinite(stamped) && stamped > 0 ? stamped : null,
        derived: isTrashDerived(entry.name),
      });
    }
  }
  return entries;
}

/**
 * 待删清单。默认口径与启动清理一致：只认文件名里的删除时刻，认不出的一律保留。
 * includeLegacy: 认不出的按 mtime 当作删除时刻（一次性历史文件用）。
 * derivedMaxAgeMs: 派生图单独用这个保留期；传 0 = 所有派生图立即删。
 */
export function trashPlan(roots, { maxAgeMs = TRASH_RETENTION_DAYS * 86400000, now = Date.now(), includeLegacy = false, derivedMaxAgeMs = null } = {}) {
  const plan = [];
  for (const item of scanTrash(roots)) {
    const canDate = includeLegacy || (item.derived && derivedMaxAgeMs !== null);
    const deletedAt = item.deletedAt ?? (canDate ? item.mtimeMs : null);
    if (deletedAt === null) continue;
    const limit = item.derived && derivedMaxAgeMs !== null ? derivedMaxAgeMs : maxAgeMs;
    if (deletedAt < now - limit) plan.push({ ...item, deletedAt });
  }
  return plan;
}

export function pruneTrash(roots, options) {
  const removed = [];
  for (const item of trashPlan(roots, options)) {
    try { fs.rmSync(item.path, { force: true }); removed.push(item.path); }
    catch { /* 权限/竞态：留给下一次 */ }
  }
  return removed;
}

// —— 目录型回收站 ——
// 主题不是「一个文件」而是一整棵目录（themes/.trash/<id>-<时间戳>），且写入侧从不平铺，
// 所以文件版扫描器看不到它们，需要单独一套按目录处理的规则。

const DIR_STAMP_RE = /(?:^|[-_])(\d{13})(?:[-_]|$)/;

export function scanTrashDirs(roots) {
  const out = [];
  for (const root of roots) {
    let list;
    try { list = fs.readdirSync(root, { withFileTypes: true }); } catch { continue; }
    for (const entry of list) {
      if (!entry.isDirectory() || entry.name.startsWith('.')) continue;
      const abs = path.join(root, entry.name);
      let stat;
      try { stat = fs.lstatSync(abs); } catch { continue; }
      if (!stat.isDirectory()) continue;
      const stamped = Number(DIR_STAMP_RE.exec(entry.name)?.[1]);
      out.push({
        path: abs,
        name: entry.name,
        mtimeMs: stat.mtimeMs,
        deletedAt: Number.isFinite(stamped) && stamped > 0 ? stamped : null,
      });
    }
  }
  return out;
}

export function trashDirPlan(roots, { maxAgeMs = TRASH_RETENTION_DAYS * 86400000, now = Date.now(), includeLegacy = false } = {}) {
  const plan = [];
  for (const item of scanTrashDirs(roots)) {
    const deletedAt = item.deletedAt ?? (includeLegacy ? item.mtimeMs : null);
    if (deletedAt === null) continue;
    if (deletedAt < now - maxAgeMs) plan.push({ ...item, deletedAt });
  }
  return plan;
}

export function pruneTrashDirs(roots, options) {
  const removed = [];
  for (const item of trashDirPlan(roots, options)) {
    try { fs.rmSync(item.path, { recursive: true, force: true }); removed.push(item.path); }
    catch { /* 权限/竞态：留给下一次 */ }
  }
  return removed;
}

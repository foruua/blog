#!/usr/bin/env node
/* 补齐缩略图与响应式变体。默认只读预览；--apply 前需停止服务（写入要持有维护锁，并拒绝符号链接）。 */
import fs from 'node:fs';
import { open, close } from '../db/driver.js';
import { DatabaseSync } from 'node:sqlite';
import { migrate } from '../db/migrate.js';
import { CONTENT_DIR, UPLOADS_DIR, DB_FILE } from '../src/config.js';
import { normalizeImage } from '../src/media/image.js';
import { variantWidthsOf, variantFile, thumbnailFile, serializeVariants } from '../src/media/variants.js';
import { mediaFile } from '../src/media/paths.js';
import { acquireMaintenanceLock } from '../src/util/lock.js';
import { syncDirectory } from '../src/util/files.js';
import path from 'node:path';
import { MEDIA_REVISION_KEY } from '../src/media/revision.js';

const apply = process.argv.includes('--apply');
const release = apply ? acquireMaintenanceLock([DB_FILE, CONTENT_DIR, UPLOADS_DIR], 'backfill-media') : () => {};
const db = apply ? open(DB_FILE) : new DatabaseSync(DB_FILE, { readOnly: true });
if (apply) migrate(db, { log() {} });

const rows = db.prepare("SELECT id, path, width, height, thumbnail, variants, animated FROM media WHERE COALESCE(mime, '') NOT LIKE 'video/%' ORDER BY id").all();
const update = db.prepare('UPDATE media SET thumbnail = ?, variants = ?, width = ?, height = ?, animated = ? WHERE id = ? AND path = ? AND thumbnail IS ? AND variants IS ?');
const absOf = mediaFile;

let done = 0, skipped = 0, failed = 0;
try {
  for (const row of rows) {
    let abs;
    try { abs = absOf(row.path); } catch (err) { console.log(`  ✗ ${row.path} ${err.message}`); failed++; continue; }
    if (!fs.existsSync(abs)) { console.log(`  · ${row.path} 原图不在磁盘上，跳过`); skipped++; continue; }
    let needsThumb = row.thumbnail !== thumbnailFile(row.path);
    if (!needsThumb) { try { needsThumb = !fs.existsSync(absOf(row.thumbnail)); } catch { needsThumb = true; } }
    // variants 为 NULL 才是没算过，空数组 [] 是算过、没有更小档位；以前当成一回事，窄图每次跑都被重新解码、重报需要处理。
    let existing = null;
    try { existing = JSON.parse(row.variants ?? 'null'); } catch { existing = null; }
    const available = (v, w) => {
      try { return v?.w === w && v.path === variantFile(row.path, w) && fs.existsSync(absOf(v.path)); }
      catch { return false; }
    };
    const needsVariants = !(row.width > 0) || !Array.isArray(existing) || variantWidthsOf(row.width).some((w) => !existing.some((v) => available(v, w)));
    // 老记录没有 animated：顺手补上，好让灯箱能正确区分动画图（回原图）与静态图（用变体）。
    const needsAnimated = row.animated == null;

    if (!needsThumb && !needsVariants && !needsAnimated) { skipped++; continue; }

    console.log(`  ${apply ? '生成' : '待生成'} ${row.path}  ${[needsThumb && '缩略图', needsVariants && '变体', needsAnimated && '动画标记'].filter(Boolean).join(' + ')}`);
    if (!apply) { done++; continue; }

    const written = [];
    const writeNew = (file, data) => {
      const fd = fs.openSync(file, 'wx', 0o600);
      written.push(file);
      try { fs.writeFileSync(fd, data); fs.fsyncSync(fd); }
      finally { fs.closeSync(fd); }
      syncDirectory(path.dirname(file));
    };
    try {
      const normalized = await normalizeImage(fs.readFileSync(abs));
      // 变体本身尽力而为，但这里**不能**降级：variants 只要写成数组（哪怕空）就等于标记已算过、下次不再重算 —— 一次瞬时失败会变成永久 srcset 缺失。
      // 所以有一档失败就整条判失败，留着下次重试。
      if (normalized.variantErrors.length) {
        throw new Error(`变体生成失败（${normalized.variantErrors.map((e) => `${e.width}px: ${e.message}`).join('；')}）`);
      }
      const rel = row.path;
      const thumbRel = thumbnailFile(rel);
      const variants = [];
      for (const v of normalized.variants) {
        const file = absOf(variantFile(rel, v.width));
        if (!fs.existsSync(file)) {
          writeNew(file, v.data);
        }
        variants.push({ w: v.width, path: variantFile(rel, v.width) });
      }
      if (needsThumb) {
        const file = absOf(thumbnailFile(rel));
        if (!fs.existsSync(file)) {
          writeNew(file, normalized.thumbnail);
        }
      }
      const res = update.run(needsThumb ? thumbRel : row.thumbnail, serializeVariants(variants), normalized.width, normalized.height, normalized.animated ? 1 : 0, row.id, row.path, row.thumbnail, row.variants);
      if (!res.changes) {
        for (const file of written) fs.rmSync(file, { force: true });
        console.log(`  · ${row.path} 记录在写盘期间已被删除，回滚刚生成的派生文件`);
        skipped++;
        continue;
      }
      done++;
    } catch (err) {
      for (const file of written) fs.rmSync(file, { force: true });
      console.log(`  ✗ ${row.path} 处理失败：${err.message}`);
      failed++;
    }
  }
  // 补出来的派生文件要让**存量正文**也享用：body_html 里的 srcset 是渲染当时算的。抬一下媒体修订号，下次内容同步就会重渲染 ——
  // 以前要人工改 PIPELINE_VERSION，忘了改就等于白跑。
  if (apply && done > 0) {
    const current = Number(db.prepare('SELECT value FROM settings WHERE key = ?').get(MEDIA_REVISION_KEY)?.value ?? 0) || 0;
    db.prepare(`INSERT INTO settings(key,value) VALUES(?,?)
      ON CONFLICT(key) DO UPDATE SET value = excluded.value`).run(MEDIA_REVISION_KEY, String(current + 1));
    console.log(`已抬媒体修订号 ${current} → ${current + 1}：下次内容同步会重渲染存量正文`);
  }
} finally {
  try { if (apply) close(db); else db.close(); } finally { release(); }
}
console.log(`\n${apply ? '已处理' : '需要处理'} ${done} 条 / 跳过 ${skipped} 条 / 失败 ${failed} 条${apply ? '' : '（加 --apply 才会真的写）'}`);
process.exitCode = failed ? 1 : 0;

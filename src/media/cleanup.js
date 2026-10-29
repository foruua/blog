import fs from 'node:fs';
import path from 'node:path';
import { referencedUploads, uploadPath } from './usage.js';
import { originalPathOf, thumbnailFile, variantFile, expandMediaPaths } from './variants.js';
import { mediaFile } from './paths.js';

function markdownFiles(root) {
  const files = [];
  if (!fs.existsSync(root)) return files;
  for (const entry of fs.readdirSync(root, { withFileTypes: true })) {
    const file = path.join(root, entry.name);
    if (entry.isDirectory()) files.push(...markdownFiles(file));
    else if (entry.isFile() && /\.md$/i.test(entry.name)) files.push(file);
  }
  return files;
}

// 仅识别可再生的旧策略文件；数据库、正文、固定页和未同步文件中的引用均保留。
export function obsoleteMediaPlan(db, { uploadsDir, contentDir }) {
  const protectedPaths = new Set();
  const protect = (value) => { const p = uploadPath(value); if (p) protectedPaths.add(p); };
  const protectMarkdown = (value) => { for (const p of referencedUploads(value)) protectedPaths.add(p); };
  // posts/revisions/comments 在大站上整表 .all() 会把所有正文一次读进内存；按 id 游标分 200 行一批扫，
  // 正文用完即弃，只留派生出来的路径。.md 本来就是逐个读，保持不动。
  const BATCH = 200;
  const eachBatch = (table, columns, onRow) => {
    const stmt = db.prepare(`SELECT id, ${columns.join(', ')} FROM ${table} WHERE id > ? ORDER BY id LIMIT ?`);
    let cursor = 0;
    for (;;) {
      const rows = stmt.all(cursor, BATCH);
      for (const row of rows) { onRow(row); cursor = row.id; }
      if (rows.length < BATCH) return;
    }
  };
  const rows = db.prepare('SELECT path, thumbnail, variants FROM media').all();
  const originals = new Set(rows.map((row) => row.path));
  for (const row of rows) for (const p of expandMediaPaths(row)) protect(p);
  eachBatch('posts', ['body_md', 'body_html'], (row) => {
    protectMarkdown(row.body_md);
    const html = String(row.body_html ?? '');
    for (const m of html.matchAll(/\b(?:src|href|data-full)="([^"]*)"/g)) protect(m[1].replace(/&amp;/g, '&'));
    for (const m of html.matchAll(/\bsrcset="([^"]*)"/g)) {
      for (const candidate of m[1].split(',')) protect(candidate.trim().split(/\s+/)[0]);
    }
  });
  for (const row of db.prepare('SELECT value FROM settings').all()) {
    protect(row.value); protectMarkdown(row.value);
  }
  // 历史修订与评论正文也可能引用旧派生文件（回滚预览、评论区插图）；以前没扫这里会导致仅被引用的派生文件被回收。
  eachBatch('revisions', ['body_md'], (row) => protectMarkdown(row.body_md));
  eachBatch('comments', ['body_md'], (row) => protectMarkdown(row.body_md));
  for (const sub of ['posts', 'notes', 'pages']) {
    for (const file of markdownFiles(path.join(contentDir, sub))) protectMarkdown(fs.readFileSync(file, 'utf8'));
  }
  const candidates = [];
  const walk = (dir) => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const file = path.join(dir, entry.name);
      if (entry.isDirectory()) { walk(file); continue; }
      if (!entry.isFile() || !/\.(?:thumb(?:-v\d+)?|(?:v\d+-)?w\d+)\.webp$/.test(entry.name)) continue;
      const url = '/uploads/' + path.relative(uploadsDir, file).split(path.sep).join('/');
      const original = originalPathOf(url);
      const width = Number(/(?:v\d+-)?w(\d+)\.webp$/.exec(url)?.[1]);
      if (!originals.has(original) || protectedPaths.has(url)
          || url === thumbnailFile(original) || (width > 0 && url === variantFile(original, width))) continue;
      if (!fs.existsSync(mediaFile(original, uploadsDir))) continue;
      const stat = fs.statSync(file);
      candidates.push({ path: url, bytes: stat.size });
    }
  };
  if (fs.existsSync(uploadsDir)) walk(uploadsDir);
  return candidates.sort((a, b) => a.path.localeCompare(b.path));
}

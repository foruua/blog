import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { parseFrontmatter, stringifyFrontmatter } from './frontmatter.js';
import { atomicWrite } from '../util/files.js';
import { CONTENT_DIR } from '../config.js';

const DIR_OF = { post: 'posts', note: 'notes', page: 'pages' };

const dirFor = (kind) => DIR_OF[kind] ?? 'posts';

export function planFilePath({ kind, slug, existingPath = null, existingKind = kind }) {
  if (existingPath && existingKind === kind
      && path.relative(CONTENT_DIR, existingPath).split(path.sep)[0] === dirFor(kind)) return existingPath;
  return path.join(CONTENT_DIR, dirFor(kind), `${slug}.md`);
}

// 读 frontmatter 前先确认路径落在 CONTENT_DIR 内：file_path 来自数据库，恢复一份被篡改的备份后
// 它可能指向任意文件（/etc/passwd、密钥文件），这里再读就成了任意文件读取。词法路径与符号链接都要查。
function withinContentDir(filePath) {
  const rel = path.relative(CONTENT_DIR, filePath);
  if (!rel || rel.startsWith('..') || path.isAbsolute(rel)) return false;
  try {
    const real = fs.realpathSync(filePath);
    const fromRoot = path.relative(fs.realpathSync(CONTENT_DIR), real);
    return Boolean(fromRoot) && !fromRoot.startsWith('..') && !path.isAbsolute(fromRoot);
  } catch { return false; }   // 文件不存在或解析失败：当作没有 frontmatter
}

export function readPostFront(filePath) {
  if (!filePath) return {};
  const resolved = path.resolve(filePath);
  if (!withinContentDir(resolved)) return {};
  return parseFrontmatter(fs.readFileSync(resolved, 'utf8')).data;
}

export function writePostFile({ filePath, front, body }) {
  const merged = { ...front };

  for (const k of Object.keys(merged)) if (merged[k] === undefined) delete merged[k];

  const text = stringifyFrontmatter(merged, body);
  atomicWrite(filePath, text);
  return { filePath, hash: crypto.createHash('sha256').update(text).digest('hex') };
}

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

export function readPostFront(filePath) {
  if (!filePath || !fs.existsSync(filePath)) return {};
  return parseFrontmatter(fs.readFileSync(filePath, 'utf8')).data;
}

export function writePostFile({ filePath, front, body }) {
  const merged = { ...front };

  for (const k of Object.keys(merged)) if (merged[k] === undefined) delete merged[k];

  const text = stringifyFrontmatter(merged, body);
  atomicWrite(filePath, text);
  return { filePath, hash: crypto.createHash('sha256').update(text).digest('hex') };
}

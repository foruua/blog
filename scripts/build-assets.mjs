#!/usr/bin/env node
// 生产静态资源预构建：精简 CSS/JS，再生成 Brotli / gzip 两份预压缩文件。
// 服务端（src/http/static.js）按 manifest 直接发 .build/<file>，不再每个请求现压；
// 源文件改了却没重新构建时，manifest 的 sha256 对不上，会自动退回运行时精简。
//
//   npm run build:assets          # 生成/更新 public/.build
//   npm run build:assets -- --check  # 只检查是否最新（CI / 发布前用）
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import zlib from 'node:zlib';
import { fileURLToPath } from 'node:url';
import { VERSIONED_ASSETS } from '../src/render/layout.js';
import { minifyAsset } from '../src/render/minify.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const PUBLIC_DIR = path.join(ROOT, 'public');
const BUILD_DIR = path.join(PUBLIC_DIR, '.build');
const MANIFEST = path.join(BUILD_DIR, 'manifest.json');
const checkOnly = process.argv.includes('--check');

const sha256 = (buf) => crypto.createHash('sha256').update(buf).digest('hex');
const files = VERSIONED_ASSETS.filter((name) => /\.(?:css|js)$/i.test(name));

// 先读旧清单，--check 时用来比较；正常构建时只作为“需要写哪些文件”的参考。
let previous = null;
try { previous = JSON.parse(fs.readFileSync(MANIFEST, 'utf8')); } catch { /* 首次构建 */ }

const manifest = { version: 1, builtAt: new Date().toISOString(), files: {} };
let stale = false;

for (const rel of files) {
  const sourceFile = path.join(PUBLIC_DIR, rel);
  const source = fs.readFileSync(sourceFile);
  const stat = fs.statSync(sourceFile);
  const minified = await minifyAsset(sourceFile, source.toString('utf8'));
  const minBuf = Buffer.from(minified, 'utf8');
  const br = zlib.brotliCompressSync(minBuf, {
    params: { [zlib.constants.BROTLI_PARAM_QUALITY]: 11 },
  });
  const gz = zlib.gzipSync(minBuf, { level: 9 });

  const entry = {
    hash: sha256(source),
    size: stat.size,
    mtimeMs: stat.mtimeMs,
    min: rel,
    br: `${rel}.br`,
    gzip: `${rel}.gz`,
    minBytes: minBuf.length,
    brBytes: br.length,
    gzipBytes: gz.length,
  };
  manifest.files[rel] = entry;

  const old = previous?.files?.[rel];
  if (!old || old.hash !== entry.hash
      || !fs.existsSync(path.join(BUILD_DIR, entry.br))
      || !fs.existsSync(path.join(BUILD_DIR, entry.gzip))
      || !fs.existsSync(path.join(BUILD_DIR, entry.min))) {
    stale = true;
  }

  if (checkOnly) continue;
  const out = path.join(BUILD_DIR, rel);
  fs.mkdirSync(path.dirname(out), { recursive: true });
  fs.writeFileSync(out, minBuf);
  fs.writeFileSync(`${out}.br`, br);
  fs.writeFileSync(`${out}.gz`, gz);
}

// 源清单里已经删掉的资源：清掉旧输出，避免 .build 越积越多。
if (previous?.files && !checkOnly) {
  for (const rel of Object.keys(previous.files)) {
    if (manifest.files[rel]) continue;
    for (const suffix of ['', '.br', '.gz']) {
      fs.rmSync(path.join(BUILD_DIR, `${rel}${suffix}`), { force: true });
    }
  }
}

if (checkOnly) {
  if (stale || !previous || previous.version !== manifest.version) {
    console.error('✗ public/.build 不是最新：请运行 npm run build:assets');
    process.exit(1);
  }
  console.log(`✓ 预构建资源已是最新（${files.length} 个文件）`);
  process.exit(0);
}

fs.mkdirSync(BUILD_DIR, { recursive: true });
const tmp = `${MANIFEST}.tmp-${process.pid}`;
fs.writeFileSync(tmp, `${JSON.stringify(manifest, null, 2)}\n`);
fs.renameSync(tmp, MANIFEST);
console.log(`✓ 已生成 public/.build：${files.length} 个资源，manifest ${path.relative(ROOT, MANIFEST)}`);

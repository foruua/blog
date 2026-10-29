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
import { SITE_SOURCES } from '../src/render/assets.js';
import { minifyAsset } from '../src/render/minify.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const PUBLIC_DIR = path.join(ROOT, 'public');
const BUILD_DIR = path.join(PUBLIC_DIR, '.build');
const MANIFEST = path.join(BUILD_DIR, 'manifest.json');
const checkOnly = process.argv.includes('--check');

const sha256 = (buf) => crypto.createHash('sha256').update(buf).digest('hex');
const files = VERSIONED_ASSETS.filter((name) => /\.(?:css|js)$/i.test(name))
  // 打包后前台只请求 site.js；五个源脚本只在 bundle 过期时回退。生产构建不再为它们各生成一份
  // 精简与 br/gzip（运行时 sendFile 仍能在回退时按需精简），少 5 个文件、少一份重复产物。
  .filter((name) => !SITE_SOURCES.includes(name));

// —— 页面级 CSS 变体 ——
// public/style.css 里用 /* @page-css <name>:start|end */ 标出「只有某类页面才用」的段。
// 这里按同一份源切出变体，规则顺序与全量逐字节一致，层叠行为不变：
//   style-lite.css    首页/列表/归档/友圈/友链/检索/404：去掉评论区与笔记流
//   style-article.css 文章/笔记内页与固定页：只去掉笔记流
// /notes/ 保留全量（评论区 + 笔记流都要）；无构建产物时服务端自动回退全量 style.css。
const PAGE_CSS_VARIANTS = {
  lite: { file: 'style-lite.css', drop: ['comments', 'notes'] },
  article: { file: 'style-article.css', drop: ['notes'] },
};
const PAGE_CSS_STAMP = path.join(BUILD_DIR, 'page-css.json');

function stripPageCss(source, drop) {
  const out = [];
  let open = '';
  for (const line of source.split('\n')) {
    const marker = /^\/\* @page-css ([a-z-]+):(start|end)\b/.exec(line);
    if (marker) {
      if (marker[2] === 'start') open = marker[1];
      else if (open === marker[1]) open = '';
      continue;
    }
    if (!drop.includes(open)) out.push(line);
  }
  return out.join('\n');
}

function pageCssSources() {
  const source = fs.readFileSync(path.join(PUBLIC_DIR, 'style.css'), 'utf8');
  return {
    sourceHash: sha256(source),
    variants: Object.fromEntries(Object.entries(PAGE_CSS_VARIANTS).map(([key, { file, drop }]) => [key, { file, text: stripPageCss(source, drop) }])),
  };
}

function syncPageCss(checkOnly) {
  const { sourceHash, variants } = pageCssSources();
  let stale = false;
  for (const { file, text } of Object.values(variants)) {
    const target = path.join(PUBLIC_DIR, file);
    if (checkOnly) {
      let current = null;
      try { current = fs.readFileSync(target, 'utf8'); } catch { /* 没生成过 */ }
      if (current !== text) stale = true;
      continue;
    }
    fs.writeFileSync(target, text);
  }
  if (checkOnly) {
    let stamp = null;
    try { stamp = JSON.parse(fs.readFileSync(PAGE_CSS_STAMP, 'utf8')); } catch { /* 首次构建 */ }
    if (stamp?.sourceHash !== sourceHash) stale = true;
  } else {
    fs.mkdirSync(BUILD_DIR, { recursive: true });
    fs.writeFileSync(PAGE_CSS_STAMP, `${JSON.stringify({ version: 1, sourceHash }, null, 2)}\n`);
  }
  return stale;
}

const pageCssStale = syncPageCss(checkOnly);

// —— 前台脚本 bundle ——
// 五个 defer 脚本合成一个请求：省 4 次往返与每份独立的压缩头。开发/无构建时回退到 5 个标签，
// 源文件仍是唯一真相（测试直接 eval public/*.js，不受影响）。顺序必须保持 request → ui → nav → search → app。
// 清单沿用 render/assets.js 的 SITE_SOURCES，避免构建脚本与运行时回退各维护一份顺序。
const SITE_BUNDLE = path.join(PUBLIC_DIR, 'site.js');
const SITE_STAMP = path.join(BUILD_DIR, 'site-bundle.json');

function siteBundleSources() {
  const hashes = {};
  const parts = [];
  for (const file of SITE_SOURCES) {
    const text = fs.readFileSync(path.join(PUBLIC_DIR, file), 'utf8');
    hashes[file] = sha256(text);
    parts.push(text);
  }
  return { text: `${parts.join('\n;\n')}\n`, hashes };
}

function syncSiteBundle(checkOnly) {
  const { text, hashes } = siteBundleSources();
  if (!checkOnly) fs.writeFileSync(SITE_BUNDLE, text);
  let stale = false;
  if (checkOnly) {
    let current = null;
    try { current = fs.readFileSync(SITE_BUNDLE, 'utf8'); } catch { /* 没生成过 */ }
    if (current !== text) stale = true;
  }
  let stamp = null;
  try { stamp = JSON.parse(fs.readFileSync(SITE_STAMP, 'utf8')); } catch { /* 首次构建 */ }
  if (JSON.stringify(stamp?.hashes) !== JSON.stringify(hashes)) {
    stale = true;
    if (!checkOnly) {
      fs.mkdirSync(BUILD_DIR, { recursive: true });
      fs.writeFileSync(SITE_STAMP, `${JSON.stringify({ version: 1, hashes }, null, 2)}\n`);
    }
  }
  return stale;
}

const siteBundleStale = syncSiteBundle(checkOnly);

// 先读旧清单，--check 时用来比较；正常构建时只作为“需要写哪些文件”的参考。
let previous = null;
try { previous = JSON.parse(fs.readFileSync(MANIFEST, 'utf8')); } catch { /* 首次构建 */ }

const manifest = { version: 1, builtAt: new Date().toISOString(), files: {} };
let stale = pageCssStale || siteBundleStale;

for (const rel of files) {
  const sourceFile = path.join(PUBLIC_DIR, rel);
  if (checkOnly && !fs.existsSync(sourceFile)) { stale = true; continue; }
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
    // mtimeMs 不参与本脚本 --check 的 stale 判断（hash 已覆盖），但 src/http/static.js 的
    // precompiledFor 运行时会用 size+mtimeMs 拒收「构建后源文件又被编辑过」的产物。
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

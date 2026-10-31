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
// 打包后前台只请求 site.js；五个源脚本只在 bundle 过期时回退。生产构建不再为它们各生成一份
// 精简与 br/gzip（运行时 sendFile 仍能在回退时按需精简），少 5 个文件、少一份重复产物。
// 例外：request.js / ui.js / nav.js 还被后台页面单独引用（不进 bundle），必须照常产出预压缩文件，
// 否则后台每次都走运行时精简 + 现压；只有纯属 bundle 的 search.js / app.js 可以跳过。
const BUNDLE_ONLY_SOURCES = ['search.js', 'app.js'];
const files = VERSIONED_ASSETS.filter((name) => /\.(?:css|js)$/i.test(name))
  .filter((name) => !BUNDLE_ONLY_SOURCES.includes(name));

// —— 页面级 CSS 变体 ——
// public/style.css 里用 /* @page-css <name>:start|end */ 标出「只有某类页面才用」的段。
// 这里按同一份源切出变体，规则顺序与全量逐字节一致，层叠行为不变：
//   style-lite.css    首页/列表/归档/友圈/友链/检索/404：去掉评论区（笔记列表也是普通列表，走这一份）
// 文章页不切变体：评论区本来就是文章页的一部分，没有可删的段。以前那份 style-article.css 是
// drop 空数组的全量副本（与 style.css 只差两行注释，压完差 0.2KB），纯属多一份产物，已删除。
// 无构建产物时服务端自动回退全量 style.css。
const PAGE_CSS_VARIANTS = {
  lite: { file: 'style-lite.css', drop: ['comments'] },
};
const PAGE_CSS_STAMP = path.join(BUILD_DIR, 'page-css.json');

// 变体必须真的更小，否则它只是「换个文件名的全量副本」：既没省字节，又让部署多维护一份。
// 3% 是底线而不是目标（lite 当前比全量小 10% 源 / 12% 压后）；真掉到这条线以下，
// 说明那个段已经不构成页面差异，该考虑删掉变体而不是继续背着它。
const MIN_VARIANT_SAVING = 0.03;

// 标记必须严格配对：以前 style.css 里多出一个 notes:end，让已删除的笔记流段提前闭合、样式漏进两份变体。
// 那段代码已经删除，但配对检查必须留着：任何未闭合、重复闭合、嵌套都会让构建直接失败，
// 而不是产出一份「看起来正常」的样式表。
function stripPageCss(source, drop) {
  const out = [];
  let open = '';
  let openAt = 0;
  source.split('\n').forEach((line, index) => {
    const marker = /^\/\* @page-css ([a-z-]+):(start|end)\b/.exec(line);
    if (marker) {
      const [, name, kind] = marker;
      if (kind === 'start') {
        if (open) throw new Error(`style.css:${index + 1} 在 ${open} 段（第 ${openAt} 行）未闭合时又开了 ${name} 段`);
        open = name; openAt = index + 1;
        return;
      }
      if (open !== name) throw new Error(`style.css:${index + 1} 的 @page-css ${name}:end 没有对应的 start（当前打开：${open || '无'}）`);
      open = '';
      return;
    }
    if (!drop.includes(open)) out.push(line);
  });
  if (open) throw new Error(`style.css:${openAt} 的 @page-css ${open}:start 没有对应的 end`);
  return out.join('\n');
}

function pageCssSources() {
  const source = fs.readFileSync(path.join(PUBLIC_DIR, 'style.css'), 'utf8');
  const sourceBytes = Buffer.byteLength(source);
  const variants = {};
  for (const [key, { file, drop }] of Object.entries(PAGE_CSS_VARIANTS)) {
    const text = stripPageCss(source, drop);
    const saving = 1 - Buffer.byteLength(text) / sourceBytes;
    if (saving < MIN_VARIANT_SAVING) {
      throw new Error(`${file} 只比全量 style.css 小 ${(saving * 100).toFixed(1)}%（下限 ${MIN_VARIANT_SAVING * 100}%）：这个变体已经没有收益，删掉它，或者让 drop 的段真的能砍下体积`);
    }
    variants[key] = { file, text };
  }
  return { sourceHash: sha256(source), variants };
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

// —— 传输体积预算 ——
// Brotli 后的字节才是访客真正付出的成本。阈值按当前实测上浮约 10%，用意不是「不许长大」，
// 而是逼每次增长都被看见：真要加 3KB，就把预算一并改上去并在提交信息里说明值不值。
const SIZE_BUDGET = {
  'base.css': 5 * 1024,
  'style.css': 15 * 1024,
  'style-lite.css': 14 * 1024,
  'site.js': 22 * 1024,
  // 后台不在首屏关键路径上，但同样别让它悄悄翻倍。
  'admin.css': 15 * 1024,
  'admin.js': 10 * 1024,
};
// 首屏阻塞资源（HTML 之外）：首页 = base + lite + site；文章页 = base + 全量 + site。
const FIRST_SCREEN_BUDGET = 42 * 1024;

function assertBudgets() {
  const kb = (n) => `${(n / 1024).toFixed(1)}K`;
  const problems = [];
  for (const [name, limit] of Object.entries(SIZE_BUDGET)) {
    const bytes = manifest.files[name]?.brBytes;
    if (bytes > limit) problems.push(`${name} ${kb(bytes)} 超预算 ${kb(limit)}`);
  }
  const firstScreen = (styleName) => ['base.css', styleName, 'site.js']
    .reduce((sum, name) => sum + (manifest.files[name]?.brBytes ?? 0), 0);
  for (const [label, styleName] of [['首页', 'style-lite.css'], ['文章页', 'style.css']]) {
    const bytes = firstScreen(styleName);
    if (bytes > FIRST_SCREEN_BUDGET) problems.push(`${label}首屏 ${kb(bytes)} 超预算 ${kb(FIRST_SCREEN_BUDGET)}`);
  }
  if (!problems.length) return;
  console.error(`✗ 传输体积超出预算：\n  ${problems.join('\n  ')}\n`
    + '  确认这份增长值得之后，再调高 scripts/build-assets.mjs 里的 SIZE_BUDGET / FIRST_SCREEN_BUDGET。');
  process.exit(1);
}

assertBudgets();

if (checkOnly) {
  // 当前文件集合也必须和旧清单一致：只比较逐个文件会漏掉「旧版构建出来的、新版已不再生成的」
  // 5 个源脚本，CI 会误报“已是最新”。
  const previousKeys = Object.keys(previous?.files ?? {}).sort().join('\n');
  const currentKeys = Object.keys(manifest.files).sort().join('\n');
  if (previousKeys !== currentKeys) stale = true;
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

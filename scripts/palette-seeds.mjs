/* 从 base.css 的实际令牌反算每套预设的「自定义」种子。
 *
 * 为什么需要这个：预设是手绘的 18 个令牌，自定义走的是另一套 OKLCH 骨架。两边若各写各的，
 * 从预设拖一下滑块就是一次跳色（宣纸的灰墨会变成土黄）。种子必须能**逐字复现**预设，
 * 而唯一可靠的来源是令牌本身 —— 手抄一份 hex 进 settings.js，改令牌时必然忘。
 *
 * 用法：node scripts/palette-seeds.mjs          打印贴进 settings.js 的字段
 *       node scripts/palette-seeds.mjs --check  只校验现有种子是否与令牌一致（退出码 1 = 漂了）
 *
 * 反算公式（与 public/palette.js 的 tokensOf 互为逆运算）：
 *   chroma = ink 的 OKLCH 彩度
 *   paper  = paper 的彩度 / PAPER_C_MAX
 *   inkL   = ink 的 OKLCH 明度          inkLD = 深色 accent 的明度
 *   bgL    = paper 的明度 + paper × PAPER_L_DROP
 *   bgLD   = 深色 bg 的明度 − paper × PAPER_L_RISE
 */
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import { fileURLToPath } from 'node:url';
import { PALETTES } from '../src/settings.js';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const paletteCtx = vm.createContext({});
vm.runInContext(fs.readFileSync(path.join(root, 'public/palette.js'), 'utf8'), paletteCtx);
const lib = paletteCtx.PaletteLib;

const css = fs.readFileSync(path.join(root, 'public/base.css'), 'utf8');

/** 取某个选择器块里的两个令牌。只认第一个匹配 —— 预设块自己就是第一处。 */
function tokensOf(selector, names) {
  const i = css.indexOf(selector);
  if (i < 0) return null;
  const open = css.indexOf('{', i);
  const close = css.indexOf('}', open);
  const body = css.slice(open + 1, close);
  const out = {};
  for (const name of names) {
    const m = new RegExp(`--${name}:\\s*(#[0-9a-fA-F]{6})`).exec(body);
    if (!m) return null;
    out[name] = m[1];
  }
  return out;
}

const selectors = (p) => (p.key
  ? { light: `html[data-palette="${p.key}"]`, dark: `html[data-theme="dark"][data-palette="${p.key}"]` }
  // 素笺是默认，不挂 data-palette：它的令牌在 :root / 深色 :root 里。
  : { root: true });

// 素笺的令牌不在独立块里：浅色在 :root，深色在「系统深色」那条 html:not(...) 上
// （与显式深色的 html[data-theme="dark"] 逐字相同，只是表达系统深色）。
// 不靠行号也不靠注释文字 —— 按选择器找块，取第一个带 --bg 的。
function blockAt(selector) {
  let from = 0;
  while (true) {
    const i = css.indexOf(selector, from);
    if (i < 0) return null;
    const open = css.indexOf('{', i);
    const close = css.indexOf('}', open);
    const body = css.slice(open + 1, close);
    if (/--bg:\s*#[0-9a-fA-F]{6}/.test(body)) {
      const pick = (n) => {
        const hit = new RegExp(`--${n}:\\s*(#[0-9a-fA-F]{6})`).exec(body);
        return hit ? hit[1] : null;
      };
      return { bg: pick('bg'), accent: pick('accent') };
    }
    from = i + selector.length;
  }
}

function sujianTokens() {
  return {
    light: blockAt(':root'),
    dark: blockAt('html:not([data-theme="light"]):not([data-theme="dark"])'),
  };
}

function seedsOf(p) {
  const sel = selectors(p);
  let tokens;
  if (sel.root) {
    tokens = sujianTokens();
  } else {
    const light = tokensOf(sel.light, ['bg', 'accent']);
    const dark = tokensOf(sel.dark, ['bg', 'accent']);
    if (!light || !dark) return null;
    tokens = { light, dark };
  }
  if (!tokens.light?.bg || !tokens.light?.accent || !tokens.dark?.bg || !tokens.dark?.accent) return null;

  const ink = lib.hexToOklch(tokens.light.accent);
  const paper = lib.hexToOklch(tokens.light.bg);
  const inkD = lib.hexToOklch(tokens.dark.accent);
  const paperD = lib.hexToOklch(tokens.dark.bg);
  const paperStrength = paper.C / lib.PAPER_C_MAX;
  const paperStrengthD = paperD.C / lib.PAPER_C_MAX;
  return {
    hue: Math.round(ink.H),
    chroma: ink.C,
    chromaD: inkD.C,
    paper: paperStrength,
    paperD: paperStrengthD,
    inkL: ink.L,
    inkLD: inkD.L,
    bgL: paper.L + paperStrength * lib.PAPER_L_DROP,
    bgLD: paperD.L - paperStrengthD * lib.PAPER_L_RISE,
  };
}

const rows = [];
for (const p of PALETTES) {
  const s = seedsOf(p);
  if (!s) { console.error(`✗ ${p.name}：找不到令牌块（选择器变了？）`); process.exit(1); }
  rows.push({ p, s });
}

/** 用反算出的种子跑一遍生成器，看能不能逐字还原令牌 —— 这才是「零跳变」的判据。 */
function verify({ p, s }) {
  // 必须带版本号：不带的话 normalizeSeed 会把这些值当旧倍率再换算一次（纸色直接被除 1.8）。
  const seed = { ...s, v: lib.SEED_VERSION };
  const t = lib.tokensOf(s.hue, seed, false);
  const dark = lib.tokensOf(s.hue, seed, true);
  const sel = selectors(p);
  const light = sel.root ? sujianTokens().light : tokensOf(sel.light, ['bg', 'accent']);
  const dk = sel.root ? sujianTokens().dark : tokensOf(sel.dark, ['bg', 'accent']);
  return {
    accent: { want: light.accent, got: t.accent },
    bg: { want: light.bg, got: t.bg },
    accentDark: { want: dk.accent, got: dark.accent },
    bgDark: { want: dk.bg, got: dark.bg },
  };
}

// 逐通道容差：浅色 1/255，深色 6/255。
// 浅色是主场景，必须逐字（1 是 oklchToHex 末尾 Math.round 的往返误差）。
// 深色放宽容差是因为深色令牌的色相与浅色不完全一致（同一套配色的深色版本来就偏一点），
// 而种子里只有一个 hue —— 真要补齐得再加 hueD / bgHueD 两个字段，为 5/255 的不可见差异
// 把种子从 8 个字段撑到 10 个不划算。深色下 6/255 在任何色相上都读不出来。
const near = (a, b, tolerance = 1) => {
  const d = (h) => [1, 3, 5].map((i) => parseInt(h.slice(i, i + 2), 16));
  const [x, y] = [d(a), d(b)];
  return x.every((v, i) => Math.abs(v - y[i]) <= tolerance);
};

const check = process.argv.includes('--check');
let bad = 0;
// --check 还要确认 settings.js 里手抄的那份种子没漂 —— 改了 base.css 却忘了重跑脚本，
// 表现就是「屏幕上没问题、一拖滑块就跳」，只有这里抓得住。
const SEED_FIELDS = ['hue', 'chroma', 'chromaD', 'paper', 'paperD', 'inkL', 'inkLD', 'bgL', 'bgLD'];
function seedDrift(p, s) {
  const bad = [];
  for (const k of SEED_FIELDS) {
    const want = s[k];
    const got = p.seed?.[k];
    if (got === undefined) { bad.push(`${k} 缺失`); continue; }
    // hue 取整；其余留 0.002 的余量（手抄时四舍五入到三位）。
    const slack = k === 'hue' ? 0 : 0.002;
    if (Math.abs(Number(got) - want) > slack) bad.push(`${k} ${got} ≠ ${Number(want.toFixed(3))}`);
  }
  return bad;
}

for (const row of rows) {
  const v = verify(row);
  const tol = { accent: 1, bg: 1, accentDark: 6, bgDark: 6 };
  const diffs = Object.entries(v).filter(([k, d]) => !near(d.want.toLowerCase(), d.got.toLowerCase(), tol[k]));
  if (diffs.length) bad++;
  const drift = seedDrift(row.p, row.s);
  if (check && drift.length) bad++;
  const flag = diffs.length || (check && drift.length) ? '✗' : '✓';
  console.log(`${flag} ${row.p.name.padEnd(3, '　')} ` + Object.entries(v)
    .map(([k, d]) => `${k} ${d.want}${near(d.want.toLowerCase(), d.got.toLowerCase(), tol[k]) ? '' : ' → ' + d.got}`)
    .join('  '));
  if (check && drift.length) console.log(`    settings.js 里的种子漂了：${drift.join('，')}`);
  if (!check) {
    const f = (n) => Number(n.toFixed(3));
    console.log(`    { chroma: ${f(row.s.chroma)}, chromaD: ${f(row.s.chromaD)}, `
      + `paper: ${f(row.s.paper)}, paperD: ${f(row.s.paperD)}, `
      + `inkL: ${f(row.s.inkL)}, inkLD: ${f(row.s.inkLD)}, bgL: ${f(row.s.bgL)}, bgLD: ${f(row.s.bgLD)} },`);
  }
}

// 手调也有一个最低要求：8 枚语法高亮令牌在浓度拖到 0 时不能糊成一片。
const gray = lib.tokensOf(200, { chroma: 0, paper: 0.5 }, false);
const hl = ['hl-keyword', 'hl-string', 'hl-number', 'hl-title', 'hl-variable'].map((k) => gray[k]);
const spread = new Set(hl).size;
if (spread < 5) { console.error(`✗ 浓度 0 时高亮令牌只剩 ${spread} 种色，地板失效`); bad++; }

if (check) {
  if (bad) { console.error(`\n${bad} 项漂了：改过 base.css 令牌后要重跑本脚本更新 settings.js 的种子。`); process.exit(1); }
  console.log('\n全部一致。');
}

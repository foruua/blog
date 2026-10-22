/* 自定义配色生成器：色相 + 浓度 + 纸色 + 强调色深浅 → 18 个色彩令牌（浅色 / 深色各一套）。
 *
 * 为什么用 OKLCH 而不是 HSL：HSL 的 L 不是感知亮度。实测固定 L=32 扫全色相，对比度从 4.34 到 11.18
 * （差 2.6 倍，黄色 H60 直接掉到 4.5 以下），这一个公式罩不住 360 度。OKLCH 固定 L 时是 5.07—5.73，
 * 一个值就够全色相用 —— 所以「任意配色」能成立的前提就是这里。
 *
 * 边界：色相、强调色彩度、纸面色染与强调色浅深可调；纸面 / 正文的明度骨架仍锁死。这不是偷懒：
 * 纸面亮度和墨色亮度一旦完全放开，配出来的就不是「这个站的另一种配色」而是「另一个站」。
 * 强调色明度也只做 ±0.02 的微调，并且每次生成都用实际纸面再钳一遍对比度。语义色
 * （--danger / --warn）不在这里 —— 它们跟着色相转的话，删除按钮会变紫。
 *
 * 这是经典脚本（非 ESM）：ui.js 首次需要时按需注入，挂 window.PaletteLib，无依赖、无 DOM 访问。
 * Node 侧（scripts/test-palette.mjs）用 vm 执行同一份文件，不复制逻辑。
 */
(function (root) {
  'use strict';

  const clamp01 = (v) => (v < 0 ? 0 : v > 1 ? 1 : v);

  // OKLCH → 线性 sRGB（Björn Ottosson 的 OKLab 矩阵）
  function oklchLinear(L, C, H) {
    const hr = (H * Math.PI) / 180;
    const a = C * Math.cos(hr);
    const b = C * Math.sin(hr);
    const l_ = L + 0.3963377774 * a + 0.2158037573 * b;
    const m_ = L - 0.1055613458 * a - 0.0638541728 * b;
    const s_ = L - 0.0894841775 * a - 1.291485548 * b;
    const l = l_ * l_ * l_;
    const m = m_ * m_ * m_;
    const s = s_ * s_ * s_;
    return [
      4.0767416621 * l - 3.3077115913 * m + 0.2309699292 * s,
      -1.2684380046 * l + 2.6097574011 * m - 0.3413193965 * s,
      -0.0041960863 * l - 0.7034186147 * m + 1.707614701 * s,
    ];
  }

  const inGamut = (v) => v.every((x) => x >= -1e-4 && x <= 1 + 1e-4);
  const toSrgb = (v) => (v <= 0.0031308 ? 12.92 * v : 1.055 * Math.pow(v, 1 / 2.4) - 0.055);
  const hex2 = (v) => Math.round(clamp01(v) * 255).toString(16).padStart(2, '0');

  // 色域外按比例降 chroma（L 与 H 不动，只丢彩度）——二分 20 次足够收敛，且比硬裁剪好：
  // 硬裁剪会让色相偏移（橙变黄、紫变蓝），同一个滑块在两个位置能跳出两种不搭的色。
  function oklchToHex(L, C, H) {
    let lin = oklchLinear(L, C, H);
    if (!inGamut(lin)) {
      let lo = 0;
      let hi = C;
      for (let i = 0; i < 20; i++) {
        const mid = (lo + hi) / 2;
        if (inGamut(oklchLinear(L, mid, H))) lo = mid;
        else hi = mid;
      }
      lin = oklchLinear(L, lo, H);
    }
    return '#' + lin.map((v) => hex2(toSrgb(clamp01(v)))).join('');
  }

  const hexToRgb = (h) => [1, 3, 5].map((i) => parseInt(h.slice(i, i + 2), 16));

  // sRGB → OKLCH。只给「取色」用：取 H/C，L 仍由本站骨架决定 —— 否则访客选一个亮黄
  // 也能把强调色明度拖到读不清的地方。公式与上面的 OKLab 矩阵互为逆运算。
  const srgbToLinear = (v) => (v <= 0.04045 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4));
  function hexToOklch(hex) {
    const text = String(hex ?? '').trim().replace(/^#/, '');
    if (!/^[0-9a-f]{6}$/i.test(text)) return null;
    const [r, g, b] = [0, 2, 4].map((i) => srgbToLinear(parseInt(text.slice(i, i + 2), 16) / 255));
    const l = Math.cbrt(0.4122214708 * r + 0.5363325363 * g + 0.0514459929 * b);
    const m = Math.cbrt(0.2119034982 * r + 0.6806995451 * g + 0.1073969566 * b);
    const s = Math.cbrt(0.0883024619 * r + 0.2817188376 * g + 0.6299787005 * b);
    const L = 0.2104542553 * l + 0.793617785 * m - 0.0040720468 * s;
    const A = 1.9779984951 * l - 2.428592205 * m + 0.4505937099 * s;
    const B = 0.0259040371 * l + 0.7827717662 * m - 0.808675766 * s;
    const C = Math.sqrt(A * A + B * B);
    const H = (Math.atan2(B, A) * 180 / Math.PI + 360) % 360;
    return { L, C, H };
  }

  /* 浓度三档仍然是「快速刻度」，但不再是唯一入口：下面的滑块在三档之间连续取值。
     三档给出三个明确意图，滑块负责「差一点」的那部分。 */
  const LEVELS = { soft: 0.72, mid: 1, bold: 1.3 };
  const LEVEL_KEYS = ['soft', 'mid', 'bold'];

  /* 自定义的三个旋钮：浓度（强调色彩度倍率）、纸色（纸面彩度倍率）、深浅（强调色明度偏移）。
     浓度 0.55—1.45 覆盖「近灰」到「浓艳」；纸色 0—1.8 覆盖「中性纸」到「明显染色」；
     深浅只给三档（轻 / 标准 / 重），实际偏移 ±0.02 后还要过对比度钳制。 */
  const CHROMA_RANGE = { min: 0.55, max: 1.45 };
  const PAPER_RANGE = { min: 0, max: 1.8 };
  const INK_KEYS = [-1, 0, 1];
  const INK_STEP = 0.02;

  // 语法高亮的辅助色相：向固定锚点收敛（权重 0.78—0.85），任何主色相下都能和 keyword 分开，
  // 又都染着一点主色的味道 —— 直接固定成五个纯色会和整套配色打架，完全跟随主色相则五个分不开。
  const mixHue = (h, anchor, weight) => (h + (anchor - h) * weight + 360) % 360;

  const SHAPES = {
    light: {
      L: {
        bg: 0.962, soft: 0.922, elev: 0.986, accent: 0.48, accentInk: 0.44,
        codeBg: 0.945, codeFg: 0.3,
        comment: 0.49, keyword: 0.46, string: 0.46, number: 0.48,
        title: 0.45, variable: 0.46, meta: 0.49, deletion: 0.5,
      },
      C: { bg: 0.011, soft: 0.016, elev: 0.006, accent: 0.105, code: 0.008, hl: 0.1 },
      soft: 0.1,
      line: 0.34,
      gold: [[0.8, 0.09], [0.58, 0.11], [0.88, 0.06]],
      goldStop: '42%',
    },
    dark: {
      L: {
        bg: 0.19, soft: 0.245, elev: 0.215, accent: 0.79, accentInk: 0.84,
        codeBg: 0.205, codeFg: 0.88,
        comment: 0.67, keyword: 0.8, string: 0.8, number: 0.8,
        title: 0.8, variable: 0.8, meta: 0.67, deletion: 0.78,
      },
      C: { bg: 0.022, soft: 0.024, elev: 0.023, accent: 0.105, code: 0.016, hl: 0.1 },
      soft: 0.13,
      line: 0.36,
      gold: [[0.85, 0.07], [0.7, 0.1], [0.92, 0.05]],
      goldStop: '45%',
    },
  };

  // 令牌顺序即输出顺序，测试与 CSP 校验都按这份清单认。
  const TOKENS = [
    'bg', 'bg-soft', 'bg-elev',
    'accent', 'accent-ink', 'accent-soft', 'accent-line',
    'gold', 'code-bg', 'code-fg',
    'hl-comment', 'hl-keyword', 'hl-string', 'hl-number',
    'hl-title', 'hl-variable', 'hl-meta', 'hl-deletion',
  ];

  const clampRange = (v, min, max, fallback) => {
    const n = Number(v);
    return Number.isFinite(n) ? Math.min(max, Math.max(min, n)) : fallback;
  };

  const levelOfChroma = (chroma) => {
    const c = Number(chroma);
    let best = 'mid';
    let dist = Infinity;
    for (const key of LEVEL_KEYS) {
      const d = Math.abs(LEVELS[key] - c);
      if (d < dist) { dist = d; best = key; }
    }
    return best;
  };

  /* 种子归一：色相取整归一、三个旋钮各自钳进安全区间。旧调用 customCss(hue, 'mid') 仍然认，
     等价于 {chroma: LEVELS.mid, paper: 1, ink: 0}。返回的 level 只用于 CSS 种子回读和 aria-label。 */
  function normalizeSeed(hue, opts) {
    const h = Math.round(((Number(hue) % 360) + 360) % 360);
    const o = opts && typeof opts === 'object' ? opts : {};
    const legacy = typeof opts === 'string' ? LEVELS[opts] : undefined;
    const chroma = clampRange(o.chroma ?? legacy, CHROMA_RANGE.min, CHROMA_RANGE.max, LEVELS.mid);
    const paper = clampRange(o.paper, PAPER_RANGE.min, PAPER_RANGE.max, 1);
    const ink = clampRange(o.ink, -1, 1, 0);
    return {
      hue: Number.isFinite(h) ? h : 0,
      chroma,
      paper,
      ink,
      level: levelOfChroma(chroma),
    };
  }

  // 「重」= 对比更强：浅色纸往下压明度，深色纸往上提明度。先按访客选的方向算，
  // 再拿实际纸面做一次对比度钳制 —— 滑块可以拖到边界，但读不清的组合不会真的落地。
  const inkL = (L, ink, dark) => L + (dark ? 1 : -1) * ink * INK_STEP;

  function accentOf(seed, s, dark, bg, elev) {
    const paperIsLight = luminance(bg) > 0.5;
    let L = inkL(s.L.accent, seed.ink, dark);
    let hex = oklchToHex(L, s.C.accent * seed.chroma, seed.hue);
    for (let i = 0; i < 24; i++) {
      if (contrast(hex, bg) >= 4.55 && contrast(hex, elev) >= 4.55) break;
      L += paperIsLight ? -0.004 : 0.004;
      hex = oklchToHex(L, s.C.accent * seed.chroma, seed.hue);
    }
    return { hex, L };
  }

  function tokensOf(hue, opts, dark) {
    const seed = normalizeSeed(hue, opts);
    const s = SHAPES[dark ? 'dark' : 'light'];
    const ca = seed.chroma;
    const cp = seed.paper;
    const bg = oklchToHex(s.L.bg, s.C.bg * cp, seed.hue);
    const elev = oklchToHex(s.L.elev, s.C.elev * cp, seed.hue);
    const accent = accentOf(seed, s, dark, bg, elev);
    const [r, g, b] = hexToRgb(accent.hex);
    const gold = s.gold
      .map(([L, C], i) => `${oklchToHex(L, C * ca, seed.hue)} ${i === 1 ? s.goldStop : i === 0 ? '0%' : '100%'}`)
      .join(', ');
    // accent-ink 跟着 accent 的实际位移走，保持「同一支墨的深浅两档」这层关系。
    const accentInkL = s.L.accentInk + (accent.L - s.L.accent);
    return {
      bg,
      'bg-soft': oklchToHex(s.L.soft, s.C.soft * cp, seed.hue),
      'bg-elev': elev,
      accent: accent.hex,
      'accent-ink': oklchToHex(accentInkL, s.C.accent * ca * 1.05, seed.hue),
      'accent-soft': `rgba(${r}, ${g}, ${b}, ${s.soft})`,
      'accent-line': `rgba(${r}, ${g}, ${b}, ${s.line})`,
      gold: `linear-gradient(120deg, ${gold})`,
      'code-bg': oklchToHex(s.L.codeBg, s.C.code * cp, seed.hue),
      'code-fg': oklchToHex(s.L.codeFg, s.C.code * ca * 1.5, seed.hue),
      'hl-comment': oklchToHex(s.L.comment, s.C.hl * ca * 0.12, seed.hue),
      'hl-keyword': oklchToHex(s.L.keyword, s.C.hl * ca, seed.hue),
      'hl-string': oklchToHex(s.L.string, s.C.hl * ca * 0.82, mixHue(seed.hue, 148, 0.78)),
      'hl-number': oklchToHex(s.L.number, s.C.hl * ca * 0.9, mixHue(seed.hue, 55, 0.82)),
      'hl-title': oklchToHex(s.L.title, s.C.hl * ca * 0.75, mixHue(seed.hue, 245, 0.85)),
      'hl-variable': oklchToHex(s.L.variable, s.C.hl * ca * 0.8, mixHue(seed.hue, 298, 0.85)),
      'hl-meta': oklchToHex(s.L.meta, s.C.hl * ca * 0.14, seed.hue),
      'hl-deletion': oklchToHex(s.L.deletion, s.C.hl * ca * 1.05, mixHue(seed.hue, 22, 0.82)),
    };
  }

  const decl = (t) => TOKENS.map((name) => `--${name}:${t[name]}`).join(';');

  const SEL = 'html[data-palette="custom"]';
  const SEL_DARK = 'html[data-theme="dark"][data-palette="custom"]';
  const SEL_AUTO = 'html:not([data-theme="light"]):not([data-theme="dark"])[data-palette="custom"]';

  /* 生成三段：浅色 / 显式深色 / 系统深色。
     后两段逐字相同是**故意**的（与 style.css 里预设那套一致）：CSS 没法用一条规则同时表达
     「显式深色」与「系统深色」，合并只能靠 light-dark()，不支持的浏览器上整套会塌。
     另：--seed-* 不是配色令牌，是给面板读回控件位置的 —— 存在 CSS 里就不用再开一个
     localStorage 键，也不会出现「种子和值对不上」的半截状态。--seed-lv 保留给旧版面板/旧数据，
     新面板优先读 --seed-c / --seed-p / --seed-k。 */
  function customCss(hue, opts) {
    const seed = normalizeSeed(hue, opts);
    const light = tokensOf(seed.hue, seed, false);
    const dark = tokensOf(seed.hue, seed, true);
    const darkDecl = decl(dark);
    const seeds = `--seed-h:${seed.hue};--seed-lv:${seed.level}`
      + `;--seed-c:${seed.chroma.toFixed(2)};--seed-p:${seed.paper.toFixed(2)};--seed-k:${seed.ink.toFixed(2)}`;
    return `${SEL}{${decl(light)};${seeds}}`
      + `${SEL_DARK}{${darkDecl}}`
      + `@media (prefers-color-scheme:dark){${SEL_AUTO}{${darkDecl}}}`;
  }

  // 相对亮度与对比度（WCAG），测试与 UI 提示共用。
  const luminance = (hex) => {
    const c = hex.replace('#', '');
    const v = [0, 2, 4]
      .map((i) => parseInt(c.slice(i, i + 2), 16) / 255)
      .map((x) => (x <= 0.03928 ? x / 12.92 : Math.pow((x + 0.055) / 1.055, 2.4)));
    return 0.2126 * v[0] + 0.7152 * v[1] + 0.0722 * v[2];
  };
  const contrast = (a, b) => {
    const [x, y] = [luminance(a), luminance(b)].sort((m, n) => n - m);
    return (x + 0.05) / (y + 0.05);
  };

  /* localStorage 是访客可写的，这里存的是整段 CSS —— 不校验就等于允许任何人往页面里塞规则。
     校验只做三件事：字符集白名单、长度上限、禁掉能引外部资源的构造。够用且不必和生成器同步演进。 */
  const SAFE_CSS = /^[#0-9a-z(),.;:%\s\-[\]{}"=+@]{1,8000}$/i;
  function sanitize(css) {
    const text = typeof css === 'string' ? css : '';
    if (!text || !SAFE_CSS.test(text)) return '';
    if (/url\(|@import|expression|<|>|\\/i.test(text)) return '';
    return text;
  }

  root.PaletteLib = {
    TOKENS,
    LEVELS,
    LEVEL_KEYS,
    CHROMA_RANGE,
    PAPER_RANGE,
    INK_KEYS,
    normalizeSeed,
    levelOfChroma,
    hexToOklch,
    tokensOf,
    customCss,
    contrast,
    sanitize,
  };
})(typeof globalThis !== 'undefined' ? globalThis : this);

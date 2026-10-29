/* 自定义配色生成器：色相 + 浓度 + 纸色 + 强调色深浅 → 19 个色彩令牌（浅色 / 深色各一套）。
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
 * 这是经典脚本（非 ESM）：ui.js 首次需要时按需注入，挂 globalThis.PaletteLib，无依赖、无 DOM 访问。
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

  /* 自定义的三个旋钮：浓度、纸色、深浅。
     浓度是**绝对 OKLCH 彩度**（0—0.145），不是倍率。这一条是踩出来的：
     sRGB 在 L=0.48 处每个色相能承受的彩度差 3 倍（红可到 0.195，青蓝只到 0.082），
     倍率上限 1.45 换算出 0.152 —— 九成色相根本到不了，超出的部分被降 chroma 的二分静默吞掉，
     于是「浓淡」滑块后半程是一个颜色都不变的死区（宣纸只有 44% 行程有效，青蓝 25%）。
     改成绝对值 + 色域拟合（见 fitL）之后，滑块走多远，墨就浓多少。
     纸色同理：强度 0—1，对应最大彩度 0.036；浅色纸压暗 0.028，深色纸提亮 0.028
     （纸是自己染的 —— 染得越浓，纸也略暗/亮一点，这比只改彩度更像「换了一张纸」）。
     两个明度斜率都从旧值（0.013 / 0.010）提到了 0.028；C_MAX 也从 0.022 提到 0.036 ——
     否则 100% 的纸只比默认纸暖几个色阶，滑块后半程几乎没有颜色变化。
     改 C_MAX 后预设的 paper / paperD 强度要重跑 scripts/palette-seeds.mjs（强度是相对上限的比例），
     否则预设会在第一帧就变浓；存量自定义种子不迁移，同一强度会变浓，这是本次刻意的增强。
     深浅仍只给三档（轻 / 标准 / 重），±0.02 偏移后还要过对比度钳制。 */
  const CHROMA_RANGE = { min: 0, max: 0.145 };
  const PAPER_RANGE = { min: 0, max: 1 };
  const PAPER_C_MAX = 0.036;
  // v4 及更早的纸色彩度上限。paper / paperD 存的是「相对上限的强度」，换上限时必须按比例折回。
  const PAPER_C_MAX_V4 = 0.022;
  // 旧斜率：v3 的浅色纸是 0.013、v2 及更早的深色纸是 0.010。存量种子要按这两个值折回。
  const PAPER_L_DROP = 0.028;
  const PAPER_L_DROP_V3 = 0.013;
  const PAPER_L_RISE = 0.028;
  const PAPER_L_RISE_V2 = 0.010;
  const INK_KEYS = [-1, 0, 1];
  const INK_STEP = 0.02;
  // 超色域时最多允许压暗多少明度来换彩度。上限 0.09 是量出来的：
  // 最吃紧的黄色相（H≈80）要把 C 顶到 0.145，得从 L=0.48 压到约 0.39；再低就发黑不像墨了。
  const L_FIT_MAX = 0.09;
  // 旧版浓淡是倍率（0.55—1.45），纸色是倍率（0—1.8）。v2 起是绝对彩度（0—0.145）与强度（0—1）；
  // 纸色的旧范围 0—1.8 与新范围 0—1 在 0—1 之间**重叠**，光看数值分不出来，只能认版本号。
  // v3 改了深色纸的明度斜率 PAPER_L_RISE，v4 改了浅色纸的 PAPER_L_DROP，
  // v5 又把纸色彩度上限 PAPER_C_MAX 从 0.022 提到 0.036：
  // 存量种子的 --seed-p/-pd 要按上限比例折算，--seed-bl/-bd 还要按折算前后的强度重算基线，
  // 否则存量自定义配色一拖纸色就会先跳一下。当前版本写进 --seed-v，换算完立刻升到 v5。
  const DIM_VERSION = 2;
  const SEED_VERSION = 5;
  // 生成器版本：种子迁移管不到「骨架/算法本身」的升级。存进 CSS 的 --seed-g 与这个数
  // 不一致时，ui.js 会在空闲时用同一组种子重算一次，老 custom 不至于停在旧算法上。
  const GEN_VERSION = 1;
  // 旧倍率 1.0 当年对应的是旧上限 0.105，不是现在这个 0.145 —— 换算要用旧尺子量旧值，
  // 否则旧用户的 mid 会悄悄变浓 40%。
  const LEGACY_CHROMA_SCALE = 0.105;
  const LEGACY_CHROMA_SPLIT = 0.3;
  const LEGACY_PAPER_SCALE = 1.8;

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
        bg: 0.218, soft: 0.261, elev: 0.243, accent: 0.79, accentInk: 0.84,
        codeBg: 0.252, codeFg: 0.88,
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
    'gold', 'code-bg', 'code-fg', 'muted',
    'hl-comment', 'hl-keyword', 'hl-string', 'hl-number',
    'hl-title', 'hl-variable', 'hl-meta', 'hl-deletion',
  ];

  const clampRange = (v, min, max, fallback) => {
    const n = Number(v);
    return Number.isFinite(n) ? Math.min(max, Math.max(min, n)) : fallback;
  };

  // 三档对应的**绝对彩度**（旧倍率 × 旧上限 0.105）。这是「档位」这个名字现在唯一还站得住的含义：
  // 拿绝对彩度去比三档，别再拿它去除新上限 —— 那会让旧的 mid（0.105）显得只有 72%，掉到 soft 去。
  const LEVEL_C = { soft: 0.105 * 0.72, mid: 0.105, bold: 0.105 * 1.3 };

  const levelOfChroma = (chroma) => {
    const c = Number(chroma);
    // 旧调用可能传倍率（> 0.3），先换成绝对彩度。
    const abs = c > LEGACY_CHROMA_SPLIT ? c * LEGACY_CHROMA_SCALE : c;
    let best = 'mid';
    let dist = Infinity;
    for (const key of LEVEL_KEYS) {
      const d = Math.abs(LEVEL_C[key] - abs);
      if (d < dist) { dist = d; best = key; }
    }
    return best;
  };

  /* 种子归一：色相取整归一、各旋钮钳进安全区间。
     兼容三层：① 老调用 customCss(hue, 'mid') ② 旧面板的倍率种子 ③ 新面板的绝对种子。
     inkL / inkLD / bgL / bgLD 是「预设自己的骨架明度」：站点手绘的四套令牌各自的墨色并不落在
     生成器写死的 0.48 上（宣纸 0.455、素笺 0.550），不带上它，从预设拖第一下就是一次跳色。
     它们是站主级字段（跟着预设走），不进滑块；访客的深浅旋钮仍是 ink（±0.02）。 */
  function normalizeSeed(hue, opts) {
    const h = Math.round(((Number(hue) % 360) + 360) % 360);
    const o = opts && typeof opts === 'object' ? opts : {};
    const legacy = typeof opts === 'string' ? LEVELS[opts] : undefined;
    const rawChroma = o.chroma ?? legacy;
    const rawPaper = o.paper;
    // 带 --seed-v:2 及以上的才是新量纲；旧 CSS / 旧 localStorage 没有这个标记，按旧倍率换算。
    // 注意量纲版本（DIM_VERSION）与种子版本（SEED_VERSION）现在不是同一个数：
    // v3 只改了深色纸的明度斜率，色相/浓淡的量纲仍是 v2 那套。
    // 内部复用（tokensOf 拿到 normalizeSeed 的输出）会带着 v，所以这条路是幂等的。
    const version = Number(o.v) || 0;
    const modern = version >= DIM_VERSION;
    const current = version >= SEED_VERSION;
    const chromaRaw = modern || !(rawChroma > LEGACY_CHROMA_SPLIT)
      ? rawChroma
      : rawChroma * LEGACY_CHROMA_SCALE;
    const chroma = clampRange(chromaRaw, CHROMA_RANGE.min, CHROMA_RANGE.max, CHROMA_RANGE.max);
    const ink = clampRange(o.ink, -1, 1, 0);
    const keep = (v, fallback) => (Number.isFinite(Number(v)) && v !== null && v !== undefined ? Number(v) : fallback);
    // 深色那套的浓度 / 纸色强度可以独立于浅色：暗纸上同一支墨要更饱和才看得出，
    // 站点手绘的深色令牌本来也更深。不填就沿用浅色的值。
    // 注意不能直接喂 clampRange：Number(null) 是 0，会把「没填」钳成一个合法的 0。
    const orNull = (v, range) => (v === null || v === undefined || v === '' ? null : clampRange(v, range.min, range.max, null));
    const chromaD = orNull(o.chromaD, CHROMA_RANGE);

    // paper / paperD 是「相对 PAPER_C_MAX 的强度」：v5 把上限从 0.022 提到 0.036，
    // 旧强度要乘 0.022 / 0.036 才能保持同一绝对彩度。缺省值 0.5 只在当前版本里代表
    // 0.5；旧版本缺省时代表旧尺子上的 0.5，也要一起折回（无版本的老调用除外）。
    const hasPaper = rawPaper !== undefined && rawPaper !== null && rawPaper !== '';
    const paperOldRaw = modern ? Number(rawPaper) : Number(rawPaper) / LEGACY_PAPER_SCALE;
    const paperOld = hasPaper ? clampRange(paperOldRaw, PAPER_RANGE.min, PAPER_RANGE.max, 0.5) : 0.5;
    const paper = !current && (hasPaper || version >= DIM_VERSION)
      ? clampRange(paperOld * PAPER_C_MAX_V4 / PAPER_C_MAX, PAPER_RANGE.min, PAPER_RANGE.max, 0.5)
      : paperOld;
    const paperDRaw = orNull(o.paperD, PAPER_RANGE);
    const paperD = paperDRaw === null
      ? null
      : (!current
          ? clampRange(paperDRaw * PAPER_C_MAX_V4 / PAPER_C_MAX, PAPER_RANGE.min, PAPER_RANGE.max, null)
          : paperDRaw);

    // 纸色骨架明度是按「旧上限 + 旧斜率」反算出来的：
    //   bgL  = 纸面 L + strength × 旧 DROP
    //   bgLD = 纸面 L − strength × 旧 RISE
    // 换上限/斜率后，strength 和明度都要一起换，才能保持原 bg：
    //   新 bgL  = 旧 bgL  + 新强度 × 新 DROP − 旧强度 × 旧 DROP
    //   新 bgLD = 旧 bgLD + 新强度 × 新 RISE − 旧强度 × 旧 RISE
    // v2 及更早的深色纸用 0.010，v3+ 用 0.028；浅色纸 v3 及更早用 0.013，v4+ 用 0.028。
    // 手调种子没写 --seed-bl/-bd（旧基线就是生成器默认的纸面明度），v2+ 也按差值补一个，
    // 不然老手调配色第一次拖纸色会从默认基线跳一下；无版本的老调用仍保持「不写骨架种子」。
    const oldDrop = version >= 4 ? PAPER_L_DROP : PAPER_L_DROP_V3;
    const bgLraw = keep(o.bgL, null);
    const bgL = current
      ? bgLraw
      : (bgLraw === null && version < DIM_VERSION
          ? null
          : (bgLraw ?? SHAPES.light.L.bg) + paper * PAPER_L_DROP - paperOld * oldDrop);
    const oldRise = version >= 3 ? PAPER_L_RISE : PAPER_L_RISE_V2;
    const oldPaperD = paperDRaw ?? paperOld;
    const newPaperD = paperD ?? paper;
    const bgLDraw = keep(o.bgLD, null);
    const bgLD = current
      ? bgLDraw
      : (bgLDraw === null && version < DIM_VERSION
          ? null
          : (bgLDraw ?? SHAPES.dark.L.bg) + oldPaperD * oldRise - newPaperD * PAPER_L_RISE);
    return {
      hue: Number.isFinite(h) ? h : 0,
      // 归一化后的种子自带版本号：再喂回 normalizeSeed 时走「新量纲」那条路，不会二次换算。
      v: SEED_VERSION,
      chroma,
      chromaD: chromaD ?? chroma,
      paper,
      paperD: paperD ?? paper,
      ink,
      inkL: keep(o.inkL, null),
      inkLD: keep(o.inkLD, null),
      bgL,
      bgLD,
      level: levelOfChroma(chroma),
    };
  }

  // 面板滑轨的端点：浓淡画到 CHROMA_MAX，纸色画到 0 / 1。只给 UI 用，别在拖动里每帧调
  // tokensOf（这里只算两支色，最多三次 accent 尝试）。
  function trackOf(hue, opts, dark) {
    const seed = normalizeSeed(hue, opts);
    const s = SHAPES[dark ? 'dark' : 'light'];
    const paperBg = (k) => {
      const c = k * PAPER_C_MAX;
      const shift = k * (dark ? PAPER_L_RISE : -PAPER_L_DROP);
      const L = (dark ? seed.bgLD ?? s.L.bg : seed.bgL ?? s.L.bg) + shift;
      return oklchToHex(L, c, seed.hue);
    };
    const paperK = paperOf(seed, dark);
    const bg = paperBg(paperK);
    const elev = oklchToHex(
      (dark ? seed.bgLD ?? s.L.bg : seed.bgL ?? s.L.bg) + paperK * (dark ? PAPER_L_RISE : -PAPER_L_DROP) + (s.L.elev - s.L.bg),
      paperK * PAPER_C_MAX * (s.C.elev / s.C.bg),
      seed.hue,
    );
    const maxSeed = { ...seed, chroma: CHROMA_RANGE.max, chromaD: CHROMA_RANGE.max };
    return {
      accentMax: accentOf(maxSeed, s, dark, bg, elev).hex,
      paper0: paperBg(0),
      paper1: paperBg(1),
    };
  }

  /* 色域拟合：颜色落在 sRGB 之外时，**先压明度、再降彩度**。
     原来的做法只降彩度 —— 那等于告诉访客「你拖到的这段区间不存在」，滑块后半程就成了死区。
     压明度才是「更浓的墨本来就更深」在数值上的对应：C 顶到 0.145 的黄色，L 要低到 0.39 才装得下。
     只要压得动就用压暗的那个 L；压到 L_FIT_MAX 还不够（蓝紫方向），才回落到降彩度。 */
  function fitL(L, C, H) {
    if (inGamut(oklchLinear(L, C, H))) return L;
    for (let d = 0.002; d <= L_FIT_MAX + 1e-9; d += 0.002) {
      const l = L - d;
      if (l > 0.05 && inGamut(oklchLinear(l, C, H))) return l;
    }
    return L;
  }

  // 「重」= 对比更强：浅色纸往下压明度，深色纸往上提明度。先按访客选的方向算，
  // 再拿实际纸面做一次对比度钳制 —— 滑块可以拖到边界，但读不清的组合不会真的落地。
  const inkL = (L, ink, dark) => L + (dark ? 1 : -1) * ink * INK_STEP;

  // 预设自带的骨架明度：浅色一套、深色一套。没有就用生成器的默认骨架。
  const baseLOf = (seed, s, dark) => (dark ? seed.inkLD ?? s.L.accent : seed.inkL ?? s.L.accent);
  // 深浅两套的墨与纸强度各自独立（见 normalizeSeed）。
  const chromaOf = (seed, dark) => (dark ? seed.chromaD : seed.chroma);
  const paperOf = (seed, dark) => (dark ? seed.paperD : seed.paper);

  function accentOf(seed, s, dark, bg, elev) {
    const paperIsLight = luminance(bg) > 0.5;
    const ca = chromaOf(seed, dark);
    let L = fitL(inkL(baseLOf(seed, s, dark), seed.ink, dark), ca, seed.hue);
    let hex = oklchToHex(L, ca, seed.hue);
    for (let i = 0; i < 24; i++) {
      if (contrast(hex, bg) >= 4.55 && contrast(hex, elev) >= 4.55) break;
      L = fitL(L + (paperIsLight ? -0.004 : 0.004), ca, seed.hue);
      hex = oklchToHex(L, ca, seed.hue);
    }
    return { hex, L };
  }

  // 正文灰是全局令牌（不跟预设走），纸色拉满时可能落到 bg-soft 上读不清。
  // 以 base.css 的 --muted 为起点，只在对比度不足时沿提高对比的方向微调明度；
  // 预设初始强度下通常不需要动，所以从预设拖进自定义不会发生正文跳色。
  const MUTED_HEX = { light: '#6b665d', dark: '#928e85' };
  function mutedOf(dark, bg, soft) {
    const base = MUTED_HEX[dark ? 'dark' : 'light'];
    const c = hexToOklch(base);
    let L = c.L;
    let hex = base;
    const dir = dark ? 0.004 : -0.004;
    for (let i = 0; i < 80; i++) {
      if (contrast(hex, bg) >= 4.5 && contrast(hex, soft) >= 4.5) break;
      L = fitL(L + dir, c.C, c.H);
      hex = oklchToHex(L, c.C, c.H);
    }
    return hex;
  }

  function tokensOf(hue, opts, dark) {
    const seed = normalizeSeed(hue, opts);
    const s = SHAPES[dark ? 'dark' : 'light'];
    // 浓度直接就是强调色的 OKLCH 彩度（绝对值，不是倍率）。深浅两套各自取。
    const ca = chromaOf(seed, dark);
    const paperK = paperOf(seed, dark);
    // 纸色强度 → 彩度 + 轻微明度。深色纸染色时不是变暗而是略提亮：暗底上上色看起来更亮。
    const bgC = paperK * PAPER_C_MAX;
    const bgShift = paperK * (dark ? PAPER_L_RISE : -PAPER_L_DROP);
    const bgL = (dark ? seed.bgLD ?? s.L.bg : seed.bgL ?? s.L.bg) + bgShift;
    // 纸面一族（elev / soft / code-bg）保持相对 bg 的原有间距与彩度比，整族跟着走 ——
    // 只让 bg 动、其余不动，纸的层次会在拖动时塌掉。
    const rel = (name) => bgL + (s.L[name] - s.L.bg);
    const cRel = (name) => bgC * (s.C[name] / s.C.bg);
    const bg = oklchToHex(bgL, bgC, seed.hue);
    const soft = oklchToHex(rel('soft'), cRel('soft'), seed.hue);
    const elev = oklchToHex(rel('elev'), cRel('elev'), seed.hue);
    const accent = accentOf(seed, s, dark, bg, elev);
    const [r, g, b] = hexToRgb(accent.hex);
    // 语法高亮跟着浓度走，但留一条彩度地板：浓度拖到 0 时若八枚令牌全变成同一个灰，
    // 代码块就只剩一片糊 —— 这是「纯灰墨」唯一必须让步的地方。灰系两枚（注释 / meta）另有更小的地板。
    const hlC = Math.max(ca * (s.C.hl / CHROMA_RANGE.max), 0.02);
    const dimC = (k) => Math.max(hlC * k, 0.005);
    const goldK = ca / CHROMA_RANGE.max;
    const gold = s.gold
      .map(([L, C], i) => `${oklchToHex(L, C * goldK, seed.hue)} ${i === 1 ? s.goldStop : i === 0 ? '0%' : '100%'}`)
      .join(', ');
    // accent-ink 跟着 accent 的实际位移走，保持「同一支墨的深浅两档」这层关系。
    const accentInkL = s.L.accentInk + (accent.L - s.L.accent);
    return {
      bg,
      'bg-soft': soft,
      'bg-elev': elev,
      accent: accent.hex,
      'accent-ink': oklchToHex(accentInkL, ca * 1.05, seed.hue),
      'accent-soft': `rgba(${r}, ${g}, ${b}, ${s.soft})`,
      'accent-line': `rgba(${r}, ${g}, ${b}, ${s.line})`,
      gold: `linear-gradient(120deg, ${gold})`,
      'code-bg': oklchToHex(rel('codeBg'), cRel('code'), seed.hue),
      'code-fg': oklchToHex(s.L.codeFg, ca * (s.C.code / CHROMA_RANGE.max) * 1.5, seed.hue),
      muted: mutedOf(dark, bg, soft),
      'hl-comment': oklchToHex(s.L.comment, dimC(0.12), seed.hue),
      'hl-keyword': oklchToHex(s.L.keyword, hlC, seed.hue),
      'hl-string': oklchToHex(s.L.string, hlC * 0.82, mixHue(seed.hue, 148, 0.78)),
      'hl-number': oklchToHex(s.L.number, hlC * 0.9, mixHue(seed.hue, 55, 0.82)),
      'hl-title': oklchToHex(s.L.title, hlC * 0.75, mixHue(seed.hue, 245, 0.85)),
      'hl-variable': oklchToHex(s.L.variable, hlC * 0.8, mixHue(seed.hue, 298, 0.85)),
      'hl-meta': oklchToHex(s.L.meta, dimC(0.14), seed.hue),
      'hl-deletion': oklchToHex(s.L.deletion, hlC * 1.05, mixHue(seed.hue, 22, 0.82)),
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
     新面板优先读 --seed-c / --seed-p / --seed-k。
     --seed-il / -id / -bl / -bd 是预设自带的骨架明度（浅色墨 / 深色墨 / 浅色纸 / 深色纸），
     --seed-cd / -pd 是深色那套的浓度与纸色强度。
     后六个只有从预设拖进自定义时才写；纯手调（没有预设底子）时省略，生成器回落到自己的骨架。 */
  function customCss(hue, opts) {
    const seed = normalizeSeed(hue, opts);
    const light = tokensOf(seed.hue, seed, false);
    const dark = tokensOf(seed.hue, seed, true);
    const darkDecl = decl(dark);
    const extra = [
      ['cd', seed.chromaD !== seed.chroma ? seed.chromaD : null],
      ['pd', seed.paperD !== seed.paper ? seed.paperD : null],
      ['il', seed.inkL], ['id', seed.inkLD], ['bl', seed.bgL], ['bd', seed.bgLD],
    ].filter(([, v]) => v !== null).map(([k, v]) => `;--seed-${k}:${v.toFixed(3)}`).join('');
    const seeds = `--seed-v:${SEED_VERSION};--seed-g:${GEN_VERSION};--seed-h:${seed.hue};--seed-lv:${seed.level}`
      + `;--seed-c:${seed.chroma.toFixed(3)};--seed-p:${seed.paper.toFixed(3)};--seed-k:${seed.ink.toFixed(2)}`
      + extra;
    // 更高对比：把自定义强调色往当前前景色掺一档（浅色变深、深色变浅），不另算一套
    // 色相。/fg 是主题变量，同一条声明在亮暗两套里各自朝正确方向走；三段只是让
    // 显式深色 / 系统深色用更高特异性的规则盖住各自的 --accent。
    // 不要写 var(--accent) 到 --accent 自身：那会形成自定义属性循环。用同一支墨的
    // 第二档 accent-ink 作为源色，再朝前景色掺；accent-ink 本身保持不动。
    const hc = '--accent:color-mix(in srgb,var(--accent-ink) 78%,var(--fg))'
      + ';--muted:color-mix(in srgb,var(--fg) 72%,var(--bg))';
    return `${SEL}{${decl(light)};${seeds}}`
      + `${SEL_DARK}{${darkDecl}}`
      + `@media (prefers-color-scheme:dark){${SEL_AUTO}{${darkDecl}}}`
      + `@media (prefers-contrast:more){${SEL}{${hc}}}`
      + `@media (prefers-contrast:more){${SEL_DARK}{${hc}}}`
      + `@media (prefers-contrast:more) and (prefers-color-scheme:dark){${SEL_AUTO}{${hc}}}`;
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
    PAPER_C_MAX,
    PAPER_C_MAX_V4,
    PAPER_L_DROP,
    PAPER_L_DROP_V3,
    PAPER_L_RISE,
    PAPER_L_RISE_V2,
    L_FIT_MAX,
    INK_KEYS,
    INK_STEP,
    LEGACY_CHROMA_SCALE,
    LEGACY_CHROMA_SPLIT,
    LEGACY_PAPER_SCALE,
    SEED_VERSION,
    GEN_VERSION,
    normalizeSeed,
    levelOfChroma,
    hexToOklch,
    tokensOf,
    trackOf,
    customCss,
    contrast,
    sanitize,
  };
})(typeof globalThis !== 'undefined' ? globalThis : this);

(() => {
  'use strict';
  const open = (dialog) => {
    if (!dialog.open) {
      window.__prepareScrollLock?.();
      try { dialog.showModal(); }
      catch (error) { window.__syncScrollLock?.(); throw error; }
    }
    window.__syncScrollLock?.();
  };
  // 焦点陷阱：缓存弹层里可聚焦的元素，避免每次 Tab 都 getClientRects()+getComputedStyle()（强制布局）。缓存随内容变化作废。
  const focusCache = new WeakMap();
  const controlsOf = (dialog) => {
    let list = focusCache.get(dialog);
    if (list) return list;
    list = [...dialog.querySelectorAll('button,input,select,textarea,a[href],[tabindex]')]
      .filter((el) => !el.disabled && el.tabIndex >= 0 && el.getClientRects().length && getComputedStyle(el).visibility !== 'hidden');
    focusCache.set(dialog, list);
    return list;
  };
  // 一次 document 级 observer 就够；只在真有弹层打开时才有意义，故先廉价判一下有没有 open 的 dialog，避免每次随便一个 class 变化都走一趟 closest。
  // **刻意不监听 style**：#progress 每帧重写 style.width，放进 attributeFilter 会让回调每帧被唤醒几十次。
  new MutationObserver((records) => {
    if (!document.querySelector('dialog[open]')) return;
    for (const record of records) {
      const target = record.target instanceof Element ? record.target : record.target.parentElement;
      const dialog = target?.closest?.('dialog[open]');
      if (dialog) focusCache.delete(dialog);
    }
  }).observe(document.documentElement, {
    childList: true, subtree: true, attributes: true,
    attributeFilter: ['disabled', 'hidden', 'tabindex', 'class'],
  });

  document.addEventListener('keydown', (event) => {
    if (event.key !== 'Tab') return;
    const dialog = [...document.querySelectorAll('dialog[open]')].at(-1);
    if (!dialog) return;
    const controls = controlsOf(dialog);
    const first = controls[0]; const last = controls.at(-1);
    if (!first) { event.preventDefault(); dialog.focus(); return; }
    if (!dialog.contains(document.activeElement) || (event.shiftKey && document.activeElement === first) || (!event.shiftKey && document.activeElement === last)) {
      event.preventDefault(); (event.shiftKey ? last : first).focus();
    }
  });
  document.addEventListener('click', (event) => {
    const dialog = event.target;
    if (!dialog.matches?.('dialog[data-dismiss-outside][open]')) return;
    const rect = dialog.getBoundingClientRect();
    if (event.clientX < rect.left || event.clientX > rect.right || event.clientY < rect.top || event.clientY > rect.bottom) dialog.close();
  });

  /* —— 访客配色（data-palette）与明暗（data-theme）—— 同一枚「配色」入口里的两段：明暗管纸的明暗，配色管纸墨的色调。
     入口只在首页 hero-meta 那一行（页脚、抽屉、页头导航都没有），仍按 .pal 取节点、不认单个 id；pjax 换页会把 #app 连入口一起换掉，节点只能现查。
     清单以 src/settings.js 的 PALETTES 为准（白名单外的值在 THEME_BOOT 就被挡掉）。
     localStorage 四态：无 key = 跟随站点默认；'' = 明确选素笺；预设 key = 选定配色；'custom' = 用本地算好的那段 CSS。
     自定义的令牌由 public/palette.js 现算（OKLCH：一个色相能罩住 360 度，HSL 罩不住，黄色会掉到 4.3:1）。
     算完整段 CSS 存进 localStorage 而不是存种子：首帧 THEME_BOOT 只做注入、不做计算，否则配色会拖慢首屏。
     版式（data-layout）走同一条路：无 key = 跟随站点默认，'paper' / 'box' = 访客自己选过。 */
  const PAL_CUSTOM_KEY = 'palCustom';
  const LAYOUT_KEY = 'layout';
  // 旧版自定义 CSS 只有 --seed-lv（三档名）：回读时用它换算成旧倍率，再由下面的量纲闸换成绝对彩度。
  // 新面板不再展示三档，这段只为存量 localStorage 不炸。
  const LEVEL_CHROMA = { soft: 0.72, mid: 1, bold: 1.3 };
  // 量纲闸：v2 起种子是绝对彩度（0—0.145）与纸色强度（0—1）；没有标记的是旧版倍率
  // （0.55—1.45 / 纸色 0—1.8）—— 纸色两条量纲在 0—1 之间重叠，只能认版本号。
  // v3 / v4 分别改了深色 / 浅色纸的明度斜率，量纲没变；normalizeSeed 会把旧版本的
  // --seed-bd / --seed-bl 折回。这里只把 v0/v1 换成 v2 量纲，其余按 dataset 原版本交出去。
  const DIM_VERSION = 2;
  const SEED_VERSION = 5;
  // 与 palette.js 的纸色常量同源：面板可能比生成器先就绪，旧种子的强度/骨架必须在这里
  // 就换算到当前版本，否则滑块会先停在旧强度上、第一次拖动才跳。PAPER_DEFAULT_L/-LD 是
  // 生成器骨架里的浅/深纸面明度（SHAPES.light.L.bg / dark.L.bg），手调种子没有
  // --seed-bl/-bd 时用它当旧基线。改这些数必须同步 palette.js 与 scripts/test-palette.mjs。
  const PAPER_C_MAX = 0.036;
  const PAPER_C_MAX_V4 = 0.022;
  const PAPER_L_DROP = 0.028;
  const PAPER_L_DROP_V3 = 0.013;
  const PAPER_L_RISE = 0.028;
  const PAPER_L_RISE_V2 = 0.010;
  const PAPER_DEFAULT_L = 0.962;
  const PAPER_DEFAULT_LD = 0.19;
  // 与 palette.js 的 GEN_VERSION 同源；--seed-g 对不上时用当前生成器重算存量 CSS。
  const GEN_VERSION = 1;
  // storage 同步发生在文章页时没有 .pal 面板可查，只能按这份白名单认预设 key。
  // 与 src/settings.js 的 PALETTES 保持同步；白名单外一律不动。
  const PALETTE_KEYS = ['xuanzhi', 'qingci', 'dailan', 'qian', 'ziteng'];
  const SEED_FIELDS = ['v', 'g', 'h', 'lv', 'c', 'cd', 'p', 'pd', 'k', 'il', 'id', 'bl', 'bd'];
  const LEGACY_CHROMA_SCALE = 0.105;
  const LEGACY_PAPER_SCALE = 1.8;
  const LEGACY_CHROMA_SPLIT = 0.3;
  // 渲染时的兜底值，真实值以面板上 range 的 max 为准（layout.js 的 CHROMA_MAX 与生成器同源）。
  const CHROMA_MAX_FALLBACK = 0.145;
  const pickers = () => [...document.querySelectorAll('.pal')];
  const pickerOf = (node) => (node && node.closest ? node.closest('.pal') : null);
  const chromaMaxOf = (picker) => {
    const max = Number(picker?.querySelector('.pal-chroma')?.max);
    return Number.isFinite(max) && max > 0 ? max : CHROMA_MAX_FALLBACK;
  };
  // 纸色上限同样以面板为准（当前恒为 1），别把 1 写死在换算里。
  const paperMaxOf = (picker) => {
    const max = Number(picker?.querySelector('.pal-paper')?.max);
    return Number.isFinite(max) && max > 0 ? max : 1;
  };
  // 明暗三态：显式 light/dark 写在 data-theme 上，'auto' 就是不写（跟随系统）—— 首帧引导也只认那两个值。
  const modeNow = () => {
    const t = document.documentElement.dataset.theme;
    return t === 'light' || t === 'dark' ? t : 'auto';
  };
  // 版式两态：data-layout="box" 才是素匣，其余（含没挂属性）都是纸面。
  const layoutNow = () => (document.documentElement.dataset.layout === 'box' ? 'box' : 'paper');
  const num = (v, fallback) => {
    const n = Number(v);
    return Number.isFinite(n) ? n : fallback;
  };
  // dataset 里读数字：缺省 / 空串要给 null（Number('') 是 0，会把「没填」读成一个合法的 0）。
  const numOr = (v) => {
    if (v === undefined || v === null || v === '') return null;
    const n = Number(v);
    return Number.isFinite(n) ? n : null;
  };
  const upChroma = (v, modern) => (modern || !(v > LEGACY_CHROMA_SPLIT) ? v : v * LEGACY_CHROMA_SCALE);
  const upPaper = (v, modern) => (modern ? v : v / LEGACY_PAPER_SCALE);

  // v5 迁移：纸色上限 0.022→0.036 后，paper / paperD 是「相对上限的强度」，要按比例折回；
  // bgL / bgLD 存的是按旧强度、旧斜率反算的基线，也要一起重算才能保持当前纸色不跳。
  // 与 palette.js 的 normalizeSeed 同一套公式；面板要先于生成器就绪，所以这里保留一份。
  const migratePaperSeed = (seed, version) => {
    if (version >= SEED_VERSION) return seed;
    const ratio = PAPER_C_MAX_V4 / PAPER_C_MAX;
    const oldPaper = seed.paper;
    const oldPaperD = seed.paperD ?? null;
    const newPaper = oldPaper * ratio;
    const newPaperD = oldPaperD === null ? null : oldPaperD * ratio;
    const oldDrop = version >= 4 ? PAPER_L_DROP : PAPER_L_DROP_V3;
    const oldRise = version >= 3 ? PAPER_L_RISE : PAPER_L_RISE_V2;
    const bgL = seed.bgL === null
      ? (version >= DIM_VERSION ? PAPER_DEFAULT_L + newPaper * PAPER_L_DROP - oldPaper * oldDrop : null)
      : seed.bgL + newPaper * PAPER_L_DROP - oldPaper * oldDrop;
    const oldEffectiveD = oldPaperD ?? oldPaper;
    const newEffectiveD = newPaperD ?? newPaper;
    const bgLD = seed.bgLD === null
      ? (version >= DIM_VERSION ? PAPER_DEFAULT_LD + oldEffectiveD * oldRise - newEffectiveD * PAPER_L_RISE : null)
      : seed.bgLD + oldEffectiveD * oldRise - newEffectiveD * PAPER_L_RISE;
    return { ...seed, v: SEED_VERSION, paper: newPaper, paperD: newPaperD, bgL, bgLD };
  };

  // 当前种子：自定义 → 读 THEME_BOOT 从注入 CSS 里抠出来挂在 dataset 上的那组值（不查
  // getComputedStyle：自定义属性会逼一次强制样式计算，拖动时每帧都做太贵）；其余 → 取当前生效
  // 预设自己标的那一组（同样由 base.css 反算，见 scripts/palette-seeds.mjs）。
  // 预设那组不只是 hue/chroma 两个数：墨与纸的骨架明度、深色那套的浓度都带着一起走 ——
  // 少了它们，从预设拖第一下就是一次跳色（宣纸的灰墨会变成土黄）。
  const seedNow = (picker) => {
    const root = document.documentElement;
    const d = root.dataset;
    const max = chromaMaxOf(picker);
    if (d.palette === 'custom') {
      const hue = parseInt(d.seedH ?? '', 10);
      if (Number.isFinite(hue)) {
        const legacyLevel = d.seedLv || 'mid';
        // 只把 v0/v1 的倍率换算成 v2 量纲；v2 之后交给 migratePaperSeed 统一折到当前版本。
        const version = Number(d.seedV) || 0;
        const modern = version >= DIM_VERSION;
        const cRaw = numOr(d.seedC);
        const pRaw = numOr(d.seedP);
        const seed = {
          // 交出去的版本是「这些数值实际属于哪一版」，不是 dataset 里的原值：
          // v0/v1 已在上面换成 v2 量纲，所以最低标 v2；v2+ 原样带出去。
          v: Math.min(SEED_VERSION, Math.max(DIM_VERSION, version)),
          hue,
          chroma: cRaw === null ? upChroma(LEVEL_CHROMA[legacyLevel] ?? 1, modern) : upChroma(cRaw, modern),
          paper: pRaw === null ? 0.5 : upPaper(pRaw, modern),
          // 旧 CSS 里可能还留着已下线的深浅种子；保留它，避免改别的滑块时把旧配色悄悄改掉。
          ink: numOr(d.seedK) ?? 0,
          chromaD: numOr(d.seedCd),
          paperD: numOr(d.seedPd),
          inkL: numOr(d.seedIl),
          inkLD: numOr(d.seedId),
          bgL: numOr(d.seedBl),
          bgLD: numOr(d.seedBd),
        };
        // 面板先于 palette.js 就绪也要把旧种子折到当前版本，否则滑块会先停在旧强度上，
        // 第一次拖动才跳；migratePaperSeed 与生成器的 normalizeSeed 保持同一套公式。
        return migratePaperSeed(seed, seed.v);
      }
    }
    const btn = picker?.querySelector(`.pal-opt[data-palette="${d.palette || ''}"]`);
    const hue = parseInt(btn?.dataset.hue ?? '', 10);
    const base = btn?.dataset ?? {};
    return {
      // 预设按钮里的字段由服务端按当前生成器渲染，已经是当前版本。
      v: SEED_VERSION,
      hue: Number.isFinite(hue) ? hue : 210,
      chroma: numOr(base.chroma) ?? max,
      paper: numOr(base.paper) ?? 0.26,
      ink: 0,
      chromaD: numOr(base.chromaD),
      paperD: numOr(base.paperD),
      inkL: numOr(base.inkL),
      inkLD: numOr(base.inkLD),
      bgL: numOr(base.bgL),
      bgLD: numOr(base.bgLD),
    };
  };

  // 深色那套的浓度 / 纸色强度是预设自带的一对（见 palette.js 的 chromaD / paperD）：面板只有
  // 一套滑块，拖动时按「当前深浅比例」同步。否则暗色访客拖浓淡 / 纸色，改的全是浅色令牌，
  // 屏幕上一点变化都没有 —— 看起来像滑块坏了。比例用当前值现算，连续拖动时每帧都能接上。
  const linkDark = (light, dark, next, max) => {
    const l = Number(light);
    const d = Number(dark);
    const ratio = Number.isFinite(l) && l > 1e-4 && Number.isFinite(d) ? d / l : 1;
    return Math.min(max, Math.max(0, next * ratio));
  };
  // 拖动时控件的值比 dataset 新：读控件而不是读 dataset，否则两个滑块会互相拽回上一帧。
  // changed 只标记「这次动的是哪一项」：只有浓淡 / 纸色才重算深色那套，拖色相时保持原值 ——
  // 旧数据里 chroma=0 / chromaD>0 的组合不能被顺手抹平。
  const readSeed = (picker, changed = '') => {
    const base = seedNow(picker);
    const hue = num(picker?.querySelector('.pal-hue')?.value, base.hue);
    const chroma = num(picker?.querySelector('.pal-chroma')?.value, base.chroma);
    const paper = num(picker?.querySelector('.pal-paper')?.value, base.paper);
    const seed = { ...base, hue, chroma, paper };
    if (changed === 'chroma') {
      seed.chromaD = linkDark(base.chroma, base.chromaD ?? base.chroma, chroma, chromaMaxOf(picker));
    } else if (changed === 'paper') {
      seed.paperD = linkDark(base.paper, base.paperD ?? base.paper, paper, paperMaxOf(picker));
    }
    return seed;
  };

  // 滑轨端点：取当前色相下的最大浓淡 / 纸色 0→1，而不是当前值。生成器没到货时 CSS 回退
  // 到当前值，至少不会空白；到货或换明暗后再写一次变量。
  const themeIsDark = () => {
    const t = modeNow();
    return t === 'dark' || (t === 'auto' && (matchMedia?.('(prefers-color-scheme: dark)').matches ?? false));
  };
  const updateTracks = (picker) => {
    const lib = window.PaletteLib;
    const box = picker?.querySelector('.pal-custom');
    if (!lib?.trackOf || !box) return;
    const seed = seedNow(picker);
    const track = lib.trackOf(seed.hue, seed, themeIsDark());
    box.style.setProperty('--chroma-end', track.accentMax);
    box.style.setProperty('--paper-0', track.paper0);
    box.style.setProperty('--paper-1', track.paper1);
  };

  // palette.js（8.8KB 的 OKLCH 生成器）只有访客真去动「自定义」里任一控件时才用得上，
  // 改成首次用到再加载：常规访客一辈子不点自定义，不该为它付一次请求。加载期间连拖几帧，
  // 只记住最后一组参数、到货补算一次；加载失败打标，不再反复重试。
  let palLoad = null;
  let palWant = null;
  let palFailed = false;
  // 生成器加载失败时不能只让滑块“点了没反应”：把自定义区打开并显示一句人话，同时禁用三根滑块。
  const markPaletteUnavailable = () => {
    for (const picker of pickers()) {
      const box = picker.querySelector('.pal-custom');
      if (!box) continue;
      box.dataset.failed = '';
      box.open = true;
      box.querySelector('.pal-fail')?.removeAttribute('hidden');
      for (const input of box.querySelectorAll('.pal-hue, .pal-chroma, .pal-paper')) {
        input.disabled = true;
        input.setAttribute('aria-disabled', 'true');
      }
    }
  };
  const clearPaletteUnavailable = () => {
    for (const picker of pickers()) {
      const box = picker.querySelector('.pal-custom');
      if (!box) continue;
      delete box.dataset.failed;
      box.querySelector('.pal-fail')?.setAttribute('hidden', '');
      for (const input of box.querySelectorAll('.pal-hue, .pal-chroma, .pal-paper')) {
        input.disabled = false;
        input.removeAttribute('aria-disabled');
      }
    }
  };
  const loadPalette = () => {
    if (window.PaletteLib) return Promise.resolve(window.PaletteLib);
    if (palLoad) return palLoad;
    const src = document.querySelector('meta[name="palette-lib"]')?.content || '/palette.js';
    palLoad = new Promise((resolve) => {
      const s = document.createElement('script');
      s.src = src;
      s.onload = () => resolve(window.PaletteLib ?? null);
      s.onerror = () => resolve(null);
      document.head.appendChild(s);
    });
    return palLoad;
  };

  const applyCustom = (seed, persist, sync) => {
    const lib = window.PaletteLib;
    if (!lib) {
      if (palFailed) return;
      palWant = { seed, persist, sync };
      loadPalette().then((loaded) => {
        palLoad = null;
        const want = palWant;
        palWant = null;
        if (!loaded) { palFailed = true; markPaletteUnavailable(); return; }
        if (want) applyCustom(want.seed, want.persist, want.sync);
      });
      return;
    }
    palFailed = false;
    clearPaletteUnavailable();
    // 种子必须带上它实际所属的版本：v2/v3 的深色 / 浅色纸骨架明度要由生成器按新斜率折回，
    // 直接标成当前版本会让存量自定义配色在拖动时先跳一下；预设与已换算过的种子则是最新版。
    const norm = lib.normalizeSeed(seed.hue, { ...seed, v: seed.v ?? SEED_VERSION });
    const css = lib.customCss(norm.hue, norm);
    let style = document.getElementById('palCustom');
    if (!style) {
      style = document.createElement('style');
      style.id = 'palCustom';
      document.head.appendChild(style);
    }
    style.textContent = css;
    const root = document.documentElement;
    root.dataset.palette = 'custom';
    // dataset 与 customCss 写进 CSS 的那段种子必须逐字一致：面板从 dataset 读、首帧从 CSS 读，
    // 两份对不上就会「刷新一下滑块位置变了」。深色浓度同理 —— 与浅色相同就不写。
    root.dataset.seedV = String(SEED_VERSION);
    root.dataset.seedG = String(GEN_VERSION);
    root.dataset.seedH = String(norm.hue);
    // --seed-lv 留作兼容：旧面板/旧测试认这一档；新面板优先读 --seed-c。
    root.dataset.seedLv = norm.level;
    root.dataset.seedC = norm.chroma.toFixed(3);
    root.dataset.seedP = norm.paper.toFixed(3);
    root.dataset.seedK = norm.ink.toFixed(2);
    const opt = (key, v) => {
      if (v === null || v === undefined) delete root.dataset[key];
      else root.dataset[key] = v.toFixed(3);
    };
    opt('seedCd', norm.chromaD !== norm.chroma ? norm.chromaD : null);
    opt('seedPd', norm.paperD !== norm.paper ? norm.paperD : null);
    opt('seedIl', norm.inkL);
    opt('seedId', norm.inkLD);
    opt('seedBl', norm.bgL);
    opt('seedBd', norm.bgLD);
    if (persist) {
      try {
        localStorage.setItem('palette', 'custom');
        localStorage.setItem(PAL_CUSTOM_KEY, css);
      } catch {  }
      // 状态栏颜色只在手指停下后更新；拖动时每帧 getComputedStyle 会强制样式计算。
      syncThemeColor();
      pickers().forEach(updateTracks);
    }
    // 拖动中 syncPaletteUI 会刻意跳过（避免把控件拽回旧值），但入口的 aria-label
    // 应该跟手走；这里只改一个属性，不碰滑块。
    for (const picker of pickers()) {
      const max = chromaMaxOf(picker);
      const box = picker.querySelector('.pal-custom');
      box?.toggleAttribute('data-active', true);
      box?.setAttribute('aria-current', 'true');
      picker.querySelector(':scope > summary')?.setAttribute('aria-label', `样式（${norm.hue}°·${chromaText(norm.chroma, max)}）`);
    }
    // 首次交互时 palette.js 可能还在异步加载：这次 apply 由 loadPalette 回调重放，
    // 必须等它真正生效后再对齐面板，否则 summary 会停在旧预设上。
    if (sync) syncPaletteUI(true);
  };

  // 拖动时每帧最多算一次（注入 1.5KB CSS 会触发整页重算，不节流会掉帧）；写完盘留 250ms 静默期，
  // 免得拖一次滑块往 localStorage 写几十遍。
  let hueRaf = 0;
  let saveTimer = 0;
  let pendingSeed = null;
  const queueCustom = (seed) => {
    pendingSeed = seed;
    if (!hueRaf) {
      hueRaf = requestAnimationFrame(() => {
        hueRaf = 0;
        if (pendingSeed) applyCustom(pendingSeed, false);
      });
    }
    clearTimeout(saveTimer);
    saveTimer = setTimeout(() => {
      saveTimer = 0;
      if (pendingSeed) {
        // persist=true 时让 applyCustom 自己收尾同步：palette.js 可能还在异步加载，
        // 这里若紧接着 sync，会在种子还没落地时把面板对齐回旧预设。
        applyCustom(pendingSeed, true, true);
        pendingSeed = null;
      }
    }, 250);
  };

  const outText = (picker, selector, text) => {
    const out = picker.querySelector(selector);
    if (out) out.textContent = text;
  };
  // 浓淡读数按滑块上限折成百分比 —— 这个百分比现在真有含义：100% 就是滑块到底、墨最浓，
  // 拖到哪个百分比，强调色的绝对彩度就是 上限 × 百分比。
  const chromaText = (chroma, max = CHROMA_MAX_FALLBACK) => {
    const ratio = max > 0 ? chroma / max : 0;
    return `${Math.round(Math.min(1, Math.max(0, ratio)) * 100)}%`;
  };
  const paperText = (paper) => (paper <= 0 ? '无' : `${Math.round(paper * 100)}%`);

  // force=false 时，拖动中直接返回：<details> 的 open 一变就会派发 toggle（异步），pjax 换页也会跑钩子，
  // 这些同步若在拖动中途执行，会把滑块拽回旧角度 —— 手指还在拖、控件自己往回跳。
  const syncPaletteUI = (force = false) => {
    if (!force && pendingSeed) return;
    const root = document.documentElement;
    const cur = root.dataset.palette || '';
    const isCustom = cur === 'custom';
    const mode = modeNow();
    for (const btn of document.querySelectorAll('.pal-opt')) {
      btn.setAttribute('aria-pressed', String((btn.dataset.palette || '') === cur));
    }
    for (const btn of document.querySelectorAll('.pal-tm')) {
      btn.setAttribute('aria-pressed', String(btn.dataset.themeOpt === mode));
    }
    // 版式两格：'paper' / 'box' 与 dataset 对齐。纸面不挂属性（少一个属性，CSS 里用 :not 更好写）。
    const ly = layoutNow();
    for (const btn of document.querySelectorAll('.pal-ly')) {
      btn.setAttribute('aria-pressed', String((btn.dataset.layoutOpt || 'paper') === ly));
    }
    for (const picker of pickers()) {
      const box = picker.querySelector('.pal-custom');
      // 小屏首次打开时把「自定义」折起来，避免纸色滑块落到面板滚动区外；只做一次，
      // 之后用户自己开合不被同步逻辑打断。
      if (box && !box.dataset.foldInit) {
        box.dataset.foldInit = '1';
        if (matchMedia?.('(max-width: 620px), (max-height: 620px)').matches) box.open = false;
      }
      box?.toggleAttribute('data-active', isCustom);
      if (box) {
        if (isCustom) box.setAttribute('aria-current', 'true');
        else box.removeAttribute('aria-current');
      }
      // 滑块始终停在当前生效的那套的种子上 —— 从「青瓷」滑进自定义观感才接得上。
      const seed = seedNow(picker);
      const max = chromaMaxOf(picker);
      const hueInput = picker.querySelector('.pal-hue');
      if (hueInput) {
        hueInput.value = String(seed.hue);
        hueInput.setAttribute('aria-valuetext', `${seed.hue} 度`);
      }
      outText(picker, '.pal-hue-out', `${seed.hue}°`);
      const chromaInput = picker.querySelector('.pal-chroma');
      if (chromaInput) {
        chromaInput.value = String(seed.chroma);
        chromaInput.setAttribute('aria-valuetext', `浓淡 ${chromaText(seed.chroma, max)}`);
      }
      const chromaOut = chromaText(seed.chroma, max);
      outText(picker, '.pal-chroma-out', chromaOut);
      const paperInput = picker.querySelector('.pal-paper');
      if (paperInput) {
        paperInput.value = String(seed.paper);
        paperInput.setAttribute('aria-valuetext', `纸色 ${paperText(seed.paper)}`);
      }
      outText(picker, '.pal-paper-out', paperText(seed.paper));
      // 入口文字恒为「配色」；当前是哪套进 aria-label（自定义没有名字，用「角度·浓度」代替）。
      const summary = picker.querySelector(':scope > summary');
      if (summary) {
        const name = isCustom
          ? `${seed.hue}°·${chromaOut}`
          : picker.querySelector(`.pal-opt[data-palette="${cur}"] .pal-name`)?.textContent ?? '';
        summary.setAttribute('aria-label', `样式（${name || '素笺'}）`);
      }
      updateTracks(picker);
    }
    // pjax 换页会重建入口：上一次失败留下的 data-failed/禁用状态在新 DOM 上不存在，
    // 这里补一次，避免新面板看起来能拖、实际没有生成器。
    if (palFailed) markPaletteUnavailable();
  };
  const setPalette = (key) => {
    // 点预设等于放弃未落盘的拖动：先把待写的种子作废，否则 250ms 后它会把自定义又写回去。
    // palette.js 还在异步加载时也要把待应用的自定义参数一起作废，否则到货回调会覆盖刚点的预设。
    pendingSeed = null;
    palWant = null;
    clearTimeout(saveTimer);
    saveTimer = 0;
    if (key) document.documentElement.dataset.palette = key;
    else document.documentElement.removeAttribute('data-palette');
    // 种子只在自定义生效时有意义，跟着一起撤掉 —— 否则下一套预设会带着上一套的角度。
    // 字段表与 THEME_BOOT 的那张表是同一份：加字段两边一起加。
    for (const key of ['seedV', 'seedG', 'seedH', 'seedLv', 'seedC', 'seedCd', 'seedP', 'seedPd', 'seedK',
      'seedIl', 'seedId', 'seedBl', 'seedBd']) {
      delete document.documentElement.dataset[key];
    }
    try { localStorage.setItem('palette', key); } catch {  }
    syncThemeColor();
  };
  // 版式：'box' 挂 data-layout，'paper' 摘掉。存的是「访客选了什么」，不是「当前生效值」——
  // 站主以后把默认改成素匣，选过纸面的人仍然停在纸面（与配色的 '' 同一条语义）。
  const setLayout = (key) => {
    const box = key === 'box';
    const root = document.documentElement;
    if (box) root.dataset.layout = 'box';
    else root.removeAttribute('data-layout');
    try { localStorage.setItem(LAYOUT_KEY, box ? 'box' : 'paper'); } catch {  }
  };
  // 首帧对齐 + pjax 换页（首页 ↔ 其他页，入口会来会走）后再对齐。
  syncPaletteUI();
  (window.__pjaxHooks = window.__pjaxHooks || []).push(syncPaletteUI);
  // details 的 toggle 不冒泡，捕获阶段能到 document。
  document.addEventListener('toggle', (e) => {
    if (e.target.matches?.('.pal') && e.target.open) syncPaletteUI();
  }, true);
  document.addEventListener('input', (e) => {
    const input = e.target;
    if (!input.matches?.('.pal-hue, .pal-chroma, .pal-paper')) return;
    const picker = pickerOf(input);
    if (!picker) return;
    const kind = input.classList.contains('pal-hue') ? 'hue'
      : input.classList.contains('pal-chroma') ? 'chroma' : 'paper';
    const seed = readSeed(picker, kind);
    if (kind === 'hue') {
      seed.hue = Number(input.value);
      outText(picker, '.pal-hue-out', `${seed.hue}°`);
      input.setAttribute('aria-valuetext', `${seed.hue} 度`);
      updateTracks(picker);
    } else if (kind === 'chroma') {
      seed.chroma = Number(input.value);
      const text = chromaText(seed.chroma, chromaMaxOf(picker));
      outText(picker, '.pal-chroma-out', text);
      input.setAttribute('aria-valuetext', `浓淡 ${text}`);
    } else {
      seed.paper = Number(input.value);
      const text = paperText(seed.paper);
      outText(picker, '.pal-paper-out', text);
      input.setAttribute('aria-valuetext', `纸色 ${text}`);
    }
    queueCustom(seed);
  });
  document.addEventListener('click', (e) => {
    // 明暗三态：亮/暗写进 data-theme，跟随就把它摘掉（首帧引导只认 light/dark，摘掉即跟随系统）。
    const tm = e.target.closest?.('.pal-tm');
    if (tm) {
      window.__theme.apply(tm.dataset.themeOpt);
      syncPaletteUI(true);
      return;
    }
    const opt = e.target.closest?.('.pal-opt');
    if (opt) {
      setPalette(opt.dataset.palette || '');
      syncPaletteUI(true);
      // 点预设不收起：面板留开，方便连着试五种；收起交给 Esc / 点面板外 / 鼠标移开（桌面悬停）。
      return;
    }
    // 版式两格：同样不收起 —— 换版式后正文会整体重排，面板留在原地才看得出「换了」。
    const ly = e.target.closest?.('.pal-ly');
    if (ly) {
      setLayout(ly.dataset.layoutOpt || 'paper');
      syncPaletteUI(true);
      return;
    }
    // 点面板外就收面板。
    for (const picker of pickers()) {
      if (picker.open && !picker.contains(e.target)) picker.removeAttribute('open');
    }
  });
  // 配色面板不是浮层，浏览器不管它的 Esc：焦点在面板里才还回去，否则只收面板不动焦点。
  document.addEventListener('keydown', (e) => {
    if (e.key !== 'Escape') return;
    // 模态/灯箱打开时让原生 Esc 先关对话框；这里 preventDefault 会让它关不掉。
    if (document.querySelector('dialog[open]')) return;
    for (const pal of pickers()) {
      if (!pal.open) continue;
      e.preventDefault();
      pal.removeAttribute('open');
      if (pal.contains(document.activeElement)) pal.querySelector('summary')?.focus({ preventScroll: true });
    }
  });

  let pending = null;
  const confirm = ({ title = '确认操作？', body = '', ok = '确认', value = null } = {}) => {
    if (pending?.open) return Promise.resolve(false);
    const dialog = document.createElement('dialog');
    dialog.className = 'ui-dialog';
    dialog.setAttribute('aria-labelledby', 'ui-dialog-title');
    dialog.setAttribute('aria-describedby', 'ui-dialog-body');
    dialog.innerHTML = '<form method="dialog"><h2 id="ui-dialog-title"></h2><p id="ui-dialog-body"></p><div class="ui-dialog-actions"><button type="submit" value="cancel" autofocus>取消</button><button type="submit" value="ok">确认</button></div></form>';
    dialog.querySelector('h2').textContent = title;
    dialog.querySelector('p').textContent = body;
    dialog.querySelector('[value=ok]').textContent = ok;
    if (value !== null) {
      const input = document.createElement('textarea');
      input.value = value; input.readOnly = true; input.className = 'ui-copy-value'; input.setAttribute('aria-label', '待复制的文本');
      dialog.querySelector('p').after(input);
      input.addEventListener('focus', () => input.select());
      const button = dialog.querySelector('[value=ok]');
      button.type = 'button'; button.textContent = '复制';
      button.addEventListener('click', async () => {
        input.focus(); input.select();
        try { await navigator.clipboard.writeText(value); dialog.close('ok'); window.__toast?.('已复制'); }
        catch { dialog.querySelector('p').textContent = '文本已选中，请使用系统复制快捷键或长按复制。'; }
      });
      dialog.querySelector('[value=cancel]').textContent = '关闭';
    }
    document.body.append(dialog);
    return new Promise((resolve) => {
      pending = dialog;
      dialog.addEventListener('close', () => { if (pending === dialog) pending = null; dialog.remove(); window.__syncScrollLock?.(); resolve(dialog.returnValue === 'ok'); }, { once: true });
      open(dialog);
    });
  };
  const busy = (form, button) => {
    if (form.getAttribute('aria-busy') === 'true') return null;
    const previous = form.getAttribute('aria-busy');
    const controls = [...form.querySelectorAll('button,input[type=submit],input[type=button]')].map((el) => [el, el.disabled]);
    const label = button?.innerHTML;
    form.setAttribute('aria-busy', 'true');
    controls.forEach(([el]) => { el.disabled = true; });
    if (button) button.textContent = form.dataset.pending || '提交中…';
    return () => {
      if (previous === null) form.removeAttribute('aria-busy'); else form.setAttribute('aria-busy', previous);
      controls.forEach(([el, disabled]) => { el.disabled = disabled; });
      if (button) button.innerHTML = label;
    };
  };
  const imageLoads = new WeakMap();
  const imageViewer = (dialog) => {
    const image = dialog.querySelector('.lb-img');
    const zoom = document.createElement('button');
    zoom.type = 'button'; zoom.className = 'lb-zoom'; zoom.disabled = true;
    // 放大镜图标固定，倍率读数由数字承担。
    zoom.innerHTML = '<svg class="z-ico" viewBox="0 0 20 20" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" aria-hidden="true"><circle cx="8" cy="8" r="5.6"/><path d="M12.3 12.3 17 17"/></svg><span class="z-num"></span>';
    const reading = zoom.querySelector('.z-num');
    dialog.append(zoom);
    let scale = 1, x = 0, y = 0, gesture = null, pinch = null, ignoreClickUntil = 0;
    // pointermove 每帧读 offsetWidth/Height 会强制同步布局；尺寸只在加载/窗口变化时量一次。
    let boxW = 0, boxH = 0;
    const measure = () => {
      if (image.hidden) return;
      boxW = image.offsetWidth; boxH = image.offsetHeight;
    };
    image.addEventListener('load', measure);
    window.addEventListener('resize', measure);
    const pointers = new Map();
    const render = () => {
      if (!boxW || !boxH) measure();
      const maxX = boxW * (scale - 1) / 2;
      const maxY = boxH * (scale - 1) / 2;
      x = Math.max(-maxX, Math.min(maxX, x)); y = Math.max(-maxY, Math.min(maxY, y));
      image.style.transform = scale === 1 ? '' : `translate(${x}px, ${y}px) scale(${scale})`;
      image.classList.toggle('is-zoomed', scale > 1);
      // 报真实倍率（可到 4×），一位小数封顶。
      reading.textContent = `${Math.round(scale * 10) / 10}×`;
      zoom.setAttribute('aria-label', scale > 1 ? '还原图片大小' : '放大图片');
      zoom.setAttribute('aria-pressed', String(scale > 1));
    };
    const resize = (value) => { scale = Math.max(1, Math.min(4, value)); render(); };
    // 结束并清掉当前触摸手势。缩放到 1 时也要清：双指结束后若还剩一个 pointerup 没派发，
    // 下一次单指滑动会被当成「仍是双指」而吞掉（Linux/CI 的触摸事件更明显）。
    const clearGestures = () => {
      for (const id of pointers.keys()) if (image.hasPointerCapture?.(id)) image.releasePointerCapture(id);
      pointers.clear(); gesture = pinch = null;
    };
    const reset = () => {
      clearGestures();
      scale = 1; x = y = 0; zoom.disabled = true; boxW = boxH = 0; render();
    };
    zoom.addEventListener('click', () => {
      const zoomed = scale > 1;
      if (zoomed) clearGestures();
      resize(zoomed ? 1 : 2);
    });
    image.draggable = false;
    image.addEventListener('click', (event) => {
      event.preventDefault(); event.stopPropagation();
      if (image.hidden || Date.now() < ignoreClickUntil) return;
      const zoomed = scale > 1;
      if (zoomed) clearGestures();
      resize(zoomed ? 1 : 2);
    });
    const distance = () => {
      const [a, b] = [...pointers.values()];
      return Math.hypot(a.x - b.x, a.y - b.y);
    };
    image.addEventListener('pointerdown', (event) => {
      if (image.hidden || event.button !== 0) return;
      pointers.set(event.pointerId, { x: event.clientX, y: event.clientY });
      image.setPointerCapture?.(event.pointerId);
      if (pointers.size === 1) gesture = { x: event.clientX, y: event.clientY, panX: x, panY: y, scale, moved: false };
      else {
        gesture = null; pinch = { distance: distance(), scale };
        ignoreClickUntil = Date.now() + 500;
      }
    });
    image.addEventListener('pointermove', (event) => {
      if (!pointers.has(event.pointerId)) return;
      pointers.set(event.pointerId, { x: event.clientX, y: event.clientY });
      if (pointers.size >= 2 && pinch) {
        if (pinch.distance > 0) resize(pinch.scale * distance() / pinch.distance);
        ignoreClickUntil = Date.now() + 500;
      } else if (gesture) {
        const dx = event.clientX - gesture.x, dy = event.clientY - gesture.y;
        if (Math.hypot(dx, dy) > 8) gesture.moved = true;
        if (gesture.scale > 1) { x = gesture.panX + dx; y = gesture.panY + dy; render(); }
      }
    });
    const end = (event) => {
      if (!pointers.has(event.pointerId)) return;
      const current = gesture;
      const dx = event.clientX - (current?.x ?? event.clientX), dy = event.clientY - (current?.y ?? event.clientY);
      pointers.delete(event.pointerId);
      if (image.hasPointerCapture?.(event.pointerId)) image.releasePointerCapture(event.pointerId);
      if (current?.moved || pinch) ignoreClickUntil = Date.now() + 500;
      gesture = pinch = null;
      // 放大后单指用于拖动图片；还原后左右滑动才切换照片。
      if (event.type === 'pointerup' && current?.scale === 1 && Math.abs(dx) >= 50 && Math.abs(dx) > Math.abs(dy) * 1.5) {
        const button = dialog.querySelector(dx < 0 ? '.lb-next' : '.lb-prev');
        if (button && !button.hidden) button.click();
      }
    };
    image.addEventListener('pointerup', end);
    image.addEventListener('pointercancel', end);
    image.addEventListener('wheel', (event) => {
      if (image.hidden) return;
      event.preventDefault(); resize(scale * Math.exp(-event.deltaY * .002));
    }, { passive: false });
    dialog.addEventListener('keydown', (event) => {
      if (zoom.disabled || event.ctrlKey || event.metaKey || event.altKey) return;
      if (['+', '=', '-', '0'].includes(event.key)) {
        event.preventDefault(); resize(event.key === '0' ? 1 : scale * (event.key === '-' ? .8 : 1.25));
      }
    });
    dialog.addEventListener('close', () => { reset(); ignoreClickUntil = 0; });
    render();
    return { reset, ready: () => { zoom.disabled = false; render(); } };
  };
  const pendingImages = new Map();
  const cancelImage = (dialog, state) => {
    state.serial++; clearTimeout(state.timer); pendingImages.delete(dialog);
    if (state.loader) { state.loader.onload = null; state.loader.onerror = null; state.loader.src = ''; }
  };
  (window.__pjaxHooks = window.__pjaxHooks || []).push(() => {
    for (const [dialog, state] of pendingImages) if (!dialog.isConnected) cancelImage(dialog, state);
  });
  const loadImage = (dialog, src, alt, opts = {}) => {
    let state = imageLoads.get(dialog);
    if (!state) {
      const feedback = document.createElement('div'); feedback.className = 'lb-feedback';
      feedback.innerHTML = '<p role="status" aria-live="polite"></p><button type="button" class="lb-retry" hidden>重试</button>';
      dialog.append(feedback);
      state = { serial: 0, feedback, loader: null, timer: null, viewer: imageViewer(dialog) };
      imageLoads.set(dialog, state);
      feedback.querySelector('button').addEventListener('click', () => loadImage(dialog, state.src, state.alt, state.opts));
      dialog.addEventListener('close', () => {
        cancelImage(dialog, state);
        const el = dialog.querySelector('.lb-img'); el.removeAttribute('src'); el.style.width = ''; el.style.removeProperty('--lb-ar');
      });
    }
    const serial = ++state.serial;
    state.src = src; state.alt = alt; state.opts = opts;
    const { placeholder = '', width = 0, height = 0 } = opts;
    state.viewer.reset();
    clearTimeout(state.timer);
    if (state.loader) { state.loader.onload = null; state.loader.onerror = null; }
    const image = dialog.querySelector('.lb-img');
    const status = state.feedback.querySelector('p');
    const retry = state.feedback.querySelector('button'); retry.hidden = true;

    // 写死显示宽（配 CSS 的 max-width/max-height 与 height:auto）：占位小图和大图占同一个盒子，换成大图时不「跳一下」。
    image.style.width = width > 0 ? `${width}px` : '';
    // 顺带把比例交给 CSS——.lb-img 的 max-width 要靠它把 84vh 折算成宽的上限，否则高度一被压就在左右留底色。
    // 没有尺寸的图撤掉，免得沿用上一张的比例。
    if (width > 0 && height > 0) image.style.setProperty('--lb-ar', `${width} / ${height}`);
    else image.style.removeProperty('--lb-ar');
    // 列表里那张小图此刻已在缓存里：先顶上去，视觉上几乎秒开；大图下完再无跳变地替换。
    const usePlaceholder = Boolean(placeholder) && placeholder !== src;
    if (usePlaceholder) { image.src = placeholder; image.alt = alt; image.hidden = false; status.textContent = ''; }
    else { image.hidden = true; status.textContent = '正在加载图片…'; }

    const loader = new Image(); state.loader = loader;
    pendingImages.set(dialog, state);
    loader.onload = () => {
      if (serial !== state.serial || !dialog.isConnected || !dialog.open) return;
      clearTimeout(state.timer);
      pendingImages.delete(dialog);
      image.src = src; image.alt = alt; image.hidden = false; status.textContent = '';
      state.viewer.ready();
    };
    loader.onerror = () => {
      if (serial !== state.serial || !dialog.isConnected || !dialog.open) return;
      clearTimeout(state.timer);
      pendingImages.delete(dialog);
      status.textContent = '图片加载失败，请重试。'; retry.hidden = false;
    };
    state.timer = setTimeout(() => {
      loader.onerror?.(); loader.onload = null; loader.onerror = null; loader.src = '';
    }, 15000);
    loader.src = src;
  };
  /* —— 浏览器界面色（theme-color meta）—— 服务端写两条带 media 的固定 hex（无脚本时按系统偏好兜底）；访客手动切暗色或挑配色后那两条就不再是实际纸色。
     这里读 <html> 实算底色写进唯一那条无 media 的 meta，此后主题/配色/系统偏好/换页都跟着更新（--bg 挂在 :root）。 */
  const syncThemeColor = () => {
    const color = getComputedStyle(document.documentElement).backgroundColor;
    if (!color || color === 'transparent' || color === 'rgba(0, 0, 0, 0)') return;
    let meta = document.head.querySelector('meta[name="theme-color"]:not([media])');
    if (!meta) {
      for (const stale of document.head.querySelectorAll('meta[name="theme-color"]')) stale.remove();
      meta = document.createElement('meta');
      meta.setAttribute('name', 'theme-color');
      document.head.append(meta);
    }
    if (meta.getAttribute('content') !== color) meta.setAttribute('content', color);
  };
  syncThemeColor();
  (window.__pjaxHooks = window.__pjaxHooks || []).push(syncThemeColor);
  // 没手动选过主题时纸色跟着系统偏好走，系统那头变了也要跟上。
  try {
    matchMedia('(prefers-color-scheme:dark)').addEventListener('change', () => {
      syncThemeColor();
      pickers().forEach(updateTracks);
    });
  } catch {  }

  /* —— 明暗主题：唯一一份状态机，「配色」浮层里那三格与它一一对应 ——
     'auto' 不是第三个 data-theme 值，而是「不写 data-theme」：<head> 的引导只认 light/dark，
     摘掉属性即跟随系统，系统变了 CSS 自己会跟，这里不需要监听。 */
  const theme = {
    apply: (mode) => {
      if (mode === 'auto') {
        delete document.documentElement.dataset.theme;
        try { localStorage.removeItem('theme'); } catch {  }
      } else {
        document.documentElement.dataset.theme = mode;
        try { localStorage.setItem('theme', mode); } catch {  }
      }
      syncThemeColor();
    },
  };
  window.__theme = theme;

  /* 灯箱关闭时把图片这条线彻底停住：还在飞的 loader 不能再把 <img> 顶回可见。 */
  const clearImage = (dialog) => {
    const state = imageLoads.get(dialog);
    if (state) {
      cancelImage(dialog, state);
      // 顺带把图片缩放器复位：否则放大按钮仍可点，操作的却是隐藏的 <img>。
      state.viewer?.reset();
    }
    const image = dialog.querySelector('.lb-img');
    if (image) {
      image.hidden = true;
      image.removeAttribute('src');
      image.style.width = '';
      image.style.removeProperty('--lb-ar');
      image.style.transform = '';
      image.classList.remove('is-zoomed');
    }
    const feedback = dialog.querySelector('.lb-feedback');
    if (feedback) {
      const status = feedback.querySelector('p'); if (status) status.textContent = '';
      const retry = feedback.querySelector('button'); if (retry) retry.hidden = true;
    }
  };
  /* 复制文本：Clipboard API 优先，失败退回「选区 + execCommand」（HTTP 页面或旧浏览器）。
     前台代码块复制与后台 [data-copy] 共用这一份，别再各写一套降级路径。 */
  const copyText = async (text) => {
    const value = String(text ?? '');
    try {
      if (navigator.clipboard?.writeText) { await navigator.clipboard.writeText(value); return true; }
    } catch { /* 无权限或非安全上下文：走下面的兜底 */ }
    const area = document.createElement('textarea');
    area.value = value; area.setAttribute('readonly', '');
    area.style.cssText = 'position:fixed;top:0;left:-9999px;opacity:0';
    document.body.appendChild(area); area.select();
    let ok = false;
    try { ok = document.execCommand('copy'); } catch { ok = false; }
    area.remove();
    return ok;
  };
  /* —— 跨标签页同步 ——
     localStorage 的 storage 事件只在「另一个文档」写入时触发，所以这里不会自激。
     预设 key 在文章页没有 .pal 按钮可查，只能靠 PALETTE_KEYS 白名单；脏值一律不动。
     自定义 CSS 仍要过生成器的 sanitize 再注入，不能因为「同源」就直接信。 */
  const seedDataKey = (key) => 'seed' + key.charAt(0).toUpperCase() + key.slice(1);
  const clearSeedDataset = () => {
    for (const key of SEED_FIELDS) delete document.documentElement.dataset[seedDataKey(key)];
  };
  const applyStoredCustom = (cssText) => {
    const run = (lib) => {
      if (!lib) { palFailed = true; markPaletteUnavailable(); return; }
      const css = lib.sanitize(String(cssText ?? ''));
      if (!css) return;
      let style = document.getElementById('palCustom');
      if (!style) {
        style = document.createElement('style');
        style.id = 'palCustom';
        document.head.appendChild(style);
      }
      style.textContent = css;
      const root = document.documentElement;
      clearSeedDataset();
      for (const key of SEED_FIELDS) {
        const m = new RegExp(`--seed-${key}:(-?[0-9.]+|[a-z]+)`).exec(css);
        if (m) root.dataset[seedDataKey(key)] = m[1];
      }
      root.dataset.palette = 'custom';
      clearPaletteUnavailable();
      syncThemeColor();
      syncPaletteUI(true);
    };
    if (window.PaletteLib) run(window.PaletteLib);
    else loadPalette().then((lib) => { palLoad = null; run(lib); });
  };
  const applyThemeExternal = (mode) => {
    const root = document.documentElement;
    if (mode === 'light' || mode === 'dark') root.dataset.theme = mode;
    else delete root.dataset.theme;
    syncThemeColor();
    syncPaletteUI(true);
  };
  const applyPaletteExternal = (value) => {
    const root = document.documentElement;
    if (value === 'custom') {
      const css = localStorage.getItem(PAL_CUSTOM_KEY);
      if (css) applyStoredCustom(css);
      return;
    }
    if (value === '') {
      root.removeAttribute('data-palette');
    } else if (PALETTE_KEYS.includes(value)) {
      root.dataset.palette = value;
    } else {
      return;
    }
    clearSeedDataset();
    syncThemeColor();
    syncPaletteUI(true);
  };
  window.addEventListener('storage', (event) => {
    if (event.storageArea && event.storageArea !== localStorage) return;
    const root = document.documentElement;
    if (event.key === 'theme') {
      applyThemeExternal(event.newValue);
    } else if (event.key === LAYOUT_KEY) {
      if (event.newValue === 'box') root.dataset.layout = 'box';
      else if (event.newValue === 'paper') root.removeAttribute('data-layout');
      else return;
      syncPaletteUI(true);
    } else if (event.key === 'palette') {
      applyPaletteExternal(event.newValue);
    } else if (event.key === PAL_CUSTOM_KEY && localStorage.getItem('palette') === 'custom') {
      applyStoredCustom(event.newValue);
    }
  });

  // 生成器算法升级（不是种子量纲升级）不会自动反映到已存的整段 CSS 上：
  // --seed-g 对不上时，用同一组种子按当前生成器重算一次。没有 .pal 的文章页也要跑。
  const maybeUpgradeCustom = () => {
    const root = document.documentElement;
    if (root.dataset.palette !== 'custom') return;
    if (Number(root.dataset.seedG) >= GEN_VERSION) return;
    // 连 --seed-h 都没有的旧 CSS 不知道原色相，重算会把它换成默认色；宁可不动。
    if (!Number.isFinite(parseInt(root.dataset.seedH ?? '', 10))) return;
    applyCustom(seedNow(pickers()[0] ?? null), true, true);
  };
  maybeUpgradeCustom();

  window.__copyText = copyText;
  window.__ui = { open, confirm, busy, loadImage, clearImage, copyText };
})();

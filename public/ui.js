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
     入口在页脚（宽屏）与窄屏抽屉各一份，故一律按 .pal 取节点、不认单个 id；pjax 换页会把 #app 连页脚一起换掉，节点只能现查。
     清单以 src/settings.js 的 PALETTES 为准（白名单外的值在 THEME_BOOT 就被挡掉）。
     localStorage 四态：无 key = 跟随站点默认；'' = 明确选素笺；预设 key = 选定配色；'custom' = 用本地算好的那段 CSS。
     自定义的令牌由 public/palette.js 现算（OKLCH：一个色相能罩住 360 度，HSL 罩不住，黄色会掉到 4.3:1）。
     算完整段 CSS 存进 localStorage 而不是存种子：首帧 THEME_BOOT 只做注入、不做计算，否则配色会拖慢首屏。 */
  const PAL_CUSTOM_KEY = 'palCustom';
  // 旧版自定义 CSS 只有 --seed-lv（三档名）：回读时用它换算成连续浓度。新面板不再展示三档。
  const LEVEL_CHROMA = { soft: 0.72, mid: 1, bold: 1.3 };
  const pickers = () => [...document.querySelectorAll('.pal')];
  const pickerOf = (node) => (node && node.closest ? node.closest('.pal') : null);
  // 明暗三态：显式 light/dark 写在 data-theme 上，'auto' 就是不写（跟随系统）—— 首帧引导也只认那两个值。
  const modeNow = () => {
    const t = document.documentElement.dataset.theme;
    return t === 'light' || t === 'dark' ? t : 'auto';
  };
  const num = (v, fallback) => {
    const n = Number(v);
    return Number.isFinite(n) ? n : fallback;
  };

  // 当前种子：自定义 → 读 THEME_BOOT 从注入 CSS 里抠出来挂在 dataset 上的那组值（不查
  // getComputedStyle：自定义属性会逼一次强制样式计算，拖动时每帧都做太贵）；其余 → 取当前生效
  // 预设自己标的 hue / chroma（OKLCH 角度，不是 HSL —— 黛蓝在 HSL 是 213、在 OKLCH 是 252）。
  // 旧版自定义 CSS 只有 --seed-lv：按那一档的 chroma 回读，纸色回落 1。
  const seedNow = (picker) => {
    const root = document.documentElement;
    if (root.dataset.palette === 'custom') {
      const hue = parseInt(root.dataset.seedH ?? '', 10);
      if (Number.isFinite(hue)) {
        const legacyLevel = root.dataset.seedLv || 'mid';
        const chroma = num(root.dataset.seedC, LEVEL_CHROMA[legacyLevel] ?? 1);
        return {
          hue,
          chroma,
          paper: num(root.dataset.seedP, 1),
          // 旧 CSS 里可能还留着已下线的深浅种子；保留它，避免改别的滑块时把旧配色悄悄改掉。
          ink: num(root.dataset.seedK, 0),
        };
      }
    }
    const box = picker?.querySelector('.pal-custom');
    const btn = picker?.querySelector(`.pal-opt[data-palette="${root.dataset.palette || ''}"]`);
    const hue = parseInt(btn?.dataset.hue ?? box?.dataset.hue ?? '', 10);
    return {
      hue: Number.isFinite(hue) ? hue : 210,
      chroma: num(btn?.dataset.chroma ?? box?.dataset.chroma, 1),
      paper: num(box?.dataset.paper, 1),
      ink: 0,
    };
  };

  // 拖动时控件的值比 dataset 新：读控件而不是读 dataset，否则两个滑块会互相拽回上一帧。
  const readSeed = (picker) => {
    const base = seedNow(picker);
    return {
      hue: num(picker?.querySelector('.pal-hue')?.value, base.hue),
      chroma: num(picker?.querySelector('.pal-chroma')?.value, base.chroma),
      paper: num(picker?.querySelector('.pal-paper')?.value, base.paper),
      ink: base.ink,
    };
  };

  // palette.js（8.8KB 的 OKLCH 生成器）只有访客真去动「自定义」里任一控件时才用得上，
  // 改成首次用到再加载：常规访客一辈子不点自定义，不该为它付一次请求。加载期间连拖几帧，
  // 只记住最后一组参数、到货补算一次；加载失败打标，不再反复重试。
  let palLoad = null;
  let palWant = null;
  let palFailed = false;
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
        if (!loaded) { palFailed = true; return; }
        if (want) applyCustom(want.seed, want.persist, want.sync);
      });
      return;
    }
    const norm = lib.normalizeSeed(seed.hue, seed);
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
    root.dataset.seedH = String(norm.hue);
    // --seed-lv 留作兼容：旧面板/旧测试认这一档；新面板优先读 --seed-c。
    root.dataset.seedLv = norm.level;
    root.dataset.seedC = norm.chroma.toFixed(2);
    root.dataset.seedP = norm.paper.toFixed(2);
    root.dataset.seedK = norm.ink.toFixed(2);
    if (persist) {
      try {
        localStorage.setItem('palette', 'custom');
        localStorage.setItem(PAL_CUSTOM_KEY, css);
      } catch {  }
    }
    syncThemeColor();
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
  const chromaText = (chroma) => `${Math.round(chroma * 100)}%`;
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
    for (const picker of pickers()) {
      const box = picker.querySelector('.pal-custom');
      box?.toggleAttribute('data-active', isCustom);
      // 滑块始终停在当前生效的那套的种子上 —— 从「青瓷」滑进自定义观感才接得上。
      const seed = seedNow(picker);
      const hueInput = picker.querySelector('.pal-hue');
      if (hueInput) hueInput.value = String(seed.hue);
      outText(picker, '.pal-hue-out', `${seed.hue}°`);
      const chromaInput = picker.querySelector('.pal-chroma');
      if (chromaInput) chromaInput.value = String(seed.chroma);
      outText(picker, '.pal-chroma-out', chromaText(seed.chroma));
      const paperInput = picker.querySelector('.pal-paper');
      if (paperInput) paperInput.value = String(seed.paper);
      outText(picker, '.pal-paper-out', paperText(seed.paper));
      // 入口文字恒为「配色」；当前是哪套进 aria-label（自定义没有名字，用「角度·浓度」代替）。
      const summary = picker.querySelector('summary');
      if (summary) {
        const name = isCustom
          ? `${seed.hue}°·${chromaText(seed.chroma)}`
          : picker.querySelector(`.pal-opt[data-palette="${cur}"] .pal-name`)?.textContent ?? '';
        summary.setAttribute('aria-label', `配色（${name || '素笺'}）`);
      }
    }
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
    delete document.documentElement.dataset.seedH;
    delete document.documentElement.dataset.seedLv;
    delete document.documentElement.dataset.seedC;
    delete document.documentElement.dataset.seedP;
    delete document.documentElement.dataset.seedK;
    try { localStorage.setItem('palette', key); } catch {  }
    syncThemeColor();
  };
  // 首帧对齐 + pjax 换页重建页头/抽屉后再对齐。
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
    const seed = readSeed(picker);
    if (input.classList.contains('pal-hue')) {
      seed.hue = Number(input.value);
      outText(picker, '.pal-hue-out', `${seed.hue}°`);
    } else if (input.classList.contains('pal-chroma')) {
      seed.chroma = Number(input.value);
      outText(picker, '.pal-chroma-out', chromaText(seed.chroma));
    } else {
      seed.paper = Number(input.value);
      outText(picker, '.pal-paper-out', paperText(seed.paper));
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
    // 两份面板（页头 + 抽屉）各自收各自的：点哪份外面就收哪份。
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
  try { matchMedia('(prefers-color-scheme:dark)').addEventListener('change', syncThemeColor); } catch {  }

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

  /* 灯箱切到视频 / 关闭时把图片这条线彻底停住：还在飞的 loader 不能再把 <img> 顶回可见（否则视频旁边闪出一张图）。 */
  const clearImage = (dialog) => {
    const state = imageLoads.get(dialog);
    if (state) {
      cancelImage(dialog, state);
      // 切到视频时把图片缩放器一并复位：否则放大按钮仍可点，操作的却是隐藏的 <img>。
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
  window.__ui = { open, confirm, busy, loadImage, clearImage };
})();

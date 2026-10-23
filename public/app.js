(() => {
  'use strict';
  const request = window.__request;
  const $ = (s) => document.querySelector(s);
  // 修饰键/中键点击交给浏览器（新标签、下载、系统菜单），别被对话/灯箱的捕获处理器吞掉。
  const isPlainClick = (e) => e.button === 0 && !e.metaKey && !e.ctrlKey && !e.shiftKey && !e.altKey;

  const perFrame = (fn) => {
    let queued = false;
    return () => {
      if (queued) return;
      queued = true;
      requestAnimationFrame(() => { queued = false; fn(); });
    };
  };

  const bar = $('#progress');
  if (bar) {
    /* scroll 回调里不再读 scrollHeight —— 那是同步布局，写一次 width 就 invalidate 一次，
       下一帧的 scroll 再读回来，等于每帧强制重排一次。可滚动高度只在「内容或视口变了」时变，
       交给 ResizeObserver（展开面板、图片落位、pjax 换页都会触发），滚动只剩读 scrollTop。 */
    let scrollable = 1;
    const measure = () => {
      const h = document.documentElement;
      return Math.max(1, h.scrollHeight - h.clientHeight);
    };
    const paintProgress = () => {
      const h = document.documentElement;
      bar.style.width = `${(h.scrollTop / scrollable * 100).toFixed(2)}%`;
      bar.classList.toggle('on', h.scrollTop > 40);
    };
    const queueProgress = perFrame(paintProgress);
    const remeasure = perFrame(() => { scrollable = measure(); paintProgress(); });
    scrollable = measure();
    if (typeof ResizeObserver === 'function') new ResizeObserver(remeasure).observe(document.body);
    addEventListener('scroll', queueProgress, { passive: true });
    addEventListener('resize', remeasure, { passive: true });
    paintProgress();
  }

  let openPicker = null;
  // 面板不再随每个表单输出，整页只有一份 <template data-emoji-tpl>（见 src/comments/view.js）。
  // 首次点开时克隆进当前 picker 并留在那儿：再点时 querySelector 直接命中，不重复克隆。
  const ensureEmojiPanel = (picker) => {
    const existing = picker.querySelector('[data-emoji-panel]');
    if (existing) return existing;
    const tpl = document.querySelector('template[data-emoji-tpl]');
    const node = tpl?.content?.firstElementChild?.cloneNode(true);
    if (!node) return null;                 // 无模板（页面本来没表单/被裁）就安静不开，别抛错
    picker.appendChild(node);
    return node;
  };
  const closeEmoji = (picker, focus = false) => {
    if (!picker) return;
    const panel = picker.querySelector('[data-emoji-panel]');
    if (panel) {
      if (typeof panel.hidePopover === 'function' && panel.matches(':popover-open')) panel.hidePopover();
      panel.classList.remove('is-open');
    }
    const trigger = picker.querySelector('[data-emoji-toggle]');
    trigger?.setAttribute('aria-expanded', 'false');
    if (openPicker === picker) openPicker = null;
    if (focus) trigger?.focus({ preventScroll: true });
  };
  const closeAllEmoji = () => {
    if (openPicker) closeEmoji(openPicker);
  };
  const positionEmoji = (picker) => {
    const panel = picker.querySelector('[data-emoji-panel]');
    const anchor = picker.querySelector('[data-emoji-toggle]').getBoundingClientRect();
    const width = panel.offsetWidth;
    const height = panel.offsetHeight;
    const above = anchor.top - height - 8;
    const top = above >= 12 ? above : Math.min(anchor.bottom + 8, window.innerHeight - height - 12);
    panel.style.left = `${Math.max(12, Math.min(anchor.right - width, window.innerWidth - width - 12))}px`;
    panel.style.top = `${Math.max(12, top)}px`;
  };
  const openEmoji = (picker) => {
    closeAllEmoji();
    const panel = ensureEmojiPanel(picker);
    if (!panel) return;
    panel.classList.add('is-open');
    if (typeof panel.showPopover === 'function') panel.showPopover();
    positionEmoji(picker);
    picker.querySelector('[data-emoji-toggle]').setAttribute('aria-expanded', 'true');
    openPicker = picker;
  };
  /* —— 笔记折叠行 —— HTML 就是原生 <details>，没有脚本也能开合，而且不带 name：多篇可以同时展开。
     有脚本时不再管别的行：展开＝直接给 open，收起＝先收高度、收完再摘 open（原因见 closeNote）。
     没有互斥就没有跨行位移 —— 补滚动、transitionend 兜底、连点竞态跟着一起没有了。
     高度怎么走：无脚本是 CSS 的 grid 0fr↔1fr；有脚本换成这里的一套 —— 量一次 px 高度，
     用同一条时间线（同 duration、同 easing）驱动面板 / 摘要尾巴 / 元信息行（形态见 style.css 的 .nf-anim 段）。
     fr 插值每帧都要按内容重算轨道基础尺寸再分配，Safari 上偶发 24ms 以上的长帧；px 高度是定值，只有一次布局。 */
  const reduceMotion = window.__reducedMotion;
  const canAnimate = () => typeof Element.prototype.animate === 'function' && !reduceMotion();
  /* 矮面板别拖、长面板别闪：220–470ms。 */
  const foldDur = (h) => Math.min(470, Math.max(220, Math.round(190 + h * 0.22)));
  const FOLD_EASE = 'cubic-bezier(.4, 0, .2, 1)';   // 与 CSS 兜底的 --fold-ease 同一根曲线

  const foldParts = (fold) => ({
    roll: fold.querySelector('.nf-rollout'),
    peek: fold.querySelector('.nf-peekwrap'),
    meta: fold.parentElement?.querySelector(':scope > .nf-meta') ?? null,   // 元信息行是 details 的兄弟
  });
  const px = (el) => (el ? el.getBoundingClientRect().height : 0);

  const folding = new WeakMap();   // fold -> { open, anims, timer, token }
  let foldToken = 0;

  /* 接管正在跑的那条时间线：cancel 会把行内高度还原成动画起点的旧值，所以先读当前视觉高度、
     停掉动画、再把当前值写回行内 —— 下一段动画从"眼睛看到的位置"接着走。 */
  function detach(fold) {
    const rec = folding.get(fold);
    if (!rec) return null;
    const p = foldParts(fold);
    const heights = { roll: px(p.roll), peek: px(p.peek), meta: px(p.meta) };
    rec.anims.forEach((a) => a.cancel());
    clearTimeout(rec.timer);
    folding.delete(fold);
    if (p.roll) p.roll.style.height = `${heights.roll}px`;
    if (p.peek) p.peek.style.height = `${heights.peek}px`;
    if (p.meta) p.meta.style.height = `${heights.meta}px`;
    return { p, heights };
  }

  function runFold(fold, open) {
    const adopted = detach(fold);
    const p = adopted?.p ?? foldParts(fold);
    if (!p.roll) { fold.open = open; return; }

    const start = adopted?.heights ?? { roll: px(p.roll), peek: px(p.peek), meta: px(p.meta) };
    let end;
    if (open) {
      /* 展开：面板 0 → 内容高度，摘要预览那两行与元信息行同时收到 0，三条共用一条时间线。
         面板顶会被预览一路往上拽，正文落点因此上移（约预览两行的高度）——这是现有观感，改之前先想清楚。 */
      fold.open = true;                     // 终态高度只能开着量；写读都在同一帧，不绘制中间态
      p.roll.style.height = '';             // 让 CSS 的 height:auto 接管，量到的才是内容高度
      end = { roll: px(p.roll), peek: 0, meta: 0 };
    } else {
      fold.classList.add('nf-rest');        // 展开态被压成 0 的两条尾巴，放回自然高度才量得到
      end = { roll: 0, peek: px(p.peek), meta: px(p.meta) };
      fold.classList.remove('nf-rest');
    }
    const dur = foldDur(open ? end.roll : start.roll);

    const token = ++foldToken;
    const rec = { open, anims: [], timer: 0, token };
    folding.set(fold, rec);

    /* 落定：清掉行内高度、摘/挂 open。此刻 CSS 终态与动画终值逐项相等（收起全 0、展开自然高度），不跳。 */
    const settle = () => {
      if (folding.get(fold)?.token !== token) return;
      clearTimeout(rec.timer);
      rec.anims.forEach((a) => a.cancel());
      folding.delete(fold);
      if (p.roll) p.roll.style.height = '';
      if (p.peek) p.peek.style.height = '';
      if (p.meta) p.meta.style.height = '';
      fold.open = open;                     // 高度已经到 0 了，这时摘 open 不会让内容跳
    };

    if (!canAnimate() || dur <= 0) { settle(); return; }

    if (p.peek) p.peek.style.height = `${start.peek}px`;
    if (p.meta) p.meta.style.height = `${start.meta}px`;
    p.roll.style.height = `${start.roll}px`;

    const opts = { duration: dur, easing: FOLD_EASE, fill: 'both' };
    const anims = [p.roll.animate([{ height: `${start.roll}px` }, { height: `${end.roll}px` }], opts)];
    // 展开时预览已经是 0 高（高度让给面板了），0→0 的动画没有意义，别再起一条空时间线
    if (p.peek && start.peek !== end.peek) anims.push(p.peek.animate([{ height: `${start.peek}px` }, { height: `${end.peek}px` }], opts));
    if (p.meta) anims.push(p.meta.animate([{ height: `${start.meta}px` }, { height: `${end.meta}px` }], opts));
    rec.anims = anims;
    // finished 在个别版本被跳过时兜底：duration + 160 后强制落定（settle 幂等）
    rec.timer = setTimeout(settle, dur + 160);
    Promise.all(anims.map((a) => a.finished)).then(settle, () => {});
  }

  /* 收起必须「延迟摘 open」：details 一关，内容立刻从渲染树上撤走，高度过渡根本来不及跑（实测 70ms 就收完了，
     等于瞬收）。所以先把高度收到 0，落定之后才 open=false —— 那时高度已是 0，摘属性不跳。 */
  const closeNote = (fold) => runFold(fold, false);

  // 点摘要 = 只切这一行。别人的开合与我无关，所以不需要先量位置、也不需要事后补滚动。
  document.addEventListener('click', (e) => {
    const sum = e.target.closest?.('summary.nf-sum');
    if (!sum) return;
    const fold = sum.closest('details.nf-fold');
    if (!fold) return;
    e.preventDefault();                  // 接管原生 <details> 的开合：收起要延迟摘 open，不能交给浏览器
    const rec = folding.get(fold);
    runFold(fold, rec ? !rec.open : !fold.open);   // 动画途中再点＝反悔，从当前高度往回走
  }, true);

  document.addEventListener('toggle', (e) => {
    if (e.target.matches?.('[data-emoji-panel]') && e.newState === 'closed') {
      e.target.classList.remove('is-open');
      const picker = e.target.closest('[data-emoji-picker]');
      picker?.querySelector('[data-emoji-toggle]')?.setAttribute('aria-expanded', 'false');
      if (picker && openPicker === picker) openPicker = null;
    }
    // 一行真正收起时把内部评论抽屉一并收掉：留着 is-open 会「看不见却仍能 Tab 进去」（inert 只在收起时加）。toggle 不冒泡，用 capture。
    if (e.target.matches?.('details.nf-fold') && e.newState === 'closed') {
      const slot = e.target.querySelector('.ncp-slot.is-open');
      if (slot) foldDrawer(slot, false);
    }
  }, true);

  /* 手机上点正文收回有个副作用：正文是从手指底下被抽走的，而 iOS 在 touchend 之后还会补一次落点判定。
     那一帧手指下面已经是**下一条**笔记的正文，于是被识别成一次选词 —— 看着就是「点收起却选中了下面那段」。
     收起后这一小段时间里禁掉选文、并清掉已经产生的选区；420ms 一到立刻恢复，正常长按或拖动选文不受影响。
     判据用「刚才是不是触摸」而不是 (pointer: coarse)：iPad 接了触控板时那个媒体查询会变，触摸才是这里要防的。 */
  let lastTouchAt = 0;
  document.addEventListener('touchstart', () => { lastTouchAt = Date.now(); }, { passive: true, capture: true });
  let tapGuardTimer = 0;
  let tapGuardClear = null;   // 上一轮的收尾：再次触发时先执行它，免得旧的 selectionchange 监听器留在文档上永久清空选区
  function guardTapSelection() {
    if (Date.now() - lastTouchAt > 700) return;   // 鼠标点的不必管，桌面选文行为一点不碰
    const root = document.querySelector('.notes');
    if (!root) return;
    // 折叠光标留在已撤走的内容里，正是「迁移成选区」的起点；窗口内再冒出来的选区一律清掉
    // （不单靠 user-select: none —— 动画期间的实现差异各地不一，这里要的是结果确定）。
    const clear = () => { const s = getSelection(); if (s && !s.isCollapsed) s.removeAllRanges(); };
    clear();
    root.classList.add('is-tap-closing');
    document.addEventListener('selectionchange', clear);
    const finish = () => {
      clearTimeout(tapGuardTimer);
      document.removeEventListener('selectionchange', clear);
      root.classList.remove('is-tap-closing');
      if (tapGuardClear === finish) tapGuardClear = null;
    };
    // 先收掉上一轮：不清的话旧的 clear 监听器会一直挂在文档上，之后用户每次选词都被清空（无法复制文字）。
    const previous = tapGuardClear;
    tapGuardClear = finish;
    previous?.();
    tapGuardTimer = setTimeout(finish, 420);
  }

  /* 展开态点正文收回这一行（正文不是 <summary>）：放行链接、划选文字、评论胶囊/抽屉/图集。 */
  document.addEventListener('click', (e) => {
    const body = e.target.closest?.('.nf-fold .nf-panel > .prose');
    // 交互元素（链接、代码复制按钮、代码块、表单、音视频）不该触发“点正文收起”；
    // 以前只排除 a，点笔记里的「复制代码」会把整篇折叠掉。
    if (!body || e.target.closest('a, button, input, textarea, select, summary, pre, code, video, audio, [contenteditable], [data-no-fold-close]')) return;
    const sel = document.getSelection();
    if (sel && !sel.isCollapsed && sel.toString().trim()) return;
    const fold = body.closest('details.nf-fold');
    if (!fold?.open) return;
    if (folding.get(fold)?.open === false) return;   // 正在收起，别把同一条时间线重起一遍
    guardTapSelection();
    closeNote(fold);
  });

  window.addEventListener('resize', closeAllEmoji);
  // 面板跟随入口，与进度条同一套 perFrame 节流；scrollTarget 把当帧滚动目标带进 rAF（面板自身滚动时要用）。
  let scrollTarget = null;
  const followEmoji = perFrame(() => {
    const target = scrollTarget;
    scrollTarget = null;
    if (!openPicker || !openPicker.isConnected) return;
    if (!target?.closest?.('[data-emoji-panel]')) {
      const anchor = openPicker.querySelector('[data-emoji-toggle]').getBoundingClientRect();
      if (anchor.bottom < 0 || anchor.top > window.innerHeight) closeEmoji(openPicker);
      else positionEmoji(openPicker);
    }
  });
  document.addEventListener('scroll', (e) => { scrollTarget = e.target; followEmoji(); }, { capture: true, passive: true });

  document.addEventListener('click', (e) => {
    const toggle = e.target.closest('[data-emoji-toggle]');
    if (toggle) {
      const picker = toggle.closest('[data-emoji-picker]');
      if (toggle.getAttribute('aria-expanded') === 'true') closeEmoji(picker);
      else openEmoji(picker);
      return;
    }
    const close = e.target.closest('[data-emoji-close]');
    if (close) { closeEmoji(close.closest('[data-emoji-picker]'), true); return; }
  });

  const toTop = document.querySelector('.to-top');
  if (toTop) {
    const sync = () => {
      const show = window.scrollY > window.innerHeight;
      toTop.classList.toggle('show', show);
    };
    const onScroll = perFrame(sync);
    window.addEventListener('scroll', onScroll, { passive: true });
    window.addEventListener('resize', onScroll, { passive: true });
    sync();
  }

  /* 正文插图的「点开大图」和封面的「点开视频」都是 JS 能力：role/tabindex 也由 JS 补，写死在 HTML 里会让禁 JS 的读者拿到假按钮。
     首页封面那张是 <h1> 唯一内容：只补 role/tabindex，不加 aria-label，否则会改掉标题可访问名。
     笔记流图集是真链接，不补 role。 */
  function decorateLightbox(root = document) {
    for (const node of root.querySelectorAll('img[data-lightbox]:not([role]), video[data-lightbox]:not([role])')) {
      node.setAttribute('role', 'button');
      node.setAttribute('tabindex', '0');
      const alt = node.dataset.alt || node.getAttribute('aria-label') || node.getAttribute('alt') || '';
      const label = node.tagName === 'VIDEO'
        ? (alt ? `播放视频：${alt}` : '播放视频')
        : (alt ? `查看大图：${alt}` : '查看大图');
      // 标题即图片/视频时只补 role/tabindex，补 aria-label 会改掉 <h1> 的可访问名。
      if (!node.closest('h1')) node.setAttribute('aria-label', label);
    }
  }

  /* 点击播放模式的封面视频：先补按钮语义，点一下才就地播放并露出控制条；灯箱入口是右上角那枚链接。
     服务器在 click 模式下不给 <video> 挂 data-lightbox，避免「点播放」被灯箱接管。 */
  function setupHeroVideoClick(root = document) {
    for (const video of root.querySelectorAll('.hero-figure video[data-video-mode="click"]:not([data-play-ready])')) {
      video.dataset.playReady = '1';
      video.setAttribute('role', 'button');
      video.setAttribute('tabindex', '0');
      const play = (event) => {
        if (event) event.preventDefault();
        video.controls = true;
        video.removeAttribute('role');
        video.closest('.hero-media, .hero-slide')?.querySelector('.hero-play')?.remove();
        video.removeEventListener('click', play);
        video.removeEventListener('keydown', onKey);
        video.play().catch(() => {});
      };
      const onKey = (e) => {
        if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); play(e); }
      };
      video.addEventListener('click', play);
      video.addEventListener('keydown', onKey);
    }
  }

  /* 封面视频的自动播放（auto 模式）。
     只靠 HTML 的 autoplay/muted/loop 在部分移动内核（鸿蒙自带浏览器、X5/WebView）上会被静默忽略：
     要么停在首帧不动，要么播一遍就停在最后一帧。这里把属性落成 IDL 再显式 play()；被内核拦下时
     等 canplay、回到前台或页面首次触摸后再试，loop 再用 ended 兜底。click 模式一根手指都不碰。 */
  let heroAutoplayVideos = [];
  let heroAutoplayBound = false;
  const heroAutoplayAllowed = () => !document.hidden && !lightboxOpen();
  const playHeroVideo = (video) => {
    if (!video?.isConnected || !heroAutoplayAllowed()) return;
    const slide = video.closest('.hero-slide');
    if (slide && !slide.classList.contains('is-active')) return;
    // 属性在部分内核里不足以让自动播放生效；muted 必须在 play() 之前就是 true。
    video.muted = true;
    video.defaultMuted = true;
    video.loop = true;
    video.playsInline = true;
    video.setAttribute('webkit-playsinline', 'webkit-playsinline');
    const played = video.play();
    if (played && typeof played.catch === 'function') played.catch(() => {});
  };
  const playHeroVideos = () => { for (const video of heroAutoplayVideos) playHeroVideo(video); };
  function setupHeroAutoplay(root = document) {
    heroAutoplayVideos = [...root.querySelectorAll('.hero-figure video')]
      .filter((video) => video.dataset.videoMode !== 'click');
    if (!heroAutoplayVideos.length) return;
    for (const video of heroAutoplayVideos) {
      if (video.dataset.autoplayReady) { playHeroVideo(video); continue; }
      video.dataset.autoplayReady = '1';
      // 这两个属性是旧内核认的「内联播放」开关，属性先写、脚本再补一遍，避免首帧被强制全屏。
      video.setAttribute('webkit-playsinline', 'webkit-playsinline');
      video.setAttribute('x5-playsinline', 'x5-playsinline');
      // 被自动播放策略拦下时，元数据就绪后再试一次（此时 play() 多半能过）。
      video.addEventListener('canplay', () => playHeroVideo(video));
      // 内核不支持 loop 时播完会停在最后一帧：回到开头再播一次。
      video.addEventListener('ended', () => {
        try { video.currentTime = 0; } catch { /* 有些内核此时禁止 seek，直接 play() 也会从头开始 */ }
        playHeroVideo(video);
      });
      playHeroVideo(video);
    }
    if (heroAutoplayBound) return;
    heroAutoplayBound = true;
    document.addEventListener('visibilitychange', () => { if (!document.hidden) playHeroVideos(); });
    // bfcache 回退不一定会发 visibilitychange，补一次 pageshow。
    addEventListener('pageshow', playHeroVideos);
    // 有内核要求页面先发生用户手势：首次操作后补播一次。之后仍失败还有 canplay / 回到前台兜底。
    for (const type of ['pointerdown', 'touchstart', 'keydown']) {
      document.addEventListener(type, playHeroVideos, { once: true, capture: true, passive: true });
    }
  }

  /* 首页轮播（多于一张图才渲染）。自动模式 5 秒一张，悬停/聚焦/切走标签页/「减弱动态效果」暂停。 */
  const HERO_AUTO_MS = 5000;
  let heroTimer = null;
  // 灯箱打开要停住轮播：对话框不置 document.hidden，否则关灯箱时已不是当时那张。
  let heroControl = null;
  // 灯箱开着时不能自动播：否则关灯箱时浏览器会把焦点还原给触发的那张封面，而它可能已被切走并标了 aria-hidden
  // （触发 Chrome「Blocked aria-hidden …」告警，读屏也会突然失焦）。开灯箱时已 stop()，这里拦住 pointerleave 触发的重启。
  const lightboxOpen = () => Boolean(document.getElementById('lightbox')?.open);
  function setupHeroCarousel() {
    heroControl = null;
    if (heroTimer) { clearInterval(heroTimer); heroTimer = null; }
    const root = document.querySelector('[data-hero-carousel]');
    if (!root) return;
    const slides = [...root.querySelectorAll('.hero-slide')];
    const copies = [...root.querySelectorAll('.hero-copy')];
    const dots = [...root.querySelectorAll('.hero-dot')];
    if (slides.length < 2) return;
    let at = Math.max(0, slides.findIndex((s) => s.classList.contains('is-active')));
    // 悬停时不自动播：手动点击会调 start()，它必须尊重这个状态位，否则悬停着点一下 5 秒后又自己动。
    let hovering = false;
    // 用户主动暂停后，hoverleave/灯箱关闭都不能把它偷偷重新启动（WCAG 2.2.2）。
    let userPaused = false;
    const videoOf = (slide) => slide.tagName === 'VIDEO' ? slide : (slide.querySelector?.('video') ?? null);
    // 非当前张在服务端只发 240w 占位小图 + data-src/data-srcset：5 张封面叠在同一视口，
    // loading=lazy 不会真的延迟。轮到它之前再升级成正式候选集；占位图先显示，不会白一下。
    const hydrate = (slide) => {
      if (!slide || !slide.isConnected || slide.tagName !== 'IMG' || !slide.dataset.src) return;
      if (slide.dataset.srcset) slide.srcset = slide.dataset.srcset;
      slide.src = slide.dataset.src;
      delete slide.dataset.src;
      delete slide.dataset.srcset;
    };
    const warm = (slide) => {
      if (!slide || slide.tagName !== 'IMG' || !slide.dataset.src) return;
      if (window.requestIdleCallback) window.requestIdleCallback(() => hydrate(slide), { timeout: 2500 });
      else setTimeout(() => hydrate(slide), 1200);
    };
    const show = (i) => {
      at = (i + slides.length) % slides.length;
      hydrate(slides[at]);
      // 被隐藏的那张若还留着焦点（鼠标点过封面、或灯箱关闭把焦点还给了封面），直接加 aria-hidden 会被
      // Chrome 拦截并报警，读屏用户也会突然失去焦点。所以先把焦点让给新的当前张，再隐藏其余几张。
      const hidden = slides.findIndex((s) => s === document.activeElement || s.contains(document.activeElement));
      const refocus = hidden !== -1 && hidden !== at;
      slides.forEach((s, k) => {
        const on = k === at;
        s.classList.toggle('is-active', on);
        // 不可见的那几张必须同时移出 Tab 序与无障碍树：灯箱装饰会给每张图/视频补 role/tabindex，
        // 不在这里收掉的话键盘要连按 5 次、读屏会听到 5 个同名按钮。
        const video = videoOf(s);
        s.tabIndex = on && !video ? 0 : -1;
        // click 模式的视频 slide 里还有「在灯箱中播放」链接；不一起收掉会把 Tab 带进 aria-hidden 的子树。
        for (const el of s.querySelectorAll('a[href], button, video')) el.tabIndex = on ? 0 : -1;
        if (video) video.tabIndex = on ? 0 : -1;
        // 视频只在轮到它时播；click 模式一律不自动播，等读者点开灯箱。
        if (video) {
          if (on && video.dataset.videoMode !== 'click') video.play().catch(() => {});
          else video.pause();
        }
      });
      if (refocus) slides[at].focus({ preventScroll: true });
      slides.forEach((s, k) => {
        if (k === at) s.removeAttribute('aria-hidden'); else s.setAttribute('aria-hidden', 'true');
      });
      // 每张封面的文字跟着图一起切换；非当前张的链接移出 Tab 序，读屏也读不到。
      copies.forEach((copy, k) => {
        const on = k === at;
        copy.classList.toggle('is-active', on);
        copy.setAttribute('aria-hidden', String(!on));
        for (const link of copy.querySelectorAll('a[href], button')) link.tabIndex = on ? 0 : -1;
      });
      dots.forEach((d, k) => d.setAttribute('aria-pressed', String(k === at)));
      root.setAttribute('aria-label', `首页封面，第 ${at + 1} 张，共 ${slides.length} 张`);
      // 提前把下一张升级好：自动轮播 5 秒一张，空闲时足够下完；手动跳远张时也会在 show() 里当场升级。
      warm(slides[(at + 1) % slides.length]);
    };
    const stop = () => { if (heroTimer) { clearInterval(heroTimer); heroTimer = null; } };
    const start = () => {
      stop();
      if (lightboxOpen() || userPaused) return;
      if (hovering) return;
      if (root.dataset.heroMode !== 'auto' || reduceMotion()) return;
      heroTimer = setInterval(() => {
        if (document.hidden) return;
        // 焦点用 :focus-visible 现查而非存状态位：点过按钮后焦点会留在轮播里，存状态位等于"点一次永久停播"。
        const f = document.activeElement;
        if (f && root.contains(f) && f.matches?.(':focus-visible')) return;
        show(at + 1);
      }, HERO_AUTO_MS);
    };
    dots.forEach((d, k) => d.addEventListener('click', () => { show(k); start(); }));
    const pauseBtn = root.querySelector('[data-hero-pause]');
    if (pauseBtn) {
      const syncPause = () => {
        pauseBtn.setAttribute('aria-pressed', String(userPaused));
        pauseBtn.setAttribute('aria-label', userPaused ? '继续自动轮播' : '暂停自动轮播');
      };
      syncPause();
      pauseBtn.addEventListener('click', () => {
        userPaused = !userPaused;
        if (userPaused) stop(); else start();
        syncPause();
      });
    }
    root.addEventListener('pointerenter', () => { hovering = true; stop(); });
    root.addEventListener('pointerleave', () => { hovering = false; start(); });
    root.querySelector('.hero-ctrl')?.removeAttribute('hidden');
    show(at);
    heroControl = { stop, start };
    start();
  }

  // 视频默认 preload=none；进入视口（或笔记展开）后再要 metadata，首帧预览保留，但不在首屏抢带宽。
  // observer 在每次 pjax 换页时重建：旧节点已从 DOM 移除，必须 disconnect，否则会一直被观察。
  let lazyVideoObserver = null;
  function setupLazyVideoPreload(root = document) {
    lazyVideoObserver?.disconnect();
    lazyVideoObserver = null;
    const videos = [...root.querySelectorAll('video[data-lazy-preload]')];
    if (!videos.length) return;
    if (typeof IntersectionObserver !== 'function') {
      videos.forEach((v) => { v.preload = 'metadata'; v.removeAttribute('data-lazy-preload'); });
      return;
    }
    lazyVideoObserver = new IntersectionObserver((entries, io) => {
      for (const entry of entries) {
        if (!entry.isIntersecting) continue;
        const video = entry.target;
        video.preload = 'metadata';
        video.removeAttribute('data-lazy-preload');
        io.unobserve(video);
      }
    }, { rootMargin: '200px' });
    videos.forEach((v) => lazyVideoObserver.observe(v));
  }

  function setupPage() {
    setupLazyVideoPreload();
    // 灯箱在 #app 外，pjax 不会替换它；换页前先关掉，否则旧灯箱会浮在新页面上，
    // lbItems/lbTrigger 还指向已移除节点。close 事件负责停视频、还焦点（触发节点已断开时自动跳过）。
    const staleLightbox = document.getElementById('lightbox');
    if (staleLightbox?.open) staleLightbox.close();
    lbItems = []; lbAt = 0; lbTrigger = null;
    fillWho();
    decorateLightbox();
    setupHeroVideoClick();
    setupHeroAutoplay();
    setupHeroCarousel();
    setupCodeCopy();

    /* 笔记列：给所有折叠行挂 .nf-anim 切到「px 高度」形态（见 style.css），开合由脚本量高度做动画。
       笔记默认全部收起，不预展开首篇。全量加载与 PJAX 换页都走这里。 */
    const notesRoot = document.querySelector('.notes');
    if (notesRoot) {
      notesRoot.querySelectorAll('details.nf-fold').forEach((fold) => fold.classList.add('nf-anim'));
    }

    // 头像加载失败摘掉 img 露字母头像，别留碎图标；补体检接住挂监听前已失败的图。
    document.querySelectorAll('.avatar-img').forEach((img) => {
      if (img.complete && img.naturalWidth === 0) img.remove();
    });

    // 落点是评论锚点或抽屉时展开那块，否则锚点跳过去什么都不会动。
    const hash = location.hash;
    const anchor = /^#c\d+$/.test(hash) ? document.querySelector(hash)
      : (/^#comments-/.test(hash) ? document.getElementById(hash.slice(1)) : null);
    const slot = anchor?.closest('.ncp-slot');
    if (slot && !slot.classList.contains('is-open')) foldDrawer(slot, true);

    // ?reply=N 进来时聚焦输入框。写在 setupPage 而非顶层，pjax 换页才会聚焦。
    if (new URLSearchParams(location.search).has('reply')) {
      document.querySelector('.c-form textarea[name="body"]')?.focus();
    }


  }

  /* 记住评论者身份：昵称/邮箱/网址存本机 localStorage，下次自动填上。只落本机、不随请求发出（不像 cookie）。 */
  const WHO_KEY = 'commenter';
  const WHO_FIELDS = ['author', 'email', 'website'];
  const readWho = () => {
    try {
      const saved = JSON.parse(localStorage.getItem(WHO_KEY) || 'null');
      return saved && typeof saved === 'object' ? saved : {};
    } catch { return {}; }
  };
  const saveWho = (form) => {
    if (!form.querySelector('[name="email"]')) return;
    const who = {};
    for (const name of WHO_FIELDS) {
      const value = (form.querySelector(`[name="${name}"]`)?.value ?? '').trim();
      if (value) who[name] = value;
    }
    try {
      if (Object.keys(who).length) localStorage.setItem(WHO_KEY, JSON.stringify(who));
      else localStorage.removeItem(WHO_KEY);
    } catch {  }
  };
  const readerForms = new WeakSet();
  const bindReaderLookup = (form) => {
    const email = form.querySelector('[name="email"]');
    if (!email || readerForms.has(form)) return;
    readerForms.add(form);
    let timer;
    let version = 0;
    let lastAddress = '';
    const names = ['author', 'website'];
    const fields = names.map(name => form.querySelector(`[name="${name}"]`));
    const edited = new Set();
    fields.forEach(field => field?.addEventListener('input', () => edited.add(field)));
    const lookup = async () => {
      clearTimeout(timer);
      const address = email.value.trim().toLowerCase();
      if (!address || !email.validity.valid || address === lastAddress) return;
      lastAddress = address;
      const current = ++version;
      const before = fields.map(field => field?.value);
      try {
        const res = await request('/api/comments/reader', {
          method: 'POST', headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ email: address }),
        });
        if (!res.ok) { if (current === version) lastAddress = ''; return; }
        const { profile } = await res.json();
        if (!profile || current !== version || email.value.trim().toLowerCase() !== address) return;
        fields.forEach((field, i) => {
          if (field && !edited.has(field) && field.value === before[i]) field.value = String(profile[names[i]] ?? '');
        });
      } catch { if (current === version) lastAddress = ''; }
    };
    email.addEventListener('input', () => {
      ++version;
      lastAddress = '';
      clearTimeout(timer);
      timer = setTimeout(lookup, 400);
    });
    email.addEventListener('change', lookup);
    email.addEventListener('blur', lookup);
  };
  const fillWho = (root = document) => {
    const who = readWho();
    for (const form of root.querySelectorAll('[data-comment-form]')) {
      bindReaderLookup(form);
      for (const name of WHO_FIELDS) {
        const field = form.querySelector(`[name="${name}"]`);
        if (field && who[name] && !field.value) field.value = who[name];
      }
      // 幂等键必须每个页面实例各一份，不能由服务端渲染：HTML 有 ETag/304，两个标签页会共用同一份缓存，
      // 用同一个 id 发两条不同评论时第二条会被当成重复。成功提交后评论区整块回刷，自然拿到新 id。
      const submission = form.querySelector('[name="submission_id"]');
      if (submission && !submission.value) {
        submission.value = globalThis.crypto?.randomUUID?.()
          ?? `${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}${Math.random().toString(36).slice(2)}`;
      }
    }
  };

  // 这 6 个 id 每个评论区各一份：服务端渲染加 `-<slug>` 后缀，`?partial=comments` 回刷的那份不带，直接换上会与别的评论区撞 id。
  const SECTION_IDS = new Set(['comments', 'reply', 'c-author', 'c-email', 'c-website', 'c-body']);
  // 评论条目自身的 id（`c34`）是锚点落点，一律不许动：必须按白名单精确匹配，不能用前缀规则。
  function adoptIdSuffix(root, suffix) {
    if (!suffix) return;
    for (const el of root.querySelectorAll('[id]')) {
      if (SECTION_IDS.has(el.id)) el.id += suffix;
    }
    for (const el of root.querySelectorAll('label[for]')) {
      const to = el.getAttribute('for');
      if (SECTION_IDS.has(to)) el.setAttribute('for', to + suffix);
    }
  }

  /* 发完评论只换评论区：不跳页、不丢滚动位置；失败退回无刷新换页 */
  async function refreshComments(form, flash, count) {
    const section = form.closest ? form.closest('[data-comments-section]') : null;
    const inPanel = Boolean(form.closest('.ncp'));
    // 分页后必须带上当前页，否则在第 2 页发完评论回刷出来的是第 1 页
    const cpage = form.dataset ? (form.dataset.cpage || '') : '';
    const query = (extra) => `?partial=comments${inPanel ? '&panel=note' : ''}${cpage ? `&cpage=${encodeURIComponent(cpage)}` : ''}${extra}`;
    let base;
    try {
      base = new URL(form.getAttribute('action') || location.href, location.href);
      base.pathname = base.pathname.replace(/comment$/, '');
      base.search = query(`&c=${encodeURIComponent(flash)}`);
      base.hash = '';
    } catch { return fallback(); }

    try {
      const res = await request(base.href);
      if (!res.ok) throw new Error(String(res.status));
      const html = await res.text();
      // 提交后立刻 pjax 换页：迟到的响应不能再改新页面、弹 toast、清缓存。
      if (!section || !section.isConnected) return;
      const box = document.createElement('div');
      box.innerHTML = html;
      const next = box.querySelector('[data-comments-section]') || box.firstElementChild;
      if (section && next) {
        // 后缀取自原来那一节的 id
        adoptIdSuffix(next, section.id.startsWith('comments') ? section.id.slice('comments'.length) : '');
        if (section.id && next.id !== section.id) next.id = section.id;
        section.replaceWith(next);
        fillWho(next);
        // 替换后原提交按钮/表单已不在 DOM，焦点会掉到 body；把它交给新的评论区标题。
        const focusTarget = next.querySelector('h2, .ncp-mark');
        if (focusTarget) {
          focusTarget.setAttribute('tabindex', '-1');
          try { focusTarget.focus({ preventScroll: true }); } catch { focusTarget.focus(); }
        }
      }
      else return fallback();

      // 数字跟着回刷走：只改数字别整块重写 textContent（会抹掉 ::after 箭头），包进 <b class="n"> 与服务端结构一致，否则那抹金色就没了。
      const slug = form.dataset.slug;
      if (slug && typeof count === 'number') {
        for (const btn of document.querySelectorAll('[data-comments]')) {
          if (btn.dataset.comments !== slug) continue;
          if (!count) { btn.textContent = '评论'; continue; }
          const n = document.createElement('b');
          n.className = 'n';
          n.textContent = String(count);
          btn.replaceChildren('评论 ', n);
        }
        // 笔记折叠行底部那处计数是另一套标记，也要跟着变，否则同一行上下两个数字打架。
        for (const link of document.querySelectorAll('[data-nf-comments]')) {
          if (link.dataset.nfComments !== slug) continue;
          link.textContent = count ? `${count} 条评论` : '暂无评论';
        }
      }
      // 列表可能过时，清掉 pjax 预取缓存
      window.__nav?.invalidate?.();
      window.__toast?.(flash === 'pending' ? '评论已提交，等待站主确认后显示。' : '评论已发布。');
    } catch {
      fallback();
    }

    function fallback() {
      const url = new URL(form.getAttribute('action') || location.href, location.href);
      url.pathname = url.pathname.replace(/comment$/, '');
      url.search = `${cpage ? `?cpage=${encodeURIComponent(cpage)}&` : '?'}c=${encodeURIComponent(flash)}`;
      url.hash = 'comments';
      if (window.__nav?.navigate) window.__nav.navigate(url.href);
      else location.href = url.href;
    }
  }

  // 头像加载失败统一出口：error 不冒泡，必须用捕获阶段委托；新换进来的 img 也接得住。
  document.addEventListener('error', (e) => {
    if (e.target?.matches?.('.avatar-img')) e.target.remove();
  }, true);

  document.addEventListener('submit', async (e) => {
    const form = e.target;
    if (!form.matches || !form.matches('[data-comment-form]')) return;
    if (typeof form.reportValidity === 'function' && !form.reportValidity()) return;
    e.preventDefault();
    saveWho(form);   // 过了校验就记下：被限流/断网也不用重敲
    const btn = form.querySelector('button[type="submit"]');
    if (form.getAttribute('aria-busy') === 'true') return;
    const releaseBusy = window.__ui?.busy(form, btn);
    if (!releaseBusy) form.setAttribute('aria-busy', 'true');
    const btnLabel = btn ? btn.textContent : '';
    if (btn && !releaseBusy) { btn.disabled = true; btn.textContent = '提交中…'; }
    const payload = Object.fromEntries(new FormData(form).entries());
    payload.slug = form.dataset.slug;
    let notice = form.querySelector('[data-submit-notice]');
    if (!notice) { notice = document.createElement('p'); notice.dataset.submitNotice = ''; notice.setAttribute('role', 'status'); form.append(notice); }
    notice.textContent = '';
    try {
      const res = await request('/api/comments', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
      });
      const out = await res.json().catch(() => ({}));
      if (!out.ok || out.status === 'discarded') {
        notice.textContent = out.error || (out.status === 'limited' ? '提交过于频繁，请稍后重试。' : '提交未成功，请稍后重试。');
        return;
      }
      await refreshComments(form, out.status === 'pending' ? 'pending' : 'ok', out.count);
    } catch { notice.textContent = '连接中断或超时，输入已保留，请重试。'; }
    finally { if (releaseBusy) releaseBusy(); else { form.removeAttribute('aria-busy'); if (btn) { btn.disabled = false; btn.textContent = btnLabel; } } }

  });

  /* —— 笔记流评论抽屉：点「评论」在笔记下方就地展开，不盖住整页；展开收起全交给 CSS（0fr→1fr），这里只改类名和 inert，不量高度。 */
  const drawerOf = (btn) => document.getElementById(`c-${btn.dataset.comments}`);
  const drawerBtn = (slot) => document.querySelector(`[data-comments="${CSS.escape(slot.id.slice(2))}"]`);

  // 笔记流的评论抽屉首次展开时才取。服务端仍用 notePanelFor 生成同一份 ncp-* 标记，
  // 区别只是从「列表页一次渲染 10 份」变成「点开哪篇取哪篇」。
  function loadDrawer(slot) {
    if (!slot || slot.dataset.loaded === '1' || slot.dataset.loading === '1') return;
    const box = slot.querySelector('.ncp-mask');
    const url = slot.dataset.commentsUrl;
    if (!box || !url) return;
    slot.dataset.loading = '1';
    box.innerHTML = '<p class="ncp-loading" role="status">正在载入评论…</p>';
    const req = window.__request || fetch;
    Promise.resolve(req(url, { headers: { 'X-Requested-With': 'fetch' }, credentials: 'same-origin' }))
      .then((res) => {
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        return res.text();
      })
      .then((html) => {
        // pjax 换页后旧 slot 已断开：别再往已移除的节点里写。
        if (!slot.isConnected) return;
        box.innerHTML = html;
        fillWho(box);
        slot.dataset.loaded = '1';
        delete slot.dataset.loading;
      })
      .catch(() => {
        if (!slot.isConnected) return;
        const page = slot.dataset.commentsPage || url;
        box.innerHTML = `<p class="ncp-loading ncp-error" role="status">评论载入失败，<a href="${page}">去笔记页查看</a>。</p>`;
        delete slot.dataset.loading;
      });
  }

  function foldDrawer(slot, open) {
    slot.classList.toggle('is-open', open);
    // inert：收起时不进 Tab 顺序、读屏念不到；光靠高度 0 挡不住（overflow:hidden 只裁剪，输入框仍能被 Tab 到）。
    slot.toggleAttribute('inert', !open);
    drawerBtn(slot)?.setAttribute('aria-expanded', open ? 'true' : 'false');
  }

  function openDrawer(btn, slot) {
    // 一次只开一个：各开会长到找不着北，展开还会顶动内容，留着上一个就同时有两块"刚展开的"。
    for (const other of document.querySelectorAll('.ncp-slot.is-open')) {
      if (other !== slot) foldDrawer(other, false);
    }
    foldDrawer(slot, true);
    loadDrawer(slot);
    // 刚点的按钮留在视口里：展开后它位置会下移。锚在篇末 .note-foot 上即可。
    (btn.closest('.note-foot') ?? slot).scrollIntoView({
      block: 'nearest',
      behavior: reduceMotion() ? 'auto' : 'smooth',
    });
  }

  document.addEventListener('click', (e) => {
    const emoji = e.target.closest('[data-emoji]');
    if (emoji) {
      const field = emoji.closest('[data-comment-form]')?.querySelector('textarea[name="body"]');
      if (!field) return;
      const start = field.selectionStart;
      const end = field.selectionEnd;
      if (field.maxLength >= 0 && field.value.length - (end - start) + emoji.dataset.emoji.length > field.maxLength) {
        window.__toast?.('评论内容已达到字数上限。');
        return;
      }
      field.setRangeText(emoji.dataset.emoji, start, end, 'end');
      field.dispatchEvent(new Event('input', { bubbles: true }));
      closeEmoji(emoji.closest('[data-emoji-picker]'));
      field.focus({ preventScroll: true });
      return;
    }
    // 只有 openPicker 可能开着（openEmoji 前必先 closeAllEmoji），不必每次点击都全量扫一遍所有 picker。
    if (openPicker && !openPicker.contains(e.target)) closeEmoji(openPicker);
    const btn = e.target.closest('[data-comments]');
    if (btn) {
      if (!isPlainClick(e)) return;
      const slot = drawerOf(btn);
      if (slot) {
        e.preventDefault();
        if (slot.classList.contains('is-open')) foldDrawer(slot, false);
        else openDrawer(btn, slot);
      }
      return;
    }

    // 「回复」就地切换。不要改回"靠 pjax 跳 ?reply=N"：取消后地址栏仍停在 ?reply=N，再点同一链接 nav.js 判定 URL 未变不接管。
    const reply = e.target.closest('[data-reply]');
    if (reply && isPlainClick(e)) {
      const form = reply.closest('[data-comments-section]')?.querySelector('[data-comment-form]');
      if (!form) return;              // 评论区已关闭之类：把这次点击让给链接本身
      e.preventDefault();
      const input = form.querySelector('input[data-parent]');
      if (input) input.value = reply.dataset.reply;
      const title = form.querySelector('[data-reply-title]');
      if (title) title.textContent = `回复 ${reply.dataset.replyAuthor ?? ''}`.trim();
      form.querySelector('[data-cancel-reply]')?.removeAttribute('hidden');
      // 表单跟随到被回复评论下面，并记下原位供「取消回复」还原；提交成功整节替换，由服务端原位生成新表单。
      const item = reply.closest('li');
      if (item && !form.__home) form.__home = { parent: form.parentNode, next: form.nextSibling };
      if (item) {
        const main = item.querySelector(':scope > .c-main') ?? item.querySelector(':scope > .ncp-c-main') ?? item;
        main.insertBefore(form, main.querySelector(':scope > ul'));
      }
      // focus() 自己会把输入区滚进视口（抽屉里它在最下面，多半在屏幕外）
      form.querySelector('textarea[name="body"]')?.focus();
      return;
    }

    // 取消回复：还原默认态。只清 parent 与标题，绝不动正文（用户可能已写一半）；被挪走的表单一并搬回原位。
    const cancelReply = e.target.closest('[data-cancel-reply]');
    if (cancelReply && isPlainClick(e)) {
      const form = cancelReply.closest('[data-comment-form]');
      if (form) {
        e.preventDefault();
        // 记下正回复谁：清空后焦点要送回那条评论的「回复」链接。别改回 focus 正文框——表单跟随会把页面拽到底部。
        const wasReplyingTo = form.querySelector('input[data-parent]')?.value || '';
        const input = form.querySelector('input[data-parent]');
        if (input) input.value = '';
        const title = form.querySelector('[data-reply-title]');
        if (title) title.textContent = '';
        cancelReply.setAttribute('hidden', '');
        const home = form.__home;
        // nextSibling 对上才在原位，否则搬回去。直接 insertBefore 会重插、让聚焦的输入框丢焦点，先比较再动。
        if (home && form.nextSibling !== home.next) home.parent.insertBefore(form, home.next);
        // 焦点落回原处：那条评论的「回复」链接就在刚点的地方，:focus-within 会让它现身。
        const back = wasReplyingTo && document.getElementById(`c${wasReplyingTo}`)?.querySelector('[data-reply]');
        if (back) back.focus();
      }
      return;
    }

    const close = e.target.closest('[data-close-comments]');
    if (close) {
      const slot = close.closest('.ncp-slot');
      if (slot) {
        e.preventDefault();
        foldDrawer(slot, false);
        // 收起后焦点会落进 inert 那块被丢回 body；送回「评论」按钮（既是刚点处也是重新展开入口）。
        drawerBtn(slot)?.focus();
      }
    }
  }, true);

  const lb = () => document.getElementById('lightbox');
  let lbItems = [], lbAt = 0;
  let lbTrigger = null;

  const lbVideo = () => lb()?.querySelector('.lb-video');
  // 切图/关灯箱时把视频彻底停住：只 pause 不摘 src，部分浏览器会继续缓冲；下一次播放从头上开始也更符合直觉。
  const stopLbVideo = () => {
    const video = lbVideo();
    if (!video) return;
    video.pause();
    video.hidden = true;
    video.removeAttribute('src');
    video.removeAttribute('width');
    video.removeAttribute('height');
    video.style.removeProperty('--lb-ar');
    try { video.load(); } catch { /* 某些浏览器在没有 src 时 load 会抛，无关紧要 */ }
  };

  function lbShow(i) {
    const box = lb();
    if (!box || !lbItems.length) return;
    lbAt = (i + lbItems.length) % lbItems.length;
    const cur = lbItems[lbAt];
    const img = box.querySelector('.lb-img');
    const video = box.querySelector('.lb-video');
    const src = cur.dataset.full || cur.href;
    const alt = cur.dataset.alt || cur.getAttribute('alt') || '';
    const isVideo = cur.dataset.media === 'video';

    if (video) video.pause();

    if (isVideo) {
      // 图片那条线要连 loader 一起取消，否则慢图下完还会把 <img> 顶到视频旁边。
      window.__ui?.clearImage?.(box);
      img.hidden = true;
      const width = Number(cur.dataset.w) || 0;
      const height = Number(cur.dataset.h) || 0;
      if (width > 0 && height > 0) {
        video.width = width; video.height = height;
        video.style.setProperty('--lb-ar', `${width} / ${height}`);
      } else {
        video.removeAttribute('width'); video.removeAttribute('height');
        video.style.removeProperty('--lb-ar');
      }
      video.hidden = false;
      video.setAttribute('aria-label', alt || '视频');
      if (video.getAttribute('src') !== src) { video.src = src; video.load(); }
      // 点击/键盘进入灯箱都是用户手势，允许带声音播放；被浏览器拦下时控制条仍可手动播。
      video.play().catch(() => {});
    } else {
      stopLbVideo();
      // 被点的这张此刻多半已经在列表里加载好、在浏览器缓存里：拿它的实际地址当占位，点开先秒显，再换大图。
      const shown = cur.tagName === 'IMG' ? cur : cur.querySelector?.('img');
      const placeholder = shown && !shown.hidden ? (shown.currentSrc || shown.src || '') : '';
      // 第 5 张起的占位 span 没有可见 <img>，尺寸要优先从 data-w/data-h 取，否则灯箱会先空白再跳。
      const width = Number(cur.dataset?.w) || Number(shown?.getAttribute?.('width')) || 0;
      const height = Number(cur.dataset?.h) || Number(shown?.getAttribute?.('height')) || 0;
      if (window.__ui) window.__ui.loadImage(box, src, alt, { placeholder, width, height });
      else { img.src = src; img.alt = alt; img.hidden = false; }
    }
    box.querySelector('.lb-count').textContent = `${lbAt + 1} / ${lbItems.length}`;
    const many = lbItems.length > 1;
    box.querySelector('.lb-prev').hidden = !many;
    box.querySelector('.lb-next').hidden = !many;
  }

  document.addEventListener('click', (e) => {
    const item = e.target.closest('[data-lightbox]');
    if (item && isPlainClick(e)) {
      e.preventDefault();
      const box = lb();
      if (!box || typeof box.showModal !== 'function') return;
      lbItems = [...document.querySelectorAll(`[data-lightbox="${CSS.escape(item.dataset.lightbox)}"]`)];
      lbShow(lbItems.indexOf(item));
      lbTrigger = item;
      // __ui.open() 已 sync 过滚动锁；缺 ui.js 的原生兜底才需自己补一次。
      window.__openDialog(box);
      heroControl?.stop();
      // 封面里的视频先停：模态后面继续播既费流量，也会和灯箱里的同一条音轨叠在一起。
      document.querySelectorAll('.hero-figure video').forEach((v) => v.pause());
      return;
    }
    const box = lb();
    if (!box) return;
    if (e.target.closest('[data-lb-close]') || e.target === box) { box.close(); return; }
    if (e.target.closest('[data-lb-prev]')) lbShow(lbAt - 1);
    if (e.target.closest('[data-lb-next]')) lbShow(lbAt + 1);
  });

  document.addEventListener('keydown', (e) => {
    // Esc 收起评论抽屉：它不是浮层，浏览器不代劳。
    if (e.key === 'Escape') {
      // 有 <dialog> 打开时先把 Esc 让给浏览器：在 keydown 上 preventDefault 会阻止灯箱/媒体选择器
      // 的原生 cancel，结果只关了后面的抽屉、模态不关，焦点还会落到模态背后。
      if (document.querySelector('dialog[open]')) return;
      const picker = openPicker?.isConnected ? openPicker : null;
      if (picker) {
        e.preventDefault();
        closeEmoji(picker, true);
        return;
      }
      // 打开抽屉后焦点仍可能停在触发按钮（在抽屉外）；不能只看 e.target 的祖先。
      const slot = e.target?.closest?.('.ncp-slot.is-open') ?? document.querySelector('.ncp-slot.is-open');
      if (slot) {
        e.preventDefault();
        foldDrawer(slot, false);
        drawerBtn(slot)?.focus();
        return;
      }
    }
    const box = lb();
    if (box?.open) {
      // 视频控制条自己要用左右键快退/快进；焦点在视频上时让给原生控件，别同时切下一条。
      if (e.target?.closest?.('.lb-video') && (e.key === 'ArrowLeft' || e.key === 'ArrowRight')) return;
      if (e.key === 'ArrowLeft') lbShow(lbAt - 1);
      if (e.key === 'ArrowRight') lbShow(lbAt + 1);
      return;
    }
    // 插图被补成 <img role=button tabindex=0>：Enter/空格不会自动变 click，补上，否则键盘进不去灯箱。
    const item = e.target?.closest?.('[data-lightbox]');
    if (item && (e.key === 'Enter' || e.key === ' ' || e.key === 'Spacebar')) {
      e.preventDefault();
      item.click();
    }
  });

  // dialog 的 close 不冒泡，捕获阶段能到 document。关灯箱后焦点归宿（Safari 实测）：WebKit 关闭时把焦点还给触发元素；
  // Esc 的键盘模态点亮 :focus-visible，全局规则会在插图外画金框（Chromium 无此问题），故程序性移焦不画圈。
  document.addEventListener('close', (e) => {
    if (e.target !== lb()) return;
    stopLbVideo();
    heroControl?.start();
    // 回到页面时恢复封面视频：轮播里只恢复当前那一条，单视频直接续播。
    document.querySelectorAll('.hero-figure video').forEach((v) => {
      if (v.dataset.videoMode === 'click') return;
      const slide = v.closest('.hero-slide');
      if (slide && !slide.classList.contains('is-active')) return;
      v.play().catch(() => {});
    });
    const t = lbTrigger;
    if (!t?.isConnected) return;
    // 触发的那张若已被切走（落在 aria-hidden 子树里），别再把焦点还原上去：改交给当前可见的那张。
    const target = t.closest('[aria-hidden="true"]') ? (document.querySelector('.hero-slide.is-active') ?? t) : t;
    if (document.activeElement !== target) {
      try { target.focus({ preventScroll: true }); } catch { target.focus(); }
    }
    target.style.outline = 'none';
    const restore = () => { target.style.outline = ''; };
    target.addEventListener('focusout', restore, { once: true });
    window.addEventListener('keydown', restore, { capture: true, once: true });
  }, true);

  /* 归档页年/月是原生 <details>：收起的内容不进打印输出。打印前统一展开、打完还原，只记原本收着的，别抹掉用户手动收起的状态。无 JS 时照常打印。 */
  addEventListener('beforeprint', () => {
    const reopen = [...document.querySelectorAll('details.chron:not([open]), details.mgrp:not([open])')];
    reopen.forEach((d) => { d.open = true; });
    addEventListener('afterprint', () => reopen.forEach((d) => { d.open = false; }), { once: true });
  });

  /* 代码块复制按钮：服务端不掺 DOM —— 无 JS 时围栏输出与加高亮之前逐字相同（渲染器那条契约还在）。
     按钮到浏览器里再补，pjax 换页后 setupPage 会重新跑一遍，所以不用管旧节点。 */
  function setupCodeCopy() {
    document.querySelectorAll('pre > code').forEach((code) => {
      const pre = code.parentElement;
      if (pre.querySelector(':scope > .code-copy')) return;
      const btn = document.createElement('button');
      btn.type = 'button'; btn.className = 'code-copy'; btn.dataset.copy = '';
      btn.setAttribute('aria-label', '复制代码'); btn.textContent = '复制';
      pre.insertBefore(btn, code);
      // 给代码块顶部留出按钮的高度；用类而不是 :has，老一点的浏览器也不会让按钮压住第一行。
      pre.classList.add('has-copy');
    });
  }

  /* 代码块复制：事件委托，pjax 换页后不必重新绑定。没有 Clipboard API 时退回选区 + execCommand。 */
  document.addEventListener('click', async (e) => {
    const btn = e.target?.closest?.('[data-copy]');
    if (!btn) return;
    const code = btn.closest('pre')?.querySelector('code');
    if (!code) return;
    const text = code.innerText;
    let ok = false;
    try {
      if (navigator.clipboard?.writeText) { await navigator.clipboard.writeText(text); ok = true; }
    } catch { ok = false; }
    if (!ok) {
      const ta = document.createElement('textarea');
      ta.value = text; ta.setAttribute('readonly', '');
      ta.style.cssText = 'position:fixed;top:0;left:-9999px;opacity:0';
      document.body.appendChild(ta); ta.select();
      try { ok = document.execCommand('copy'); } catch { ok = false; }
      ta.remove();
    }
    if (!ok) { window.__toast?.('复制失败，请手动选择'); return; }
    // 原始文案只在第一次点击时记下来：连点第二次时 textContent 已经是「已复制」，不能拿它当还原值。
    if (!btn.dataset.copyLabel) btn.dataset.copyLabel = btn.textContent;
    btn.textContent = '已复制'; btn.classList.add('is-done');
    clearTimeout(btn.__copyTimer);
    btn.__copyTimer = setTimeout(() => {
      btn.textContent = btn.dataset.copyLabel;
      btn.classList.remove('is-done');
    }, 1600);
  });

  setupPage();

  (window.__pjaxHooks = window.__pjaxHooks || []).push(() => setupPage());
})();

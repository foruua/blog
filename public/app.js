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
  document.addEventListener('toggle', (e) => {
    if (e.target.matches?.('[data-emoji-panel]') && e.newState === 'closed') {
      e.target.classList.remove('is-open');
      const picker = e.target.closest('[data-emoji-picker]');
      picker?.querySelector('[data-emoji-toggle]')?.setAttribute('aria-expanded', 'false');
      if (picker && openPicker === picker) openPicker = null;
    }
  }, true);

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

  /* 正文插图/封面视频的「点开」是 JS 能力：role/tabindex 也由 JS 补，写死在 HTML 里会让禁 JS 的读者拿到假按钮。
     首页封面那张是 <h1> 唯一内容：只补 role/tabindex，不加 aria-label，否则会改掉标题可访问名。 */
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

  /* —— 首页封面视频：静音自动循环 ——
     只靠 HTML 的 autoplay/muted 在部分移动内核（鸿蒙 ArkWeb、X5/WebView）上会被静默忽略。
     这里落成 IDL 再显式 play()；被自动播放策略拦下时等一次手势；播放卡住（原生层没出帧）时
     彻底退回首帧海报，避免视频层盖住封面文字/抽屉。点击封面始终进灯箱播放，不在这里抢播放控制。 */
  const reduceMotion = window.__reducedMotion;
  const HERO_AUTO_MS = 5000;
  const HERO_VIDEO_MAX_MS = 8000;
  let heroTimer = null;
  // 灯箱打开要停住轮播：对话框不置 document.hidden，否则关灯箱时已不是当时那张。
  let heroControl = null;
  let heroSchedule = null;
  let heroAdvance = null;
  let heroVideos = [];
  let heroGesture = null;
  let heroWatchdog = null;
  let heroEventsBound = false;
  // 灯箱开着时不能自动播：否则关灯箱时浏览器会把焦点还原给触发的那张封面，而它可能已被切走并标了 aria-hidden
  // （触发 Chrome「Blocked aria-hidden …」告警，读屏也会突然失焦）。开灯箱时已 stop()，这里拦住 pointerleave 触发的重启。
  const lightboxOpen = () => Boolean(document.getElementById('lightbox')?.open);
  const heroSaveData = () => Boolean(navigator.connection?.saveData);
  const heroAutoAllowed = () => !document.hidden && !lightboxOpen() && !reduceMotion() && !heroSaveData();
  const heroVideoSingle = (video) => !video.closest('.hero-slide');
  const heroVideoActive = (video) => {
    const slide = video.closest('.hero-slide');
    return !slide || slide.classList.contains('is-active');
  };
  const settleHeroPlay = (video) => {
    video.__heroPending = false;
    clearTimeout(video.__heroPendingTimer);
    video.__heroPendingTimer = 0;
  };

  const armHeroGesture = () => {
    if (heroGesture || typeof AbortController !== 'function') return;
    const controller = new AbortController();
    heroGesture = controller;
    const retry = () => {
      controller.abort();
      if (heroGesture === controller) heroGesture = null;
      for (const video of heroVideos) if (heroVideoActive(video)) playHeroVideo(video, { gesture: true });
    };
    for (const type of ['pointerdown', 'touchstart', 'keydown']) {
      document.addEventListener(type, retry, { capture: true, passive: true, signal: controller.signal });
    }
  };

  function playHeroVideo(video, { gesture = false } = {}) {
    if (!video?.isConnected || video.__heroFrozen || !heroAutoAllowed() || !heroVideoActive(video)) return;
    // 属性在部分内核里不足以让自动播放生效；muted 必须在 play() 之前就是 true。
    video.muted = true;
    video.defaultMuted = true;
    video.playsInline = true;
    video.setAttribute('webkit-playsinline', 'webkit-playsinline');
    // 单视频无限循环；轮播里播一遍就交给下一张。
    video.loop = heroVideoSingle(video);
    if (gesture) video.__heroBlocked = false;
    if (video.__heroPending) return;
    if (video.__heroBlocked) { armHeroGesture(); return; }
    video.__heroPending = true;
    video.__heroPlayAt = performance.now();
    let played;
    try {
      played = video.play();
    } catch {
      settleHeroPlay(video);
      video.__heroBlocked = true;
      armHeroGesture();
      return;
    }
    if (!played || typeof played.then !== 'function') { settleHeroPlay(video); return; }
    played.then(
      () => {
        settleHeroPlay(video);
        video.__heroBlocked = false;
        video.__heroStarted = !video.paused;
        heroSchedule?.();
      },
      (error) => {
        settleHeroPlay(video);
        // 只有自动播放策略拦截需要等手势；其它错误（AbortError、解码失败）交给 canplay / 看门狗。
        if (error && error.name === 'NotAllowedError') {
          video.__heroBlocked = true;
          armHeroGesture();
          heroSchedule?.();
        }
      },
    );
    // 个别内核会返回一个永不落定的 Promise：留超时，别让 __heroPending 永久卡死。
    video.__heroPendingTimer = setTimeout(() => settleHeroPlay(video), 5000);
  }

  function pauseHeroVideos() {
    for (const video of heroVideos) {
      settleHeroPlay(video);
      video.pause();
    }
  }

  function resumeActiveHeroVideo() {
    for (const video of heroVideos) if (heroVideoActive(video)) playHeroVideo(video);
  }

  // 播放卡住时不再重试原生播放器：直接换成首帧海报，视频层彻底退出合成，封面文字/抽屉就不会被盖住。
  function freezeHeroVideo(video) {
    if (!video || video.__heroFrozen) return;
    video.__heroFrozen = true;
    video.pause();
    const poster = video.dataset.poster || video.getAttribute('poster') || '';
    video.dataset.heroFrozen = '1';
    heroSchedule?.();
    if (!poster || !video.isConnected) return;
    const fallback = document.createElement('img');
    fallback.className = 'hero-fallback';
    fallback.src = poster;
    fallback.alt = '';
    fallback.decoding = 'async';
    const w = Number(video.dataset.w) || Number(video.getAttribute('width')) || 0;
    const h = Number(video.dataset.h) || Number(video.getAttribute('height')) || 0;
    if (w > 0 && h > 0) {
      fallback.width = w; fallback.height = h;
      fallback.style.aspectRatio = `${w} / ${h}`;
      fallback.dataset.w = String(w); fallback.dataset.h = String(h);
    }
    for (const key of ['lightbox', 'media', 'full', 'poster', 'alt']) {
      const value = video.dataset[key];
      if (value) fallback.dataset[key] = value;
    }
    // 隐藏的原视频不能再留在灯箱组/键盘序里，否则翻页会翻到一个看不见的视频。
    for (const key of ['lightbox', 'media', 'full']) video.removeAttribute(`data-${key}`);
    video.tabIndex = -1;
    video.setAttribute('aria-hidden', 'true');
    video.hidden = true;
    video.after(fallback);
    decorateLightbox(fallback);
    fallback.tabIndex = heroVideoActive(video) ? 0 : -1;
  }

  function setupHeroVideo(video) {
    if (video.dataset.heroReady) return;
    video.dataset.heroReady = '1';
    video.setAttribute('webkit-playsinline', 'webkit-playsinline');
    video.setAttribute('x5-playsinline', 'x5-playsinline');
    video.addEventListener('loadedmetadata', () => {
      if (heroVideoActive(video)) playHeroVideo(video);
      heroSchedule?.();
    });
    video.addEventListener('canplay', () => { if (heroVideoActive(video)) playHeroVideo(video); });
    video.addEventListener('playing', () => {
      settleHeroPlay(video);
      video.__heroBlocked = false;
      video.__heroStarted = true;
      video.__stuck = 0;
      video.__heroProbe = null;
      if (!video.loop) video.loop = heroVideoSingle(video);
      if (!video.muted) video.muted = true;
      heroSchedule?.();
    });
    video.addEventListener('pause', () => settleHeroPlay(video));
    video.addEventListener('ended', () => {
      settleHeroPlay(video);
      video.__heroStarted = false;
      if (heroVideoSingle(video)) {
        try { video.currentTime = 0; } catch { /* 有些内核此时禁止 seek，直接 play() 也会从头开始 */ }
        playHeroVideo(video);
        return;
      }
      // 轮播里的视频播完就交给下一张（悬停/灯箱/切页时由 heroAdvance 里的条件拦住）。
      heroAdvance?.();
    });
    video.addEventListener('error', () => freezeHeroVideo(video));
  }

  function getDecodedFrames(video) {
    try {
      return Number(video.getVideoPlaybackQuality?.().totalVideoFrames ?? video.webkitDecodedFrameCount ?? video.mozDecodedFrames ?? -1);
    } catch { return -1; }
  }

  function ensureHeroPlayback() {
    if (!heroVideos.length) return;
    for (const video of heroVideos) {
      if (!video.isConnected || video.__heroFrozen || !heroVideoActive(video)) continue;
      const frames = getDecodedFrames(video);
      const time = video.currentTime;
      const probe = video.__heroProbe;
      // 播放器「声称在播」但时间与解码帧两拍都不动：鸿蒙原生层没有出帧，继续等只会一直盖着页面。
      if (!video.paused && video.readyState >= 2
          && probe && Math.abs(time - probe.time) < 0.02 && (frames < 0 || frames === probe.frames)) {
        video.__stuck = (video.__stuck ?? 0) + 1;
      } else {
        video.__stuck = 0;
      }
      video.__heroProbe = { time, frames };
      if (video.__stuck >= 2) { freezeHeroVideo(video); continue; }
      // 起播请求已经过了一段时间却连首帧都没出来，也不再等。
      if (!video.paused && !video.__heroBlocked && video.__heroPlayAt
          && performance.now() - video.__heroPlayAt > 3500 && time < 0.05 && (frames <= 0)) {
        freezeHeroVideo(video);
        continue;
      }
      // 只恢复「确实起播过、后来被系统打断」的视频；首次起播交给 canplay / 手势，避免反复 play() 顶掉加载。
      if (video.__heroStarted && video.paused && !video.__heroPending && !video.__heroBlocked && video.readyState >= 3) {
        playHeroVideo(video);
      }
    }
  }

  function setupHeroVideos(root = document) {
    heroGesture?.abort();
    heroGesture = null;
    if (heroWatchdog) { clearInterval(heroWatchdog); heroWatchdog = null; }
    heroVideos = [...root.querySelectorAll('.hero-figure video')];
    if (!heroEventsBound) {
      heroEventsBound = true;
      // 上一次被自动播放策略拒掉不代表这次还会被拒：回到前台/从 bfcache 回来都当成一次全新的起播机会。
      const retryOnReturn = () => {
        for (const video of heroVideos) video.__heroBlocked = false;
        resumeActiveHeroVideo();
      };
      document.addEventListener('visibilitychange', () => {
        if (document.hidden) pauseHeroVideos();
        else retryOnReturn();
      });
      // bfcache 回退不一定会发 visibilitychange，补一次 pageshow。
      addEventListener('pageshow', retryOnReturn);
    }
    for (const video of heroVideos) {
      setupHeroVideo(video);
      video.loop = heroVideoSingle(video);
      if (heroVideoActive(video)) playHeroVideo(video);
    }
    if (!heroVideos.length) return;
    armHeroGesture();
    heroWatchdog = setInterval(ensureHeroPlayback, 1500);
  }

  /* 首页轮播（多于一张媒体才渲染）。图片 5 秒，视频按自身时长（服务端封顶 8 秒）播完推进；
     悬停/聚焦/切走标签页/灯箱打开/「减弱动态效果」暂停。 */
  function setupHeroCarousel() {
    heroControl = null;
    heroSchedule = null;
    heroAdvance = null;
    if (heroTimer) { clearTimeout(heroTimer); heroTimer = null; }
    const root = document.querySelector('[data-hero-carousel]');
    if (!root) return;
    const slides = [...root.querySelectorAll('.hero-slide')];
    if (slides.length < 2) return;
    let at = Math.max(0, slides.findIndex((s) => s.classList.contains('is-active')));
    // 悬停时不自动播：手动点击会调 start()，它必须尊重这个状态位，否则悬停着点一下又自己动。
    let hovering = false;
    const videoOf = (slide) => (slide?.tagName === 'VIDEO'
      ? slide
      : (slide?.querySelector?.('video') ?? null));
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
    const clearTimer = () => { if (heroTimer) { clearTimeout(heroTimer); heroTimer = null; } };
    const focusInCarousel = () => {
      const f = document.activeElement;
      return Boolean(f && root.contains(f) && f.matches?.(':focus-visible'));
    };
    const dwellOf = () => {
      const video = videoOf(slides[at]);
      if (!video || video.__heroFrozen || video.__heroBlocked || !video.__heroStarted) return HERO_AUTO_MS;
      const duration = Number(video.duration);
      return duration > 0 ? Math.min(HERO_VIDEO_MAX_MS, Math.max(1000, Math.round(duration * 1000))) : HERO_AUTO_MS;
    };
    const schedule = () => {
      clearTimer();
      if (!heroAutoAllowed() || hovering) return;
      heroTimer = setTimeout(() => {
        heroTimer = null;
        if (!heroAutoAllowed() || hovering) { schedule(); return; }
        // 焦点在轮播里（键盘 Tab 到封面）时暂停推进：用户正读着那张，别抽走。
        if (focusInCarousel()) { schedule(); return; }
        show(at + 1);
      }, dwellOf());
    };
    heroSchedule = schedule;
    const show = (i) => {
      at = (i + slides.length) % slides.length;
      hydrate(slides[at]);
      // 被隐藏的那张若还留着焦点（鼠标点过封面、或灯箱关闭把焦点还给了封面），直接加 aria-hidden 会被
      // Chrome 拦截并报警，读屏用户也会突然失去焦点。所以先把焦点让给新的当前张，再隐藏其余几张。
      const hidden = slides.findIndex((s) => s === document.activeElement || s.contains(document.activeElement));
      const refocus = hidden !== -1 && hidden !== at;
      slides.forEach((s, k) => {
        const on = k === at;
        const video = videoOf(s);
        s.classList.toggle('is-active', on);
        // 不可见的那几张必须同时移出 Tab 序与无障碍树：灯箱装饰会给每张图/视频补 role/tabindex，
        // 不在这里收掉的话键盘要连按 5 次、读屏会听到 5 个同名按钮。
        if (video) {
          s.tabIndex = -1;
          video.tabIndex = on ? 0 : -1;
          const fallback = s.querySelector?.('.hero-fallback');
          if (fallback) fallback.tabIndex = on ? 0 : -1;
          if (!on) {
            video.pause();
            try { video.currentTime = 0; } catch { /* 有些内核此时禁止 seek */ }
            video.__heroProbe = null;
            video.__stuck = 0;
          }
        } else {
          s.tabIndex = on ? 0 : -1;
        }
      });
      if (refocus) {
        const fallback = slides[at].querySelector?.('.hero-fallback');
        const target = fallback ?? videoOf(slides[at]) ?? slides[at];
        try { target.focus({ preventScroll: true }); } catch { target.focus?.(); }
      }
      slides.forEach((s, k) => {
        if (k === at) s.removeAttribute('aria-hidden'); else s.setAttribute('aria-hidden', 'true');
      });
      root.setAttribute('aria-label', `首页封面，第 ${at + 1} 项，共 ${slides.length} 项`);
      // 提前把下一张升级好：空闲时足够下完；手动跳远张时也会在 show() 里当场升级。
      warm(slides[(at + 1) % slides.length]);
      const activeVideo = videoOf(slides[at]);
      if (activeVideo && !activeVideo.__heroFrozen) playHeroVideo(activeVideo);
      schedule();
    };
    const stop = () => clearTimer();
    const start = () => {
      clearTimer();
      if (!heroAutoAllowed() || hovering) return;
      // 视频在悬停期间已经播完：松手后直接翻页，别再等一整段视频时长。
      const activeVideo = videoOf(slides[at]);
      if (activeVideo?.ended && !focusInCarousel()) { show(at + 1); return; }
      schedule();
    };
    heroAdvance = () => {
      if (!heroAutoAllowed() || hovering || focusInCarousel()) return;
      show(at + 1);
    };
    root.addEventListener('pointerenter', () => { hovering = true; stop(); });
    root.addEventListener('pointerleave', () => { hovering = false; start(); });
    show(at);
    heroControl = { stop, start };
  }

  function setupPage() {
    // 灯箱在 #app 外，pjax 不会替换它；换页前先关掉，否则旧灯箱会浮在新页面上，
    // lbItems/lbTrigger 还指向已移除节点。close 事件负责还焦点（触发节点已断开时自动跳过）。
    const staleLightbox = document.getElementById('lightbox');
    if (staleLightbox?.open) staleLightbox.close();
    lbItems = []; lbAt = 0; lbTrigger = null;
    fillWho();
    decorateLightbox();
    setupHeroVideos();
    setupHeroCarousel();
    setupCodeCopy();

    // 头像加载失败摘掉 img 露字母头像，别留碎图标；补体检接住挂监听前已失败的图。
    document.querySelectorAll('.avatar-img').forEach((img) => {
      if (img.complete && img.naturalWidth === 0) img.remove();
    });

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

  /* 发完评论只换评论区：不跳页、不丢滚动位置；失败退回无刷新换页 */
  async function refreshComments(form, flash) {
    const section = form.closest ? form.closest('[data-comments-section]') : null;
    // 分页后必须带上当前页，否则在第 2 页发完评论回刷出来的是第 1 页
    const cpage = form.dataset ? (form.dataset.cpage || '') : '';
    const query = (extra) => `?partial=comments${cpage ? `&cpage=${encodeURIComponent(cpage)}` : ''}${extra}`;
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
        section.replaceWith(next);
        fillWho(next);
        // 替换后原提交按钮/表单已不在 DOM，焦点会掉到 body；把它交给新的评论区标题。
        const focusTarget = next.querySelector('h2');
        if (focusTarget) {
          focusTarget.setAttribute('tabindex', '-1');
          try { focusTarget.focus({ preventScroll: true }); } catch { focusTarget.focus(); }
        }
      }
      else return fallback();

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
    // 失败提示优先用轻提示；没有轻提示能力时才在表单里留一行文案。
    // 元素按需创建：一提交就塞一个空的 <p>（自带段落外边距）会让表单瞬间变高一下。
    const showError = (message) => {
      if (window.__toast) {
        form.querySelector('[data-submit-notice]')?.remove();
        window.__toast(message, 'bad');
        return;
      }
      let notice = form.querySelector('[data-submit-notice]');
      if (!notice) {
        notice = document.createElement('p');
        notice.dataset.submitNotice = '';
        notice.setAttribute('role', 'status');
        form.append(notice);
      }
      notice.textContent = message;
    };
    try {
      const res = await request('/api/comments', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
      });
      const out = await res.json().catch(() => ({}));
      if (!out.ok || out.status === 'discarded') {
        showError(out.error || (out.status === 'limited' ? '提交过于频繁，请稍后重试。' : '提交未成功，请稍后重试。'));
        return;
      }
      await refreshComments(form, out.status === 'pending' ? 'pending' : 'ok');
    } catch {
      showError('连接中断或超时，输入已保留，请重试。');
    }
    finally { if (releaseBusy) releaseBusy(); else { form.removeAttribute('aria-busy'); if (btn) { btn.disabled = false; btn.textContent = btnLabel; } } }

  });

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
        const main = item.querySelector(':scope > .c-main') ?? item;
        main.insertBefore(form, main.querySelector(':scope > ul'));
      }
      // focus() 自己会把输入区滚进视口（表单在评论列表下方，多半在屏幕外）
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
    video.removeAttribute('poster');
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
    // 被点的这张此刻多半已经在列表里加载好、在浏览器缓存里：拿它的实际地址当占位，点开先秒显，再换大图。
    const shown = cur.tagName === 'IMG' ? cur : cur.querySelector?.('img');
    // 第三方主题/手写正文可能只有 <img data-lightbox>（没有 href/data-full）：回退到图片自身地址，
    // 都取不到就别打开，避免请求 /undefined。
    const src = cur.dataset.full || cur.getAttribute?.('href') || shown?.currentSrc || shown?.src || '';
    if (!src) return;
    const alt = cur.dataset.alt || cur.getAttribute?.('alt') || shown?.getAttribute?.('alt') || '';
    const isVideo = cur.dataset.media === 'video';
    // 第 5 张起的占位 span 没有可见 <img>，尺寸要优先从 data-w/data-h 取，否则灯箱会先空白再跳。
    const width = Number(cur.dataset?.w) || Number(shown?.getAttribute?.('width')) || 0;
    const height = Number(cur.dataset?.h) || Number(shown?.getAttribute?.('height')) || 0;
    if (video) video.pause();
    if (isVideo) {
      // 图片那条线要连 loader 一起取消，否则慢图下完还会把 <img> 顶到视频旁边。
      window.__ui?.clearImage?.(box);
      img.hidden = true;
      if (width > 0 && height > 0) {
        video.width = width; video.height = height;
        video.style.setProperty('--lb-ar', `${width} / ${height}`);
      } else {
        video.removeAttribute('width'); video.removeAttribute('height');
        video.style.removeProperty('--lb-ar');
      }
      const poster = cur.dataset.poster || '';
      if (poster) video.setAttribute('poster', poster); else video.removeAttribute('poster');
      video.hidden = false;
      video.setAttribute('aria-label', alt || '视频');
      if (video.getAttribute('src') !== src) { video.src = src; video.load(); }
      // 点击/键盘进入灯箱都是用户手势，允许播放；被浏览器拦下时控制条仍可手动播。
      video.play().catch(() => {});
    } else {
      stopLbVideo();
      const placeholder = shown && !shown.hidden ? (shown.currentSrc || shown.src || '') : '';
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
      // 模态后面的封面视频先停：既省流量，也避免和灯箱里的视频同时占着解码器。
      pauseHeroVideos();
      return;
    }
    const box = lb();
    if (!box) return;
    if (e.target.closest('[data-lb-close]') || e.target === box) { box.close(); return; }
    if (e.target.closest('[data-lb-prev]')) lbShow(lbAt - 1);
    if (e.target.closest('[data-lb-next]')) lbShow(lbAt + 1);
  });

  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') {
      // 有 <dialog> 打开时先把 Esc 让给浏览器：在 keydown 上 preventDefault 会阻止灯箱/媒体选择器
      // 的原生 cancel，结果只关了后面的面板、模态不关，焦点还会落到模态背后。
      // 前面的搜索框/配色面板已经处理过这次 Esc：一次按键只关一层。
      if (e.defaultPrevented) return;
      if (document.querySelector('dialog[open]')) return;
      const picker = openPicker?.isConnected ? openPicker : null;
      if (picker) {
        e.preventDefault();
        closeEmoji(picker, true);
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
    resumeActiveHeroVideo();
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
    // 降级路径（无 Clipboard API 时选区 + execCommand）收敛在 ui.js，见 window.__copyText。
    const ok = await window.__copyText?.(text);
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

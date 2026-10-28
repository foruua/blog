/* —— 窄屏导航抽屉 —— 刻意放在下面 IIFE 外面：纯界面逻辑，不该跟 pjax 的「不支持就早退」一起失效。
   节点用时现查：pjax 换页会把 #app 整个换掉，闭包引用会成死节点。 */
(function () {
  'use strict';

  if (!document.getElementById('mnav')) return;

  var OPEN_CLASS = 'mnav-open';
  var WIDE = 620;            // 与 CSS 断点同值
  // 抽屉打开时摘出被遮罩盖住的"背景"（含 #app 外的「跳到正文」「回到顶部」，它们排在 Tab 最前/最后，漏掉就会跑到看不见的地方）。
  var BACKGROUND = '.skip, .to-top, header.site, main, footer.site';
  var last = null;           // 打开前焦点，关闭时还回去
  var pad = 0;               // 滚动条宽度，只在没锁时量得到

  function nodes() {
    return {
      btn: document.querySelector('header.site .navbtn'),
      panel: document.getElementById('mnav'),
    };
  }
  function isOpen() { return document.body.classList.contains(OPEN_CLASS); }

  function measurePad() {
    if (isOpen()) return;    // 锁上后滚动条已消失，量到的是 0
    var w = Math.round((window.innerWidth || 0) - (document.documentElement.clientWidth || 0));
    if (w >= 0 && w <= 40) pad = w;
  }

  function set(open, restoreFocus) {
    if (open === isOpen()) return;
    var n = nodes();
    document.body.classList.toggle(OPEN_CLASS, open);
    document.body.style.setProperty('--mnav-pad', pad + 'px');
    if (n.btn) n.btn.setAttribute('aria-expanded', open ? 'true' : 'false');
    // inert 把被盖住的半页摘出可达性树，Tab 只能绕在抽屉里。
    if (n.panel) n.panel.inert = !open;
    document.querySelectorAll(BACKGROUND).forEach(function (el) { el.inert = open; });
    if (open) {
      last = document.activeElement;
      if (n.panel) { n.panel.tabIndex = -1; n.panel.focus({ preventScroll: true }); }
    } else if (restoreFocus !== false) {
      // 焦点还给打开它的按钮；是 body 或已销毁的都退回新页头那枚。
      var back = (last && last !== document.body && last.isConnected) ? last : n.btn;
      if (back) back.focus({ preventScroll: true });
    }
  }
  // 换页时收抽屉：只归位状态与 inert，不碰焦点。
  window.__closeNavDrawer = function () { set(false, false); };

  measurePad();
  window.addEventListener('resize', function () {
    if (isOpen() && window.innerWidth > WIDE) set(false);
    measurePad();
  }, { passive: true });

  document.addEventListener('click', function (ev) {
    var t = ev.target;
    if (!t || !t.closest) return;
    if (t.closest('[data-mnav-close]')) { set(false); return; }
    if (t.closest('header.site .navbtn')) { set(!isOpen()); return; }
  });

  document.addEventListener('keydown', function (ev) {
    if (ev.key === 'Escape' && isOpen()) set(false);
  });
})();

(function () {
  'use strict';

  // 「JS 可用」的唯一标记是 <head> 内联主题引导加的 html.has-js（见 layout.js 的 THEME_BOOT）；以前另有 .js，易漏，现统一。

  var APP_ID = 'app';
  var container = document.getElementById(APP_ID);
  if (!container) return;
  if (!window.fetch || !window.history || !history.pushState || !window.DOMParser) return;

  var CACHE_MAX = 12;
  var CACHE_TTL_MS = 30000;
  var cache = new Map();
  var serial = 0;
  var activeController = null;
  var prefetched = new Map();
  var applySerial = 0;
  // JSDOM 不加载外链样式，link 永远不会触发 load；测试里别为每次换页白等 1.5 秒。
  var styleLoading = !(typeof navigator !== 'undefined' && /jsdom/i.test(navigator.userAgent || ''));
  // 预取时已经开始加载、但还没 onload 的样式表。换页若只看到 <link> 已存在就放行，
  // 会在 hover 后立刻点击时闪一下裸样式；这里让换页等同一张表加载完。
  var stylePending = new Map();
  var index = Number(history.state && history.state.blogIndex) || 0;
  var renderedUrl = location.href;
  var restoring = false;

  function freshCached(url) {
    var item = cache.get(url);
    if (item && Date.now() - item.fetchedAt < CACHE_TTL_MS) return item;
    cache.delete(url);
    return null;
  }

  var renderedPath = location.pathname + location.search;

  function toast(message, kind) {
    if (!message) return;
    var box = document.getElementById('toast');
    if (!box) {
      box = document.createElement('div');
      box.id = 'toast';
      box.setAttribute('role', 'status');
      box.setAttribute('aria-live', 'polite');
      document.body.appendChild(box);
    }
    box.className = 'toast' + (kind ? ' toast-' + kind : '');
    box.textContent = message;
    box.classList.add('on');
    clearTimeout(box.__toastTimer);
    box.__toastTimer = setTimeout(function () { box.classList.remove('on'); }, 3800);
  }
  window.__toast = toast;

  /* 滚到哪儿 —— 平滑与否一律**显式传参**，不靠翻转内联样式。
     老写法（内联 scrollBehavior='auto' → scrollTo → 还原）只有 WebKit 认：scroll-behavior 不脏布局，
     Blink 在 scrollTo 里拿到的还是旧 ComputedStyle（smooth），于是 Chrome 照样滑一段 —— 想要瞬移反而移不动，
     想要平滑也得显式说。这里两种诉求都走 behavior 参数，两端行为才对齐。
     CSS 那条 `@media (prefers-reduced-motion: reduce){html{scroll-behavior:auto}}` 管不到显式传参的调用，
     所以减弱动效要自己判（每次现查，测试也能改到）。 */
  function prefersReducedMotion() {
    try {
      return Boolean(window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches);
    } catch (e) { return false; }
  }

  function jumpTo(y, smooth) {
    var top = y || 0;
    var animate = Boolean(smooth) && !prefersReducedMotion();
    try {
      window.scrollTo({ top: top, left: 0, behavior: animate ? 'smooth' : 'instant' });
    } catch (e) {
      // 老浏览器不认 instant/smooth 枚举值：退回两参形式，并临时压住 CSS 的平滑（这条只有 WebKit 吃）。
      var root = document.documentElement;
      var prev = root.style.scrollBehavior;
      root.style.scrollBehavior = animate ? 'smooth' : 'auto';
      window.scrollTo(0, top);
      root.style.scrollBehavior = prev;
    }
  }

  /* —— 弹窗滚动锁 —— 桌面靠 CSS 的 overflow:hidden 就够；iOS 上挡不住触摸滚动，必须把 body 钉住（top 取滚动量负值）关时再瞬移回原位。 */
  var lockedY = 0;
  var scrollbarW = 0;
  // 滚动条宽度只能在"未锁定"时量：锁滚动会让它消失，此时读 clientWidth 会量到 0。
  function measureScrollbar() {
    var root = document.documentElement;
    // 弹窗打开时 :has(dialog[open]) 已收走滚动条，读 clientWidth 会量到 0；只用缓存，不许重测。
    if (root.classList.contains('modal-open') || document.querySelector('dialog[open]')) return scrollbarW;
    try {
      var w = Math.round((window.innerWidth || 0) - (root.clientWidth || 0));
      // 真实滚动条不超 40px；超出说明不可信（如尚未布局），保留上一个值
      if (w >= 0 && w <= 40) scrollbarW = w;
    } catch (e) { /* 忽略 */ }
    return scrollbarW;
  }
  measureScrollbar();
  window.addEventListener('resize', function () { measureScrollbar(); }, { passive: true });

  // 必须在 showModal 前量当前页，别沿用上一页或内容展开前的宽度。
  function prepareScrollLock() {
    var root = document.documentElement;
    if (root.classList.contains('modal-open')) return;
    var pad = measureScrollbar();
    lockedY = Math.round(window.scrollY || 0);
    root.style.setProperty('--modal-lock-y', -lockedY + 'px');
    root.style.setProperty('--modal-lock-pad', pad + 'px');
    root.classList.add('modal-open');
  }

  function syncScrollLock() {
    var root = document.documentElement;
    var open = Boolean(document.querySelector('dialog[open]'));
    var locked = root.classList.contains('modal-open');
    if (open && !locked) {
      prepareScrollLock();
    } else if (!open && locked) {
      root.classList.remove('modal-open');
      root.style.removeProperty('--modal-lock-y');
      root.style.removeProperty('--modal-lock-pad');
      jumpTo(lockedY);
    }
  }
  // 换页会销毁浮窗：先摘锁，否则滚动位置会被还原回旧值
  function releaseScrollLock() {
    var root = document.documentElement;
    if (!root.classList.contains('modal-open')) return;
    root.classList.remove('modal-open');
    root.style.removeProperty('--modal-lock-y');
    root.style.removeProperty('--modal-lock-pad');
  }
  window.__syncScrollLock = syncScrollLock;
  window.__prepareScrollLock = prepareScrollLock;
  window.__measureScrollbar = measureScrollbar;
  document.addEventListener('close', function () { syncScrollLock(); }, true);
  /* —— 持续把「当前这条历史记录滚到哪了」写回去 —— 自带的「后退/前进」不走 click 那条路：
     popstate 时 history.state 已是**目标**记录的 state，再没机会存"刚离开的位置"，于是后退再前进只会回到顶部。
     办法是滚动时就写，节流 500ms、值没变跳过（Safari 对 replaceState 有频率限制，更短会被拒）。 */
  var savedY = -1;
  var saveYTimer = 0;
  function flushScrollY() {
    saveYTimer = 0;
    // 换页中 location 已是新的、renderedPath 还是旧的，此刻写会把旧页位置记到新记录；等渲染完成、jumpTo 落位后再写。
    if (location.pathname + location.search !== renderedPath) return;
    var y = Math.round(window.scrollY || 0);
    if (y === savedY) return;
    savedY = y;
    try { history.replaceState(Object.assign({}, history.state, { blogIndex: index, scrollY: y }), ''); } catch (e) {  }
  }
  window.addEventListener('scroll', function () {
    if (saveYTimer) return;
    saveYTimer = setTimeout(flushScrollY, 500);
  }, { passive: true });

  function scrollToHash() {
    var h = location.hash;
    if (!h || h.length < 2) return false;
    var el = null;
    try { el = document.getElementById(decodeURIComponent(h.slice(1))); } catch (e) {  }
    if (!el) return false;

    if (typeof el.scrollIntoView === 'function') el.scrollIntoView({ block: 'start' });
    return true;
  }

  function eligible(a, ev) {
    if (!a || !a.href) return false;
    if (a.target || a.hasAttribute('download') || a.dataset.noPjax !== undefined) return false;
    if (a.getAttribute('rel') && /\bexternal\b/.test(a.getAttribute('rel'))) return false;
    if (ev && (ev.defaultPrevented || ev.button !== 0)) return false;
    if (ev && (ev.metaKey || ev.ctrlKey || ev.shiftKey || ev.altKey)) return false;

    var url;
    try { url = new URL(a.href, location.href); } catch (e) { return false; }
    if (url.origin !== location.origin) return false;

    if (url.pathname === location.pathname && url.search === location.search) return false;

    if (/^\/admin\/logout/.test(url.pathname) || /^\/moderate\//.test(url.pathname)) return false;
    if (url.pathname.startsWith('/admin') !== location.pathname.startsWith('/admin')) return false;

    if (/\.(css|js|mjs|map|json|xml|txt|csv|pdf|zip|tar|gz|png|jpe?g|gif|webp|avif|svg|ico|mp3|woff2?)$/i.test(url.pathname)) return false;
    return true;
  }

  var loadTimer = 0;
  function setLoading(on) {
    clearTimeout(loadTimer);
    var bar = document.getElementById('progress');
    if (!bar) return;
    if (on) loadTimer = setTimeout(function () { bar.classList.add('is-loading'); }, 150);
    else bar.classList.remove('is-loading');
  }

  function syncHead(doc) {
    ['meta[name="description"]', 'meta[name="robots"]', 'meta[property^="og:"]', 'meta[property^="article:"]', 'meta[name^="twitter:"]'].forEach(function (selector) {
      document.head.querySelectorAll(selector).forEach(function (el) { el.remove(); });
      doc.head.querySelectorAll(selector).forEach(function (el) { document.head.appendChild(el.cloneNode(true)); });
    });
    // 结构化数据也得跟着换页：WebSite 每页一样，但文章页的 BlogPosting / BreadcrumbList 不同；
    // 留在旧页会让爬虫（或分享面板）读到上一页的标题和日期。
    document.head.querySelectorAll('script[type="application/ld+json"]').forEach(function (el) { el.remove(); });
    doc.head.querySelectorAll('script[type="application/ld+json"]').forEach(function (el) {
      document.head.appendChild(el.cloneNode(true));
    });
    var cNew = doc.querySelector('link[rel="canonical"]');
    var cOld = document.querySelector('link[rel="canonical"]');
    if (cNew && cOld) cOld.setAttribute('href', cNew.getAttribute('href'));
  }

  /* —— pjax 换页后的样式表 ——
     页面按类型只发 lite / article / 全量三档；#app 换了但 <head> 不换，
     从首页点进笔记或文章时会缺评论区 / 笔记流规则。三档是包含关系（lite ⊂ article ⊂ full），
     所以只补不删：把目标页缺的 <link> 追加进来，等 onload 再换 DOM，既不闪裸表单，也不用回退全量。 */
  function stylesheetHrefs(root) {
    return Array.prototype.map.call(root.querySelectorAll('link[rel="stylesheet"][href]'), function (link) {
      return link.getAttribute('href');
    });
  }

  function styleLinkOf(absolute) {
    var links = document.head.querySelectorAll('link[rel="stylesheet"][href]');
    for (var i = 0; i < links.length; i++) {
      try { if (new URL(links[i].getAttribute('href'), location.href).href === absolute) return links[i]; } catch (e) { /* 坏地址忽略 */ }
    }
    return null;
  }

  function ensureStyles(doc) {
    var wanted = stylesheetHrefs(doc);
    if (!wanted.length) return null;
    var target = [];
    wanted.forEach(function (href) {
      try { target.push(new URL(href, location.href).href); } catch (e) { /* 坏地址忽略 */ }
    });
    if (!target.length) return null;
    var have = {};
    stylesheetHrefs(document).forEach(function (href) {
      try { have[new URL(href, location.href).href] = 1; } catch (e) { /* 坏地址忽略 */ }
    });
    var pending = [];
    target.forEach(function (absolute, index) {
      if (stylePending.has(absolute)) { pending.push(stylePending.get(absolute)); return; }
      if (have[absolute]) return;
      have[absolute] = 1;
      var loading = new Promise(function (resolve) {
        var link = document.createElement('link');
        var settle = function () { resolve(); };
        link.rel = 'stylesheet';
        link.href = absolute;
        link.setAttribute('data-pjax-css', '');
        link.addEventListener('load', settle);
        link.addEventListener('error', settle);
        // 按目标页的样式表顺序插入：主题 CSS 在变体之后加载时，变体不能甩到它后面去改变层叠。
        var anchor = null;
        for (var i = index + 1; i < target.length; i++) {
          anchor = styleLinkOf(target[i]);
          if (anchor) break;
        }
        if (anchor) document.head.insertBefore(link, anchor);
        else document.head.appendChild(link);
        // JSDOM 不加载样式表，onload 永远不会来：直接放行，别让测试每次换页多等 1.5 秒。
        if (!styleLoading) { settle(); return; }
        // 网络卡住时别把换页永远吊着：1.5s 后照常换，样式到了会自己生效。
        setTimeout(settle, 1500);
      });
      stylePending.set(absolute, loading);
      loading.then(function () { stylePending.delete(absolute); });
      pending.push(loading);
    });
    return pending.length ? Promise.all(pending) : null;
  }

  function noticeIn(doc) {
    var el = doc.querySelector('.a-notice, .c-flash');
    if (!el) return '';
    return String(el.textContent || '').replace(/\s+/g, ' ').trim().slice(0, 140);
  }

  function applyDoc(doc, url, opts) {
    opts = opts || {};
    var push = opts.push !== false;
    var next = doc.getElementById(APP_ID);
    if (!next) { location.href = url; return; }

    // 补样式是异步的：期间若又发生一次换页，这次就作废，别把旧内容盖到新页面上。
    var token = ++applySerial;
    var run = function () {
      if (token !== applySerial) return;

      document.title = doc.title || document.title;

      var dp = doc.body && doc.body.getAttribute('data-page');
      if (dp) document.body.setAttribute('data-page', dp);
      else document.body.removeAttribute('data-page');

      // 必须先收抽屉再换 body.className：set(false) 靠 isOpen() 读 class，若先被抹掉 mnav-open，set() 会早退，.skip/.to-top 的 inert 与 --mnav-pad 就永远留着。
      releaseScrollLock();
      if (window.__closeNavDrawer) window.__closeNavDrawer();
      document.body.className = doc.body.className;
      syncHead(doc);

      // 页头也在 #app 里，会被下面这句整块换掉；新节点一进 DOM 就会从头播「钤印落纸」（0.55s 内字标是隐形的）。
      // 先挂标记，让新节点的首次样式计算就落到「不播」那一条（见 style.css html.pjax-swapped），不闪这一下。
      document.documentElement.classList.add('pjax-swapped');


      container.innerHTML = next.innerHTML;

      if (push) {
        if (opts.replace) {
          history.replaceState({ pjax: 1, scrollY: Math.round(window.scrollY || 0), blogIndex: index }, '', url);
        } else {
          index++;
          history.pushState({ pjax: 1, scrollY: 0, blogIndex: index }, '', url);
        }
      }

      renderedPath = location.pathname + location.search;
      renderedUrl = location.href;
      index = Number(history.state && history.state.blogIndex) || 0;

      setLoading(false);

      // 先跑页面钩子再算滚动：笔记抽屉/评论锚点要在钩子里才展开，否则 scrollToHash 找不到目标；
      // 钩子也可能把焦点交给 ?reply= 的输入框，下面 focus main 时要检测并让位。
      (window.__pjaxHooks || []).forEach(function (fn) {
        try { fn(); } catch (e) { console.error('[nav] pjax 钩子出错：', e); }
      });

      if (push) {
        if (opts.keepScroll) {
          if (location.hash) scrollToHash();
        } else if (!scrollToHash()) {
          // 换页回顶部：两个内核都平滑滚过去（时长各家自己定，Chrome ~0.9s / WebKit ~0.2s）。
          jumpTo(0, true);
        }
      } else {
        jumpTo(opts.restoreY || 0);
      }

      // 换页后原链接节点已被替换，焦点会掉到 body；把它交给 <main>，键盘/读屏用户才不丢位置。
      // 表单原地回刷（keepScroll）不抢焦点，避免后台保存后把光标从编辑器里带走；
      // 钩子已经主动聚焦（如 ?reply= 输入框）时也不抢。
      if (!opts.keepScroll) {
        var active = document.activeElement;
        var hookFocused = active && active !== document.body && active !== document.documentElement;
        var main = document.getElementById('main');
        if (main && !hookFocused) { try { main.focus({ preventScroll: true }); } catch (e) { main.focus(); } }
      }

      measureScrollbar();
      syncScrollLock();

      if (opts.toast) toast(opts.toast, opts.toastKind);
    };

    // 不用 View Transition：它把新旧两页截图交叉溶解，会被看成"上下跳一下"。容器也不做淡入（连页头一起呼吸更晃眼），
    // 换页就是一次硬切；页头里唯一会重播的动效（字标落印）由上面那句 html.pjax-swapped 按掉。
    var css = ensureStyles(doc);
    if (css) css.then(run); else run();
  }

  /* —— 跟随服务端跳转：把最终地址当作真正的目标 —— */
  function finalUrlOf(res, fallback) {
    return res && res.redirected && res.url ? res.url : fallback;
  }

  function navigate(url, opts) {
    opts = opts || {};
    var requestId = ++serial;
    if (activeController) activeController.abort();
    activeController = new AbortController();
    var controller = activeController;
    setLoading(true);
    var cached = freshCached(url); cache.delete(url);
    var done = function (html, at) {
      if (requestId !== serial) return;
      var doc = new DOMParser().parseFromString(html, 'text/html');
      applyDoc(doc, at || url, {
        push: opts.push !== false,
        restoreY: opts.restoreY,
        replace: opts.replace,
        keepScroll: opts.keepScroll,
        toast: opts.toast,
        toastKind: opts.toastKind,
      });
    };
    if (cached) { done(cached.html, cached.url); return Promise.resolve(); }
    var timeout = setTimeout(function () { controller.abort(); }, 15000);
    return fetch(url, { headers: { 'X-Requested-With': 'pjax', Accept: 'text/html' }, credentials: 'same-origin', cache: 'no-cache', signal: controller.signal })
      .then(function (res) {
        if (requestId !== serial) return null;
        var at = finalUrlOf(res, url);
        if (!res.ok || (res.headers.get('content-type') || '').indexOf('text/html') === -1) { location.href = at; return null; }
        return res.text().then(function (html) { return { html: html, url: at }; });
      }).then(function (out) { if (out && requestId === serial) { done(out.html, out.url); } })
      .catch(function () { if (requestId === serial) location.href = url; })
      .finally(function () { clearTimeout(timeout); if (requestId === serial) { setLoading(false); activeController = null; } });
  }

  /* —— 表单：GET 当作换页，POST 走 fetch 并跟随 303 —— */
  function errorText(code) {
    return {
      csrf: '安全令牌已失效', unauthorized: '登录状态已失效', 'too-large': '内容过大',
      'missing-slug': '缺少目标',
    }[code] || String(code || '');
  }

  var pendingForms = new WeakSet();
  function submitForm(form, submitter) {
    if (pendingForms.has(form)) return Promise.resolve({ ok: false, busy: true });
    // 提交按钮的 formaction/formmethod 优先于 form 同名属性（HTML 规范）：后台「移除首页封面」「清除页面配置」靠它指向另一端点，只看 form.action 会变成"再保存一次"。
    var rawAction = (submitter && submitter.getAttribute && submitter.getAttribute('formaction'))
      || form.getAttribute('action') || location.href;
    var url;
    try { url = new URL(rawAction, location.href); } catch (e) { return Promise.resolve({ ok: false }); }
    if (url.origin !== location.origin) { form.submit(); return Promise.resolve({ ok: false }); }

    var rawMethod = (submitter && submitter.getAttribute && submitter.getAttribute('formmethod'))
      || form.getAttribute('method') || 'get';
    var method = String(rawMethod).toUpperCase();
    if (method !== 'POST') {
      url.search = new URLSearchParams(new FormData(form)).toString();
      navigate(url.href);
      return Promise.resolve({ ok: true });
    }

    var body;
    try { body = submitter ? new FormData(form, submitter) : new FormData(form); }
    catch (e) { body = new FormData(form); }
    if (submitter && submitter.name && !body.has(submitter.name)) body.append(submitter.name, submitter.value);
    pendingForms.add(form);
    try {
      Array.from(body.keys()).forEach(function (key) {
        body.getAll(key).forEach(function (value) {
          if (typeof File === 'function' && value instanceof File && !value.size) body.delete(key);
        });
      });
    } catch (e) { /* 忽略 */ }

    var requestId = ++serial;
    if (activeController) activeController.abort();
    activeController = new AbortController();
    var controller = activeController;
    setLoading(true);

    var btn = submitter || form.querySelector('[type="submit"]');
    var wasDisabled = Boolean(btn && btn.disabled);
    var wasLabel = btn ? btn.textContent : '';
    var releaseBusy = window.__ui && window.__ui.busy(form, btn);
    // 上传/发信表单可以自带更长超时；普通表单仍用 15 秒，别让一次慢请求永远吊着。
    var timeout = setTimeout(function () { controller.abort(); }, Number(form.dataset.timeout) || 15000);
    var savedText = submitter && submitter.dataset ? (submitter.dataset.saved || '') : '';
    if (!releaseBusy && btn && !wasDisabled) { btn.disabled = true; btn.textContent = form.dataset.pending || '提交中…'; }

    var settle = function () {
      clearTimeout(timeout);
      pendingForms.delete(form);
      if (releaseBusy) releaseBusy();
      else if (btn && !wasDisabled && btn.isConnected) { btn.disabled = false; if (wasLabel) btn.textContent = wasLabel; }
      if (requestId === serial) { setLoading(false); activeController = null; }
    };

    return fetch(url.href, {
      method: 'POST', body: body, credentials: 'same-origin', signal: controller.signal,
      headers: { 'X-Requested-With': 'pjax' },
    }).then(function (res) {
      if (requestId !== serial) return { ok: false, stale: true };
      var at = finalUrlOf(res, url.href);
      var type = res.headers.get('content-type') || '';
      // 5xx 不替换页面（服务端错误页会丢掉正在编辑的内容）；4xx 的 HTML 是后台刻意渲染的
      // 编辑器错误页（slug 冲突、版本冲突、字段校验），必须应用，否则具体提示永远看不到。
      if (!res.ok && res.status >= 500 && type.indexOf('text/html') !== -1) {
        toast('提交失败，输入已保留，请重试。', 'bad');
        form.dispatchEvent(new CustomEvent('ui:submit-failed', { bubbles: true }));
        return { ok: false, status: res.status };
      }
      if (type.indexOf('text/html') === -1) {
        return res.json().catch(function () { return {}; }).then(function (out) {
          var status = res.status || 0;
          if (status === 401) {
            toast('登录状态已失效，正在返回登录页…', 'bad');
            setTimeout(function () { location.href = '/admin/login'; }, 800);
          } else if (status === 403 && out.error === 'csrf') {
            toast('安全令牌已失效，正在重新载入页面…', 'bad');
            setTimeout(function () { location.reload(); }, 900);
          } else {
            // 别把所有 403 都当 CSRF 失效：/moderate 的 403 是 Origin 校验失败，一律 reload 会丢掉刚敲的回复。
            toast('提交失败：' + (errorText(out.error) || '请稍后重试'), 'bad');
          }
          form.dispatchEvent(new CustomEvent('ui:submit-failed', { bubbles: true }));
          return { ok: false, status: status, error: out.error };
        });
      }
      return res.text().then(function (html) {
        var doc = new DOMParser().parseFromString(html, 'text/html');
        var samePath = false;
        try { samePath = new URL(at, location.href).pathname === location.pathname; } catch (e) { /* 保持 false */ }
        applyDoc(doc, at, { push: true, replace: samePath, keepScroll: samePath, toast: noticeIn(doc) || savedText });
        cache.clear();
        return { ok: res.ok, status: res.status, url: at };
      });
    }).catch(function (err) {
      if (requestId !== serial) return { ok: false, stale: true };
      // 网络中断时不能自动重放写操作：服务端可能已提交成功。
      toast(err && err.name === 'AbortError' ? '提交超时，输入已保留。请检查结果后再重试。' : '连接中断，输入已保留。请检查结果后再重试。', 'bad');
      form.dispatchEvent(new CustomEvent('ui:submit-failed', { bubbles: true }));
      return { ok: false };
    }).finally(settle);
  }

  // 页面自己改了地址（如编辑器自动保存拿到 id 后 replaceState）时通知这里更新"已渲染"基准，否则 Back/Forward 会重取。
  function syncUrl(url) {
    renderedPath = location.pathname + location.search;
    renderedUrl = url ? new URL(url, location.href).href : location.href;
  }
  function invalidate(url) {
    if (url) cache.delete(url);
    else cache.clear();
    // 只清已完成的缓存不够：在飞的预取请求完成后还会写回 cache，评论刚发布就可能命中旧 HTML。
    for (const [pendingUrl, controller] of prefetched) {
      if (url && pendingUrl !== url) continue;
      controller.abort();
      prefetched.delete(pendingUrl);
    }
  }

  window.__nav = { navigate: navigate, cache: cache, eligible: eligible, submitForm: submitForm, toast: toast, invalidate: invalidate, syncUrl: syncUrl };

  try {
    // bundle 模式下没有单独的 nav.js 标签：构建指纹挂在通用 data-site-build 上，回退模式则由 nav.js 自带。
    var tag = document.querySelector('script[data-site-build]') || document.querySelector('script[src*="nav.js"]');
    window.__navBuild = tag
      ? (tag.getAttribute('data-site-build') || new URL(tag.getAttribute('src'), location.href).searchParams.get('v') || '')
      : '';
  } catch (e) { window.__navBuild = ''; }

  var navigationIntent = 0;
  document.addEventListener('click', async function (ev) {
    var a = ev.target && ev.target.closest ? ev.target.closest('a') : null;
    if (!eligible(a, ev)) return;
    var url = new URL(a.href, location.href).href;

    ev.preventDefault();
    var intent = ++navigationIntent;
    if (typeof window.__beforeNavigate === 'function') {
      try { if (await window.__beforeNavigate(url) === false || intent !== navigationIntent) return; }
      catch (e) { return; }
    }

    try { history.replaceState(Object.assign({}, history.state, { blogIndex: index, scrollY: Math.round(window.scrollY) }), ''); } catch (e) {}
    navigate(url);
  }, false);

  // 表单提交：挂在冒泡末端，让各页自己的处理器先 preventDefault；放行的才交给无刷新提交。
  window.addEventListener('submit', function (ev) {
    if (ev.defaultPrevented) return;
    var form = ev.target;
    if (!form || String(form.tagName).toUpperCase() !== 'FORM') return;
    if (form.getAttribute('method') === 'dialog') return;
    if (form.dataset && form.dataset.noPjax !== undefined) return;
    var action = form.getAttribute('action') || location.href;
    var path;
    try { path = new URL(action, location.href).pathname; } catch (e) { return; }
    if (/^\/admin\/logout/.test(path)) return;
    ev.preventDefault();
    submitForm(form, ev.submitter || null);
  }, false);

  window.addEventListener('popstate', async function (ev) {
    if (restoring) { restoring = false; return; }
    if (location.pathname + location.search === renderedPath) { renderedUrl = location.href; return; }
    var targetIndex = Number(ev.state && ev.state.blogIndex);
    var targetUrl = location.href;
    var intent = ++navigationIntent;
    var allowed = true;
    try { if (typeof window.__beforeNavigate === 'function') allowed = await window.__beforeNavigate(targetUrl); }
    catch (e) { allowed = false; }
    if (intent !== navigationIntent) return;
    if (allowed === false) {
      if (Number.isFinite(targetIndex) && targetIndex !== index) { restoring = true; history.go(index - targetIndex); }
      else history.replaceState(Object.assign({}, history.state, { blogIndex: index }), '', renderedUrl);
      return;
    }
    var y = ev.state && ev.state.scrollY ? ev.state.scrollY : 0;
    navigate(targetUrl, { push: false, restoreY: y });
  }, false);

  function prefetch(a) {
    if (!eligible(a, null)) return;
    // 省流量模式/极慢网络下不做预取：整页 HTML 对用户没有可见收益。
    var conn = navigator.connection;
    if (conn && (conn.saveData || /(^|-)2g$/.test(conn.effectiveType || ''))) return;
    var url = new URL(a.href, location.href).href;
    if (new URL(url).pathname.startsWith('/admin') || freshCached(url) || prefetched.has(url) || prefetched.size >= 3) return;
    var controller = new AbortController();
    var timer = setTimeout(function () { controller.abort(); }, 10000);
    prefetched.set(url, controller);
    fetch(url, { headers: { 'X-Requested-With': 'pjax', Accept: 'text/html' }, credentials: 'same-origin', cache: 'no-cache', signal: controller.signal })
      .then(function (res) {
        if (!res.ok || (res.headers.get('content-type') || '').indexOf('text/html') === -1) return null;
        var at = finalUrlOf(res, url);
        return res.text().then(function (html) {
          // 悬停预取时顺手把目标页的样式表也拉起来：三档是包含关系，提前套到当前页不会改变外观。
          try { ensureStyles(new DOMParser().parseFromString(html, 'text/html')); } catch (e) { /* 预取失败不打扰 */ }
          return { html: html, url: at, fetchedAt: Date.now() };
        });
      })
      .then(function (item) { if (!item) return; if (cache.size >= CACHE_MAX) cache.delete(cache.keys().next().value); cache.set(url, item); })
      .catch(function () {}).finally(function () { clearTimeout(timer); prefetched.delete(url); });
  }
  window.addEventListener('pagehide', function () { if (activeController) activeController.abort(); prefetched.forEach(function (controller) { controller.abort(); }); });

  document.addEventListener('mouseover', function (ev) {
    var a = ev.target && ev.target.closest ? ev.target.closest('a') : null;
    if (a) prefetch(a);
  }, { passive: true });
  // 触摸按下不等于导航意图：手指常只是准备滚动。延迟一小段，touchmove/scroll 时取消；
  // 以前一碰链接就预取整页，长列表上滚一圈会发出很多无谓请求。
  var touchPrefetchTimer = 0;
  var cancelTouchPrefetch = function () { clearTimeout(touchPrefetchTimer); touchPrefetchTimer = 0; };
  document.addEventListener('touchstart', function (ev) {
    var a = ev.target && ev.target.closest ? ev.target.closest('a') : null;
    cancelTouchPrefetch();
    if (a) touchPrefetchTimer = setTimeout(function () { prefetch(a); }, 120);
  }, { passive: true });
  document.addEventListener('touchmove', cancelTouchPrefetch, { passive: true });
  document.addEventListener('scroll', cancelTouchPrefetch, { passive: true });

  try { history.replaceState(Object.assign({}, history.state, { blogIndex: index, scrollY: Math.round(window.scrollY) }), ''); } catch (e) {}
})();

/* —— 页头浮层（「页面」二级菜单 / 「配色」面板）—— 都走 <details> 原生那套；这里补：悬停即开（仅真鼠标）、
   点面板外关掉、Esc 关掉并把焦点还给触发器。都挂 document 走委托，PJAX 换页后仍有效。
   用 pointerover/pointerout 而非 mouseover/mouseout：触摸屏 tap 会补发一套兼容 mouse 事件 —— mouseover 先打开、
   紧接着的 click 又 toggle，表现成「第一下点不开、第二下才行」；用 pointerType 只认鼠标就断了这条因果。
   再判 relatedTarget 是否仍在同一组内：从触发器滑到面板要过一段空隙，不判就会"滑到一半先关再重开"。
   跨空隙时有些浏览器把 relatedTarget 报成 null，所以再加一段 400ms 的宽限：指针只要回到这一组就取消关闭。 */
(function () {
  var OPEN = '.nsub[open], .pal[open]';
  var CLOSE_DELAY = 400;

  function groupOf(node) {
    if (!node || !node.closest) return null;
    var d = node.closest('.nsub, .pal');
    // 首页 hero-meta 只有一枚配色入口，走点击（鼠标扫过封面信息行就弹面板太吵），不参与桌面悬停。
    return d && !d.classList.contains('pal-hero') ? d : null;
  }
  function cancelClose(d) {
    if (!d.__closeTimer) return;
    clearTimeout(d.__closeTimer);
    d.__closeTimer = 0;
  }

  document.addEventListener('pointerover', function (ev) {
    if (ev.pointerType !== 'mouse') return;
    var d = groupOf(ev.target);
    if (!d) return;
    cancelClose(d);
    // 同一时刻只留一组浮层：从「页面」滑到「配色」时，旧的立即收起。
    document.querySelectorAll(OPEN).forEach(function (node) {
      if (node !== d) node.removeAttribute('open');
    });
    if (!d.open) d.__hoverOpened = true;
    d.setAttribute('open', '');
  });
  document.addEventListener('pointerout', function (ev) {
    if (ev.pointerType !== 'mouse') return;
    var d = groupOf(ev.target);
    if (!d || d.contains(ev.relatedTarget)) return;
    cancelClose(d);
    d.__closeTimer = setTimeout(function () {
      d.__closeTimer = 0;
      if (!d.isConnected) return;
      // 指针可能已经回到触发器/面板（跨空隙）—— 还在这一组里就不该收。
      if (d.matches(':hover')) return;
      d.__hoverOpened = false;
      d.removeAttribute('open');
    }, CLOSE_DELAY);
  });
  // 键盘/点击明确打开时，取消一次悬停离开留下的尾随关闭。
  document.addEventListener('toggle', function (ev) {
    var d = ev.target;
    if (!d || !d.matches || !d.matches('.nsub, .pal')) return;
    if (d.open) cancelClose(d);
    else d.__hoverOpened = false;
  }, true);
  // 悬停已经打开的浮层，鼠标再点触发器时别让原生 details 把它 toggle 关掉；
  // 第二次点击（或键盘 Enter）仍走原生开合。
  document.addEventListener('click', function (ev) {
    var t = ev.target;
    var summary = t && t.closest ? t.closest('.nsub > summary, .pal > summary') : null;
    if (!summary) return;
    var d = summary.closest('.nsub, .pal');
    if (!d) return;
    cancelClose(d);
    if (!d.__hoverOpened || ev.detail === 0) return;
    ev.preventDefault();
    d.__hoverOpened = false;
  });
  document.addEventListener('click', function (ev) {
    var t = ev.target;
    var panel = t && t.closest ? t.closest('.nsub-panel') : null;
    if (panel) { var d = panel.closest('.nsub'); if (d) { cancelClose(d); d.removeAttribute('open'); } return; }
    document.querySelectorAll('.nsub[open]').forEach(function (node) {
      if (!node.contains(t)) { cancelClose(node); node.removeAttribute('open'); }
    });
  });
  document.addEventListener('keydown', function (ev) {
    if (ev.key !== 'Escape') return;
    var open = document.querySelector('.nsub[open]');
    if (!open) return;
    var inside = open.contains(document.activeElement);
    cancelClose(open);
    open.removeAttribute('open');
    if (inside) { var s = open.querySelector('summary'); if (s) s.focus({ preventScroll: true }); }
  });
})();

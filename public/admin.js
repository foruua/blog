(() => {
  'use strict';

  const request = window.__request;
  const $ = (id) => document.getElementById(id);

  let ed = null;
  let editorAssets = null;

  // 编辑器脚本只在编辑器页首屏输出；pjax 从别的后台页切进编辑器时在这里补载。
  // 顺序加载（先 admin-editor 再 editor），加载完由 setupPage() 重跑一次初始化。
  function loadEditorAssets() {
    if (window.__setupAdminEditor) return Promise.resolve();
    const body = document.body;
    const sources = [body?.dataset.adminEditorSrc, body?.dataset.editorSrc].filter(Boolean);
    if (!sources.length) return Promise.reject(new Error('missing editor asset urls'));
    if (!editorAssets) {
      editorAssets = (async () => {
        for (const src of sources) {
          await new Promise((resolve, reject) => {
            const script = document.createElement('script');
            script.src = src;
            script.onload = resolve;
            script.onerror = () => reject(new Error(`load failed: ${src}`));
            document.head.append(script);
          });
        }
      })();
    }
    return editorAssets.catch((error) => { editorAssets = null; throw error; });
  }

  const feedSnapshots = new WeakMap();
  const feedValue = (form) => JSON.stringify([...new FormData(form)]);
  const editedFeed = () => {
    const dialog = document.querySelector('.a-feed-editor[open]');
    return dialog && feedSnapshots.get(dialog) !== feedValue(dialog.querySelector('form'));
  };
  async function closeFeed(dialog) {
    const form = dialog.querySelector('form');
    if (form.getAttribute('aria-busy') === 'true') return;
    if (feedSnapshots.get(dialog) !== feedValue(form)) {
      const allowed = await window.__ui?.confirm({ title: '关闭订阅源编辑？', body: '改动尚未保存，关闭后将恢复原来的设置。', ok: '放弃改动' });
      if (!allowed || !dialog.isConnected) return;
    }
    form.reset(); dialog.close();
  }
  document.addEventListener('click', (e) => {
    const trigger = e.target.closest?.('[data-feed-open]');
    if (trigger) {
      const dialog = $(trigger.dataset.feedOpen);
      if (!dialog) return;
      feedSnapshots.set(dialog, feedValue(dialog.querySelector('form')));
      window.__openDialog(dialog);
    }
    const close = e.target.closest?.('[data-feed-close]');
    if (close) {
      const dialog = close.closest('dialog');
      if (dialog) void closeFeed(dialog);
    }
  });
  document.addEventListener('cancel', (e) => {
    if (!e.target.matches('.a-feed-editor')) return;
    e.preventDefault(); void closeFeed(e.target);
  }, true);

  document.addEventListener('click', async (e) => {
    const btn = e.target.closest && e.target.closest('[data-copy]');
    if (!btn) return;
    const text = btn.dataset.copy;
    const iconOnly = Boolean(btn.querySelector('svg'));
    // 原始文案只在第一次点击时记进 dataset：以前每次点击都抓当前 innerHTML，1400ms 内连点第二次抓到的已是「已复制」，就会永久卡在它上面。
    if (btn.dataset.copyLabel === undefined) btn.dataset.copyLabel = btn.innerHTML;
    clearTimeout(Number(btn.dataset.copyTimer) || 0);
    // 复制与降级路径统一在 ui.js：后台不再自带一份 execCommand 兜底。
    const ok = await window.__copyText?.(text);
    if (!ok) { await window.__ui?.confirm({ title: '复制文本', body: '点击复制，或选中文本后使用系统复制操作。', value: text }); return; }
    if (iconOnly) window.__toast?.('路径已复制'); else btn.textContent = '已复制';
    btn.dataset.copyTimer = String(setTimeout(() => { btn.innerHTML = btn.dataset.copyLabel; }, 1400));
  });

  let mediaLightbox = null;
  document.addEventListener('click', (e) => {
    const link = e.target.closest?.('[data-media-original]');
    if (!link || e.button !== 0 || e.metaKey || e.ctrlKey || e.shiftKey || e.altKey) return;
    e.preventDefault(); e.stopPropagation();
    if (!mediaLightbox) {
      mediaLightbox = document.createElement('dialog');
      mediaLightbox.className = 'lightbox a-media-lightbox';
      mediaLightbox.setAttribute('aria-label', '查看完整原图');
      mediaLightbox.innerHTML = '<button type="button" class="lb-close" aria-label="关闭原图"><svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" aria-hidden="true"><path d="M4.4 4.4 11.6 11.6M11.6 4.4 4.4 11.6"/></svg></button><img class="lb-img" alt="">';
      document.body.append(mediaLightbox);
      const img = mediaLightbox.querySelector('img');
      mediaLightbox.addEventListener('click', (ev) => {
        if (ev.target === mediaLightbox || ev.target.closest('.lb-close')) mediaLightbox.close();
      });
      mediaLightbox.addEventListener('close', () => { img.removeAttribute('src'); window.__syncScrollLock?.(); });
    }
    const img = mediaLightbox.querySelector('img');
    // __ui.open() 已 sync 过滚动锁；缺 ui.js 的原生兜底才补一次。
    window.__openDialog(mediaLightbox);
    if (window.__ui) window.__ui.loadImage(mediaLightbox, link.href, link.querySelector('img')?.alt || '完整原图');
    else img.src = link.href;
  }, true);

  let mediaRequest = null;
  const cancelMediaRequest = () => {
    if (!mediaRequest) return;
    clearTimeout(mediaRequest.timer); mediaRequest.controller.abort(); mediaRequest = null;
  };
  async function loadMediaDetails(dlg, href) {
    cancelMediaRequest();
    const body = dlg.querySelector('.a-media-dialog-body');
    body.replaceChildren();
    const loading = document.createElement('p'); loading.className = 'a-dim'; loading.setAttribute('role', 'status'); loading.textContent = '正在读取引用详情…'; body.append(loading);
    const pending = { controller: new AbortController(), timer: null };
    pending.timer = setTimeout(() => pending.controller.abort(), 15000);
    mediaRequest = pending;
    try {
      const url = new URL(href, location.href); url.searchParams.set('partial', 'details');
      const response = await fetch(url, { credentials: 'same-origin', cache: 'no-store', signal: pending.controller.signal });
      if (!response.ok || response.redirected) throw new Error('读取失败');
      const html = await response.text();
      if (mediaRequest !== pending || !dlg.isConnected || !dlg.open) return;
      // 只接受本站转义的详情片段，登录失效时不把登录页塞进弹窗。
      const fragment = document.createElement('template'); fragment.innerHTML = html;
      if (!fragment.content.querySelector('.a-media-detail')) throw new Error('读取失败');
      body.replaceChildren(fragment.content.cloneNode(true));
    } catch {
      if (mediaRequest !== pending || !dlg.isConnected || !dlg.open) return;
      body.replaceChildren();
      const message = document.createElement('p'); message.className = 'a-dim'; message.setAttribute('role', 'alert'); message.textContent = '引用详情读取失败，请重试；登录过期时请刷新页面。';
      const retry = document.createElement('button'); retry.type = 'button'; retry.className = 'a-btn-ghost'; retry.textContent = '重试'; retry.addEventListener('click', () => loadMediaDetails(dlg, href)); body.append(message, retry);
    } finally {
      clearTimeout(pending.timer);
      if (mediaRequest === pending) mediaRequest = null;
    }
  }
  document.addEventListener('click', (e) => {
    const dlg = $('a-media-dialog');
    if (!dlg) return;
    const link = e.target.closest?.('[data-media-details]');
    if (link && !e.metaKey && !e.ctrlKey && !e.shiftKey && !e.altKey && e.button === 0 && typeof dlg.showModal === 'function') {
      e.preventDefault(); e.stopPropagation();
      window.__openDialog(dlg);
      void loadMediaDetails(dlg, link.href);
      return;
    }
    if (e.target.closest?.('[data-media-close]')) dlg.close();
    if (e.target === dlg) {
      const box = dlg.getBoundingClientRect();
      if (e.clientX < box.left || e.clientX > box.right || e.clientY < box.top || e.clientY > box.bottom) dlg.close();
    }
  }, true);
  document.addEventListener('close', (e) => { if (e.target.id === 'a-media-dialog') cancelMediaRequest(); }, true);

  // 评论行内展开回复框。靠"链接所在行的下一行"定位而非 id（两张表同一条评论会撞车）。链接自带 href，禁 JS 时仍能跳到回复页。
  const replyRowOf = (el) => {
    const row = el.closest('tr')?.nextElementSibling;
    return row && row.classList.contains('a-reply-row') ? row : null;
  };
  function setReplyRow(row, link, open) {
    if (!row) return;
    row.hidden = !open;
    if (link) link.setAttribute('aria-expanded', String(open));
    // 收起时整行（含刚聚焦的 textarea）被隐藏；把焦点还给触发链接，键盘用户不会掉回 body。
    if (open) row.querySelector('textarea')?.focus();
    else link?.focus({ preventScroll: true });
  }

  document.addEventListener('click', (e) => {
    const toggle = e.target.closest && e.target.closest('[data-reply-toggle]');
    if (toggle) {
      e.preventDefault();
      const row = replyRowOf(toggle);
      setReplyRow(row, toggle, Boolean(row?.hidden));
      return;
    }
    const cancel = e.target.closest && e.target.closest('[data-reply-cancel]');
    if (cancel) {
      e.preventDefault();
      const row = cancel.closest('tr');
      setReplyRow(row, row?.previousElementSibling?.querySelector('[data-reply-toggle]') ?? null, false);
    }
  });

  document.addEventListener('keydown', (e) => {
    if (e.key !== 'Escape') return;
    const form = e.target.closest && e.target.closest('.a-reply-form');
    if (!form) return;
    const row = form.closest('tr');
    setReplyRow(row, row?.previousElementSibling?.querySelector('[data-reply-toggle]') ?? null, false);
  });

  function setupPage() {
    ed?.dispose();
    ed = null;
    // 后台 pjax 只换 #app，不重载 <script>；进入编辑器页时若脚本还没到，先补载再初始化。
    if (document.getElementById('editorForm') && !window.__setupAdminEditor) {
      // 首屏编辑器页自己带了 defer 脚本，它们会在 admin.js 之后才执行：等 load 再初始化，
      // 不要在这里动态插一份造成重复执行。
      if (document.body.dataset.editorInline === '1') {
        window.addEventListener('load', () => {
          if (document.getElementById('editorForm') && window.__setupAdminEditor) setupPage();
        }, { once: true });
        return;
      }
      void loadEditorAssets()
        .then(() => { if (document.getElementById('editorForm')) setupPage(); })
        .catch(() => { /* 加载失败时保持普通页面，不阻断其它后台功能 */ });
      return;
    }
    ed = window.__setupAdminEditor ? window.__setupAdminEditor() : null;
  }

  // 主题设置的颜色项是「文本框 + 原生取色器」两个控件：任一边改动都要同步另一边，
  // 否则取色器选完色，提交的还是文本框里的旧值。
  function setupThemeColors() {
    for (const swatch of document.querySelectorAll('[data-color-for]')) {
      const target = document.getElementById(swatch.dataset.colorFor);
      if (!target || swatch.dataset.bound) continue;
      swatch.dataset.bound = '1';
      swatch.addEventListener('input', () => { target.value = swatch.value; });
      target.addEventListener('input', () => {
        if (/^#[0-9a-f]{6}$/i.test(target.value)) swatch.value = target.value;
      });
    }
  }

  // 主题设置的 image 项：文本框 + 「媒体库」按钮，共用页面底部那个 dialog。
  // onPick 是创建时固定的闭包，用 target 记住这次是哪个字段点的。
  let themeImagePicker = null;
  let heroPicker = null;
  function applyThemeImage(btn, value) {
    const id = btn.dataset.themeImage ?? btn.dataset.themeImageClear;
    const input = id ? document.getElementById(id) : null;
    if (!input) return;
    input.value = value;
    const preview = document.querySelector(`[data-image-preview="${id}"]`);
    if (!preview) return;
    const img = preview.querySelector('img');
    preview.hidden = !value;
    if (img) { if (value) img.src = value; else img.removeAttribute('src'); }
  }

  function setupThemeImages() {
    themeImagePicker?.dispose();
    themeImagePicker = null;
    const dialog = document.getElementById('a-picker');
    const body = document.getElementById('a-picker-body');
    const buttons = document.querySelectorAll('[data-theme-image]');
    if (!dialog || !body || !buttons.length) return;
    let target = null;

    if (!dialog.dataset.themeImageBound) {
      dialog.dataset.themeImageBound = '1';
      themeImagePicker = window.__setupMediaPicker?.({
        dialog,
        body,
        uploadButton: document.getElementById('a-picker-upload'),
        // 主题页没有上传用的 file input：去媒体页传，传完回来再选，别让按钮点了没反应。
        onUpload: () => window.open('/admin/media', '_blank', 'noopener'),
        onPick: (it) => {
          if (!target) return;
          applyThemeImage(target, it.path);
          target.focus();
        },
      });
    }

    for (const btn of buttons) {
      if (btn.dataset.bound) continue;
      btn.dataset.bound = '1';
      btn.addEventListener('click', (e) => {
        e.preventDefault();   // 别让外层 label 把焦点抢回文本框
        target = btn;
        themeImagePicker?.open();
      });
    }
    for (const clear of document.querySelectorAll('[data-theme-image-clear]')) {
      if (clear.dataset.bound) continue;
      clear.dataset.bound = '1';
      clear.addEventListener('click', (e) => {
        e.preventDefault();
        applyThemeImage(clear, '');
      });
    }
  }

  function setupThemeUpload() {
    const picker = document.querySelector('[data-theme-picker]');
    if (!picker) return;
    const input = picker.querySelector('[data-theme-picker-input]');
    if (!input) return;
    const name = picker.querySelector('[data-theme-picker-name]');
    const meta = picker.querySelector('[data-theme-picker-meta]');
    const submit = picker.closest('form')?.querySelector('button[type="submit"]');
    const defaultName = name?.textContent ?? '';
    const defaultMeta = meta?.textContent ?? '';
    const formatSize = (bytes) => bytes >= 1024 * 1024
      ? `${(bytes / 1024 / 1024).toFixed(1)} MB`
      : `${Math.max(1, Math.round(bytes / 1024))} KB`;
    const sync = () => {
      const file = input.files?.[0];
      if (!file) {
        if (name) name.textContent = defaultName;
        if (meta) meta.textContent = defaultMeta;
        picker.classList.remove('has-file');
        if (submit) submit.disabled = true;
        return;
      }
      if (name) name.textContent = file.name;
      if (meta) meta.textContent = `${formatSize(file.size)} · 已选择`;
      picker.classList.add('has-file');
      if (submit) submit.disabled = false;
    };
    input.addEventListener('change', sync);
    sync();
    for (const type of ['dragenter', 'dragover']) {
      picker.addEventListener(type, (e) => { e.preventDefault(); picker.classList.add('is-drag'); });
    }
    for (const type of ['dragleave', 'drop']) {
      picker.addEventListener(type, (e) => { e.preventDefault(); picker.classList.remove('is-drag'); });
    }
    picker.addEventListener('drop', (e) => {
      if (!e.dataTransfer?.files?.length) return;
      input.files = e.dataTransfer.files;
      sync();
    });
  }

  function setupMailForm() {
    const preset = document.querySelector('[data-mail-preset]');
    if (!preset) return;
    const host = document.getElementById('m-host');
    const port = document.getElementById('m-port');
    const tls = document.getElementById('m-tls');

    preset.addEventListener('change', () => {
      const o = preset.selectedOptions[0];
      const h = o?.dataset.host ?? '';
      if (h && host) host.value = h;
      if (o?.dataset.port && port) port.value = o.dataset.port;
      if (o?.dataset.tls && tls) tls.value = o.dataset.tls;

    });

    host?.addEventListener('input', () => {
      const v = host.value.trim();
      const hit = [...preset.options].find((o) => o.dataset.host && o.dataset.host === v);
      preset.value = hit ? hit.value : 'custom';
    });
  }

  function setupHeroForm() {
    heroPicker?.dispose();
    heroPicker = null;
    const form = $('heroForm');
    if (!form) return;
    const file = $('heroFile');
    const videoFile = $('heroVideoFile');
    const input = $('heroImages');
    const list = $('heroList');
    const x = $('heroX');
    const state = $('heroState');
    // 图片选择器仍只收图片：也挡住把 .mp4 改名成 .png 混进来的情况。视频走独立的转码接口。
    const NON_IMAGE_RE = /\.(?:mp4|webm|mov|m4v)(?:$|[?#])/i;
    const VIDEO_RE = NON_IMAGE_RE;
    const MAX = 8;
    let items = [];
    try { items = JSON.parse(input.value).filter((it) => it && it.path); } catch { items = []; }
    let thumbs = {};
    try { thumbs = JSON.parse(input.dataset.thumbs || '{}'); } catch { thumbs = {}; }

    let dragged = null;         // 正在拖的格子
    let suppressClick = false;  // 拖完紧接着的那次 click 要吞掉，别误触移除叉
    // 一枚缩略格：原比例图 + 拖拽柄·序号·封面 + 移除叉。「封面」= 第一位。标记要与 views/system.js 首屏那份一致。
    // 封面比例固定 16:9，与前台同一套。
    const tile = (it, i) => {
      const fig = document.createElement('figure');
      fig.className = 'a-hero-item';
      fig.draggable = true;
      fig.dataset.path = it.path;
      fig.title = '拖动排序';

      const shot = document.createElement('img');
      shot.className = 'a-hero-shot';
      shot.decoding = 'async';
      shot.alt = '';
      shot.src = thumbs[it.path] || it.path;
      shot.draggable = false;   // 让拖拽从整个格子开始
      // 宽高写死，不写图片加载完会把下面的表单顶动（CLS）
      if (/^\d+$/.test(String(it.w)) && /^\d+$/.test(String(it.h))) {
        shot.width = Number(it.w);
        shot.height = Number(it.h);
      }

      const cap = document.createElement('figcaption');
      cap.className = 'a-hero-cap';
      const grip = document.createElement('span');
      grip.className = 'a-hero-grip';
      grip.setAttribute('aria-hidden', 'true');
      const idx = document.createElement('span');
      idx.className = 'a-hero-idx';
      idx.textContent = String(i + 1).padStart(2, '0');
      cap.append(grip, idx);
      if (i === 0) {
        const em = document.createElement('em');
        em.textContent = '封面';
        cap.append(em);
      }

      // 键盘也能调整顺序：拖拽之外给每格两个显式按钮。
      const moves = document.createElement('span');
      moves.className = 'a-hero-move';
      for (const [dir, label, text] of [[-1, '上移', '↑'], [1, '下移', '↓']]) {
        const nudge = document.createElement('button');
        nudge.type = 'button';
        nudge.className = 'a-hero-nudge';
        nudge.dataset.heroMove = String(dir);
        nudge.disabled = dir < 0 ? i === 0 : i === items.length - 1;
        nudge.setAttribute('aria-label', `${label}第 ${i + 1} 项`);
        nudge.textContent = text;
        moves.append(nudge);
      }
      cap.append(moves);

      const btn = document.createElement('button');
      btn.type = 'button';
      btn.className = 'a-hero-x';
      btn.dataset.heroRemove = it.path;
      btn.title = `从列表移除第 ${i + 1} 项`;
      btn.setAttribute('aria-label', `从列表移除第 ${i + 1} 项`);
      btn.textContent = '×';
      fig.append(shot, cap, btn);
      if (VIDEO_RE.test(it.path)) {
        const kind = document.createElement('span');
        kind.className = 'a-hero-kind';
        kind.textContent = '视频';
        fig.append(kind);
      }
      return fig;
    };

    // 末尾「添加」格：空列表铺满一行；到上限就没有（跟服务端同一套）
    const addTile = (id, label) => {
      const btn = document.createElement('button');
      btn.type = 'button';
      btn.className = 'a-hero-add';
      btn.id = id;
      if (!items.length) btn.dataset.wide = '1';
      const plus = document.createElement('span');
      plus.className = 'a-hero-add-plus';
      plus.setAttribute('aria-hidden', 'true');
      plus.textContent = '＋';
      const txt = document.createElement('span');
      txt.className = 'a-hero-add-txt';
      txt.textContent = label;
      btn.append(plus, txt);
      return btn;
    };
    const addTiles = () => (items.length >= MAX
      ? []
      : [addTile('heroPick', '添加图片'), addTile('heroPickVideo', '添加视频')]);

    const render = () => {
      input.value = JSON.stringify(items);
      list.style.setProperty('--hero-ar', '16 / 9');
      list.replaceChildren(...items.map(tile), ...addTiles());
      list.classList.toggle('is-empty', !items.length);
      x.hidden = !items.length;
    };

    // 媒体库选择器（与编辑器同一份实现）：选中的图片加进封面列表，点保存才生效。
    heroPicker = window.__setupMediaPicker?.({
      dialog: $('a-picker'),
      body: $('a-picker-body'),
      uploadButton: $('a-picker-upload'),
      fileInput: file,
      onPick: (it) => {
        if (NON_IMAGE_RE.test(it.path)) { state.textContent = '首页封面只能用图片'; return; }
        if (items.length >= MAX) { state.textContent = `最多 ${MAX} 项，先移掉几项再选`; return; }
        if (items.some((x) => x.path === it.path)) { state.textContent = '这个已经在列表里了'; return; }
        items.push({ path: it.path, w: String(it.width ?? ''), h: String(it.height ?? '') });
        thumbs[it.path] = it.thumbnail || '';
        render();
        // 重画会换掉「添加」格；把焦点交回新的添加入口（到上限时交给最后一项的移除按钮），别让键盘用户掉回 body。
        (list.querySelector('#heroPick') ?? [...list.querySelectorAll('[data-hero-remove]')].at(-1))?.focus();
        state.textContent = '已从媒体库添加（还没保存）';
      },
    });

    // 缩略格与「添加」格每次重画，监听挂容器上（委托），别挂节点上
    list.addEventListener('click', (e) => {
      if (suppressClick) return;
      if (e.target.closest?.('#heroPickVideo')) {
        videoFile?.click();
        return;
      }
      if (e.target.closest?.('#heroPick')) {
        if (heroPicker) heroPicker.open();
        else file?.click();
        return;
      }
      const nudge = e.target.closest?.('[data-hero-move]');
      if (nudge) {
        const fig = nudge.closest('.a-hero-item');
        const from = items.findIndex((it) => it.path === fig?.dataset.path);
        const to = from + Number(nudge.dataset.heroMove);
        if (from < 0 || to < 0 || to >= items.length) return;
        [items[from], items[to]] = [items[to], items[from]];
        render();
        // 重画后把焦点交给移动后的同一方向按钮（到端点时交给另一枚），键盘操作可连续。
        const moved = list.querySelectorAll('.a-hero-item')[to];
        (moved?.querySelector(`[data-hero-move="${nudge.dataset.heroMove}"]:not(:disabled)`)
          ?? moved?.querySelector('[data-hero-move]:not(:disabled)'))?.focus();
        state.textContent = '已调整顺序（还没保存）';
        return;
      }
      const rm = e.target.closest?.('[data-hero-remove]');
      if (!rm) return;
      items = items.filter((it) => it.path !== rm.dataset.heroRemove);
      render();
      // 被点的 × 已随重绘消失；把焦点交给「添加」格（或最后一枚移除键），别让键盘用户掉回 body。
      (list.querySelector('#heroPick') ?? [...list.querySelectorAll('[data-hero-remove]')].at(-1))?.focus();
      state.textContent = items.length ? '已从列表移除（还没保存）' : '已全部移除（还没保存）';
    });

    // —— 拖拽排序（原生 DnD）—— 松手（drop）才真正重排，原生 DnD 只覆盖鼠标。
    // dragover 只算落点，**不动被拖的那一格**：Chromium 里在 dragover 期间挪动拖拽源会让后续 drop 不再触发。
    let dropBefore = null;
    let dragFrame = 0;
    let dragPoint = null;
    list.addEventListener('dragstart', (e) => {
      const fig = e.target.closest?.('.a-hero-item');
      if (!fig) return;
      dragged = fig;
      suppressClick = true;   // 拖拽后可能补一个 click，别误触移除叉
      fig.classList.add('is-dragging');
      if (e.dataTransfer) { e.dataTransfer.effectAllowed = 'move'; e.dataTransfer.setData('text/plain', fig.dataset.path); }
    });
    // 落点判定：网格无单一坐标定序，所以「同排比左右、跨排比上下」—— 指针在某格上半区、或同排左半区之前，就插到它前面。
    list.addEventListener('dragover', (e) => {
      if (!dragged) return;
      e.preventDefault();
      if (e.dataTransfer) e.dataTransfer.dropEffect = 'move';
      // dragover 每秒几十次；把落点计算压到一帧一次，避免每次都全量 getBoundingClientRect 强制布局。
      dragPoint = { x: e.clientX, y: e.clientY };
      if (dragFrame) return;
      dragFrame = requestAnimationFrame(() => {
        dragFrame = 0;
        if (!dragged || !dragPoint) return;
        const { x, y } = dragPoint;
        const others = [...list.querySelectorAll('.a-hero-item')].filter((el) => el !== dragged);
        const anchor = others.find((el) => {
          const r = el.getBoundingClientRect();
          return y < r.top + r.height / 2 || (y <= r.bottom && x < r.left + r.width / 2);
        }) ?? null;
        dropBefore = anchor ?? list.querySelector('.a-hero-add');
        for (const el of list.querySelectorAll('.a-hero-item')) el.classList.toggle('is-drop-before', el === dropBefore);
      });
    });
    const endDrag = (commit) => {
      if (!dragged) return;
      const draggedPath = dragged.dataset.path;
      const anchorPath = dropBefore?.classList.contains('a-hero-item') ? dropBefore.dataset.path : null;
      dragged.classList.remove('is-dragging');
      for (const el of list.querySelectorAll('.a-hero-item')) el.classList.remove('is-drop-before');
      dragged = null;
      dropBefore = null;
      if (commit) {
        const rest = items.filter((it) => it.path !== draggedPath);
        const moved = items.find((it) => it.path === draggedPath);
        let at = rest.length;
        if (anchorPath) { const j = rest.findIndex((it) => it.path === anchorPath); if (j >= 0) at = j; }
        rest.splice(at, 0, moved);
        items = rest;
        state.textContent = '已调整顺序（还没保存）';
      }
      render();   // 落定或还原，都把序号重画一遍
      setTimeout(() => { suppressClick = false; }, 0);
    };
    list.addEventListener('drop', (e) => { e.preventDefault(); endDrag(true); });
    list.addEventListener('dragend', () => endDrag(false));

    file?.addEventListener('change', async () => {
      const files = [...(file.files ?? [])];
      file.value = '';
      if (!files.length) return;
      if (items.length >= MAX) { state.textContent = `最多 ${MAX} 项，先移掉几项再传`; return; }
      if (files.length > MAX - items.length) {
        state.textContent = `最多 ${MAX} 项，这次只收前 ${MAX - items.length} 项`;
        files.length = MAX - items.length;
      }
      let added = 0, failed = 0;
      for (const f of files) {
        state.textContent = `上传 ${f.name}…`;
        try {
          // 原始文件直传（与编辑器插图同一份实现）：服务端流式落临时文件，不整块进 Node 堆。
          const out = await window.__uploadRaw(f);
          if (!out.ok) { state.textContent = `上传失败：${out.error}`; failed++; continue; }
          // 上传接口只收图片；封面再确认一次地址后缀。
          if (NON_IMAGE_RE.test(out.url)) { state.textContent = '首页封面只能用图片'; continue; }
          if (items.some((it) => it.path === out.url)) { state.textContent = '这个已经在列表里了'; continue; }
          items.push({ path: out.url, w: String(out.width ?? ''), h: String(out.height ?? '') });
          thumbs[out.url] = out.thumbnail || '';
          added++;
        } catch (err) {
          state.textContent = `上传失败：${err.message}`;
          failed++;
        }
      }
      render();
      if (added) state.textContent = `已加 ${added} 项 —— 记得点保存${failed ? `（${failed} 项失败）` : ''}`;
      else if (!failed) state.textContent = '';
    });

    // 视频：上传后在服务端转成统一的 16:9 MP4 + 首帧海报，返回与图片同样的 {url,width,height,thumbnail}。
    videoFile?.addEventListener('change', async () => {
      const picked = [...(videoFile.files ?? [])][0];
      videoFile.value = '';
      if (!picked) return;
      if (items.length >= MAX) { state.textContent = `最多 ${MAX} 项，先移掉几项再传`; return; }
      state.textContent = `上传并转码 ${picked.name}…`;
      try {
        const out = await window.__uploadRaw(picked, { endpoint: '/admin/api/hero-video' });
        if (!out.ok) { state.textContent = `视频上传失败：${out.error}`; return; }
        if (items.some((it) => it.path === out.url)) {
          state.textContent = '这个视频已经在列表里了';
          return;
        }
        items.push({ path: out.url, w: String(out.width ?? ''), h: String(out.height ?? '') });
        thumbs[out.url] = out.thumbnail || '';
        render();
        const note = out.truncated ? '，已截取前 8 秒' : '';
        state.textContent = `已加视频（${Number(out.duration) > 0 ? `${Math.round(Number(out.duration) * 10) / 10} 秒` : '时长未知'}${note}）—— 记得点保存`;
        (list.querySelector('#heroPick') ?? [...list.querySelectorAll('[data-hero-remove]')].at(-1))?.focus();
      } catch (err) {
        state.textContent = `视频上传失败：${err.message}`;
      }
    });

    render();
  }

  const dirty = () => Boolean(ed && ed.hasPending());

  window.addEventListener('beforeunload', (e) => {
    if (!dirty() && !editedFeed()) return;
    e.preventDefault();
    e.returnValue = '';
  });

  window.__beforeNavigate = () => {
    const feedDirty = editedFeed();
    if (!dirty() && !feedDirty) return true;
    return window.__ui ? window.__ui.confirm({ title: '离开编辑页面？', body: feedDirty ? '订阅源改动尚未保存，离开将放弃这些改动。' : '还有改动未保存，建议先保存再离开。', ok: '离开页面' }) : window.confirm('还有改动未保存，确定离开？');
  };

function setupConfirmModal() {
  const dlg = document.getElementById('a-modal');
  const form = document.getElementById('a-modal-form');
  if (!dlg || !form || typeof dlg.showModal !== 'function') return;

  const navSubmit = (target) => {
    if (window.__nav?.submitForm) { window.__nav.submitForm(target, null); return; }
    target.submit();
  };

  const $title = dlg.querySelector('.a-modal-title');
  const $body = dlg.querySelector('.a-modal-body');
  const $note = dlg.querySelector('.a-modal-note');
  const $ok = dlg.querySelector('[data-modal-ok]');
  let link = null;
  let button = null;
  let confirmed = false;

  const fill = (el) => {
    $title.textContent = el.dataset.modalTitle || '确认删除？';
    $body.textContent = el.dataset.modalBody || '';
    $body.hidden = !el.dataset.modalBody;
    $note.textContent = el.dataset.modalNote || '';
    $note.hidden = !el.dataset.modalNote;
    $ok.textContent = el.dataset.modalOk || el.textContent.trim() || '确认操作';

    $ok.disabled = el.dataset.modalDisabled === '1';
  };

  document.addEventListener('click', (e) => {
    const a = e.target.closest('a[data-modal-title]');
    if (!a || e.metaKey || e.ctrlKey || e.shiftKey || e.altKey || e.button > 0) return;
    e.preventDefault();
    if (form.getAttribute('aria-busy') === 'true' || dlg.open) return;
    link = a; button = null;
    fill(a);
    form.action = a.dataset.modalAction || a.href;
    // __ui.open() 已 sync 过滚动锁；缺 ui.js 的原生兜底才补一次。
    window.__openDialog(dlg);
  }, true);

  document.addEventListener('submit', (e) => {
    if (confirmed) { confirmed = false; return; }
    const btn = e.submitter;
    if (!btn || !btn.dataset || !btn.dataset.modalTitle) return;
    e.preventDefault();
    if (btn.form?.getAttribute('aria-busy') === 'true' || dlg.open) return;
    button = btn; link = null;
    fill(btn);
    // __ui.open() 已 sync 过滚动锁；缺 ui.js 的原生兜底才补一次。
    window.__openDialog(dlg);
  }, true);

  dlg.querySelector('[data-modal-cancel]').addEventListener('click', () => dlg.close());

  form.addEventListener('submit', (e) => {
    e.preventDefault();
    dlg.close();
    if (link) {
      link = null;
      navSubmit(form);
      return;
    }
    if (button) {
      const btn = button;
      button = null;
      confirmed = true;

      btn.form.requestSubmit(btn);
    }
  });
}

/** 窄屏导航轨横向滚动：只维护 data-edge 供 CSS 加渐隐。 */
const syncRail = (nav) => {
  if (!nav) return;
  const max = nav.scrollWidth - nav.clientWidth;
  nav.dataset.edge = max <= 1 ? 'none'
    : nav.scrollLeft <= 1 ? 'start'
      : nav.scrollLeft >= max - 1 ? 'end' : 'mid';
};

// 窄屏导航轨是横向滚动条：当前项在 /admin/media、/admin/system 这类页面会落在屏幕外，页头就看不出自己在哪。
// 进入页面（含 PJAX 换页）与转屏时把它滚进可见区。
const revealRailActive = (nav) => {
  const active = nav?.querySelector('a.on');
  if (!active) return;
  const navRect = nav.getBoundingClientRect();
  const activeRect = active.getBoundingClientRect();
  const delta = activeRect.left - navRect.left;
  if (delta < 0 || delta + activeRect.width > navRect.width) {
    nav.scrollLeft = Math.max(0, nav.scrollLeft + delta - 12);
  }
};

// resize 只往 window 挂**一次**，免得 PJAX 换页替换 nav 后每切一页就多挂一个指向旧节点的监听器、永不释放。
let railNav = null;
window.addEventListener('resize', () => { syncRail(railNav); revealRailActive(railNav); }, { passive: true });

function setupRailScroll() {
  const nav = document.querySelector('.a-rail-nav');
  railNav = nav;
  if (!nav) return;
  if (nav.dataset.railBound !== '1') {
    nav.dataset.railBound = '1';
    nav.addEventListener('scroll', () => syncRail(nav), { passive: true });
  }
  revealRailActive(nav);
  syncRail(nav);
}

/* 「订阅未加入友圈的友链」：一轮跑几秒到几十秒，页面却是静态快照，不自己更新站主会以为卡死。进度与结果都收进弹窗，
   弹窗开着且还在跑时每 1.5s 换最新片段。定时器与节点都现查：PJAX 换页会把弹窗换掉，闭包引用会成死节点。 */
let importTimer = 0;
let importFetching = false;

const importDialogEl = () => $('a-import-dialog');
const importBox = () => importDialogEl()?.querySelector('[data-import]') ?? null;
const importRunning = () => importBox()?.dataset.running === '1';

/* 入口按钮跟着片段走：跑着时禁用，跑完没待订阅的站改成「友链都订阅过了」，否则点下去只白跑一轮。文案由服务端给。 */
function syncImportEntry(box) {
  const btn = document.querySelector('[data-import-start] button');
  const pending = Number(box?.dataset.pending);
  if (!btn || !Number.isFinite(pending)) return;
  btn.disabled = box.dataset.running === '1' || pending === 0;
  btn.textContent = box.dataset.entryLabel || btn.textContent;
}

function openImportDialog() {
  const dialog = importDialogEl();
  if (!dialog) return null;
  window.__openDialog(dialog);
  return dialog;
}

/* —— 轮询「进度片段」：把最新那份换回页面 —— 批量订阅与进度条共用。endpointAttr 是不带 data- 的属性名，
   既规定片段根节点必须带哪个属性，也从同名 data-* 读地址。拿到可用片段后调 onDone(fresh, html, box)；返回是否拿到。 */
async function pollFragment(box, { endpointAttr, onDone }) {
  const attr = `data-${endpointAttr}`;
  const endpoint = box?.dataset[camelAttr(attr)];
  if (!box || !endpoint) return { ok: false, terminal: true };
  const res = await request(endpoint, { cache: 'no-store' });
  if (!res.ok) return { ok: false, terminal: false };   // 网络/5xx：下一拍再试
  const html = await res.text();
  const fresh = document.createRange().createContextualFragment(html).firstElementChild;
  // 只认这一个片段：登录过期回来的登录页也是 200，塞进去会把整块换成别的页面。
  if (!fresh?.hasAttribute(attr) || !box.isConnected) return { ok: false, terminal: true };
  onDone?.(fresh, html, box);
  return { ok: true, terminal: false };
}

async function refreshImport() {
  importTimer = 0;
  const box = importBox();
  if (!box || importFetching || box.dataset.importStopped === '1') return;
  importFetching = true;
  let terminal = false;
  try {
    const result = await pollFragment(box, {
      endpointAttr: 'import',
      onDone: (fresh) => {
        box.replaceWith(fresh);
        syncImportEntry(fresh);
      },
    });
    terminal = result.terminal;
  } catch { /* 网络抖动就静默跳过，下一拍再试 */ }
  importFetching = false;
  // 登录过期/片段不合法：继续 1.5s 一次只会刷请求，停轮并提示刷新。
  if (terminal) {
    box.dataset.importStopped = '1';
    window.__toast?.('登录已过期或进度片段无效，请刷新页面后重试。');
    return;
  }
  scheduleImport();
}

function scheduleImport() {
  clearTimeout(importTimer);
  // 弹窗关着就不轮询；跑完再打开照样能看到结果。
  if (importDialogEl()?.open && importRunning()) importTimer = setTimeout(refreshImport, 1500);
}

/** 打开弹窗；start 为真时顺带开始一轮。 */
async function openImport({ start }) {
  const dialog = openImportDialog();
  if (!dialog || !start) return;            // 只看
  const form = document.querySelector('[data-import-start]');
  if (!form) return;
  // 不预先判断「有没有在跑」：后端 start() 自己防重入，多问反而多一层竞态。
  const res = await request(form.action, {
    method: 'POST',
    body: new URLSearchParams(new FormData(form)),
    headers: { 'x-requested-with': 'fetch' },        // 后端据此回 204，不整页跳一次
  }).catch(() => null);
  if (!res?.ok) { window.__toast?.('没能开始订阅，刷新页面再试'); return; }
  await res.text().catch(() => {});   // 消费响应体：request() 的超时/监听清理挂在读取上，不读会吊着定时器
  await refreshImport();
}

const setupImportDialog = () => {
  importFetching = false;
  clearTimeout(importTimer); importTimer = 0;
  const dialog = importDialogEl();
  if (!dialog) return;
  syncImportEntry(importBox());
  dialog.addEventListener('toggle', () => { if (dialog.open) void refreshImport(); });
  dialog.addEventListener('close', () => { clearTimeout(importTimer); importTimer = 0; });
  // 刷新/换页回来时一轮还在跑：直接把弹窗亮出来。
  if (importRunning()) openImportDialog();
  scheduleImport();
};

document.addEventListener('submit', (e) => {
  if (!e.target.closest?.('[data-import-start]')) return;
  e.preventDefault();
  void openImport({ start: true });
}, true);

document.addEventListener('click', (e) => {
  const target = e.target.closest?.('[data-import-view], [data-import-close]');
  if (!target) return;
  if (target.hasAttribute('data-import-view')) void openImport({ start: false });
  else importDialogEl()?.close();
});

/* 一轮「批量活儿」进度条 —— 友链「立即检查全部」与友圈「刷新全部」共用。一轮跑几秒到几十秒，页面却是静态快照，
   不自己更新站主会盯着一动不动的「0 / 41」以为卡死。POST 带 x-requested-with: fetch 后端回 204；之后每 1s 拉进度片段整条换掉；
   报「不跑了」再让 pjax 换整页（行里「最近成功」等标记也变了）。刷新走 replace+保留滚动位置。定时器与节点都**现查**，
   pjax 换页会把整块换掉，闭包引用会成死节点。参数：boxAttr 进度块属性、formAttr 入口表单、doneText 跑完提示。 */
const camelAttr = (attr) => attr.slice(5).replace(/-([a-z])/g, (_, ch) => ch.toUpperCase());

function progressWatch({ boxAttr, formAttr, doneText }) {
  const boxSel = `[${boxAttr}]`;
  const attr = boxAttr.slice(5);            // 不带 data- 前缀，喂给 pollFragment
  const key = camelAttr(boxAttr);
  let timer = 0;
  let fetching = false;
  let pollStopped = false;
  let lastHtml = '';      // 上一次搬上去的片段（一样就别动 DOM）

  const box = () => document.querySelector(boxSel);
  const isRunning = (el) => el?.dataset.running === '1';

  /* 跑着时入口按钮禁用（首屏那一次由服务端渲染）。 */
  const syncEntry = (running) => {
    const btn = document.querySelector(`[${formAttr}] button`);
    if (btn) btn.disabled = Boolean(running);
  };

  const reload = () => {
    const nav = window.__nav;
    if (nav?.navigate) nav.navigate(location.href, { replace: true, keepScroll: true, toast: doneText });
    else location.reload();
  };

  async function tick() {
    timer = 0;
    const el = box();
    const endpoint = el?.dataset[key];
    if (!el || !endpoint || fetching) return;
    fetching = true;
    let result = { ok: false, terminal: false };
    try {
      result = await pollFragment(el, {
        endpointAttr: attr,
        onDone: (fresh, html) => {
          // 内容一字没变就别换节点：呼吸动画每 1s 重建，看着反倒像在抖。
          if (html !== lastHtml) { lastHtml = html; el.replaceWith(fresh); }
          if (isRunning(fresh)) {
            syncEntry(true);
            schedule();
            return;
          }
          syncEntry(false);
          reload();
        },
      });
    } catch { /* 网络抖一下就静默跳过，下一拍再试 */ }
    fetching = false;
    // 登录过期/片段不合法：继续 1s 一次只会刷请求，停轮并提示刷新。
    if (result.terminal) {
      pollStopped = true;
      syncEntry(false);
      window.__toast?.('登录已过期或进度片段无效，请刷新页面后重试。');
      return;
    }
    if (!result.ok) schedule();
  }

  function schedule() {
    clearTimeout(timer);
    if (pollStopped) return;
    const el = box();
    if (!el || !isRunning(el)) return;
    timer = setTimeout(tick, 1000);
  }

  async function start(form) {
    syncEntry(true);
    const res = await request(form.action, {
      method: 'POST',
      body: new URLSearchParams(new FormData(form)),
      headers: { 'x-requested-with': 'fetch' },         // 后端据此回 204
    }).catch(() => null);
    if (!res?.ok) {
      syncEntry(false);
      window.__toast?.('没能开始，刷新页面再试');
      return;
    }
    await res.text().catch(() => {});   // 消费响应体，放掉 request() 挂着的超时定时器
    await tick();
    schedule();
  }

  return {
    setup: () => {
      fetching = false;
      pollStopped = false;
      lastHtml = '';
      clearTimeout(timer); timer = 0;
      const el = box();
      syncEntry(isRunning(el));
      // 刷新/换页回来时一轮还在跑：接着看它跑到哪儿。
      schedule();
    },
    start,
  };
}

const watchers = [
  [progressWatch({
    boxAttr: 'data-links-progress', formAttr: 'data-links-check-all', doneText: '✓ 一轮检查已结束',
  }), 'data-links-check-all'],
  [progressWatch({
    boxAttr: 'data-feeds-progress', formAttr: 'data-feeds-refresh', doneText: '✓ 一轮刷新已结束',
  }), 'data-feeds-refresh'],
];

const setupProgress = () => { for (const [watch] of watchers) watch.setup(); };

document.addEventListener('submit', (e) => {
  for (const [watch, attr] of watchers) {
    const form = e.target.closest?.(`[${attr}]`);
    if (!form) continue;
    e.preventDefault();
    void watch.start(form);
    return;
  }
}, true);

  setupPage();
  setupThemeUpload();
  setupThemeColors();
  setupThemeImages();
  setupMailForm();
  setupHeroForm();
  setupConfirmModal();
  setupRailScroll();
  setupImportDialog();
  setupProgress();
  (window.__pjaxHooks = window.__pjaxHooks || []).push(() => {
    if (mediaLightbox?.open) mediaLightbox.close();
    // #a-modal 在 #app 外，pjax 不替换它；不关掉会停在新页面上，确认按钮还指向旧页面。
    const confirmDialog = document.getElementById('a-modal');
    if (confirmDialog?.open) confirmDialog.close();
    cancelMediaRequest(); setupPage(); setupThemeUpload(); setupThemeColors(); setupThemeImages(); setupMailForm(); setupHeroForm(); setupRailScroll(); setupImportDialog(); setupProgress();
  });
})();

/* 媒体库选择器。编辑器和「设置 → 首页封面」共用同一份：读 /admin/api/media、分页、图片/视频格子、
   失败重试、关闭时取消在飞的请求。选中的处理由调用方给（编辑器插 Markdown，首页封面加进列表）。
   经典脚本（无构建），挂在 window.__setupMediaPicker 上；admin-editor.js 与 admin.js 都在之后加载。 */
(() => {
  'use strict';
  const request = window.__request;
  const PLACEHOLDER = 'data:image/gif;base64,R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7';

  window.__setupMediaPicker = ({ dialog, body, uploadButton, fileInput, onPick, onUpload } = {}) => {
    if (!dialog || !body) {
      return { open: () => fileInput?.click(), dispose: () => {} };
    }

    let session = 0;
    let controller = null;
    let page = 1;
    let items = [];
    let videoObserver = null;

    // 视频格只在进入视口时才挂 src：一页 20 个视频时，否则会同时发 20 个 range 请求取元数据。
    const ensureVideoObserver = () => {
      if (videoObserver || typeof IntersectionObserver !== 'function') return videoObserver;
      videoObserver = new IntersectionObserver((entries, observer) => {
        for (const entry of entries) {
          if (!entry.isIntersecting) continue;
          const frame = entry.target;
          if (frame.dataset.videoSrc) { frame.src = frame.dataset.videoSrc; delete frame.dataset.videoSrc; }
          observer.unobserve(frame);
        }
      }, { rootMargin: '200px' });
      return videoObserver;
    };

    const cancel = () => {
      session++; controller?.abort(); controller = null;
      videoObserver?.disconnect(); videoObserver = null;
    };
    const isVideo = (it) => String(it.mime ?? '').startsWith('video/') || window.__isVideoPath(it.path);

    const render = () => {
      // 重绘会把所有 <video> 从 DOM 里换掉；旧的 IntersectionObserver 仍持有这些节点，
      // 不 disconnect 的话「加载更多」翻几页就会攒下一串已断开的观察对象。
      videoObserver?.disconnect();
      videoObserver = null;
      if (!items.length) {
        body.innerHTML = '<p class="a-dim" role="status">媒体库还是空的 —— 点右上角「上传新文件」传一个。</p>';
        return;
      }
      body.innerHTML = '';
      const grid = document.createElement('div');
      grid.className = 'a-picker-grid';
      for (const it of items) {
        const btn = document.createElement('button');
        btn.type = 'button';
        btn.className = 'a-picker-item';
        btn.dataset.path = it.path;
        btn.dataset.name = it.filename;
        if (isVideo(it)) {
          // 只读 metadata 并 seek 到 0.1s：让浏览器把首帧画成封面；播放标记叠在上面提示这是视频。
          const ph = document.createElement('span');
          ph.className = 'a-picker-video';
          ph.setAttribute('aria-hidden', 'true');
          const frame = document.createElement('video');
          frame.muted = true;
          frame.playsInline = true;
          frame.preload = 'metadata';
          const src = `${it.path}#t=0.1`;
          const observer = ensureVideoObserver();
          if (observer) { frame.dataset.videoSrc = src; observer.observe(frame); }
          else frame.src = src;
          frame.setAttribute('aria-hidden', 'true');
          const mark = document.createElement('span');
          mark.className = 'a-picker-play';
          mark.innerHTML = '<svg viewBox="0 0 24 24" fill="currentColor" aria-hidden="true"><path d="M8 5.5v13l11-6.5z"/></svg>';
          ph.append(frame, mark);
          btn.append(ph);
        } else {
          const im = document.createElement('img');
          im.src = it.thumbnail || PLACEHOLDER;
          im.alt = ''; im.loading = 'lazy'; im.decoding = 'async';
          if (it.previewSrcset) { im.srcset = it.previewSrcset; im.sizes = 'auto, 120px'; }
          if (it.width > 0 && it.height > 0) { im.width = it.width; im.height = it.height; im.style.aspectRatio = `${it.width}/${it.height}`; }
          btn.append(im);
        }
        const cap = document.createElement('span');
        cap.textContent = it.filename;
        btn.append(cap);
        grid.append(btn);
      }
      body.append(grid);
    };

    const load = async (nextPage, append, sessionId) => {
      controller?.abort();
      const ctrl = new AbortController();
      controller = ctrl;
      const res = await request(`/admin/api/media?page=${nextPage}`, { signal: ctrl.signal });
      const out = await res.json();
      if (sessionId !== session || ctrl.signal.aborted || !dialog.open || !dialog.isConnected) return;
      if (!out.ok) throw new Error('无法读取媒体库');
      items = append ? [...items, ...out.items] : out.items;
      // 重绘会删掉正在聚焦的「加载更多」；记下来，重绘后把焦点还给新按钮。
      const moreHadFocus = document.activeElement?.dataset?.pickerMore === '1';
      render();
      page = nextPage;
      if (out.hasMore) {
        const more = document.createElement('button');
        more.type = 'button'; more.className = 'a-btn-ghost'; more.textContent = '加载更多';
        more.dataset.pickerMore = '1';
        more.addEventListener('click', async () => {
          more.disabled = true; more.textContent = '正在加载…';
          try { await load(page + 1, true, sessionId); }
          catch { if (sessionId === session && dialog.open) { more.disabled = false; more.textContent = '读取失败，重试'; } }
        });
        body.append(more);
        if (moreHadFocus) more.focus();
      } else if (moreHadFocus) {
        // 没有下一页了：焦点交给最后一个可选条目，别掉回 body。
        [...body.querySelectorAll('.a-picker-item')].at(-1)?.focus();
      }
    };

    const read = async () => {
      cancel();
      const sessionId = session;
      body.innerHTML = '<p class="a-dim" role="status">正在读取媒体库…</p>';
      try { await load(1, false, sessionId); }
      catch {
        if (sessionId !== session || !dialog.open || !dialog.isConnected) return;
        body.innerHTML = '<p class="a-dim" role="alert">媒体库读取失败，请重试或上传新文件。</p>';
        const retry = document.createElement('button');
        retry.type = 'button'; retry.className = 'a-btn-ghost'; retry.textContent = '重试';
        retry.addEventListener('click', read);
        body.append(retry);
      }
    };

    // 所有监听器共用一个 signal：dispose 时一次性摘掉。以前只取消在飞的请求，复用同一个 dialog
    // 时 close/取消/上传监听会一轮轮累加，第 N 次打开就会触发 N 次。
    const listeners = new AbortController();
    const on = { signal: listeners.signal };
    dialog.addEventListener('close', cancel, on);
    dialog.querySelectorAll('[data-picker-cancel]').forEach((btn) => btn.addEventListener('click', () => dialog.close(), on));
    body.addEventListener('click', (e) => {
      const btn = e.target.closest('.a-picker-item');
      if (!btn) return;
      dialog.close();
      const item = items.find((it) => it.path === btn.dataset.path);
      if (item) onPick?.(item);
    }, on);
    uploadButton?.addEventListener('click', () => {
      dialog.close();
      if (onUpload) onUpload();
      else fileInput?.click();
    }, on);

    return {
      open: () => {
        window.__openDialog(dialog);
        void read();
      },
      dispose: () => {
        cancel();
        listeners.abort();
        videoObserver?.disconnect();
        videoObserver = null;
      },
    };
  };
})();

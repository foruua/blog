(() => {
  'use strict';
  // 超时覆盖请求发送与响应体读取，避免只发响应头时永久挂起。
  // timeoutMs 可由调用方覆盖：上传大视频时 15 秒会把正常请求误杀（服务端给上传留了 600 秒）。
  window.__request = async (url, options) => {
    const controller = new AbortController();
    const { timeoutMs: rawTimeout, signal, ...fetchOptions } = options ?? {};
    const timeoutMs = Number(rawTimeout) > 0 ? Number(rawTimeout) : 15000;
    const abort = () => controller.abort();
    if (signal?.aborted) abort();
    else signal?.addEventListener('abort', abort, { once: true });
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    const cleanup = () => { clearTimeout(timer); signal?.removeEventListener('abort', abort); };
    try {
      const res = await fetch(url, { ...fetchOptions, signal: controller.signal });
      const read = (method) => async () => {
        try { return await res[method](); } finally { cleanup(); }
      };
      return { ok: res.ok, status: res.status, json: read('json'), text: read('text') };
    } catch (error) { cleanup(); throw error; }
  };

  // 共用小工具。所有脚本都是 defer 且 request.js 永远最先执行，故集中挂在这里，省掉四个文件各定义一份。
  window.__csrf = () => document.querySelector('input[name="_csrf"]')?.value ?? '';
  window.__reducedMotion = () => matchMedia('(prefers-reduced-motion: reduce)').matches;

  // 视频判断：正文渲染（src/media/video.js）、后台封面、媒体库格子都按同一份扩展名认。
  const VIDEO_RE = /\.(?:mp4|webm|mov|m4v)(?:$|[?#])/i;
  window.__isVideoPath = (p) => VIDEO_RE.test(String(p ?? ''));

  // 首页封面比例：与 src/media/video.js 的 heroAspectOf 同口径。后台改封面时要即时算，不能等服务端。
  window.__heroAspect = (items = []) => {
    const video = (items ?? []).find((it) => window.__isVideoPath(it?.path) && Number(it.w) > 0 && Number(it.h) > 0);
    const a = Math.max(1, Math.round(Number(video?.w) || 16));
    const b = Math.max(1, Math.round(Number(video?.h) || 9));
    const gcd = (x, y) => (y ? gcd(y, x % y) : x);
    const g = gcd(a, b);
    return `${a / g} / ${b / g}`;
  };

  // 原始文件直传（编辑器插图、首页封面共用）：服务端流式落临时文件，视频 128MB 走 600 秒窗口，
  // 别被 15 秒的默认超时先掐断。返回服务端 JSON，调用方自己判 out.ok。
  window.__uploadRaw = async (file, { signal } = {}) => {
    const res = await window.__request('/admin/api/upload', {
      method: 'POST',
      headers: {
        'x-csrf-token': window.__csrf(),
        'x-raw-upload': '1',
        'Content-Type': file.type || 'application/octet-stream',
        'x-file-name': encodeURIComponent(file.name),
      },
      body: file, signal, timeoutMs: 600000,
    });
    return res.json();
  };

  // 视频默认 preload=none；进入视口（或笔记展开）后再要 metadata，首帧预览保留，但不在首屏抢带宽。
  // observer 在每次 pjax 换页时重建：旧节点已从 DOM 移除，必须 disconnect，否则会一直被观察。
  let lazyVideoObserver = null;
  window.__lazyVideo = (root = document) => {
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
  };
  // 打开弹层：有 ui.js 走它（带滚动锁/焦点处理）；没有则退回原生 showModal，绝不因为缺一个脚本就打不开。
  window.__openDialog = (dialog) => {
    if (!dialog) return;
    if (window.__ui) { window.__ui.open(dialog); return; }
    if (!dialog.open) { try { dialog.showModal(); } catch { /* 已在打开中 */ } }
    window.__syncScrollLock?.();
  };
})();

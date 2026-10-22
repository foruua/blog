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
  // 打开弹层：有 ui.js 走它（带滚动锁/焦点处理）；没有则退回原生 showModal，绝不因为缺一个脚本就打不开。
  window.__openDialog = (dialog) => {
    if (!dialog) return;
    if (window.__ui) { window.__ui.open(dialog); return; }
    if (!dialog.open) { try { dialog.showModal(); } catch { /* 已在打开中 */ } }
    window.__syncScrollLock?.();
  };
})();

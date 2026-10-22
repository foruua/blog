/* 写作台。后台无构建（跟 nav.js / app.js / admin.js 一样是经典脚本），不引任何东西。
   分工：admin.js 管"保存"（自动保存、两段式提交、409 冲突、脏状态守卫、上传/选图），本文件只管"写得顺"：
   几个 Markdown 快捷键、列表自动续行、Tab 缩进。正文就是原生 textarea，没有镜像高亮层，不存在错位问题。
   纯函数（列表续行、包裹、缩进）挂在 globalThis.__writer 上：jsdom 和 Node 都能直接调用，不必先跑起整个页面。
*/
(function () {
  'use strict';

  /* —— 纯函数 —— */

  /** 列表自动续行；返回 null 表示"这次 Enter 不归我管"。空条目再按 Enter → 去掉标记、跳出列表。 */
  function continueList(value, start, end = start) {
    const before = value.slice(0, start);
    const lineStart = before.lastIndexOf('\n') + 1;
    const line = before.slice(lineStart);
    const m = /^(\s*)([-*+]|\d+[.)])(\s+)(.*)$/.exec(line);
    if (!m) return null;
    const [, indent, marker, gap, rest] = m;
    if (!rest.trim()) {
      // 空条目：删掉标记本身，光标停在行首
      return { value: value.slice(0, lineStart) + value.slice(end), start: lineStart, end: lineStart };
    }
    let next = marker;
    if (/^\d/.test(marker)) {
      const n = parseInt(marker, 10) + 1;
      const tail = marker.slice(String(parseInt(marker, 10)).length);   // 保留 `.` 或 `)`
      next = `${n}${tail}`;
    }
    const insert = `\n${indent}${next}${gap}`;
    return { value: before + insert + value.slice(end), start: start + insert.length, end: start + insert.length };
  }

  /** 用一对记号包住选区；无选区则插一对、光标放中间。 */
  function wrap(value, start, end, mark) {
    const sel = value.slice(start, end);
    const text = `${mark}${sel}${mark}`;
    const at = sel ? start + text.length : start + mark.length;
    return { value: value.slice(0, start) + text + value.slice(end), start: at, end: at };
  }

  /** ⌘K：选中文字变链接文本；没选就插 [](…) 并把光标放进方括号。 */
  function linkify(value, start, end) {
    const sel = value.slice(start, end);
    if (sel) {
      const text = `[${sel}](url)`;
      const at = start + text.length - 4;     // 落在 url 的 u 上，直接就能改
      return { value: value.slice(0, start) + text + value.slice(end), start: at, end: at + 3 };
    }
    const text = '[](url)';
    return { value: value.slice(0, start) + text + value.slice(end), start: start + 1, end: start + 1 };
  }

  /** Tab / ⇧Tab：多行选区整块缩进，单行插两个空格。 */
  function indent(value, start, end, out) {
    const sel = value.slice(start, end);
    if (start !== end && sel.includes('\n')) {
      const lineStart = value.lastIndexOf('\n', start - 1) + 1;
      const block = value.slice(lineStart, end);
      const next = out ? block.replace(/^ {1,2}/gm, '') : block.replace(/^/gm, '  ');
      return { value: value.slice(0, lineStart) + next + value.slice(end), start, end: lineStart + next.length };
    }
    const text = out ? '' : '  ';
    if (out) {
      const lineStart = value.lastIndexOf('\n', start - 1) + 1;
      const line = value.slice(lineStart);
      const stripped = line.replace(/^ {1,2}/, '');
      const shrink = line.length - stripped.length;
      if (!shrink) return null;
      return { value: value.slice(0, lineStart) + stripped, start: Math.max(lineStart, start - shrink), end: Math.max(lineStart, end - shrink) };
    }
    return { value: value.slice(0, start) + text + value.slice(end), start: start + text.length, end: end + text.length };
  }

  const API = { continueList, wrap, linkify, indent };
  globalThis.__writer = API;

  // Node 里（测试直接调纯函数）到此为止
  if (typeof document === 'undefined') return;

  /* —— 接线 —— */

  let dispose = null;
  const $ = (id) => document.getElementById(id);

  function init() {
    dispose?.();
    dispose = null;

    const form = $('editorForm');
    const body = $('f-body');
    if (!form || !body) return;

    const cleanups = [];
    const on = (target, type, fn, opts) => { target.addEventListener(type, fn, opts); cleanups.push(() => target.removeEventListener(type, fn, opts)); };

    const previewButton = form.querySelector('[data-editor-preview]');
    const previewDialog = document.querySelector('[data-editor-preview-dialog]');
    let previewRequest = null;
    let disposed = false;
    if (previewButton && previewDialog) {
      on(previewButton, 'click', async () => {
        const output = previewDialog.querySelector('[data-preview-body]');
        previewRequest?.abort();
        const controller = new AbortController();
        previewRequest = controller;
        previewDialog.querySelector('[data-preview-title]').textContent = form.querySelector('[name="title"]')?.value || '无标题';
        output.textContent = '正在生成预览…';
        if (!previewDialog.open) { window.__openDialog(previewDialog); }
        try {
          const token = form.querySelector('[name="_csrf"]').value;
          const response = await window.__request('/admin/api/preview', {
            method: 'POST', signal: controller.signal,
            headers: { 'content-type': 'application/json', 'x-csrf-token': token },
            body: JSON.stringify({ body: body.value, _csrf: token }),
          });
          const result = await response.json();
          if (disposed || controller.signal.aborted) return;
          if (!response.ok || !result.ok) throw new Error('preview');
          // result.html 由服务端清洗后才返回，才敢写 innerHTML。
          output.innerHTML = result.html;

        } catch {
          if (!disposed && !controller.signal.aborted) output.textContent = '预览失败，请关闭后重试。';
        }
      });
      on(previewDialog.querySelector('[data-preview-close]'), 'click', () => previewDialog.close());
      on(previewDialog, 'close', () => previewRequest?.abort());
    }

    /* —— 编辑动作：改值 → 选中 → 触发 input —— */
    function applyEdit(next) {
      if (!next) return;
      body.value = next.value;
      body.setSelectionRange(next.start, next.end ?? next.start);
      body.dispatchEvent(new Event('input', { bubbles: true }));
    }

    /* —— 键位 —— */
    let tabEscape = false;
    function onKeyDown(e) {
      if (!form.contains(e.target)) return;
      const mod = e.metaKey || e.ctrlKey;
      const key = (e.key || '').toLowerCase();
      // 输入法组字期间（keyCode 229 / isComposing）一个键都不许抢
      if (e.isComposing || e.keyCode === 229) return;
      // Tab / Enter 只对**正文 textarea** 生效，否则在标题、slug、上传按钮上按 Tab 会被吞掉、还往正文插两格；表单级快捷键不受影响。
      const inBody = e.target === body;
      // Tab 默认用于缩进，但键盘用户必须有办法离开正文框：按 Esc 后下一次 Tab 交还给浏览器。
      // 否则行首有缩进时 Shift+Tab 会一直反缩进，永远移不出焦点（WCAG 2.1.2 No Keyboard Trap）。
      if (inBody && e.key === 'Escape') { tabEscape = true; return; }
      if (inBody && e.key === 'Tab' && tabEscape) { tabEscape = false; return; }
      if (e.key !== 'Tab') tabEscape = false;
      if (inBody && !mod && e.key === 'Enter' && !e.shiftKey && !e.altKey) {
        const next = continueList(body.value, body.selectionStart, body.selectionEnd);
        if (next) { e.preventDefault(); applyEdit(next); }
        return;
      }
      if (inBody && e.key === 'Tab' && !mod) {
        const next = indent(body.value, body.selectionStart, body.selectionEnd, e.shiftKey);
        if (next) { e.preventDefault(); applyEdit(next); }
        return;
      }
      if (!mod) return;
      if (key === 's') { e.preventDefault(); form.querySelector('button[value="save"]')?.click(); return; }
      if (e.key === 'Enter') { e.preventDefault(); form.querySelector('button[value="publish"]')?.click(); return; }
      // 加粗/斜体/行内码/链接都直接改 body.value —— 必须只在焦点位于正文时生效，否则在标题框按 ⌘B 会把 **** 插进正文（还看不到）。
      if (inBody && key === 'b') { e.preventDefault(); applyEdit(wrap(body.value, body.selectionStart, body.selectionEnd, '**')); return; }
      if (inBody && key === 'i') { e.preventDefault(); applyEdit(wrap(body.value, body.selectionStart, body.selectionEnd, '*')); return; }
      if (inBody && key === 'e') { e.preventDefault(); applyEdit(wrap(body.value, body.selectionStart, body.selectionEnd, '`')); return; }
      if (inBody && key === 'k') { e.preventDefault(); applyEdit(linkify(body.value, body.selectionStart, body.selectionEnd)); return; }
    }

    on(document, 'keydown', onKeyDown);

    dispose = () => {
      disposed = true;
      previewRequest?.abort();
      if (previewDialog?.open) previewDialog.close();
      for (const fn of cleanups.splice(0)) fn();
    };
  }

  init();
  (window.__pjaxHooks = window.__pjaxHooks || []).push(() => init());
})();

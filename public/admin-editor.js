(() => {
  'use strict';
  const request = window.__request;
  const csrf = window.__csrf;
  const $ = (id) => document.getElementById(id);
  // 服务端 src/util/text.js 的 slugify() 镜像：两边必须逐字一致，否则显示与实际落库/落文件名的 slug 会不同。
  const slugify = (s) => String(s ?? '').trim().toLowerCase()
    .replace(/[\s_]+/g, '-')
    .replace(/[^\p{Script=Han}\p{Letter}\p{Number}-]+/gu, '')
    .replace(/-{2,}/g, '-')
    .replace(/^-+|-+$/g, '') || 'untitled';

  window.__setupAdminEditor = () => {
    let disposePicker = () => {};
    const form = $('editorForm');
    if (!form) return null;

    const body = form.querySelector('[name="body"]');
    const state = $('a-save-state');
    const setState = (text, bad = false) => {
      if (!state) return;
      state.textContent = text;
      state.classList.toggle('is-bad', bad);
    };

    // 标题 → slug 联动。slug 就是 URL，规则保守：只有 slug 空着才自动填，已有的绝不动（改了要换文件名、旧链接靠 301 兜）；
    // 手动改过则停止联动，清空恢复。
    const titleField = form.querySelector('[name="title"]');
    const slugField = form.querySelector('[name="slug"]');
    if (titleField && slugField) {
      let slugAuto = !slugField.value.trim();
      const syncSlug = () => {
        // 标题为空时不要填成 "untitled"，会让新建页凭空多出一个 slug
        if (slugAuto && titleField.value.trim()) slugField.value = slugify(titleField.value);
      };
      titleField.addEventListener('input', syncSlug);
      slugField.addEventListener('input', () => { slugAuto = !slugField.value.trim(); });
      syncSlug();
    }

    let timer = 0;
    let inflight = false;
    let conflicted = false;
    // 400 是输入校验失败：不要在用户修改前每隔几秒重试同一条无效请求。
    let validationError = false;
    let retryDelay = 800;
    let version = 0;
    let savedVersion = 0;
    let disposed = false;
    let submitting = false;
    let submitAllowed = false;
    let activeRequest = null;
    const pendingUploads = new Set();
    const hasPending = () => version !== savedVersion || inflight || pendingUploads.size > 0;

    const payloadOf = (action) => {
      const data = Object.fromEntries(new FormData(form).entries());
      data.draft = form.draft?.checked ? '1' : '';
      data.comments = form.comments?.checked ? '1' : '';
      if (action === 'local-draft') data.body = data.body.replace(/!\[上传中…\]\(uploading:\d+\)/g, '![上传已中断，请重新选择图片]()');
      data.action = action;
      data._csrf = csrf();
      return data;
    };

    async function autosave() {
      if (disposed || submitting || inflight || conflicted) return;
      if (pendingUploads.size) { setState('媒体上传中，完成后自动保存…'); return; }
      const sentVersion = version;
      inflight = true;
      setState('保存中…');
      try {
        activeRequest = request('/admin/api/autosave', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', 'x-csrf-token': csrf() },
          body: JSON.stringify(payloadOf('autosave')),
        }).then(async (res) => ({ res, out: await res.json().catch(() => ({})) }));
        const { res, out } = await activeRequest;
        if (disposed) return;
        if (!out.ok) {
          setState(`自动保存失败：${out.error ?? res.status}`, true);
          if (res.status === 409) { conflicted = true; await showConflict(); }
          // 400 是「这次输入不合法」：等用户改完再重试；鉴权/CSRF/体积这类才彻底停下。
          else if (res.status === 400) validationError = true;
          else if ([401,403,413].includes(res.status)) {
            conflicted = true;
            setState(res.status === 413
              ? '内容超过大小限制，自动保存已停止；请精简后手动保存。'
              : '登录状态已失效，自动保存已停止；请刷新页面重新登录。', true);
          }
          return;
        }
        retryDelay = 800;
        validationError = false;
        const versionField = form.elements.namedItem('version');
        if (versionField && out.version) versionField.value = out.version;
        savedVersion = sentVersion;
        if (version === sentVersion) { try { sessionStorage.removeItem(localKey()); } catch {} }

        const idField = form.elements.namedItem('id');
        if (!idField.value && out.id) {
          const oldKey = draftKey;
          idField.value = out.id;
          draftKey = `blog-draft:${out.id}`;
          try {
            const stored = sessionStorage.getItem(oldKey);
            if (stored) { sessionStorage.setItem(draftKey, stored); sessionStorage.removeItem(oldKey); }
          } catch {}
          try {
            history.replaceState(Object.assign({}, history.state, { pjax: 1 }), '', `/admin/edit/${out.id}`);
            window.__nav?.syncUrl?.();   // 告诉导航层地址变了，否则 Back/Forward 会拿旧地址
          } catch {  }
        }
        if (pendingUploads.size) { setState('媒体上传中，完成后自动保存…'); return; }
        if (version !== savedVersion) { setState('仍有修改待保存…'); return; }
        setState(`已自动保存 ${new Date(out.savedAt).toLocaleTimeString('zh-CN')}${out.warning ? ` · ${out.warning}` : ''}`, Boolean(out.warning));
      } catch (err) {
        setState(`自动保存失败：${err.message}`, true);
      } finally {
        inflight = false;
        activeRequest = null;
        if (!disposed && !submitting && !conflicted && !validationError && hasPending()) {
          clearTimeout(timer);
          timer = setTimeout(autosave, retryDelay); retryDelay = Math.min(retryDelay * 2, 30000);
        }
      }
    }

    let draftKey = `blog-draft:${form.elements.namedItem('id').value || 'new-' + form.elements.namedItem('kind').value}`;
    const localKey = () => draftKey;
    // 草稿落 sessionStorage 是为了刷新/崩溃后恢复本页未保存的输入。以前每个 input 都同步序列化整个表单
    //（50KB 文章每敲一个字都阻塞主线程），改成节流 500ms + 离开/切标签时补写。
    let draftTimer = 0;
    const writeDraft = () => {
      clearTimeout(draftTimer); draftTimer = 0;
      if (!hasPending()) return;
      try { sessionStorage.setItem(localKey(), JSON.stringify(payloadOf('local-draft'))); } catch { /* 配额满/隐私模式：草稿丢了不影响正常保存 */ }
    };
    const onLeave = () => { if (!disposed) writeDraft(); };
    const onHidden = () => { if (document.hidden) onLeave(); };
    window.addEventListener('pagehide', onLeave);
    document.addEventListener('visibilitychange', onHidden);

    const scheduleAutosave = () => {
      if (disposed) return;
      validationError = false;
      version++;
      if (!draftTimer) draftTimer = setTimeout(writeDraft, 500);
      clearTimeout(timer);
      timer = setTimeout(autosave, 3000);
    };

    async function showConflict() {
      let panel = form.querySelector('[data-conflict]');
      if (!panel) { panel = document.createElement('section'); panel.dataset.conflict = ''; panel.className = 'a-notice'; form.append(panel); }
      panel.textContent = '内容有冲突，正在读取最新版本…';
      try {
        const res = await request('/admin/api/post/' + form.elements.namedItem('id').value);
        const out = await res.json(); if (!out.ok) throw new Error('无法读取最新版本');
        panel.textContent = '';
        const label = document.createElement('p'); label.textContent = '其他页面保存的最新正文（请与编辑框中的本地内容比较并合并）：';
        const latest = document.createElement('textarea'); latest.readOnly = true; latest.value = out.post.body_md; latest.rows = 8; latest.className = 'a-textarea'; latest.setAttribute('aria-label','最新版本正文');
        const accept = document.createElement('button'); accept.type = 'button'; accept.className = 'a-btn'; accept.textContent = '已比较，使用编辑框内容继续保存';
        accept.addEventListener('click', () => { form.elements.namedItem('version').value = out.post.version; conflicted = false; panel.remove(); scheduleAutosave(); });
        panel.append(label, latest, accept);
      } catch { panel.textContent = '无法读取最新版本。本地内容已保留，请先复制正文，再刷新页面比较。'; }
    }
    try {
      const draft = JSON.parse(sessionStorage.getItem(localKey()) || 'null');
      if (draft?.body) draft.body = draft.body.replace(/!\[上传中…\]\(uploading:\d+\)/g, '![上传已中断，请重新选择图片]()');
      const current = payloadOf('autosave');
      const editable = ['title', 'body', 'slug', 'date', 'draft', 'comments', 'kind'];
      if (draft && editable.some((key) => String(draft[key] ?? '') !== String(current[key] ?? ''))) {
        const recover = document.createElement('button'); recover.type = 'button'; recover.className = 'a-btn'; recover.textContent = '恢复本页未保存的输入';
        recover.addEventListener('click', () => { for (const [name,value] of Object.entries(draft)) { const field = form.elements.namedItem(name); if (field && editable.includes(name)) { if (field.type === 'checkbox') field.checked = value === '1'; else field.value = value; } } touch(); recover.remove(); });
        form.prepend(recover);
      }
    } catch {}
    form.addEventListener('input', scheduleAutosave);
    form.addEventListener('change', scheduleAutosave);
    form.addEventListener('submit', async (e) => {
      clearTimeout(timer);
      if (pendingUploads.size) { e.preventDefault(); submitting = false; submitAllowed = false; setState('请等待媒体上传完成后再保存或发布。', true); return; }
      if (submitAllowed) return;

      e.preventDefault();
      if (submitting) return;
      submitting = true;
      const submitter = e.submitter;
      try { await activeRequest; } catch {  }
      if (disposed) return;
      if (pendingUploads.size) { submitting = false; setState('请等待媒体上传完成后再保存或发布。', true); return; }
      if (!form.reportValidity()) {
        submitting = false;
        if (hasPending()) timer = setTimeout(autosave, retryDelay); retryDelay = Math.min(retryDelay * 2, 30000);
        return;
      }
      submitAllowed = true;
      // A second submission during the first dispatch is ignored by WebKit.
      setTimeout(() => {
        if (!disposed) form.requestSubmit(submitter ?? undefined);
      }, 0);
    });

    form.addEventListener('ui:submit-failed', () => {
      submitting = false; submitAllowed = false;
      setState('提交失败，输入已保留，请重试。', true);
    });

    if (form.dataset.conflict === '1') { conflicted = true; void showConflict(); }

    // 预览、键位等在 editor.js 里。程序化改动（上传插图、草稿恢复）必须补 input 事件，否则字数等不会更新（改 value 不触发 input）。
    const touch = () => body.dispatchEvent(new Event('input', { bubbles: true }));

    const fileInput = $('a-file');

    /* 每次上传用**独占**占位串：共用占位串时 String.replace 只替换第一个匹配，两张图同时在飞会互相填错位置。
       替换一律走函数形式（md 可能含 `$`，字符串式替换会把 `$&`/`$1` 当分组引用）。 */
    let uploadSeq = 0;

    async function upload(file) {
      const controller = new AbortController();
      pendingUploads.add(controller);
      const marker = `![上传中…](uploading:${++uploadSeq})`;
      const at = body.selectionStart;
      body.setRangeText(marker, at, body.selectionEnd, 'end');
      touch();
      setState(`上传 ${file.name}…`);
      try {
        const res = await request('/admin/api/upload', {
          method: 'POST',
          headers: {
            'x-csrf-token': csrf(),
            'x-raw-upload': '1',
            'Content-Type': file.type || 'application/octet-stream',
            'x-file-name': encodeURIComponent(file.name),
          },
          body: file, signal: controller.signal,
          // 视频默认上限 128MB，服务端读取窗口 600 秒；前端不能再用通用 15 秒把上传打断。
          timeoutMs: 600000,
        });
        const out = await res.json();
        if (disposed) return;
        if (!out.ok) {
          body.value = body.value.replace(marker, () => `![上传失败：${out.error}]()`);
          touch();
          setState(`上传失败：${out.error}`, true);
          return;
        }

        const md = `![${file.name.replace(/\.[^.]+$/, '')}](${out.url})`;
        body.value = body.value.replace(marker, () => md);
        touch();
        setState(`已插入 ${out.url}${out.deduped ? '（内容重复，复用已有文件）' : ''}`);
      } catch (err) {
        if (disposed) return;
        body.value = body.value.replace(marker, () => '![上传失败]()');
        touch();
        setState(`上传失败：${err.message}`, true);
      } finally {
        pendingUploads.delete(controller);
        if (!disposed && !pendingUploads.size) scheduleAutosave();
      }
    }

    const insertImage = (url, alt) => {

      const at = body.selectionStart;
      const md = `![${alt || '图片'}](${url})`;
      body.setRangeText(md, at, body.selectionEnd, 'end');
      body.focus();
      touch();
      setState(`已插入 ${url}`);
    };

    // 选择器本体在 media-picker.js（设置页首页封面共用）；这里只决定「选中后怎么插」。
    const picker = window.__setupMediaPicker?.({
      dialog: $('a-picker'),
      body: $('a-picker-body'),
      uploadButton: $('a-picker-upload'),
      fileInput,
      onPick: (it) => insertImage(it.path, (it.filename ?? '').replace(/\.[^.]+$/, '')),
    }) ?? { open: () => fileInput?.click(), dispose() {} };
    disposePicker = () => picker.dispose();
    const openPicker = () => picker.open();

    $('a-upload-btn')?.addEventListener('click', openPicker);

    fileInput?.addEventListener('change', () => {
      const f = fileInput.files?.[0];
      if (f) upload(f);
      fileInput.value = '';
    });

    body.addEventListener('paste', (e) => {
      const item = [...(e.clipboardData?.items ?? [])].find((i) => i.type.startsWith('image/'));
      if (!item) return;
      e.preventDefault();
      const f = item.getAsFile();
      if (f) upload(f);
    });

    body.addEventListener('dragover', (e) => { e.preventDefault(); body.style.borderColor = 'var(--accent)'; });
    body.addEventListener('dragleave', () => { body.style.borderColor = ''; });
    body.addEventListener('drop', (e) => {
      const f = [...(e.dataTransfer?.files ?? [])].find((x) => x.type.startsWith('image/') || x.type.startsWith('video/'));
      body.style.borderColor = '';
      if (!f) return;
      e.preventDefault();
      body.focus();
      upload(f);
    });

    return { form, body, scheduleAutosave, hasPending, dispose: () => {
      // 离开页面前补写一次节流中的草稿，再摘掉全局监听 —— 不摘则每换一页多留一对监听器（disposed 只挡写入）。
      writeDraft();
      disposePicker();
      disposed = true;
      for (const controller of pendingUploads) controller.abort();
      pendingUploads.clear();
      clearTimeout(timer);
      clearTimeout(draftTimer);
      window.removeEventListener('pagehide', onLeave);
      document.removeEventListener('visibilitychange', onHidden);
    } };
  };
})();

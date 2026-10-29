/* —— 检索交互 —— 桌面：导航里一枚放大镜图标，点它**就地展开**输入框；提交走 /search 结果页。
 *   输入框展开时绝对定位在按钮左侧（盖住目录），所以开合不推动导航项。
 *   事件**委托在 document 上、节点用时现查**：页头住在 #app，pjax 换页会把整条换掉，
 *   闭包缓存住旧节点 = 换页后点不动（踩过）。
 *   无 JS 时这套用不了：CSS 会把表单藏掉、露出直接去 /search 的真链接（见 style.css 的 html.* 规则）。
 *   手机抽屉里那枚是常驻输入框，不需要这里管。 */
(() => {
  'use strict';

  const formOf = () => document.querySelector('.nav-search');
  const inputOf = (form) => form?.querySelector('.nav-search-input');
  const isOpen = (form) => form?.getAttribute('data-open') === 'true';

  // 判断节点在不在可见的祖先链上。不能用 getClientRects()/offsetParent：jsdom 里它们恒为空，
  // 而真实窄屏是 `.nav { display:none }` 藏掉整条桌面导航，节点本身仍 computed display: inline-flex。
  const isVisible = (el) => {
    for (let node = el; node && node.nodeType === 1; node = node.parentElement) {
      const style = getComputedStyle(node);
      if (style.display === 'none' || style.visibility === 'hidden') return false;
    }
    return true;
  };

  function open() {
    const form = formOf();
    // ≤620px 时桌面导航整条被 CSS 藏掉；快捷键不能把焦点送进一个不可见的输入框。
    if (!form || !isVisible(form)) return;
    form.setAttribute('data-open', 'true');
    form.querySelector('.nav-search-btn')?.setAttribute('aria-expanded', 'true');
    const input = inputOf(form);
    if (input) { input.tabIndex = 0; input.focus({ preventScroll: true }); input.select(); }
  }
  function close({ clear = false } = {}) {
    const form = formOf();
    if (!form) return;
    const input = inputOf(form);
    const btn = form.querySelector('.nav-search-btn');
    const hadFocus = document.activeElement === input;
    form.setAttribute('data-open', 'false');
    btn?.setAttribute('aria-expanded', 'false');
    if (input) { input.tabIndex = -1; if (clear) input.value = ''; }
    // 收起态输入框不可见（宽度 0），若焦点还在里面就把焦点交还按钮：否则键盘用户对着看不见的框打字、也没有焦点提示。
    if (hadFocus) btn?.focus({ preventScroll: true });
  }
  // 收起态输入框仍在 DOM 里但不可见；把它移出 Tab 序（展开时再放回）。pjax 换页后页头重建，需重跑。
  function syncTab() {
    const input = inputOf(formOf());
    if (input) input.tabIndex = isOpen(formOf()) ? 0 : -1;
  }

  /* —— 点击（委托）—— 图标开合；点窗口外且输入为空则收起。 */
  document.addEventListener('click', (ev) => {
    const t = ev.target;
    if (!t || !t.closest) return;
    const btn = t.closest('.nav-search-btn');
    if (btn) {
      ev.preventDefault();
      const form = btn.closest('.nav-search');
      const input = inputOf(form);
      // 已展开时再点图标 = 提交（等同回车）；空着就只把焦点交回去。
      if (isOpen(form)) { if (input.value.trim()) form.requestSubmit?.(); else input.focus(); return; }
      open();
      return;
    }
    const form = formOf();
    if (!isOpen(form) || form.contains(t)) return;
    if (!inputOf(form).value.trim()) close();
  });

  // 回车提交是表单原生行为；提交即收起（pjax 换页后页头也会重建回收起态）。
  document.addEventListener('submit', (ev) => {
    if (ev.target?.classList?.contains('nav-search')) close();
  });

  // Tab 走开且输入为空 → 收起。
  document.addEventListener('focusout', (ev) => {
    if (!ev.target?.classList?.contains('nav-search-input')) return;
    setTimeout(() => {
      const form = formOf();
      if (!isOpen(form) || form.contains(document.activeElement) || inputOf(form).value.trim()) return;
      close();
    }, 0);
  });

  document.addEventListener('keydown', (ev) => {
    const t = ev.target;
    const typing = t && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.isContentEditable);
    // 模态打开时先把 Esc 让给原生 dialog；否则搜索框会 preventDefault，灯箱反而关不掉。
    if (document.querySelector('dialog[open]')) return;
    // 配色面板等前面的处理器已经消费了这次 Esc：同一按键只关一层。
    if (ev.key === 'Escape' && ev.defaultPrevented) return;
    if (ev.key === 'Escape' && isOpen(formOf())) { ev.preventDefault(); close({ clear: true }); return; }
    const own = document.getElementById('sQ');
    const form = formOf();
    if ((ev.metaKey || ev.ctrlKey) && (ev.key === 'k' || ev.key === 'K')) {
      if (!own && !form) return;
      ev.preventDefault();
      // 已在检索页：聚焦页面自己的输入框，别去够导航这枚
      if (own) { own.focus({ preventScroll: true }); own.select(); } else open();
      return;
    }
    // 输入框里不抢键（不然打「/」会跳走）
    if (typing || ev.metaKey || ev.ctrlKey || ev.altKey) return;
    if (ev.key === '/') {
      if (!own && !form) return;
      ev.preventDefault();
      if (own) { own.focus({ preventScroll: true }); own.select(); } else open();
    }
  });

  syncTab();
  (window.__pjaxHooks = window.__pjaxHooks || []).push(syncTab);
})();

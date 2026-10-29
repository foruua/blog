import { SITE } from '../config.js';
import { esc, csrfField, toLocalInput } from '../util/text.js';
import { assetVer, THEME_BOOT, paletteAttr } from '../render/layout.js';

// 主题/配色引导与前台共用一份内联（外链会闪白）；server.js 对它算 sha256 放进 CSP 白名单。后台不做选色入口，配色跟随前台。
export { THEME_BOOT };


const SVG = (d) => `<svg class="a-ico" viewBox="0 0 20 20" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${d}</svg>`;
const ICO = {
  posts: SVG('<path d="M5.2 3.4h6.4l3.2 3.2v10H5.2z"/><path d="M11.6 3.4v3.2h3.2"/><path d="M7.6 10.4h4.8M7.6 13.2h3.2"/>'),
  notes: SVG('<path d="M13.4 3.6 16.4 6.6 8 15H5v-3z"/><path d="M11.6 5.4l3 3"/>'),
  comments: SVG('<path d="M4 5.2A1.2 1.2 0 0 1 5.2 4h9.6A1.2 1.2 0 0 1 16 5.2v6.4a1.2 1.2 0 0 1-1.2 1.2H9l-3.6 3v-3H5.2A1.2 1.2 0 0 1 4 11.6z"/>'),
  media: SVG('<rect x="3.4" y="4.4" width="13.2" height="11.2" rx="1.4"/><circle cx="7.6" cy="8.4" r="1.3"/><path d="M3.8 13.6 8 9.8l3 2.6 2.4-2 2.8 2.8"/>'),
  system: SVG('<path d="M4 6.2h12M4 13.8h12"/><circle cx="8" cy="6.2" r="1.7"/><circle cx="12.6" cy="13.8" r="1.7"/>'),
  feeds: SVG('<circle cx="5.6" cy="14.4" r="1.5"/><path d="M4 10.4a5.6 5.6 0 0 1 5.6 5.6M4 5.6A10.4 10.4 0 0 1 14.4 16"/>'),

  links: SVG('<path d="M12.6 6h2.4a4.2 4.2 0 0 1 0 8.4h-2.4"/><path d="M7.4 14.4H5a4.2 4.2 0 0 1 0-8.4h2.4"/><path d="M6.9 10.2h6.2"/>'),
  themes: SVG('<path d="M10 3.2a6.8 6.8 0 1 0 0 13.6c1.1 0 1.7-.6 1.7-1.4 0-.8-.5-1.2-.5-2 0-.8.6-1.4 1.5-1.4h1.1a2.7 2.7 0 0 0 2.7-2.7C16.5 6.2 13.6 3.2 10 3.2z"/><circle cx="7.1" cy="7.6" r=".9" fill="currentColor" stroke="none"/><circle cx="10.1" cy="6.2" r=".9" fill="currentColor" stroke="none"/><circle cx="13" cy="7.7" r=".9" fill="currentColor" stroke="none"/>'),
  pages: SVG('<rect x="4.8" y="3.4" width="10.4" height="13.2" rx="1.4"/><path d="M7.4 7.8h5.2M7.4 10.8h3.6"/>'),
  out: SVG('<path d="M11.4 4.4H5.6A1.2 1.2 0 0 0 4.4 5.6v8.8a1.2 1.2 0 0 0 1.2 1.2h5.8"/><path d="M12.6 7.2 15.4 10l-2.8 2.8M15 10H8.4"/>'),
  site: SVG('<path d="M4.6 15.4 15.4 4.6"/><path d="M9.6 4.6h5.8v5.8"/>'),
  more: SVG('<rect x="3.6" y="3.6" width="5.4" height="5.4" rx="1.3"/><rect x="11" y="3.6" width="5.4" height="5.4" rx="1.3"/><rect x="3.6" y="11" width="5.4" height="5.4" rx="1.3"/><rect x="11" y="11" width="5.4" height="5.4" rx="1.3"/>'),
};

export const adminIcon = (key) => ICO[key] ?? '';


const NAV = [
  { group: '内容', items: [
    ['/admin', '文章', 'posts'],
    ['/admin/notes', '笔记', 'notes'],
    ['/admin/pages', '页面', 'pages'],
    ['/admin/comments', '评论', 'comments', 'comments'],
    ['/admin/media', '媒体', 'media'],
  ] },
  { group: '站点', items: [
    ['/admin/feeds', '友圈', 'feeds'],
    ['/admin/links', '友链', 'links'],
    ['/admin/themes', '外观', 'themes'],
    ['/admin/system', '设置', 'system'],
  ] },
];

const railNav = (active, badges = {}) => NAV.map(({ group, items }) => `
      <p class="a-rail-group">${esc(group)}</p>
${items.map(([href, label, key, badgeKey]) => {
  const n = badgeKey ? (badges[badgeKey] ?? 0) : 0;
  return `      <a href="${href}"${key === active ? ' class="on" aria-current="page"' : ''}>${ICO[badgeKey ?? key] ?? ''}<span>${esc(label)}</span>${n ? `<em>${n}</em>` : ''}</a>`;
}).join('\n')}`).join('');

const TABS = [
  { key: 'content', href: '/admin', label: '内容', icon: 'posts', active: ['posts', 'notes', 'pages'] },
  { key: 'comments', href: '/admin/comments', label: '评论', icon: 'comments', badge: 'comments', active: ['comments'] },
  { key: 'media', href: '/admin/media', label: '媒体', icon: 'media', active: ['media'] },
  { key: 'more', href: '/admin/more', label: '更多', icon: 'more', active: ['more', 'feeds', 'links', 'themes', 'system'] },
];

const tabOf = (active) => TABS.find((tab) => tab.active.includes(active))?.key ?? '';

// 手机端的顶部应用栏：只放身份与「看站点」，页面标题留给下方的大标题；编辑页整体隐藏（有自己的吸顶保存条）。
const mobileBar = () => `<header class="a-mbar" data-audit-skip-align>
  <a class="a-mbar-brand" href="/admin"><span class="a-glyph" aria-hidden="true">${esc(monogram())}</span><span class="a-mbar-name">后台</span></a>
  <span class="a-mbar-sp"></span>
  <a class="a-mbar-link" href="/" target="_blank" rel="noopener">看站点</a>
</header>`;

const tabbar = (active, badges = {}) => {
  const current = tabOf(active);
  return `<nav class="a-tabbar" aria-label="后台主导航">
${TABS.map((tab) => {
  const on = current === tab.key;
  const n = tab.badge ? badges[tab.badge] ?? 0 : 0;
  return `  <a href="${tab.href}" class="a-tab${on ? ' on' : ''}"${on ? ' aria-current="page"' : ''}>${ICO[tab.icon]}<span>${tab.label}</span>${n ? `<b class="a-tab-badge">${n}</b>` : ''}</a>`;
}).join('\n')}
</nav>`;
};

const monogram = () => {
  const ch = String(SITE.identity ?? '').trim().slice(0, 1);
  return /[\p{Script=Han}\p{Letter}\p{Number}]/u.test(ch) ? ch : '·';
};

// title/sub/notice 一律当纯文本，转义统一在这里做，调用方不要再 esc()——这两处曾是注入路：访客可控的评论昵称流进「回复评论」副标题、/admin/feeds?w= 的原样反射。page 给 .a-main 挂页面类（样式微调，别改全局）。
const headOf = (title) => `<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1,viewport-fit=cover">
<title>${esc(title)}</title>
<meta name="robots" content="noindex,nofollow">
<meta name="theme-color" content="#f8f8f8" media="(prefers-color-scheme:light)">
<meta name="theme-color" content="#0b0b0b" media="(prefers-color-scheme:dark)">
<link rel="icon" href="/favicon.svg?v=${assetVer('favicon.svg')}" type="image/svg+xml">
<link rel="stylesheet" href="/base.css?v=${assetVer('base.css')}">
<link rel="stylesheet" href="/admin.css?v=${assetVer('admin.css')}">
<script>${THEME_BOOT}</script>
</head>`;

export function adminLayout({
  title, sub = '', actions = '', body, active = '', csrf = '', notice = '', badges = {},
  page = '', kicker = '',
}) {
  return `<!DOCTYPE html>
<html lang="${esc(SITE.lang)}"${paletteAttr()}>
${headOf(`${title} · ${SITE.identity} 后台`)}
<body class="admin${page ? ` page-${esc(page)}` : ''}"
      data-admin-editor-src="/admin-editor.js?v=${assetVer('admin-editor.js')}"
      data-editor-src="/editor.js?v=${assetVer('editor.js')}"${page === 'is-editor' ? ' data-editor-inline="1"' : ''}>
<div id="progress" aria-hidden="true"></div>
<div id="app">
${mobileBar()}
<div class="a-app">
  <aside class="a-rail">
    <div class="a-rail-head">
      <a class="a-brand" href="/admin">
        <span class="a-glyph" aria-hidden="true">${esc(monogram())}</span>
        <span class="a-brand-name">${esc(SITE.identity)}<em class="a-tag">后台</em></span>
      </a>
    </div>
    <nav class="a-rail-nav" aria-label="后台导航">
${railNav(active, badges)}
    </nav>
    <div class="a-rail-foot">
      <a href="/" target="_blank" rel="noopener">${ICO.site}看站点</a>
      <form method="post" action="/admin/logout">
        ${csrfField(csrf)}
        <button type="submit">${ICO.out}退出</button>
      </form>
    </div>
  </aside>

  <main class="a-main${page ? ` ${page}` : ''}">
    <header class="a-head">
      <div class="a-head-lead">
${kicker ? `        <p class="a-kicker">${esc(kicker)}</p>\n` : ''}        <h1 class="a-h1">${esc(title)}${sub ? `<span class="a-sub">${esc(sub)}</span>` : ''}</h1>
      </div>
      ${actions ? `<div class="a-actions">\n        ${actions}\n      </div>` : ''}
    </header>
${notice ? `    <p class="a-notice">${esc(notice)}</p>\n` : ''}${body}
  </main>
</div>
${tabbar(active, badges)}
</div>

<dialog class="a-modal" id="a-modal" aria-labelledby="a-modal-title" aria-describedby="a-modal-body a-modal-note">
  <form method="post" id="a-modal-form">
    ${csrfField(csrf)}
    <h2 class="a-modal-title" id="a-modal-title"></h2>
    <p class="a-modal-body" id="a-modal-body"></p>
    <p class="a-modal-note" id="a-modal-note" hidden></p>
    <div class="a-modal-actions">
      <button type="button" class="a-btn-ghost" data-modal-cancel autofocus>取消</button>
      <button type="submit" class="a-btn-danger" data-modal-ok>确认删除</button>
    </div>
  </form>
</dialog>

<script src="/request.js?v=${assetVer('request.js')}" defer></script>
<script src="/ui.js?v=${assetVer('ui.js')}" defer></script>
<script src="/nav.js?v=${assetVer('nav.js')}" defer></script>
<!-- media-picker 与 admin 全站加载；编辑器两件套只在编辑器页输出。后台导航走 pjax 时，
     从非编辑器页进编辑器由 admin.js 按 body 上的 data-*-src 动态补载，再初始化，避免每个后台页
     都白下载/解析约 20KB 编辑器脚本。 -->
<script src="/media-picker.js?v=${assetVer('media-picker.js')}" defer></script>
<script src="/admin.js?v=${assetVer('admin.js')}" defer></script>
${page === 'is-editor' ? `<script src="/admin-editor.js?v=${assetVer('admin-editor.js')}" defer></script>
<script src="/editor.js?v=${assetVer('editor.js')}" defer></script>` : ''}
</body>
</html>`;
}

export function loginPage({ notice = '', to = '/admin', configured = true } = {}) {
  return `<!DOCTYPE html>
<html lang="${esc(SITE.lang)}"${paletteAttr()}>
${headOf(`登录 · ${SITE.identity} 后台`)}
<body class="admin a-login-body">
<div class="a-login-wrap">
  <div class="a-login-panel">
    <span class="a-login-mono" aria-hidden="true">${esc(monogram())}</span>
    ${SITE.mark ? `<p class="a-login-mark">${esc(SITE.mark)}</p>` : ''}
    <h1 class="a-login-title">${esc(SITE.identity)}</h1>
    <p class="a-login-lede">写作者的控制台</p>
    ${notice ? `<p class="a-notice">${esc(notice)}</p>` : ''}
    <div class="a-login-card">
${configured ? `    <form method="post" action="/admin/login">
      <input type="hidden" name="to" value="${esc(to)}">
      <div class="a-field">
        <label for="pw">密码</label>
        <input class="a-input" id="pw" name="password" type="password" autocomplete="current-password" required autofocus>
      </div>
      <p class="a-actions"><button type="submit" class="a-btn a-btn-block">进入后台</button></p>
    </form>`
  : `    <p class="a-dim">未设置后台密码。请先在服务器上运行 <code>npm run set-password</code>。</p>`}
    </div>
    <a class="a-login-back" href="/">← 回到站点</a>
  </div>
</div>
</body>
</html>`;
}

// 用站点展示时区（SITE_TZ_OFFSET，默认 +08:00）；以前按 UTC 原样输出，同一篇在列表与编辑器里会差 8 小时。
const shortTime = (s) => {
  if (!s) return '—';
  try { return toLocalInput(String(s)).replace('T', ' ').slice(0, 16); }
  catch { return String(s).replace('T', ' ').replace('Z', '').slice(0, 16); }
};

export { shortTime };

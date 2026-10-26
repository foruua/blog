import { createAssetVersions } from './assets.js';
import { SITE, PUBLIC_DIR } from '../config.js';
import { esc, monthCn, cleanExcerpt, relativeDate, contentUrl, absUrl } from '../util/text.js';
import { PALETTES, CUSTOM_PALETTE, LAYOUTS } from '../settings.js';
import { navItemsOf, visibleNavOf } from '../site/nav.js';
import { lightboxHtml } from './lightbox.js';
import { emojiPanelTemplate } from '../comments/view.js';
import { ICON_COPYRIGHT } from './icons.js';
import { themeRequest } from '../themes/request.js';

// 带内容指纹的静态资源；server.js 也 import 这份生成「可长期缓存」正则——两处必须同一份，否则新增资源必漏。
export const VERSIONED_ASSETS = ['base.css', 'style.css', 'app.js', 'nav.js', 'admin.css', 'admin.js', 'admin-editor.js', 'media-picker.js', 'editor.js', 'favicon.svg', 'icon-192.png', 'icon-512.png', 'icon-maskable-512.png', 'apple-touch-icon.png', 'og-default.jpg', 'police-badge.png', 'icp-badge.png', 'request.js', 'ui.js', 'search.js', 'palette.js'];

// —— 主题钩子 ——
// server.js 在启动时注入「当前请求该用哪套主题」和「如何渲染主题模板」；测试或未启用主题时保持内置渲染。
// 这样 public.js 不必逐条路由知道主题存在，layout() 仍是唯一出口。
let themeResolver = () => null;
let themeRenderer = null;
let themeErrorLogger = (error) => console.error('[theme] 渲染失败，回退默认渲染：', error);
export const setThemeResolver = (fn) => { themeResolver = typeof fn === 'function' ? fn : () => null; };
export const setThemeRenderer = (fn) => { themeRenderer = typeof fn === 'function' ? fn : null; };
export const setThemeErrorLogger = (fn) => { themeErrorLogger = typeof fn === 'function' ? fn : (error) => console.error('[theme]', error); };

// 主题引导必须内联在 <head>（外链会闪白），靠 CSP 的 sha256 白名单放行；server.js 对该常量算哈希。

// —— 访客可选配色（html[data-palette]）——
// 清单（唯一真相源）在 src/settings.js 的 PALETTES，这里 re-export；白名单两层：THEME_BOOT 挡访客 localStorage 非法值，settings.paletteDefault 挡站主默认值。
export { PALETTES, LAYOUTS };
const PALETTE_WHITELIST = JSON.stringify(PALETTES.filter((p) => p.key).map((p) => p.key));

// 自定义配色存在 localStorage 里的是**整段算好的 CSS**（见 public/palette.js），不是种子：
// 首帧不该为了配色去加载生成器、更不该等它算完再画。代价是这段 CSS 来自可写存储，得先过闸。
// 字符集白名单挡掉 url( / @import / 标签 / 反斜杠转义 —— 这四项之外，CSS 也拿不到外部资源。
// 注意：public/palette.js 的 sanitize() 是同一道闸，两边必须同步放宽；test-palette 会拿生成器
// 的输出逐个喂给这道闸，放宽过头会当场失败。
const PALETTE_CSS_GUARD = /^[#0-9a-z(),.;:%\s\-[\]{}"=+@]{1,8000}$/i;
// 禁词用 \x3c \x3e 而不是 < >：这两个正则会被 toString 进 <head> 的内联脚本，字面尖括号会让
// 「抠 <script> 内容」的解析（以及任何按 < 分段的工具）误判脚本到此结束。
const PALETTE_CSS_BANNED = /[\x3c\x3e]|url\(|@import|expression/i;
// 导出给 test-palette.mjs：它拿生成器的输出逐个喂这道闸。闸放松了而生成器没跟上（或反过来）
// 会当场失败 —— 这两份正则必须与 public/palette.js 的 sanitize() 同步放宽。
export { PALETTE_CSS_GUARD, PALETTE_CSS_BANNED };

// 结构化数据：WebSite 全站一份，文章页再叠 BlogPosting + BreadcrumbList。
// JSON-LD 是数据块（type 不是可执行脚本），不参与 CSP 的内联脚本哈希；< 转义防止内容里出现 </script>。
const jsonLdHtml = (value) => {
  const list = Array.isArray(value) ? value : (value ? [value] : []);
  return list
    .filter(Boolean)
    .map((item) => `<script type="application/ld+json">${JSON.stringify(item).replace(/</g, '\\u003c')}</script>`)
    .join('\n');
};

const websiteLd = () => ({
  '@context': 'https://schema.org',
  '@type': 'WebSite',
  name: SITE.identity,
  url: `${SITE.url}/`,
  description: SITE.desc,
  inLanguage: SITE.lang,
  potentialAction: {
    '@type': 'SearchAction',
    target: `${SITE.url}/search?q={search_term_string}`,
    'query-input': 'required name=search_term_string',
  },
});

export const THEME_BOOT = "document.documentElement.classList.add('has-js');"
  + "try{var theme=localStorage.getItem('theme');if(theme==='light'||theme==='dark')document.documentElement.dataset.theme=theme;"
  // 配色四态：无 key = 跟随服务端默认；'' = 明确选素笺；预设 key = 覆盖；'custom' = 用本地算好的那段 CSS。
  // 白名单外脏值不认——localStorage 访客可写，别让它把任意值塞进 data-palette。
  + "var pal=localStorage.getItem('palette');"
  + "if(pal===null){}"
  + "else if(pal===''){document.documentElement.removeAttribute('data-palette');}"
  + `else if(pal==='${CUSTOM_PALETTE}'){var css=localStorage.getItem('palCustom');`
  + `if(css&&${PALETTE_CSS_GUARD}.test(css)&&!${PALETTE_CSS_BANNED}.test(css)){`
  + "var st=document.createElement('style');st.id='palCustom';st.textContent=css;document.head.appendChild(st);"
  // 种子顺便挂到 dataset 上：面板要读它把滑块摆回原位。从 CSS 里正则抠出来，就不必再开一个
  // localStorage 键 —— 单键存储不会出现「种子和值对不上」的半截状态。--seed-lv 是旧版字段，
  // 新面板优先读 --seed-c / --seed-p / --seed-k；旧 CSS 缺后三个时按 1 / 1 / 0 回读。
  + "var m=/--seed-h:(\\d{1,3});--seed-lv:([a-z]+)/.exec(css);"
  + "if(m){document.documentElement.dataset.seedH=m[1];document.documentElement.dataset.seedLv=m[2];}"
  + "var mc=/--seed-c:([\\d.]+)/.exec(css);if(mc)document.documentElement.dataset.seedC=mc[1];"
  + "var mp=/--seed-p:([\\d.]+)/.exec(css);if(mp)document.documentElement.dataset.seedP=mp[1];"
  + "var mk=/--seed-k:(-?[\\d.]+)/.exec(css);if(mk)document.documentElement.dataset.seedK=mk[1];"
  + "document.documentElement.dataset.palette='custom';}}"
  + `else if(${PALETTE_WHITELIST}.indexOf(pal)>-1){document.documentElement.dataset.palette=pal;}`
  + "}catch(e){}"
  // 版式三态：无 key = 跟随服务端默认；'paper' = 明确选纸面（把服务端挂的 data-layout 摘掉）；
  // 'box' = 素匣。白名单外脏值不认 —— 与配色同一道闸，localStorage 是访客可写的。
  + "try{var ly=localStorage.getItem('layout');"
  + "if(ly==='paper'){document.documentElement.removeAttribute('data-layout');}"
  + "else if(ly==='box'){document.documentElement.dataset.layout='box';}"
  + "}catch(e){}"
  // 首帧就把浏览器界面色改成实际纸色：服务端只能写死两条按系统偏好兜底的 hex，访客切了配色/明暗后
  // 手机状态栏要等到 ui.js 才跟着变，部分 WebView 会一直停在首帧的值。这里在 <head> 里同步算一次
  // （样式表已阻塞解析，自定义 style 也刚注入），后面主题/配色再变由 ui.js 的 syncThemeColor 接管。
  + "try{var bg=getComputedStyle(document.documentElement).backgroundColor;"
  + "if(bg&&bg!=='transparent'&&bg!=='rgba(0, 0, 0, 0)'){"
  + "var ms=document.head.querySelectorAll('meta[name=\"theme-color\"]');"
  + "for(var i=ms.length-1;i>=0;i--)ms[i].remove();"
  + "var mt=document.createElement('meta');mt.setAttribute('name','theme-color');mt.setAttribute('content',bg);document.head.appendChild(mt);"
  + "}}catch(e){}";

// 资源指纹 = 内容哈希 + 构建盐。「精简/打包方式变了但源文件没变」时要手动把盐 +1：指纹只认内容，
// 不改盐的话 CDN 会按 immutable 把旧产物缓存住一年（刚踩过：开了精简、指纹没变，CF 一直发旧的非精简版）。
const ASSET_BUILD = 'm2';
// 生产：资源只在部署时变，指纹缓存按小时计（一页要问十次，同步 statSync 全在请求路径上）。
// 开发：1 秒，改完样式刷新就能看到新指纹。
export const assetVer = createAssetVersions(PUBLIC_DIR, {
  salt: ASSET_BUILD,
  ttlMs: process.env.NODE_ENV === 'production' ? 3_600_000 : 1000,
});


// —— 导航与页脚的数据源 ——
// 两者都在后台可改（设置 → 导航菜单 / 页脚与社交），由 server.js 在启动时注入读取函数。
// 不在这里直接 import 站点配置模块：那会把 sharp（图标生成）拖进每一次纯渲染调用，
// 包括所有不碰图标的渲染测试。
let pagesOf = () => [];
export const setNavPages = (fn) => { pagesOf = typeof fn === 'function' ? fn : () => []; };

let navSourceOf = () => null;   // () => { items, moreLabel } | null
export const setNavSource = (fn) => { navSourceOf = typeof fn === 'function' ? fn : () => null; };

/**
 * 菜单：有注入的读取函数就用它（含后台改过的顺序/名称/显隐），否则按出厂清单 + 固定页现算。
 * 出厂那条路是测试与「未接入 server.js 的独立挂载」的兜底，保证任何情况下导航都不空。
 */
function navFacts() {
  const injected = navSourceOf();
  if (injected && Array.isArray(injected.items)) {
    return { items: injected.items, moreLabel: injected.moreLabel || '页面' };
  }
  return { items: navItemsOf(null, pagesOf() ?? []), moreLabel: '页面' };
}

// 站主选的「访客默认配色」：直接挂 <html>；访客没选过（localStorage 无合法值）时首帧即此，选过的由 THEME_BOOT 覆盖。
let paletteDefaultOf = () => '';
export const setPaletteDefault = (fn) => { paletteDefaultOf = typeof fn === 'function' ? fn : () => ''; };
const sitePaletteDefault = () => paletteDefaultOf();
export const paletteAttr = () => {
  const key = paletteDefaultOf();
  return key ? ` data-palette="${esc(key)}"` : '';
};

// 主题模板的自动转义会把属性值两侧的引号变成 &#34;（浏览器读成值的一部分，选择器就匹配不上）。
// 配色 key 已由白名单校验、只含 [a-z-]，用无引号写法既合法又不必要求模板写 | raw。
const themePaletteAttr = () => {
  const key = paletteDefaultOf();
  return key ? ` data-palette=${key}` : '';
};

// 站主选的「访客默认版式」：与配色同一条路 —— 服务端直接挂 <html data-layout="box">，
// 访客自己选过的由 THEME_BOOT 覆盖。纸面是默认，不挂属性（少一个属性，样式里也好写 :not）。
let layoutDefaultOf = () => '';
export const setLayoutDefault = (fn) => { layoutDefaultOf = typeof fn === 'function' ? fn : () => ''; };
export const layoutAttr = () => (layoutDefaultOf() === 'box' ? ' data-layout="box"' : '');
const themeLayoutAttr = () => (layoutDefaultOf() === 'box' ? ' data-layout=box' : '');

// —— 检索入口 ——
// 桌面：导航里一枚放大镜图标，点它**就地展开**搜索框；提交走 /search 结果页。手机：抽屉里一枚常驻搜索框。
// 无 JS 时展开那套用不了，另给一枚真链接兜底（has-js 由 <head> 的引导脚本挂上，见 style.css 的两条 html.* 规则）。
const SEARCH_ICO = '<svg class="so-ico" viewBox="0 0 20 20" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" aria-hidden="true"><circle cx="8" cy="8" r="5.6"/><path d="M12.3 12.3 17 17"/></svg>';
const searchNavForm = () => `<form class="nav-search" action="/search" method="get" role="search">
        <label class="sr-only" for="navSearchQ">检索</label>
        <button class="nav-search-btn" type="button" aria-label="检索" aria-expanded="false" aria-controls="navSearchQ">${SEARCH_ICO}</button>
        <input class="nav-search-input" id="navSearchQ" type="search" name="q" placeholder="检索" aria-keyshortcuts="Control+K Meta+K /" autocomplete="off" spellcheck="false">
      </form>
      <a class="nav-search-fallback" href="/search" aria-label="检索">${SEARCH_ICO}</a>`;
// 窄屏抽屉里的检索：一枚常驻搜索框。抽屉本身只在窄屏 display:block。
const searchDrawerForm = () => `<form class="s-drawer-form" action="/search" method="get" role="search">
      <label class="sr-only" for="sDrawerQ">检索</label>
      ${SEARCH_ICO}
      <input class="s-drawer-input" id="sDrawerQ" type="search" name="q" placeholder="检索" autocomplete="off" spellcheck="false">
      <button class="s-drawer-go" type="submit">搜索</button>
    </form>`;

// 配色选择器：宽屏在首页 hero-meta 那一行、窄屏在抽屉底部工具条，各一份（同一个模板，id 不同）。访客存了选择时由 ui.js 首帧对齐。
// 页头导航里没有它 —— 样式是低频偏好，不占导航（test-search 的 M8f 钉着这条）。
// 面板里「明暗 / 版式 / 配色」三段并列：明暗管纸的明暗，版式管内容装不装进匣子，配色管纸墨的色调 ——
// 都是"选一个生效的状态"，故同一套 aria-pressed 按钮，不再用早先页脚那枚写着"下一个动作"（显示「暗色」
// 其实是点了会变暗）的开关。版式只有两格，用图标 + 名称并排；配色是五行带色样的长条，故单独分段。
// 「自定义」区只预置当前预设的种子（色相 / 浓度 / 纸色），真正的令牌由 ui.js 按需调 PaletteLib 现算，
// 服务端不生成那段 CSS。初始值取当前生效预设 —— 从「青瓷」滑进自定义时观感要接得上，不能一拖就跳色。
// 入口图标与明暗三态的「跟随系统」同形：半实心圆盘 —— 样式管的是整套外观（明暗/版式/配色），
// 半实半空正好读作「外观有一半可换」。轮廓仍是圆，缩到 14px 也不散形。
// 同一批候选做过 48 / 24 / 14 三档 + 明暗对照，记录在本地沙盒 docs/design/style-icon/round2.html
// （design/ 在 .gitignore 里，不进仓库 —— 这里写明路径是给手边有这份文件的人看的）。
// 20 格画布、1.6 描边，与检索、明暗三态同一套规格。
const PAL_ICO = '<svg class="pal-ico" viewBox="0 0 20 20" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><circle cx="10" cy="10" r="7.2"/><path d="M10 2.8a7.2 7.2 0 0 0 0 14.4z" fill="currentColor" stroke="none"/></svg>';
// 订阅入口：点 + 两道弧。viewBox 收到 3.25 3.6 12.05 12.05，把图形撑到上面那枚同样的 12px，
// 描边跟着收到 0.97（≈1.2px）；两枚图标的图形框、线宽、上下留白由此一致。
const RSS_ICO = '<svg class="ico-rss" viewBox="3.25 3.6 12.05 12.05" fill="none" stroke="currentColor" stroke-width="0.97" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><circle cx="5.6" cy="13.3" r="1.15" fill="currentColor" stroke="none"/><path d="M4.5 9.3a5.1 5.1 0 0 1 5.1 5.1"/><path d="M4.5 4.8a9.6 9.6 0 0 1 9.6 9.6"/></svg>';

// 明暗三态的三枚图标：面板内自成一套（20 格画布、1.6 描边），缩到 16px 仍是实心/空心的对比。
// 名称不写进按钮里 —— 图标就是那一格的全部内容，名称只留给读屏（aria-label）与悬停（title）。
const TM_ICO = (inner) => `<svg class="tm-ico" viewBox="0 0 20 20" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${inner}</svg>`;
const TM_ICON = {
  auto: TM_ICO('<circle cx="10" cy="10" r="7.2"/><path d="M10 2.8a7.2 7.2 0 0 0 0 14.4z" fill="currentColor" stroke="none"/>'),
  light: TM_ICO('<circle cx="10" cy="10" r="3.5"/><path d="M10 2.4v2M10 15.6v2M2.4 10h2M15.6 10h2M4.7 4.7l1.4 1.4M13.9 13.9l1.4 1.4M15.3 4.7 13.9 6.1M6.1 13.9 4.7 15.3"/>'),
  dark: TM_ICO('<path d="M15.6 12.1A6.2 6.2 0 0 1 7.9 4.4a6.2 6.2 0 1 0 7.7 7.7z"/>'),
};

// 版式两格的图标（20 格画布、1.6 描边，与明暗三态同一套规格）：左边只有几行字 = 内容直接铺在纸上；
// 右边一个圆角框 + 框内两行字 = 内容收进匣子。15px 下也读得出「有框 / 没框」这一件事。
const LY_ICO = (inner) => `<svg class="ly-ico" viewBox="0 0 20 20" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${inner}</svg>`;
const LY_ICON = {
  paper: LY_ICO('<path d="M4 5.4h12M4 9.4h12M4 13.4h7.4"/>'),
  box: LY_ICO('<rect x="3" y="3.8" width="14" height="12.4" rx="2.2"/><path d="M6.6 8.2h6.8M6.6 11.2h6.8"/>'),
};
// 名称与悬停提示取自 settings.js 的 LAYOUTS（后台下拉用的是同一份），这里只建索引。
const LAYOUT_LABEL = Object.fromEntries(LAYOUTS.map((l) => [l.key, l]));

const palettePanelHtml = (cur) => `<div class="pal-panel">
        <div class="pal-theme" role="group" aria-label="明暗">
          <button type="button" class="pal-tm" data-theme-opt="auto" aria-pressed="false" aria-label="跟随系统" title="跟随系统">${TM_ICON.auto}</button>
          <button type="button" class="pal-tm" data-theme-opt="light" aria-pressed="false" aria-label="亮色" title="亮色">${TM_ICON.light}</button>
          <button type="button" class="pal-tm" data-theme-opt="dark" aria-pressed="false" aria-label="暗色" title="暗色">${TM_ICON.dark}</button>
        </div>
        <div class="pal-rule" role="separator"></div>
        <div class="pal-lyt" role="group" aria-label="版式">
          <button type="button" class="pal-ly" data-layout-opt="paper" aria-pressed="false" title="${esc(LAYOUT_LABEL.paper.hint)}">${LY_ICON.paper}<span class="pal-ly-name">${esc(LAYOUT_LABEL.paper.name)}</span></button>
          <button type="button" class="pal-ly" data-layout-opt="box" aria-pressed="false" title="${esc(LAYOUT_LABEL.box.hint)}">${LY_ICON.box}<span class="pal-ly-name">${esc(LAYOUT_LABEL.box.name)}</span></button>
        </div>
        <div class="pal-rule" role="separator"></div>
        ${PALETTES.map((p) => `<button type="button" class="pal-opt" data-palette="${p.key}" data-hue="${p.hue}" data-chroma="${p.chroma}" aria-pressed="false"><i class="pal-sw" style="--sw-paper:${p.paper};--sw-ink:${p.ink}" aria-hidden="true"></i><span class="pal-name">${p.name}</span></button>`).join('\n        ')}
        <div class="pal-custom" data-hue="${cur.hue}" data-chroma="${cur.chroma}" data-paper="1">
          <div class="pal-head">
            <span class="pal-lb">自定义</span>
            <output class="pal-hue-out">${cur.hue}°</output>
          </div>
          <input type="range" class="pal-hue" min="0" max="359" step="1" value="${cur.hue}" aria-label="色相">
          <div class="pal-row">
            <span class="pal-lb">浓淡</span>
            <output class="pal-chroma-out">${Math.round(cur.chroma * 100)}%</output>
          </div>
          <input type="range" class="pal-chroma" min="0.55" max="1.45" step="0.01" value="${cur.chroma}" aria-label="浓淡">
          <div class="pal-row">
            <span class="pal-lb">纸色</span>
            <output class="pal-paper-out">100%</output>
          </div>
          <input type="range" class="pal-paper" min="0" max="1.8" step="0.05" value="1" aria-label="纸色">
        </div>
      </div>`;

// 入口只有一枚，只出现在首页 hero-meta 那一行：当前是哪套不进入口，面板里那一行有 ✓。色名留给读屏（aria-label）。
// 面板锚在整行下方居中展开（pal-hero）。页头导航、页脚、窄屏抽屉底部都不再放 —— 别再加回来，test-search 的 M8f 会当场失败。
const palettePickerHtml = (palDefault = '') => {
  const cur = PALETTES.find((p) => p.key === palDefault) ?? PALETTES[0];
  return `<details class="pal pal-hero" id="palettePickerH">
      <summary aria-label="样式（${esc(cur.name)}）" title="样式">${PAL_ICO}</summary>
      ${palettePanelHtml(cur)}
    </details>`;
};

/** 首页 hero-meta 那一行的两枚工具：RSS 与配色。图标式入口 —— 与两侧「N 篇文章」同一层小字，不抢视线。
 *  两枚之间也是同一枚「·」（与行内其它分隔符同形同色），间距与行内其它分隔对齐 —— 图形和文字一视同仁。
 *  配色面板锚在整行中间（见 style.css 的 .pal-hero）：锚在 24px 的图标上，窄屏会顶出视口。 */
export const heroToolsHtml = (palDefault = sitePaletteDefault()) => `<span class="hero-tools">
        <a class="hero-tool" href="/feed.xml" aria-label="RSS 订阅" title="RSS 订阅">${RSS_ICO}</a>
        <span class="sep" aria-hidden="true">·</span>
        ${palettePickerHtml(palDefault)}
      </span>`;


// —— 导航图标 —— 20 格画布、1.6 描边、圆头圆角，与「检索」「配色」同一套规格，缩到 14px 仍是一块读得出的轮廓。
// 按 key 取（导航项用它自己的 key，固定页用 slug）；认不出的落回「折角纸页」—— 站主新加一页不必改代码。
// 全部 aria-hidden：链接的可访问名仍只有那两个字，读屏不会念出图形。
const NAV_ICO_SVG = (inner) => `<svg class="n-ico" viewBox="0 0 20 20" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${inner}</svg>`;

const NAV_ICO = {
  // 屋顶 + 山墙 + 门：屋脊比墙线宽出去一点，缩到 14px 才不会缩成一个「人」字。
  home: NAV_ICO_SVG('<path d="M3.6 8.9 10 3.7l6.4 5.2"/><path d="M5.4 8.1v8.1h9.2V8.1"/><path d="M8.3 16.2v-4.1h3.4v4.1"/>'),
  // 一页正文：外框 + 三行字（末行短），与「笔记」的铅笔、「归档」的盒子区分得开。
  posts: NAV_ICO_SVG('<rect x="4.4" y="3.2" width="11.2" height="13.6" rx="1.8"/><path d="M7.4 7.4h5.2M7.4 10.4h5.2M7.4 13.4h3"/>'),
  // 铅笔：斜杆 + 笔尖，「写下来」这件事不需要别的装饰。
  notes: NAV_ICO_SVG('<path d="M13.7 3.1a1.8 1.8 0 0 1 2.5 2.5L5.9 15.9l-3.3.8.8-3.3z"/><path d="M12.4 4.4 15.4 7.4"/>'),
  // 「页面」这枚是容器不是内容：用文件夹，说明点开是一组，而不是又要跳走。
  pages: NAV_ICO_SVG('<path d="M3.2 6.6c0-.8.6-1.4 1.4-1.4h3l1.6 2h6.2c.8 0 1.4.6 1.4 1.4v6.8c0 .8-.6 1.4-1.4 1.4H4.6c-.8 0-1.4-.6-1.4-1.4z"/>'),
  // 双人：前人画全（头 + 肩），后人只露半张脸（右弯的月牙）—— 14px 下多画一截肩只会变成一道飘着的短线。
  friends: NAV_ICO_SVG('<circle cx="7.9" cy="7.5" r="2.5"/><path d="M3.5 16.4c0-2.4 2-4.4 4.4-4.4s4.4 2 4.4 4.4"/><path d="M13.4 5.6a2.3 2.3 0 0 1 0 4.5"/>'),
  // 链环：两只开口相对的钩 + 中间一段，交叠处才不像一根实心斜棒。
  links: NAV_ICO_SVG('<path d="M8.3 10.8a4.2 4.2 0 0 0 6.28.45l2.5-2.5a4.2 4.2 0 0 0-5.89-5.89l-1.43 1.43"/><path d="M11.7 9.2a4.2 4.2 0 0 0-6.28-.45l-2.5 2.5a4.2 4.2 0 0 0 5.89 5.89l1.43-1.43"/>'),
  // 归档盒：盖 + 箱体 + 把手，一眼是「收起来」而不是「又一篇文章」。
  archive: NAV_ICO_SVG('<rect x="3.4" y="4.4" width="13.2" height="3.6" rx="1.1"/><path d="M5.2 8v6.4c0 .9.7 1.6 1.6 1.6h6.4c.9 0 1.6-.7 1.6-1.6V8"/><path d="M8.5 11.2h3"/>'),
  // 关于：圆里一个 i，与「文章」的外框页、「笔记」的铅笔都不撞。
  about: NAV_ICO_SVG('<circle cx="10" cy="10" r="6.6"/><path d="M10 9.2v4.4"/><path d="M10 6.5h.01"/>'),
  // 兜底：折角纸页。
  page: NAV_ICO_SVG('<path d="M5.2 3.4h5.6l4.6 4.6v8.6H5.2z"/><path d="M10.8 3.4V8h4.6"/>'),
};
const navIco = (key) => NAV_ICO[key] ?? NAV_ICO.page;

// 标签是页面标题（用户内容），一律转义。
// 图标在 <a> 里、文字包一层 .n-txt：图标不参与可访问名，链接读出来仍是「文章」，与加图标前一致。
const navLink = (active) => ([href, label, key]) =>
  `<a href="${esc(href)}"${key === active ? ' aria-current="page"' : ''}>${navIco(key)}<span class="n-txt">${esc(label)}</span></a>`;
// 二级里若是当前页，触发器自己也高亮（data-current）——否则会「人在某页、导航却看不出」，不必再扫一眼才认出。
// main/more 的划分与顺序都来自后台（site/nav.js），这里只负责标记；more 为空时整块下拉不出现。
const navHtml = (active, { main = [], more = [], moreLabel = '页面' } = {}) => {
  const moreCurrent = more.some(([, , key]) => key === active);
  const dropdown = more.length
    ? `<details class="nsub"><summary${moreCurrent ? ' data-current="true"' : ''}>${navIco('pages')}<span class="n-txt">${esc(moreLabel)}</span></summary>` +
      `<div class="nsub-panel">${more.map(navLink(active)).join('')}</div></details>`
    : '';
  return [...main.map(navLink(active)), dropdown].filter(Boolean).join('');
};

// 窄屏抽屉是一页满屏目录：图标 + 衬线标题 + 右端等宽序号（序号给眼睛认位置，对辅助技术隐藏）。
// 图标在左、序号在右 —— 两者分居两端，中间那行字才不被挤成三列。
// 导航项由 themeChrome 算好的 items 传入（与顶部导航同一份）；不再留默认参数，免得漏传时又算一遍 pageMenuItems()。
const navDrawerHtml = (active, items) => items.map(([href, label, key], i) =>
  `<li><a href="${esc(href)}"${key === active ? ' aria-current="page"' : ''}>${navIco(key)}<span>${esc(label)}</span><span class="n-idx" aria-hidden="true">${String(i + 1).padStart(2, '0')}</span></a></li>`).join('\n      ');

// 站点默认分享图：文章没有首图时用它。layout() 内部兜底与 public.js 的 OG/JSON-LD 共用这一份
// （以前 public.js 又抄了一份常量，改默认图要记得改两处）。图本身由 npm run make:og 生成。
export const defaultOgImage = () => ({
  url: absUrl(`/og-default.jpg?v=${assetVer('og-default.jpg')}`),
  width: 1200,
  height: 630,
  alt: SITE.identity,
});

const mainHtmlOf = (page, main) => `<main id="main" tabindex="-1"${page === 'home' ? ' class="home-main"' : ''}>\n${main}\n  </main>`;
const emojiTplOf = (main) => (String(main ?? '').includes('data-emoji-toggle') || String(main ?? '').includes('data-comments-slot')
  ? `\n${emojiPanelTemplate()}` : '');

/** 把一次 layout() 的参数整理成 head / chrome / 主题上下文共用的结构。 */
function layoutContext({
  title = '', main = '', desc = SITE.desc, canonical = '/', active = '',
  ogType = 'website', noindex = false, extraHead = '', jsonLd = null,
  page = '', ogImage = null, lang = '', themeType = '', themeData = null,
}) {
  const fullTitle = title
    ? (SITE.title ? `${esc(title)} · ${esc(SITE.title)}` : esc(title))
    : esc(SITE.identity);
  // 分享图：调用方给文章首图；没给就用站点默认图。宽高只在是正整数时输出，避免把 undefined 写进 meta。
  const og = ogImage ?? defaultOgImage();
  const ogW = Number(og.width) > 0 ? Math.round(Number(og.width)) : 0;
  const ogH = Number(og.height) > 0 ? Math.round(Number(og.height)) : 0;
  // frontmatter 的 lang 常写成 `zh` 这种不带地区的形态，而 og:locale 要 language_TERRITORY。
  // 只有它自带地区（如 en-US）时才覆盖站点默认值，别替作者猜一个地区出来。
  const ogLocale = String(lang?.includes('-') ? lang : (SITE.lang || 'zh-CN')).replace('-', '_');
  // WebSite 每页都有；调用方传进来的文章/面包屑等叠在后面。
  const structuredData = [websiteLd(), ...(Array.isArray(jsonLd) ? jsonLd : (jsonLd ? [jsonLd] : []))];

  // 导航三份视图：顶栏（main）、「页面」下拉（more）、抽屉（两者拼起来，保持顶栏在前）。
  // 三元组 [href, label, key] 是与主题上下文共用的老口径，别在这里改成对象——themeChrome 与模板都按它解构。
  const menu = navFacts();
  const groups = visibleNavOf(menu.items);
  const triple = ({ href, label, key }) => [href, label, key];
  const navGroups = { main: groups.main.map(triple), more: groups.more.map(triple), moreLabel: menu.moreLabel };
  const items = groups.all.map(triple);

  // 站名：域名里的点换成五角星（.bmark）。点被换掉会丢语义，故补一个只给读屏器的「.」，五角星对辅助技术隐藏；只拆第一处。
  const brandHtml = (() => {
    if (!SITE.title) return '';
    const dot = SITE.title.indexOf('.');
    const head = dot < 0 ? SITE.title : SITE.title.slice(0, dot);
    // 印面（.bseal）字母挂 data-seal、由 CSS ::before 画——两条都得守：① 不能落在 span 文字节点里（会进 textContent，爬虫/读屏会看到「uuua.me」）；② 也不能由 .brand::before 画（Chromium 也算进可访问名）。
    const seal = `<span class="bseal" aria-hidden="true" data-seal="${esc(head.slice(0, 1))}"></span>`;
    if (dot < 0) return `<a class="brand" href="/">${seal}${esc(SITE.title)}</a>`;
    const tail = SITE.title.slice(dot + 1);
    return `<a class="brand" href="/">${seal}${esc(head)}<span class="bmark" aria-hidden="true"></span><span class="sr-only">.</span>${esc(tail)}</a>`;
  })();
  const mainHtml = mainHtmlOf(page, main);

  // 表情面板整页一份（见 comments/view.js）：只在页面里真有表情触发键时输出，其余页面不多背这 7KB。
  // 笔记列表首屏只有评论抽屉的空壳（data-comments-slot），表单点开后才取回来；那时模板已经没机会再输出了，
  // 所以有懒加载抽屉的页面也要一并下发，否则抽屉里的表情键点开时找不到模板。
  const emojiTpl = emojiTplOf(main);

  // 窄屏导航抽屉放在 #app 里：换页时随内容重建，不留第二份；初始 inert 让它关闭时不接受点击与焦点。
  // 抽屉只做目录 + 检索：底部那排 RSS / 配色 / 后台早已撤掉（配色入口只在首页 hero-meta，RSS 也在那行）。
  const drawer = `<div class="mnav" id="mnav" inert>
  <div class="mnav-scrim" data-mnav-close></div>
  <nav class="mnav-panel" aria-label="主导航">
    <div class="mnav-head">
      <span aria-hidden="true">目录</span>
      <button class="navbtn navbtn-inpanel" type="button" data-mnav-close aria-label="关闭菜单">
        <span class="nb-ico" aria-hidden="true"></span><span class="nb-close">关闭</span>
      </button>
    </div>
    ${searchDrawerForm()}
    <ul>
      ${navDrawerHtml(active, items)}
    </ul>
  </nav>
</div>`;

  return {
    title, main, desc, canonical, active, ogType, noindex, extraHead, jsonLd, page, ogImage, lang,
    themeType: themeType || page || '', themeData: themeData ?? {},
    fullTitle, og, ogW, ogH, ogLocale, structuredData, navGroups, items, brandHtml, mainHtml, emojiTpl, drawer,
  };
}

/** 主题只覆盖页面模板时，复用 themeChrome 已经算好的导航/head，只替换正文相关字段。 */
function withMainContext(ctx, main) {
  return {
    ...ctx,
    main,
    mainHtml: mainHtmlOf(ctx.page, main),
    emojiTpl: emojiTplOf(main),
  };
}

/** <head> 内容（不含 head 标签本身）。主题布局必须原样输出它，SEO/分享/主题引导才不会丢。 */
function headHtmlOf(ctx) {
  return `<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<meta name="theme-color" content="#faf8f4" media="(prefers-color-scheme:light)">
<meta name="theme-color" content="#0b0b0d" media="(prefers-color-scheme:dark)">
<title>${ctx.fullTitle}</title>
<meta name="description" content="${esc(ctx.desc)}">
<link rel="canonical" href="${esc(absUrl(ctx.canonical))}">
${ctx.noindex ? '<meta name="robots" content="noindex,follow">' : ''}
<meta property="og:type" content="${esc(ctx.ogType)}">
<meta property="og:title" content="${esc(ctx.title || SITE.identity)}">
<meta property="og:description" content="${esc(ctx.desc)}">
<meta property="og:url" content="${esc(absUrl(ctx.canonical))}">
<meta property="og:site_name" content="${esc(SITE.identity)}">
<meta property="og:locale" content="${esc(ctx.ogLocale)}">
<meta property="og:image" content="${esc(ctx.og.url)}">
<meta property="og:image:alt" content="${esc(ctx.og.alt)}">
${ctx.ogW ? `<meta property="og:image:width" content="${ctx.ogW}">` : ''}
${ctx.ogH ? `<meta property="og:image:height" content="${ctx.ogH}">` : ''}
<meta name="twitter:card" content="summary_large_image">
<meta name="twitter:image" content="${esc(ctx.og.url)}">
<meta name="twitter:image:alt" content="${esc(ctx.og.alt)}">
<link rel="alternate" type="application/rss+xml" title="${esc(SITE.identity)}" href="/feed.xml">
<link rel="alternate" type="application/atom+xml" title="${esc(SITE.identity)}" href="/atom.xml">
<link rel="alternate" type="application/feed+json" title="${esc(SITE.identity)}" href="/feed.json">
<link rel="icon" href="/favicon.svg?v=${assetVer('favicon.svg')}" type="image/svg+xml">
<link rel="apple-touch-icon" href="/apple-touch-icon.png?v=${assetVer('apple-touch-icon.png')}">
<link rel="manifest" href="/site.webmanifest">
<link rel="stylesheet" href="/base.css?v=${assetVer('base.css')}">
<link rel="stylesheet" href="/style.css?v=${assetVer('style.css')}">
<meta name="palette-lib" content="/palette.js?v=${assetVer('palette.js')}">
${ctx.extraHead}
${jsonLdHtml(ctx.structuredData)}
<script>${THEME_BOOT}</script>`;
}

// 警徽用公安备案那枚官方徽标（public/police-badge.png，62×67 带透明通道）。
// 不内联 base64：11KB 塞进每一页的 HTML 不划算，而且每次响应都要重传、也进不了缓存；
// 走静态资源 + 内容指纹即可长缓存，换图自动换 URL。
const policeBadgeImg = () => `<img class="foot-police-ico" src="/police-badge.png?v=${assetVer('police-badge.png')}" alt="" width="13" height="14" decoding="async">`;

// ICP 徽标用备案 logo（public/icp-badge.png，白底原图经白底反推 alpha 抠成透明，42×40）。
// 与警徽同一规矩：走静态资源 + 内容指纹长缓存，不内联 base64。
const icpBadgeImg = () => `<img class="foot-icp-ico" src="/icp-badge.png?v=${assetVer('icp-badge.png')}" alt="" width="15" height="14" decoding="async">`;

/**
 * 页脚的公安联网备案号。号码形如「冀公网安备13060202001368号」，其中末尾那串数字同时是
 * 官方查询页的 code 参数 —— 从号码里抠出来拼链接，站主照着备案单填一行字即可，不必另维护一条 URL。
 * 抠不到数字就退到查询首页：宁可少一层深链，也不要把半截链接拼出去。
 */
function policeHtml() {
  if (!SITE.police) return '';
  const code = /\d{6,}/.exec(SITE.police)?.[0] ?? '';
  const href = code ? `https://beian.mps.gov.cn/#/query/webSearch?code=${code}` : 'https://beian.mps.gov.cn/';
  return `<a class="foot-police" href="${href}" rel="nofollow noopener">${policeBadgeImg()}${esc(SITE.police)}</a>`;
}

/** 页面公共外壳：页头、抽屉、页脚、灯箱、表情模板与脚本。主题布局可按需拼装。 */
function chromeOf(ctx) {
  return {
    head: `<head>\n${headHtmlOf(ctx)}\n</head>`,
    skip: '<a class="skip" href="#main">跳到正文</a>',
    progress: '<div id="progress" aria-hidden="true"></div>',
    top: '<span id="top"></span>',
    toTop: '<a class="to-top" href="#top" aria-label="回到顶部" title="回到顶部"><span aria-hidden="true">↑</span></a>',
    header: `<header class="site">
  <div class="shell">

    <div class="row${SITE.title ? '' : ' row-solo'}">
      ${ctx.brandHtml}
      <nav class="nav" aria-label="主导航">
        ${navHtml(ctx.active, ctx.navGroups)}
        <span class="nav-tools">
          ${searchNavForm()}
        </span>
      </nav>
      <button class="navbtn" type="button" aria-expanded="false" aria-controls="mnav">
        <span class="nb-ico" aria-hidden="true"></span>
        <span class="nb-open">菜单</span><span class="nb-close">关闭</span>
      </button>
    </div>
  </div>
</header>`,
    drawer: ctx.drawer,
    // 页脚两行：第一行版权，第二行两条备案号（RSS 与配色在首页 hero-meta 那一行）。
    // 后台入口与「回到顶部」早先已从页脚撤掉 —— 手机端不再需要第二枚回到顶部（悬浮钮仍按原断点隐藏）。
    footer: `<footer class="site">
    <div class="foot-inner">
      <div class="foot-legal">
        <span class="foot-copy"><span class="sr-only">©</span>${ICON_COPYRIGHT} ${new Date().getFullYear()}${SITE.author ? `<span class="sep">·</span>${esc(SITE.author)}` : ''}</span>
        <span class="foot-beian">
          ${SITE.icp ? `<a class="foot-icp" href="https://beian.miit.gov.cn/" rel="nofollow noopener">${icpBadgeImg()}${esc(SITE.icp)}</a>` : ''}
          ${policeHtml()}
        </span>
      </div>
    </div>
  </footer>`,
    emoji: ctx.emojiTpl,
    lightbox: lightboxHtml,
    scripts: `<script src="/request.js?v=${assetVer('request.js')}" defer></script>
<script src="/ui.js?v=${assetVer('ui.js')}" defer></script>
<script src="/nav.js?v=${assetVer('nav.js')}" defer></script>
<script src="/search.js?v=${assetVer('search.js')}" defer></script>
<script src="/app.js?v=${assetVer('app.js')}" defer></script>`,
  };
}

/** 默认渲染：主题渲染失败时的最终兜底，保证任何页都不会白屏。 */
function builtinLayout(opts, ctx = layoutContext(opts)) {
  const chrome = chromeOf(ctx);
  return `<!DOCTYPE html>
<html lang="${SITE.lang}"${paletteAttr()}${layoutAttr()}>
${chrome.head}
<body data-page="${esc(ctx.page)}">
${chrome.top}
${chrome.skip}
${chrome.progress}

${chrome.toTop}

<div id="app">
${chrome.header}
${chrome.drawer}
${ctx.page === 'home' ? ctx.mainHtml : ''}

<div class="wrap">
  ${ctx.page === 'home' ? '' : ctx.mainHtml}

  ${chrome.footer}
</div>
${chrome.emoji}
</div>
<!-- 灯箱放在 #app（和 main）外面：main 带 tabindex="-1"，WebKit 关 dialog 还原焦点时会交给 dialog 的可聚焦祖先 ——
     落在 main 上就点亮 :focus-visible、整页被金框圈住（Safari 实测复现，Chromium 无此问题）。放 #app 外就没有可聚焦
     祖先；pjax 只换 #app，弹窗也不必每次换页重建。 -->
${chrome.lightbox}

${chrome.scripts}
</body>
</html>`;
}

/**
 * 预览主题时给站主一条固定的提示条。注入放在这里而不是 chrome 里：
 * 主题布局不必输出它，第三方主题也不会因为漏了某个片段就"看不出自己在预览"。
 */
function withPreviewBar(html, canonical = '/') {
  const request = themeRequest();
  if (!request?.preview || !html) return html;
  const name = request.previewName || request.preview;
  const to = encodeURIComponent(String(canonical || '/').slice(0, 300));
  const bar = `<div class="preview-bar" role="status"><span>正在预览主题「${esc(name)}」</span>`
    + `<a class="preview-bar-exit" href="/admin/themes/preview/exit?to=${to}">退出预览</a></div>`;
  return html.includes('</body>') ? html.replace('</body>', `${bar}\n</body>`) : html + bar;
}

/** 前台唯一出口：有激活主题且本次渲染成功就走主题，否则回退默认渲染。 */
export function layout(opts) {
  // 解析主题本身也可能碰数据库/文件系统：失败时退回内置渲染，别把整页变成 500。
  let theme = null;
  try { theme = themeResolver?.() ?? null; } catch (error) { themeErrorLogger?.(error); }
  let html = '';
  if (theme && themeRenderer) {
    try {
      const rendered = themeRenderer(theme, opts);
      if (typeof rendered === 'string' && rendered) html = rendered;
      else if (rendered && typeof rendered === 'object') {
        // 主题只覆盖了页面模板、没有布局模板：仍然套内置外壳，并把主题 CSS/head 片段补进内置 <head>。
        if (typeof rendered.html === 'string' && rendered.html) html = rendered.html;
        else if (typeof rendered.content === 'string') {
          const extraHead = [opts.extraHead ?? '', rendered.head ?? ''].filter(Boolean).join('\n');
          // engine 在没有 layout 模板时会带回 themeChrome 已算好的 context：
          // 导航、head、结构化数据不必在 builtinLayout 里再构建一遍。
          const shellContext = withMainContext(rendered.context ?? layoutContext(opts), rendered.content);
          // themeChrome 的 context 只带原始 opts 的 head；主题自己的 head.liquid/theme.css 追加在这里。
          shellContext.extraHead = extraHead;
          html = builtinLayout({ ...opts, main: rendered.content, extraHead }, shellContext);
        }
      }
    } catch (error) {
      themeErrorLogger?.(error);
    }
  }
  return withPreviewBar(html || builtinLayout(opts), opts.canonical);
}

/** 主题布局可复用的页面外壳；engine 用它把内置 head/header/footer 交给模板。 */
export const themeChrome = (opts) => {
  const ctx = layoutContext(opts);
  return {
    // chrome 只放 HTML 片段（供模板 | raw），导航数据单独给，避免把数组混进外壳。
    chrome: { ...chromeOf(ctx), htmlAttrs: themePaletteAttr() + themeLayoutAttr(), lang: SITE.lang },
    // 导航与内置页头同源：主题上下文不必再由每条路由各拼一份 data.nav。
    nav: ctx.items.map(([href, label, key]) => ({ href, label, key, active: key === ctx.active })),
    // 自行写 <head> 的主题也需要这些；内置 layoutContext 已经算好，别让主题再猜一遍。
    meta: {
      full_title: ctx.fullTitle,
      og_image: ctx.og?.url ?? '',
      og_locale: ctx.ogLocale,
      json_ld: ctx.structuredData,
    },
    // 只给 layout() 在没有 layout 模板时复用，模板本身用不到。
    context: ctx,
  };
};

export const masthead = ({ mark, title, stats = [], tail = '', titleTools = '' }) => `    <header class="mast">
      <p class="mast-mark">${esc(mark)}</p>
      ${titleTools ? `<div class="mast-title-row"><h1 class="mast-title">${esc(title)}</h1>${titleTools}</div>` : `<h1 class="mast-title">${esc(title)}</h1>`}
${stats.length ? `      <p class="mast-stat">\n${stats.map((s) => `        ${s}`).join('\n')}\n      </p>\n` : ''}${tail}
    </header>`;

const leading = (p, lines = 2) => {

  const head = (p.body_head ?? '')
    .replace(/<h[1-6][^>]*>[\s\S]*?<\/h[1-6]>/gi, ' ')
    .replace(/<h[1-6][^>]*>[\s\S]*$/i, ' ');

  const text = cleanExcerpt(head, lines >= 3 ? 132 : 88);
  return text ? `    <p class="excerpt">${esc(text)}</p>` : '';
};

/** 站内时区的 YYYY-MM-DD 拆成 [年, 月, 日]；列表、归档与检索共用同一口径。 */
const dayParts = (day) => [day.slice(0, 4), day.slice(5, 7), day.slice(8)];

const dayLabel = ([y, m, d]) => `${y} 年 ${Number(m)} 月 ${Number(d)} 日`;

/** 编年日期徽记（大字日 + 月份/年份两行小字）：文章列表、笔记折叠行与检索命中三处同构，别再各拼一份。 */
export function dateBadge(day, datetime = day) {
  const [y, m, d] = dayParts(day);
  return `<time datetime="${esc(datetime)}" aria-label="${esc(dayLabel([y, m, d]))}"><b>${esc(d)}</b><small><span>${esc(monthCn(m))}</span><span>${esc(y)}</span></small></time>`;
}

/** 评论数文案：列表与笔记折叠行两处口径必须一致。 */
export const commentLabel = (n) => (n ? `${n} 条评论` : '暂无评论');

/** 列表条目 = 编年轨 + 底部元信息行。底部元信息行是 .e-main 的兄弟（评论链接不能嵌进整行链接里）。结构约束：.excerpt 必须是 .e-main 的直接子节点——不许再包一层。
 *  excerpt 可以换掉：检索结果要的是「以命中词为中心」的那段摘要，不是正文开头。换的只是那一个 <p>，
 *  编年轨、标题、元信息行照旧 —— 检索列表与文章列表共用这一份，别再另写一套标记（两份迟早长歪）。 */
function listItem(p, showKind, excerpt = leading(p, 2)) {
  const note = p.kind === 'note';
  const kindTag = showKind && note ? '<span class="kind">笔记</span>' : '';
  // 地址一律走 contentUrl()，别再手拼 kindPrefix——固定页会拼成 404 的 /p/<slug>/。
  const href = contentUrl(p);


  const commentHref = `${contentUrl(p)}#comments`;
  // 检索结果会把命中词包进 <mark>（titleHtml 已是转义后的 HTML）；普通列表仍走 esc。
  const title = p.titleHtml ?? esc(p.title);

  return `<li${note ? ' class="note"' : ''}>
  <a class="e-main" href="${href}">
    ${dateBadge(p.day, p.published_at)}
    <h2>${title}${kindTag}</h2>
${excerpt}
  </a>
  <p class="e-meta"><time class="e-rel" datetime="${esc(p.published_at)}">${esc(relativeDate(p.published_at))}</time><a class="e-comments" href="${commentHref}">${commentLabel(p.comments)}</a></p>
</li>`;
}

/** excerptOf 可给每行换一段摘要（检索结果用）；返回 undefined 就退回正文开头那一档。 */
export const listBlock = (posts, { showKind = true, excerptOf = null } = {}) => {
  if (!posts.length) return '';
  const kinds = new Set(posts.map((p) => p.kind));
  const solo = kinds.size === 1 ? ` data-kind="${posts[0].kind}"` : '';
  return `<ul class="list"${solo}>\n${posts.map((p) => listItem(p, showKind, excerptOf?.(p))).join('\n')}\n</ul>`;
};

export const ledgerItem = (p, { relative = false } = {}) => {
  const [y, m, d] = dayParts(p.day);
  const note = p.kind === 'note';

  const shown = relative ? relativeDate(p.published_at) : d;

  // 标题单独包一层：flex 里的裸文本是匿名 flex item，挂不了 text-overflow（.recent 会用到）；<a title> 是截断兜底；地址同样走 contentUrl()。
  return `<li${note ? ' class="note"' : ''}><a href="${contentUrl(p)}" title="${esc(p.title)}"><time datetime="${esc(p.day)}" title="${esc(p.day)}" aria-label="${esc(dayLabel([y, m, d]))}">${esc(shown)}</time><span class="e-title"><span class="e-title-text">${esc(p.title)}</span></span><span class="e-kind">${note ? '笔记' : '文章'}</span></a></li>`;
};


export const entriesBlock = (posts, { relative = false } = {}) =>
  posts.length ? `<ul class="entries${relative ? ' entries-rel' : ''}">\n${posts.map((p) => ledgerItem(p, { relative })).join('\n')}\n</ul>` : '';

/** 「更早的 X →」翻页链接：文章/笔记列表、友圈、友链三处共用同一标记。 */
export const moreLink = (href, label) => `<p class="pager-more"><a href="${esc(href)}">${esc(label)} →</a></p>`;

/** 空状态。message 可省略——有的页面标题已说清。
 *  as 默认 h1（404 / go 这类没有刊头的页面）；已有 masthead 时传 'p'，避免一页两个 h1。
 */
export const emptyPage = (title, message = '', as = 'h1') => `
    <article class="post post-empty">
      <${as} class="post-empty-title">${esc(title)}</${as}>${message ? `\n      <div class="prose"><p>${message}</p></div>` : ''}
    </article>`;

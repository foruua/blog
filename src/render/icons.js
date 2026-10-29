// 前后台共用的图标与尺寸常量：同一份标记出现两次时，改一次很容易漏掉另一处。
// 只放纯字符串，不依赖运行环境。

/** 首页封面 `sizes`：首屏图被 CSS 限在 480px 内，不能按 100vw 选最大档。 */
export const HERO_IMAGE_SIZES = '(min-width: 528px) 480px, calc(100vw - 48px)';

/** 关闭按钮的 × 图标：媒体选择器/引用详情/订阅源编辑/内容预览/灯箱共用一份标记。 */
export const ICON_CLOSE = '<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" aria-hidden="true"><path d="M4.4 4.4 11.6 11.6M11.6 4.4 4.4 11.6"/></svg>';

/** 版权符号：页脚版权行用。版权行走 mono 字体栈，Windows 命中的 Consolas © 又小又方，
 *  矢量描边版让圆度、笔画粗细三端逐像素一致（与字号标那颗金星同哲学：品牌符号不走字体栈）。 */
export const ICON_COPYRIGHT = '<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" aria-hidden="true"><circle cx="8" cy="8" r="6.1" stroke-width="1.15"/><path d="M10.7 5.8A3.5 3.5 0 1 0 10.7 10.2" stroke-width="1.25" stroke-linecap="round"/></svg>';

/** 检索放大镜：导航、抽屉搜索框与 404 页共用。20 格画布、1.6 描边。 */
export const SEARCH_ICO = '<svg class="so-ico" viewBox="0 0 20 20" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" aria-hidden="true"><circle cx="8" cy="8" r="5.6"/><path d="M12.3 12.3 17 17"/></svg>';

/** 外观入口：半实心圆盘，缩到 14px 仍读得出「一半可换」。 */
export const PAL_ICO = '<svg class="pal-ico" viewBox="0 0 20 20" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><circle cx="10" cy="10" r="7.2"/><path d="M10 2.8a7.2 7.2 0 0 0 0 14.4z" fill="currentColor" stroke="none"/></svg>';

/** 订阅：点 + 两道弧，viewBox 收窄让图形与相邻图标等大。 */
export const RSS_ICO = '<svg class="ico-rss" viewBox="3.25 3.6 12.05 12.05" fill="none" stroke="currentColor" stroke-width="0.97" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><circle cx="5.6" cy="13.3" r="1.15" fill="currentColor" stroke="none"/><path d="M4.5 9.3a5.1 5.1 0 0 1 5.1 5.1"/><path d="M4.5 4.8a9.6 9.6 0 0 1 9.6 9.6"/></svg>';

/** 邮件：信封 + 折角线。 */
export const MAIL_ICO = '<svg class="ico-mail" viewBox="0 0 20 20" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><rect x="2.9" y="5.1" width="14.2" height="9.8" rx="2"/><path d="m4.2 6.9 5.8 4.1 5.8-4.1"/></svg>';

/** GitHub 官方 mark（实心）：15px 只有实心版还认得出轮廓。 */
export const GITHUB_ICO = '<svg class="ico-github" viewBox="0 0 16 16" fill="currentColor" aria-hidden="true"><path d="M8 0C3.58 0 0 3.58 0 8c0 3.54 2.29 6.53 5.47 7.59.4.07.55-.17.55-.38 0-.19-.01-.82-.01-1.49-2.01.37-2.53-.49-2.69-.94-.09-.23-.48-.94-.82-1.13-.28-.15-.68-.52-.01-.53.63-.01 1.08.58 1.23.82.72 1.21 1.87.87 2.33.66.07-.52.28-.87.51-1.07-1.78-.2-3.64-.89-3.64-3.95 0-.87.31-1.59.82-2.15-.08-.2-.36-1.02.08-2.12 0 0 .67-.21 2.2.82.64-.18 1.32-.27 2-.27.68 0 1.36.09 2 .27 1.53-1.04 2.2-.82 2.2-.82.44 1.1.16 1.92.08 2.12.51.56.82 1.27.82 2.15 0 3.07-1.87 3.75-3.65 3.95.29.25.54.73.54 1.48 0 1.07-.01 1.93-.01 2.2 0 .21.15.46.55.38A8.01 8.01 0 0 0 16 8c0-4.42-3.58-8-8-8z"/></svg>';

/** 明暗三态/版式两格的图标工厂：20 格画布、1.6 描边。 */
export const TM_ICO = (inner) => `<svg class="tm-ico" viewBox="0 0 20 20" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${inner}</svg>`;
export const TM_ICON = {
  auto: TM_ICO('<circle cx="10" cy="10" r="7.2"/><path d="M10 2.8a7.2 7.2 0 0 0 0 14.4z" fill="currentColor" stroke="none"/>'),
  light: TM_ICO('<circle cx="10" cy="10" r="3.5"/><path d="M10 2.4v2M10 15.6v2M2.4 10h2M15.6 10h2M4.7 4.7l1.4 1.4M13.9 13.9l1.4 1.4M15.3 4.7 13.9 6.1M6.1 13.9 4.7 15.3"/>'),
  dark: TM_ICO('<path d="M15.6 12.1A6.2 6.2 0 0 1 7.9 4.4a6.2 6.2 0 1 0 7.7 7.7z"/>'),
};

export const LY_ICO = (inner) => `<svg class="ly-ico" viewBox="0 0 20 20" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${inner}</svg>`;
export const LY_ICON = {
  paper: LY_ICO('<path d="M4 5.4h12M4 9.4h12M4 13.4h7.4"/>'),
  box: LY_ICO('<rect x="3" y="3.8" width="14" height="12.4" rx="2.2"/><path d="M6.6 8.2h6.8M6.6 11.2h6.8"/>'),
};

const NAV_ICO_SVG = (inner) => `<svg class="n-ico" viewBox="0 0 20 20" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${inner}</svg>`;

export const NAV_ICO = {
  home: NAV_ICO_SVG('<path d="M3.6 8.9 10 3.7l6.4 5.2"/><path d="M5.4 8.1v8.1h9.2V8.1"/><path d="M8.3 16.2v-4.1h3.4v4.1"/>'),
  posts: NAV_ICO_SVG('<rect x="4.4" y="3.2" width="11.2" height="13.6" rx="1.8"/><path d="M7.4 7.4h5.2M7.4 10.4h5.2M7.4 13.4h3"/>'),
  notes: NAV_ICO_SVG('<path d="M13.7 3.1a1.8 1.8 0 0 1 2.5 2.5L5.9 15.9l-3.3.8.8-3.3z"/><path d="M12.4 4.4 15.4 7.4"/>'),
  pages: NAV_ICO_SVG('<path d="M3.2 6.6c0-.8.6-1.4 1.4-1.4h3l1.6 2h6.2c.8 0 1.4.6 1.4 1.4v6.8c0 .8-.6 1.4-1.4 1.4H4.6c-.8 0-1.4-.6-1.4-1.4z"/>'),
  friends: NAV_ICO_SVG('<circle cx="7.9" cy="7.5" r="2.5"/><path d="M3.5 16.4c0-2.4 2-4.4 4.4-4.4s4.4 2 4.4 4.4"/><path d="M13.4 5.6a2.3 2.3 0 0 1 0 4.5"/>'),
  links: NAV_ICO_SVG('<path d="M8.3 10.8a4.2 4.2 0 0 0 6.28.45l2.5-2.5a4.2 4.2 0 0 0-5.89-5.89l-1.43 1.43"/><path d="M11.7 9.2a4.2 4.2 0 0 0-6.28-.45l-2.5 2.5a4.2 4.2 0 0 0 5.89 5.89l1.43-1.43"/>'),
  archive: NAV_ICO_SVG('<rect x="3.4" y="4.4" width="13.2" height="3.6" rx="1.1"/><path d="M5.2 8v6.4c0 .9.7 1.6 1.6 1.6h6.4c.9 0 1.6-.7 1.6-1.6V8"/><path d="M8.5 11.2h3"/>'),
  about: NAV_ICO_SVG('<circle cx="10" cy="10" r="6.6"/><path d="M10 9.2v4.4"/><path d="M10 6.5h.01"/>'),
  page: NAV_ICO_SVG('<path d="M5.2 3.4h5.6l4.6 4.6v8.6H5.2z"/><path d="M10.8 3.4V8h4.6"/>'),
};
export const navIco = (key) => NAV_ICO[key] ?? NAV_ICO.page;

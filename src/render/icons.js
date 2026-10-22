// 前后台共用的图标与尺寸常量：同一份标记出现两次时，改一次很容易漏掉另一处。
// 只放纯字符串，不依赖运行环境。

/** 灯箱/视频的「放大展开」图标：20/24 画布同一套描边规格。 */
export const EXPAND_ICON = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M9 4H4v5M15 20h5v-5M20 9V4h-5M4 15v5h5"/></svg>';

/** 首页封面 `sizes`：首屏图被 CSS 限在 480px 内，不能按 100vw 选最大档。 */
export const HERO_IMAGE_SIZES = '(min-width: 528px) 480px, calc(100vw - 48px)';

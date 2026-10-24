// 前后台共用的图标与尺寸常量：同一份标记出现两次时，改一次很容易漏掉另一处。
// 只放纯字符串，不依赖运行环境。

/** 首页封面 `sizes`：首屏图被 CSS 限在 480px 内，不能按 100vw 选最大档。 */
export const HERO_IMAGE_SIZES = '(min-width: 528px) 480px, calc(100vw - 48px)';

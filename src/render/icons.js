// 前后台共用的图标与尺寸常量：同一份标记出现两次时，改一次很容易漏掉另一处。
// 只放纯字符串，不依赖运行环境。

/** 首页封面 `sizes`：首屏图被 CSS 限在 480px 内，不能按 100vw 选最大档。 */
export const HERO_IMAGE_SIZES = '(min-width: 528px) 480px, calc(100vw - 48px)';

/** 关闭按钮的 × 图标：媒体选择器/引用详情/订阅源编辑/内容预览/灯箱共用一份标记。 */
export const ICON_CLOSE = '<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" aria-hidden="true"><path d="M4.4 4.4 11.6 11.6M11.6 4.4 4.4 11.6"/></svg>';

// `<img ...>` 标签匹配：属性值里允许出现被引号包住的 `>`（`alt="a > b"`），
// 不能用 `<img\b[^>]*>` 那种简单正则。正文/灯箱/笔记画廊共用同一份。
export const IMG_TAG_RE = /<img\b(?:[^>"']|"[^"]*"|'[^']*')*>/gi;

/** 正文里第一张 <img> 标签（分享图等只看首图）。全局正则有 lastIndex，取完归一，别让状态跨调用漂移。 */
export function firstImgTag(html) {
  IMG_TAG_RE.lastIndex = 0;
  return IMG_TAG_RE.exec(String(html ?? ''))?.[0] ?? null;
}

/** 宽高比的行内写法：只靠 width/height 属性算出的比例带 auto 前缀，会被懒加载审计判成「没设比例」（CLS）。 */
export const aspectRatioStyle = (w, h) => `aspect-ratio:${w}/${h}`;

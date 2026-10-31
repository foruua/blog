// 响应式图片变体：命名、存取与 srcset 拼装。变体跟原图同放，命名含策略版本（<原文件名>.v4-w1280.webp），
// 路径可从原图推导；但仍要查库确认存在——浏览器可能选中一个 404 候选，命中就整张图不显示。
// 640 → 960 之间补一档 768：手机 2x 屏（约 684px 需求）不再被迫跳到 960，首图能少一半字节。
const VARIANT_WIDTHS = [240, 480, 640, 768, 960, 1280, 1920, 2560];
export const thumbnailFile = (basePath) => `${basePath}.thumb-v3.webp`;

export const variantFile = (basePath, width) => `${basePath}.v4-w${width}.webp`;

export const parseVariants = (text) => {
  try {
    const list = JSON.parse(text ?? '[]');
    return Array.isArray(list)
      ? list.filter((v) => Number.isInteger(v?.w) && v.w > 0 && typeof v?.path === 'string')
      : [];
  } catch { return []; }
};

export const serializeVariants = (list) => JSON.stringify(
  [...list].sort((a, b) => a.w - b.w).map(({ w, path }) => ({ w, path })));

export function variantWidthsOf(width) {
  if (!(width > 0)) return [];
  return [...new Set([...VARIANT_WIDTHS.filter((w) => w < width), Math.min(width, 2560)])].sort((a, b) => a - b);
}

export const originalPathOf = (source) => String(source ?? '').split(/[?#]/, 1)[0].replace(/\.(?:thumb(?:-v\d+)?|(?:v\d+-)?w\d+)\.webp$/, '');

// 一条 media 行派生出的全部文件路径（原图 + 缩略图 + 全部变体）。
// 使用索引（usage.js）/回收计划（cleanup.js）/备份（backup.js）三家共用，
// 避免派生文件命名规则长出第三份会漂移的拷贝。
export function expandMediaPaths(row) {
  return [row?.path, row?.thumbnail, ...parseVariants(row?.variants).map((v) => v.path)].filter(Boolean);
}

export const IMAGE_PLACEHOLDER = 'data:image/gif;base64,R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7';

/** 媒体表没有这一行时退回原图（只接受站内路径）；外站/数据地址才用占位图。 */
export const mediaFallback = (original) => (typeof original === 'string'
  && original.startsWith('/') && !original.startsWith('//') ? original : IMAGE_PLACEHOLDER);

function srcsetOf(src, variants, fullWidth) {
  return variants.filter((v) => v.path !== src && (!(fullWidth > 0) || v.w <= fullWidth))
    .sort((a, b) => a.w - b.w).map((v) => `${v.path} ${v.w}w`).join(', ');
}

function staticVariants(media, parsed = parseVariants(media?.variants)) {
  // 升级或回填中断时仍可读取既有 v3，写入只生成 v4。
  return parsed.filter((v) => v.path === variantFile(media.path, v.w)
    || v.path === `${media.path}.v3-w${v.w}.webp`);
}

// parsed 可由调用方传入复用（info.js 一次要算四处，避免四次 JSON.parse）。
export function previewSrcsetOf(media, maxWidth = 960, parsed) {
  return srcsetOf(media?.path, staticVariants(media, parsed), Math.min(media?.width || maxWidth, maxWidth));
}

export function previewSourceOf(media, preferredWidth = 480, parsed) {
  const variants = staticVariants(media, parsed).sort((a, b) => a.w - b.w);
  return variants.find((v) => v.w >= preferredWidth)?.path
    ?? variants.at(-1)?.path
    ?? ([thumbnailFile(media?.path), `${media?.path}.thumb-v2.webp`, `${media?.path}.thumb.webp`].includes(media?.thumbnail)
      ? media.thumbnail : IMAGE_PLACEHOLDER);
}

// 灯箱展示图。动画图（多帧）只有原图带全部帧，缩略图和变体都是静止首帧——这类必须回原图，否则动画在灯箱里变静止。
// animated 为 NULL 是加这列之前的老记录，GIF 保守视为可能动画。其余一律用最大档 WebP 变体：同分辨率下体积
// 通常只有原图（常见是 PNG 截图）的个位数百分比，且缩略图/正文里大概率已下过同名文件、能命中浏览器缓存。
export function fullSourceOf(media, parsed) {
  const animates = media?.animated == null ? media?.mime === 'image/gif' : Boolean(media.animated);
  if (animates) return media?.path ?? IMAGE_PLACEHOLDER;
  const variants = staticVariants(media, parsed);
  let best = null;
  for (const v of variants) if (!best || v.w > best.w) best = v;
  return best?.path ?? media?.path ?? IMAGE_PLACEHOLDER;
}

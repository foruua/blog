import { SITE } from '../config.js';
import { previewSourceOf, previewSrcsetOf, fullSourceOf, originalPathOf, parseVariants } from './variants.js';

// 与正文栏 46rem 及左右各 24px 内边距保持一致。
const BODY_IMAGE_SIZES = '(min-width: 784px) 736px, calc(100vw - 48px)';

export function createImageInfo(media) {
  const origin = new URL(SITE.url).origin;
  return (src) => {
    if (typeof src !== 'string') return null;
    let url, uploadPath;
    try {
      url = new URL(src, SITE.url + '/');
      if (url.origin !== origin || !url.pathname.startsWith('/uploads/')) return null;
      uploadPath = decodeURIComponent(url.pathname);
    } catch { return null; }
    const originalPath = originalPathOf(uploadPath);
    const item = media.mediaByPath(uploadPath) ?? (originalPath !== uploadPath ? media.mediaByPath(originalPath) : null);
    if (!item) return null;
    const variants = parseVariants(item.variants);
    return {
      width: Math.max(0, item.width || 0),
      height: Math.max(0, item.height || 0),
      thumbnail: previewSourceOf(item, 480, variants), preview: previewSourceOf(item, 960, variants),
      full: fullSourceOf(item, variants),
      original: item.path + url.search + url.hash,
      previewSrcset: previewSrcsetOf(item, 960, variants), srcset: previewSrcsetOf(item, 2560, variants), sizes: BODY_IMAGE_SIZES,
    };
  };
}

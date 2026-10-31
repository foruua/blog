import { SITE } from '../config.js';
import { previewSourceOf, previewSrcsetOf, fullSourceOf, originalPathOf, parseVariants, isVideoMedia } from './variants.js';

// 与正文栏 46rem 及左右各 24px 内边距保持一致。
const BODY_IMAGE_SIZES = '(min-width: 784px) 736px, calc(100vw - 48px)';

export function createImageInfo(media, { revisionOf = () => '', maxEntries = 4000 } = {}) {
  const origin = new URL(SITE.url).origin;
  // 正文重建时会为同一批图片反复问同一路径；按媒体修订号整块失效，避免每次 <img> 都点查一次 media。
  // rev 为空时（脚本里没有 repo）就按进程生命周期缓存，单次同步内媒体表不会变。
  const cache = new Map();
  let revision = Symbol('initial');
  return (src) => {
    if (typeof src !== 'string') return null;
    const rev = revisionOf();
    if (rev !== revision) {
      cache.clear();
      revision = rev;
    }
    if (cache.has(src)) return cache.get(src);

    let info = null;
    let url, uploadPath;
    try {
      url = new URL(src, SITE.url + '/');
      if (url.origin === origin && url.pathname.startsWith('/uploads/')) uploadPath = decodeURIComponent(url.pathname);
    } catch { /* 外站/坏地址：按没有媒体信息处理 */ }
    if (uploadPath) {
      const originalPath = originalPathOf(uploadPath);
      const item = media.mediaByPath(uploadPath) ?? (originalPath !== uploadPath ? media.mediaByPath(originalPath) : null);
      if (item) {
        const variants = parseVariants(item.variants);
        const video = isVideoMedia(item);
        info = {
          width: Math.max(0, item.width || 0),
          height: Math.max(0, item.height || 0),
          thumbnail: previewSourceOf(item, 480, variants), preview: previewSourceOf(item, 960, variants),
          full: fullSourceOf(item, variants),
          original: item.path + url.search + url.hash,
          previewSrcset: previewSrcsetOf(item, 960, variants), srcset: previewSrcsetOf(item, 2560, variants), sizes: BODY_IMAGE_SIZES,
          mime: item.mime,
          video: video ? item.path + url.search + url.hash : null,
          poster: video ? previewSourceOf(item, 960, variants) : null,
        };
      }
    }
    if (cache.size >= maxEntries) cache.delete(cache.keys().next().value);
    cache.set(src, info);
    return info;
  };
}

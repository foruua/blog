import MarkdownIt from 'markdown-it';
import { SITE } from '../config.js';
import { expandMediaPaths } from './variants.js';

const md = new MarkdownIt({ html: false, linkify: true });
const origin = new URL(SITE.url).origin;

export function uploadPath(value) {
  try {
    const url = new URL(value, SITE.url + '/');
    if (url.origin !== origin) return null;
    const pathname = decodeURIComponent(url.pathname);
    return pathname.startsWith('/uploads/') ? pathname : null;
  } catch { return null; }
}

function mediaPaths(item) {
  return [...new Set(expandMediaPaths(item).map(uploadPath).filter(Boolean))];
}

// 按 Markdown 的真实图片/链接解析：引用式图片、转义、查询参数均可识别，代码示例不算引用。
export function referencedUploads(body) {
  const found = new Set();
  const visit = (tokens) => {
    for (const token of tokens) {
      const value = token.type === 'image' ? token.attrGet('src')
        : token.type === 'link_open' ? token.attrGet('href') : null;
      if (value) { const p = uploadPath(value); if (p) found.add(p); }
      if (token.children) visit(token.children);
    }
  };
  visit(md.parse(String(body ?? ''), {}));
  return found;
}

export function createUsageCache({ maxEntries = 1000, maxBytes = 4 * 1024 * 1024 } = {}) {
  const cache = new Map();
  let bytes = 0;
  return (body) => {
    const text = String(body ?? '');
    const hit = cache.get(text);
    if (hit) { cache.delete(text); cache.set(text, hit); return hit.paths; }
    const paths = referencedUploads(text);
    const size = text.length * 2 + [...paths].reduce((n, p) => n + p.length * 2, 0);
    if (size > maxBytes) return paths;
    while (cache.size && (cache.size >= maxEntries || bytes + size > maxBytes)) {
      const key = cache.keys().next().value;
      bytes -= cache.get(key).size; cache.delete(key);
    }
    cache.set(text, { paths, size }); bytes += size;
    return paths;
  };
}

export function indexUploads(posts, references = referencedUploads) {
  const index = new Map();
  for (const post of posts) {
    const { body_md, ...summary } = post;
    for (const p of references(body_md)) {
      if (!index.has(p)) index.set(p, []);
      index.get(p).push(summary);
    }
  }
  return index;
}

export function usageOf(items, index) {
  return new Map(items.map((item) => {
    const used = new Map();
    for (const p of mediaPaths(item)) {
      for (const post of index.get(p) ?? []) used.set(post.id, post);
    }
    return [item.id, [...used.values()]];
  }));
}

export function mediaUsage(items, posts, references = referencedUploads) {
  return usageOf(items, indexUploads(posts, references));
}

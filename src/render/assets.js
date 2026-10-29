import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { PUBLIC_DIR } from '../config.js';

// 前台五个脚本的顺序：build:assets 按它合并 site.js，无构建时的 <script> 回退也按它输出。
export const SITE_SOURCES = ['request.js', 'ui.js', 'nav.js', 'search.js', 'app.js'];

// 资源指纹缓存。命中窗口内只读一次文件元数据；内容签名变了才读盘算指纹。
// ttlMs 决定「多久重新问一次内核」：开发环境留 1 秒（改完 CSS 刷新就能看到新指纹），生产环境资源只在部署时
// 变、进程重启即重算，所以按小时计——否则每渲染一页就是十次同步 statSync，全在请求路径上。
export function createAssetVersions(root, { now = Date.now, salt = '', ttlMs = 1000 } = {}) {
  const cache = new Map();
  return (file) => {
    const at = now(), previous = cache.get(file);
    if (previous && at - previous.at < ttlMs) return previous.value;
    const location = path.join(root, file);
    let signature;
    try {
      const stat = fs.statSync(location, { bigint: true });
      signature = `${stat.ino}:${stat.size}:${stat.mtimeNs}:${stat.ctimeNs}`;
    } catch { signature = 'missing'; }
    if (previous?.signature === signature) { previous.at = at; return previous.value; }
    let content;
    try { content = fs.readFileSync(location); } catch { content = `${file}:missing`; }
    const value = crypto.createHash('sha1').update(salt).update(content).digest('hex').slice(0, 10);
    cache.set(file, { at, signature, value });
    return value;
  };
}

// —— 页面级 CSS / 前台 bundle 的构建产物探测 ——
// 没有构建产物（开发/测试/刚 clone）或源文件在构建后又被改过时，回退到全量 style.css 与五个脚本，
// 绝不发半套样式。检查结果按进程缓存：改完源文件需要重跑构建并重启进程。
let pageCssReady;
export function hasPageCss() {
  if (pageCssReady !== undefined) return pageCssReady;
  pageCssReady = false;
  try {
    const stamp = JSON.parse(fs.readFileSync(path.join(PUBLIC_DIR, '.build', 'page-css.json'), 'utf8'));
    const source = fs.readFileSync(path.join(PUBLIC_DIR, 'style.css'));
    pageCssReady = stamp?.sourceHash === crypto.createHash('sha256').update(source).digest('hex')
      && fs.existsSync(path.join(PUBLIC_DIR, 'style-lite.css'))
      && fs.existsSync(path.join(PUBLIC_DIR, 'style-article.css'));
  } catch { pageCssReady = false; }
  return pageCssReady;
}

let siteBundleReady;
export function hasSiteBundle() {
  if (siteBundleReady !== undefined) return siteBundleReady;
  siteBundleReady = false;
  try {
    const stamp = JSON.parse(fs.readFileSync(path.join(PUBLIC_DIR, '.build', 'site-bundle.json'), 'utf8'));
    const fresh = SITE_SOURCES.every((file) => stamp?.hashes?.[file]
      === crypto.createHash('sha256').update(fs.readFileSync(path.join(PUBLIC_DIR, file))).digest('hex'));
    siteBundleReady = fresh && fs.existsSync(path.join(PUBLIC_DIR, 'site.js'));
  } catch { siteBundleReady = false; }
  return siteBundleReady;
}

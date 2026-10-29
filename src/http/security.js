import crypto from 'node:crypto';
import { SITE } from '../config.js';
import { esc } from '../util/text.js';
import { THEME_BOOT as PUBLIC_THEME_BOOT } from '../render/layout.js';
import { THEME_BOOT as ADMIN_THEME_BOOT } from '../admin/layout.js';

// CSP：script-src 只放行自身脚本与内联引导的 sha256（前台/后台共用同一常量，Set 去重）——
// 主题/配色必须在 <head>（外链会闪白）；style-src 需 unsafe-inline。
const INLINE_SCRIPT_HASHES = [...new Set([PUBLIC_THEME_BOOT, ADMIN_THEME_BOOT])]
  .map((src) => `'sha256-${crypto.createHash('sha256').update(src, 'utf8').digest('base64')}'`);
export const CSP = [
  "default-src 'self'",
  "base-uri 'self'",
  "object-src 'none'",
  "img-src 'self' data:",
  "font-src 'self'",
  "style-src 'self' 'unsafe-inline'",
  `script-src 'self' ${INLINE_SCRIPT_HASHES.join(' ')}`,
  "connect-src 'self'",
  "form-action 'self'",
  "frame-ancestors 'none'",
].join('; ');

// 基础安全头；供正常响应与 onError 共用。函数而不是模块级常量：后台改站名/语言后，500 页要跟着变。
export function securityHeaders(c) {
  c.header('X-Content-Type-Options', 'nosniff');
  c.header('Referrer-Policy', 'strict-origin-when-cross-origin');
  c.header('X-Frame-Options', 'DENY');
  c.header('Content-Security-Policy', CSP);
  // 仅 https 时发 HSTS（否则首次访问可被 SSL-strip 降级）；不带 preload（上列表难撤回）。
  if (SITE.url.startsWith('https')) c.header('Strict-Transport-Security', 'max-age=31536000; includeSubDomains');
  c.header('Permissions-Policy', 'camera=(), microphone=(), geolocation=(), payment=(), usb=()');
}

// 渲染抛错时给浏览器一张能读的错页。刻意不套 layout()：那要读库取导航，库坏了会二次抛错。
export const errorPage = () => `<!doctype html>
<html lang="${esc(SITE.lang)}">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<meta name="robots" content="noindex">
<title>出了点问题 · ${esc(SITE.title || SITE.identity)}</title>
<style>
:root{color-scheme:light dark}
body{margin:0;min-height:100vh;display:grid;place-items:center;padding:2rem;background:#f8f8f8;color:#2b2b2b;
  font:16px/1.75 ui-sans-serif,system-ui,-apple-system,"Segoe UI","PingFang SC","Microsoft YaHei",sans-serif}
main{max-width:32rem}
h1{margin:0 0 .6rem;font-size:1.4rem;letter-spacing:.02em}
p{margin:0 0 1.2rem;color:#6b6b6b}
a{color:inherit}
@media (prefers-color-scheme:dark){body{background:#151413;color:#e8e4dc}p{color:#9a948a}}
</style>
</head>
<body><main>
<h1>出了点问题</h1>
<p>这一页暂时打不开，稍后刷新试试。</p>
<p><a href="/">回到首页</a></p>
</main></body>
</html>`;

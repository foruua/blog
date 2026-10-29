import { SITE, UPLOADS_DIR } from '../config.js';
import { isSafeRelative } from '../themes/registry.js';

/** 静态资源出口：带指纹的 public 资源、主题资源、上传附件与 PWA 清单。 */
export function registerAssetRoutes(app, { sendFile, themes, auth, assetVer }) {
  // 主题资源：/theme-assets/<id>/<相对路径>。只允许截图和 assets/ 下的文件，路径由 registry.assetPath 校验。
  // 激活主题对所有访客可用；未激活主题只有站主（预览/后台截图）能取，避免把半成品主题公开。
  app.get('/theme-assets/*', async (c) => {
    // 用原始 pathname 而不是 c.req.path：Hono 已经解码过一次，这里再 decodeURIComponent 会把
    // 文件名里的字面 % 当成非法序列（100%.png 直接 404），也会把 %2F 二次展开。
    const raw = (c.get('requestUrl') ?? new URL(c.req.url)).pathname.slice('/theme-assets/'.length);
    const slash = raw.indexOf('/');
    if (slash <= 0) return c.notFound();
    let id, rel;
    try {
      id = decodeURIComponent(raw.slice(0, slash));
      rel = decodeURIComponent(raw.slice(slash + 1));
    } catch { return c.notFound(); }
    const theme = themes.get(id);
    if (!theme) return c.notFound();
    // 别在这里 list(true)：每张主题截图都会触发一次全量扫描（重新 walk 所有主题模板并 stat）。
    // activeId()/defaultTheme() 都走 registry 的 TTL 缓存，扫描时机仍由后台页面控制。
    const activeId = themes.activeId() || themes.defaultTheme()?.id || '';
    const isActive = id === activeId;
    // 未激活主题的资源只给站主看：公共缓存不能存，否则 CDN/浏览器可能把预览中的半成品主题
    // 或后台截图当成公开资源发给匿名访客。
    if (!isActive && !auth.session(c)) return c.notFound();
    if (!isSafeRelative(rel)) return c.notFound();
    const file = themes.assetPath(theme, rel);
    if (!file) return c.notFound();
    const requestedV = c.req.query('v');
    const versioned = Boolean(requestedV && requestedV === themes.assetVersion(theme, rel, file));
    const cacheControl = isActive
      ? (versioned ? 'public, max-age=31536000, immutable' : 'public, max-age=300')
      : 'private, no-store';
    // 复用静态文件出口：Range/HEAD/304 与流式读取都只维护一份；主题资源不再整文件读进内存。
    // compress: 主题 CSS/JS 通常很小且带 ?v=，预压缩后缓存，别让每个请求都走一遍流式 gzip。
    return sendFile(c, c.req.path, { resolveFile: () => file, cacheControl, weakEtag: true, compress: true });
  });

  app.get('/uploads/*', (c) => sendFile(c, c.req.path, { root: UPLOADS_DIR, prefix: '/uploads' }));
  app.get('/favicon.ico', (c) => c.body(null, 204));

  // PWA 清单动态生成：图标 URL 带内容指纹，换图后 manifest 里的引用也跟着换；
  // 清单本身只发 no-cache（下方默认中间件也会这么兜），浏览器每次校验一次，几十字节。
  app.get('/site.webmanifest', (c) => {
    const icon = (file) => `/${file}?v=${assetVer(file)}`;
    const manifest = {
      id: '/',
      name: SITE.identity,
      short_name: SITE.title || SITE.identity,
      description: SITE.desc,
      lang: SITE.lang,
      start_url: '/',
      scope: '/',
      display: 'standalone',
      background_color: '#faf8f4',
      theme_color: '#faf8f4',
      icons: [
        { src: icon('icon-192.png'), sizes: '192x192', type: 'image/png' },
        { src: icon('icon-512.png'), sizes: '512x512', type: 'image/png' },
        { src: icon('icon-maskable-512.png'), sizes: '512x512', type: 'image/png', purpose: 'maskable' },
      ],
    };
    return c.body(JSON.stringify(manifest), 200, {
      'Content-Type': 'application/manifest+json; charset=utf-8',
      'Cache-Control': 'no-cache',
    });
  });
}

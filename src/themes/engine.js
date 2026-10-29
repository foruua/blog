import path from 'node:path';
import { Liquid } from 'liquidjs';
import { SITE } from '../config.js';
import { themeChrome } from '../render/layout.js';
import { decodeEntities } from '../util/entities.js';
import { THEME_API } from './registry.js';
import { walkTemplates, templateMap, templateSignature } from './templates.js';

// 与 WordPress 的模板层级同构：越具体的文件越先被选中，最后都落到 index。
const HIERARCHY = {
  home: ['home', 'front-page', 'index'],
  posts: ['posts', 'home', 'list', 'index'],
  notes: ['notes', 'list', 'index'],
  post: ['single-post', 'single', 'index'],
  note: ['single-note', 'single', 'index'],
  page: ['page', 'index'],
  archive: ['archive', 'index'],
  'archive-year': ['archive-year', 'archive', 'index'],
  search: ['search', 'index'],
  friends: ['friends', 'index'],
  links: ['links', 'index'],
  404: ['404', 'not-found', 'index'],
  go: ['go', '404', 'index'],
};

const safeSlug = (slug) => String(slug ?? '').replace(/[^\p{L}\p{N}_-]+/gu, '-').replace(/^-+|-+$/g, '').slice(0, 80);

function candidateNames(opts) {
  const type = String(opts.themeType || '').trim();
  const base = [...(HIERARCHY[type] ?? ['index'])];
  if (type === 'page') {
    const slug = safeSlug(opts?.themeData?.page?.slug ?? opts?.themeData?.slug);
    if (slug) base.unshift(`page-${slug}`);
  }
  if (type === 'post' || type === 'note') {
    const slug = safeSlug(opts?.themeData?.post?.slug ?? opts?.themeData?.slug);
    if (slug) base.unshift(`${type}-${slug}`);
  }
  // 去掉重复项，保持优先级。
  return [...new Set(base)];
}

function makeEngine(theme, { cache = process.env.NODE_ENV === 'production' } = {}) {
  return new Liquid({
    root: theme.dir,
    extname: '.liquid',
    cache,
    strictFilters: true,
    strictVariables: false,
    // 模板默认自动转义，预渲染 HTML 必须显式 | raw —— 第三方主题最容易出 XSS，默认安全比方便重要。
    outputEscape: 'escape',
    jsTruthy: true,
    // 第三方主题的 DoS 护栏：正常模板远达不到这些值，但 (1..999999999) 这类循环不能拖死请求线程。
    parseLimit: 2_000_000,
    renderLimit: 3000,
    memoryLimit: 50_000_000,
  });
}

function registerFilters(engine, theme, registry) {
  engine.registerFilter('asset', (rel) => registry.assetUrl(theme, rel));
  engine.registerFilter('theme_asset', (rel) => registry.assetUrl(theme, rel));
  engine.registerFilter('abs_url', (value) => {
    try { return new URL(String(value ?? '/'), SITE.url).toString(); } catch { return SITE.url; }
  });
  // 转义 <：主题常把 | json | raw 塞进 <script>，正文里出现 </script> 时不能提前闭合标签。
  engine.registerFilter('json', (value) => {
    const text = JSON.stringify(value);
    return typeof text === 'string' ? text.replace(/</g, '\\u003c') : '';
  });
  // 去标签后也要解实体，否则 &amp; 会被自动转义成 &amp;amp;；与 data.*.excerpt 的 cleanExcerpt 口径一致。
  const textOf = (value) => decodeEntities(String(value ?? '').replace(/<[^>]*>/g, ' ')).replace(/\s+/g, ' ').trim();
  engine.registerFilter('strip_html', textOf);
  engine.registerFilter('excerpt', (value, length = 120) => {
    const text = textOf(value);
    return text.length > Number(length) ? `${text.slice(0, Number(length))}…` : text;
  });
  return engine;
}

// 导航默认取站点外壳里已经算好的那份（themeChrome），路由不必再逐页传 data.nav；
// 仍允许调用方用 themeData.nav 覆盖。
function navOf(opts, nav) {
  const current = String(opts.active ?? '');
  const items = Array.isArray(opts.themeData?.nav)
    ? opts.themeData.nav
    : (Array.isArray(nav) ? nav : []);
  return {
    current,
    items: items.map((item) => ({ ...item, active: item.key === current })),
  };
}

function siteOf() {
  return {
    title: SITE.title,
    identity: SITE.identity,
    desc: SITE.desc,
    author: SITE.author,
    url: SITE.url,
    domain: SITE.domain,
    lang: SITE.lang,
    mark: SITE.mark,
    icp: SITE.icp,
    year: new Date().getFullYear(),
  };
}

function baseContext(theme, opts, registry, chrome, nav, computedMeta = null) {
  const options = registry.optionsOf(theme);
  const page = {
    type: opts.themeType || opts.page || '',
    active: opts.active || '',
    page: opts.page || '',
    title: opts.title || '',
    desc: opts.desc || '',
    canonical: opts.canonical || '/',
    url: (() => { try { return new URL(opts.canonical || '/', SITE.url).toString(); } catch { return SITE.url; } })(),
    noindex: Boolean(opts.noindex),
    lang: opts.lang || SITE.lang,
    ogType: opts.ogType || 'website',
  };
  const data = opts.themeData && typeof opts.themeData === 'object' ? opts.themeData : {};
  return {
    site: siteOf(),
    page,
    meta: {
      title: opts.title || '',
      full_title: computedMeta?.full_title || opts.fullTitle || '',
      desc: opts.desc || '',
      canonical: page.url,
      og_type: page.ogType,
      og_image: computedMeta?.og_image || opts.og?.url || '',
      og_locale: computedMeta?.og_locale || opts.ogLocale || '',
      noindex: page.noindex,
      extra_head: opts.extraHead || '',
      json_ld: computedMeta?.json_ld || opts.structuredData || [],
    },
    nav: navOf(opts, nav),
    theme: {
      id: theme.id,
      name: theme.name,
      version: theme.version,
      author: theme.author,
      description: theme.description,
      api: THEME_API,
      options,
      asset_base: `/theme-assets/${theme.id}/`,
    },
    options,
    data,
    content: opts.main ?? '',
    main: opts.main ?? '',
    chrome,
    theme_css: registry.assetUrl(theme, 'theme.css'),
    theme_js: registry.assetUrl(theme, 'theme.js'),
  };
}

/**
 * 主题 CSS / head 片段必须落在 </head> 里。正常用法是 layout 输出 chrome.head（引擎已把片段塞进去），
 * 但第三方主题常会自己写一段 <head>；这里做最后一道兜底，已存在就不重复注入。
 */
function injectThemeHead(html, context) {
  if (!html.includes('</head>')) return html;
  let tags = '';
  if (context.theme_css && !html.includes(context.theme_css)) tags += context.theme_css_tag;
  if (context.theme_head && !html.includes(context.theme_head)) tags += context.theme_head;
  return tags ? html.replace('</head>', () => `${tags}</head>`) : html;
}

function renderFile(engine, rel, context, theme) {
  try {
    return engine.renderFileSync(rel, context);
  } catch (error) {
    const wrapped = new Error(`主题「${theme.name}」模板 ${rel} 渲染失败：${error.message}`);
    wrapped.cause = error;
    // 给上层记录用：后台要能说清是哪个主题的哪个模板挂了。
    wrapped.themeId = theme.id;
    wrapped.template = rel;
    throw wrapped;
  }
}

/**
 * 渲染一套主题。返回：
 *   string            —— 完整 HTML（主题有 layout 模板）
 *   { content, head } —— 没有 layout，交给站点默认外壳；head 是主题 CSS / head 片段
 *   null              —— 这套主题与当前页面无关，继续用默认渲染
 */
export function createThemeEngine(registry, { cache } = {}) {
  const engines = new Map();
  // 模板索引与签名由 registry 在扫描时算好（见 templates.js）；直接传 theme 对象的老调用方再兜一次。
  const mapOf = (theme) => theme.templates ?? templateMap(theme);
  const engineOf = (theme) => {
    const signature = theme.signature ?? templateSignature(theme);
    const key = `${theme.dir}:${theme.version}:${signature}`;
    let engine = engines.get(key);
    if (engine) {
      // 命中就把这条挪到队尾（Map 插入序当 LRU）：后台安装/预览主题时会在缓存里留下临时目录的引擎，
      // 纯 FIFO 下它们能把正在用的主题挤出去，然后每次渲染都重新解析整套模板。
      engines.delete(key);
      engines.set(key, engine);
      return engine;
    }
    // 每改一次模板就多一个引擎：只留最近几个，长跑的进程不会攒着旧解析树。
    if (engines.size >= 8) engines.delete(engines.keys().next().value);
    engine = registerFilters(makeEngine(theme, { cache }), theme, registry);
    engines.set(key, engine);
    return engine;
  };

  function resolve(theme, opts) {
    const map = mapOf(theme);
    for (const name of candidateNames(opts)) {
      const file = map.get(name);
      if (file) return { map, file };
    }
    return { map, file: null };
  }

  function hasLayout(theme) {
    return Boolean(mapOf(theme).get('layout'));
  }

  function render(theme, opts) {
    if (!theme) return null;
    const { map, file } = resolve(theme, opts);
    const layoutFile = map.get('layout') ?? null;
    // 页面/布局都没覆盖时，通常交回默认渲染；但仅提供 theme.css 或 head.liquid 的主题仍应全局生效
    // （主题激活后样式却只在自己覆盖的页面里出现，会非常反直觉）。
    if (!file && !layoutFile && !map.has('head') && !registry.assetUrl(theme, 'theme.css')) return null;

    const engine = engineOf(theme);
    const { chrome, nav, meta, context: shellContext } = themeChrome(opts);
    const context = baseContext(theme, opts, registry, chrome, nav, meta);
    context.theme_css_tag = context.theme_css
      ? `<link rel="stylesheet" href="${context.theme_css}">`
      : '';
    // theme.js 不会自动注入：主题自己决定放 head 还是 body 末尾、要不要 defer。
    context.theme_js_tag = context.theme_js
      ? `<script src="${context.theme_js}" defer></script>`
      : '';

    // 主题自己的 head 片段：可选，放在站点 head 里，便于加字体、预加载等。
    if (map.has('head')) {
      context.theme_head = renderFile(engine, map.get('head'), context, theme);
    } else {
      context.theme_head = '';
    }
    // 主题 CSS / head 片段必须落在 </head> 内；layout 模板只输出 chrome.head 即可。
    // 作者若已手动输出过 {{ theme_css }}，别再注入第二份。
    const alreadyLinked = Boolean(context.theme_css)
      && (context.chrome.head.includes(context.theme_css) || context.theme_head.includes(context.theme_css));
    const injected = `${alreadyLinked ? '' : context.theme_css_tag}${context.theme_head}`;
    context.chrome = {
      ...context.chrome,
      head: context.chrome.head.replace('</head>', () => `${injected}</head>`),
    };

    const content = file ? renderFile(engine, file, context, theme) : (opts.main ?? '');
    // 没有 layout 时交给内置外壳；把主题 CSS / head 片段一并带过去，否则「主题样式自动注入」只在有 layout 时成立。
    if (!layoutFile) return { content, head: injected, context: shellContext };

    return injectThemeHead(renderFile(engine, layoutFile, { ...context, content, main: content }, theme), context);
  }

  /** 启用前校验：所有模板都能被解析；返回错误数组。 */
  function validate(theme) {
    const errors = [];
    const engine = engineOf(theme);
    for (const abs of walkTemplates(theme.templatesAbs)) {
      const rel = path.relative(theme.dir, abs).split(path.sep).join('/');
      try { engine.parseFileSync(rel); } catch (error) { errors.push(`${rel}：${error.message}`); }
    }
    if (!errors.length && !hasLayout(theme) && !mapOf(theme).size) errors.push('templates 目录里没有模板文件');
    return errors;
  }

  return { render, validate };
}

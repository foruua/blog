import { PAGE_SIZE, RECENT, COMMENTS_PER_PAGE, FEEDS_PER_PAGE } from './config.js';
import { isSafeUploadPath } from './util/url.js';

export const KEYS = {
  pageSize: 'page_size',
  homeRecent: 'home_recent',
  commentsPerPage: 'comments_per_page',
  feedsPerPage: 'feeds_per_page',
  paletteDefault: 'palette_default',
  paletteCustom: 'palette_custom',
  layoutDefault: 'layout_default',
  themeDefault: 'theme_default',
  heroImages: 'hero_images',
  heroOverlay: 'hero_overlay',
  themeActive: 'theme_active',
  themeOptionsPrefix: 'theme_options:',
};

/** 主题选项按主题 id 分键存；值是一段 JSON 对象，由主题仓库负责校验与补默认值。 */
export const themeOptionsKey = (id) => `${KEYS.themeOptionsPrefix}${String(id ?? '')}`;

/* 首页封面旧键（单图时代）：写入仍镜像维护（脚本/备份对比还认），读取仅在多图键缺失/损坏时回落。 */
export const HERO_LEGACY_KEYS = { url: 'hero_image', w: 'hero_image_w', h: 'hero_image_h' };

/* 已下线的首页封面选项（视频播放方式、文字版式、文字颜色、轮播方式——已恒为自动轮播）：
   不再读取，只在「全部移除」时顺手清掉残值。 */
export const HERO_RETIRED_KEYS = ['hero_video_mode', 'hero_layout', 'hero_text_tone', 'hero_mode'];

/* 首页轮播上限，写死而非设置项：这是封面不是相册，八张还翻不到头就该换内容。 */
export const HERO_MAX = 8;

// 访客可选配色的唯一真相源：后台校验、配色面板里的色样、THEME_BOOT 白名单都取自这里。paper/ink 只是两个
// 色样点；chroma 是「自定义」滑块从预设接上来的浓度（与 palette.js 的 LEVELS 同步，test-palette 会比对）。
// 整套令牌在 style.css 末尾，改配色值要两处同步（test-palette.mjs 对不上会报错）。
// hue 是这套配色的 OKLCH 色相（不是 HSL —— 两者角度不等价，黛蓝在 HSL 是 213、OKLCH 是 252）。
// 它的唯一用途：从预设切到「自定义」时，滑块停在这个角度，观感才接得上。key '' 即「素笺」。
export const PALETTES = [
  { key: '',       name: '素笺', paper: '#faf8f4', ink: '#926922', hue: 80,  level: 'mid',  chroma: 1 },
  { key: 'qingci', name: '青瓷', paper: '#eef4f1', ink: '#26604f', hue: 168, level: 'mid',  chroma: 1 },
  { key: 'dailan', name: '黛蓝', paper: '#eff3f8', ink: '#2f5a86', hue: 252, level: 'mid',  chroma: 1 },
  { key: 'qian',   name: '茜色', paper: '#f9f2f0', ink: '#9d3a32', hue: 32,  level: 'bold', chroma: 1.3 },
  { key: 'ziteng', name: '紫藤', paper: '#f4f2f8', ink: '#5d4685', hue: 300, level: 'mid',  chroma: 1 },
];
const PALETTE_KEYS = PALETTES.map((p) => p.key);

// 「自定义配色」不是一套预设，是访客在自己浏览器里算出的一段 CSS（见 public/palette.js）。
// 它进访客白名单，**不进**站主可选清单 —— 站主设了也没用：那份 CSS 只存在于每个访客自己的
// localStorage 里，服务端渲染不出首帧，只会退化成素笺。
export const CUSTOM_PALETTE = 'custom';

// 访客可选版式的唯一真相源：后台下拉、面板按钮、THEME_BOOT 白名单都取自这里。
// 'paper' 是现行版式（内容直接铺在纸上）；'box' 是「素匣」（除首页外的页面收进一只圆角纸匣）。
// 与配色同理：站主设的是**默认**，访客选过的存在自己的 localStorage 里，首帧由 THEME_BOOT 覆盖。
export const LAYOUTS = [
  { key: 'paper', name: '纸面', hint: '内容直接铺在纸上（现行版式）' },
  { key: 'box',   name: '素匣', hint: '内页收进一只纸匣，与首页同款' },
];
const LAYOUT_KEYS = LAYOUTS.map((l) => l.key);

// 访客可选明暗的唯一真相源（后台「访客默认样式」里的三格）。
// 'auto' 不是第三个 data-theme 值，而是「不写 data-theme」—— 与前台面板同一套语义：
// 站主设 light/dark 时服务端直接挂 data-theme，访客选过（含明确选「跟随系统」）就由 THEME_BOOT 覆盖。
export const THEMES = [
  { key: 'auto',  name: '跟随系统' },
  { key: 'light', name: '亮色' },
  { key: 'dark',  name: '暗色' },
];
const THEME_KEYS = THEMES.map((t) => t.key);

// 站主可以把「自定义」设成默认配色 —— 与访客那份不同：访客的 CSS 存在他自己浏览器里，
// 站主这份由服务端用 public/palette.js 现算（见 src/palette.js），首帧就注入 <head>。
const PALETTE_DEFAULT_KEYS = [...PALETTE_KEYS, CUSTOM_PALETTE];

// 自定义配色的种子范围（与 public/palette.js 的滑块一致）。越界一律钳住，不报错 ——
// 这三个数是观感旋钮，不是安全边界；钳到边界比让整张表单存不进去合理。
const SEED_RANGE = {
  hue: { min: 0, max: 359, fallback: 210 },
  chroma: { min: 0.55, max: 1.45, fallback: 1 },
  paper: { min: 0, max: 1.8, fallback: 1 },
};
const clampNum = (raw, { min, max, fallback }) => {
  const n = Number(String(raw ?? '').trim());
  if (!Number.isFinite(n)) return fallback;
  return Math.min(max, Math.max(min, n));
};

const FEEDS_PER_PAGE_RANGE = { min: 5, max: 100, fallback: FEEDS_PER_PAGE };

function intOr(raw, { min, max, fallback }) {
  const n = Number.parseInt(String(raw ?? '').trim(), 10);
  if (!Number.isFinite(n)) return fallback;
  return Math.min(max, Math.max(min, n));
}

function parseSettingInteger(raw, { min, max }) {
  const text = String(raw ?? '').trim();
  if (!/^\d+$/.test(text)) return null;
  const n = Number(text);
  return Number.isSafeInteger(n) && n >= min && n <= max ? n : null;
}

export const settings = {

  pageSize: (repo) => intOr(repo.getSetting(KEYS.pageSize), { min: 5, max: 100, fallback: PAGE_SIZE }),

  homeRecent: (repo) => intOr(repo.getSetting(KEYS.homeRecent), { min: 0, max: 30, fallback: RECENT }),

  commentsPerPage: (repo) => intOr(repo.getSetting(KEYS.commentsPerPage), { min: 5, max: 100, fallback: COMMENTS_PER_PAGE }),

  feedsPerPage: (repo) => intOr(repo.getSetting(KEYS.feedsPerPage), FEEDS_PER_PAGE_RANGE),

  paletteDefault: (repo) => {
    const raw = String(repo.getSetting(KEYS.paletteDefault) ?? '').trim().toLowerCase();
    return PALETTE_DEFAULT_KEYS.includes(raw) ? raw : '';
  },

  // 默认配色选了「自定义」时用的种子。没存过/坏了 → 素笺那套的角度与浓度（滑块位置有着落）。
  paletteCustom: (repo) => {
    const raw = String(repo.getSetting(KEYS.paletteCustom) ?? '').trim();
    let data = null;
    if (raw) {
      try { data = JSON.parse(raw); } catch { data = null; }
    }
    const base = PALETTES[0];
    return {
      hue: Math.round(clampNum(data?.hue, { ...SEED_RANGE.hue, fallback: base.hue })),
      chroma: clampNum(data?.chroma, { ...SEED_RANGE.chroma, fallback: base.chroma }),
      paper: clampNum(data?.paper, SEED_RANGE.paper),
      ink: 0,
    };
  },

  // 访客默认明暗：auto / light / dark。脏值回落 auto（等于没设过，跟随系统）。
  themeDefault: (repo) => {
    const raw = String(repo.getSetting(KEYS.themeDefault) ?? '').trim().toLowerCase();
    return THEME_KEYS.includes(raw) ? raw : 'auto';
  },

  // 访客默认版式：'paper' 纸面 / 'box' 素匣。脏值一律回落纸面（等于没设过）。
  layoutDefault: (repo) => {
    const raw = String(repo.getSetting(KEYS.layoutDefault) ?? '').trim().toLowerCase();
    return LAYOUT_KEYS.includes(raw) ? raw : 'paper';
  },

  // 主题 id；不存在时由启动逻辑/渲染前兜底自动切到 themes/ 里的第一个可用主题。
  themeActive: (repo) => String(repo.getSetting(KEYS.themeActive) ?? '').trim().slice(0, 64),
};

// 校验「友圈每页几个源」。与 intOr 不同：不做静默兜底——填 abc/999 要收到"请填 5—100"，
// 而非看似保存成功却悄悄回默认。非法返回 null。
export function parseFeedsPerPage(raw) {
  return parseSettingInteger(raw, FEEDS_PER_PAGE_RANGE);
}


// 「访客默认配色」：只认 PALETTES 的 key（含 '' 素笺）或 'custom'，否则 null；旧客户端缺字段回 ''（等于素笺，非篡改）。
export function parsePaletteDefault(raw) {
  const v = String(raw ?? '').trim().toLowerCase();
  return PALETTE_DEFAULT_KEYS.includes(v) ? v : null;
}

// 「访客默认明暗」：只认 THEMES 的 key，否则 null。空值按跟随系统 —— 与版式同一条理由（旧表单没这字段）。
export function parseThemeDefault(raw) {
  const v = String(raw ?? '').trim().toLowerCase();
  if (!v) return 'auto';
  return THEME_KEYS.includes(v) ? v : null;
}

// 自定义配色的种子：只钳不拒（观感旋钮，不是安全边界）。返回可直接 JSON 化的四元组。
export function parsePaletteCustom(body = {}) {
  return {
    hue: Math.round(clampNum(body.hue, SEED_RANGE.hue)),
    chroma: Number(clampNum(body.chroma, SEED_RANGE.chroma).toFixed(2)),
    paper: Number(clampNum(body.paper, SEED_RANGE.paper).toFixed(2)),
    ink: 0,
  };
}

// 「访客默认版式」：只认 LAYOUTS 的 key，否则 null。空值按纸面处理 —— 旧版后台表单里没有这个
// 下拉，不能让它们一提交就报「版式不合法」（新表单恒提交 paper / box）。
export function parseLayoutDefault(raw) {
  const v = String(raw ?? '').trim().toLowerCase();
  if (!v) return 'paper';
  return LAYOUT_KEYS.includes(v) ? v : null;
}

// 首页封面列表的读取侧（前台渲染、后台表单、媒体库守卫共用）。宽松解析：JSON 坏了或挑不出时回落旧单图键
// （存量站点免迁移）；单条坏只丢那条。路径只认 /uploads/，越界直接扔。
// 每条只有 path/w/h：封面文字（标题/副标题/按钮/颜色/版式）已整块下线，历史数据里多出来的字段直接忽略。
// 只收图片：视频支持已下线，库里若还留着视频路径（历史数据），这里统一滤掉，首页直接回落站名。
const HERO_IMAGE_EXT_RE = /\.(?:png|jpe?g|gif|webp|avif)(?:$|[?#])/i;
export function heroImages(repo) {
  const raw = String(repo.getSetting(KEYS.heroImages) ?? '').trim();
  if (raw) {
    try {
      const data = JSON.parse(raw);
      if (Array.isArray(data)) {
        const list = data
          .filter((it) => it && typeof it === 'object' && isSafeUploadPath(it.path) && HERO_IMAGE_EXT_RE.test(it.path))
          .slice(0, HERO_MAX)
          .map((it) => ({
            path: it.path,
            w: /^\d{1,5}$/.test(String(it.w ?? '')) ? Number(it.w) : 0,
            h: /^\d{1,5}$/.test(String(it.h ?? '')) ? Number(it.h) : 0,
          }));
        if (list.length) return list;
      }
    } catch { /* 落到旧键 */ }
  }
  const legacy = String(repo.getSetting(HERO_LEGACY_KEYS.url) ?? '').trim();
  if (!isSafeUploadPath(legacy) || !HERO_IMAGE_EXT_RE.test(legacy)) return [];
  const w = String(repo.getSetting(HERO_LEGACY_KEYS.w) ?? '');
  const h = String(repo.getSetting(HERO_LEGACY_KEYS.h) ?? '');
  return [{
    path: legacy,
    w: /^\d{1,5}$/.test(w) ? Number(w) : 0,
    h: /^\d{1,5}$/.test(h) ? Number(h) : 0,
  }];
}

// 封面蒙版文案：压在封面下缘的渐变蒙版上，留空则整层不渲染。上限 200 字与后台输入框 maxlength 一致。
export const HERO_OVERLAY_MAX = 200;
export function heroOverlay(repo) {
  return String(repo.getSetting(KEYS.heroOverlay) ?? '').trim().slice(0, HERO_OVERLAY_MAX);
}

export const settingsFormState = (repo) => ({
  pageSize: settings.pageSize(repo),
  homeRecent: settings.homeRecent(repo),
  commentsPerPage: settings.commentsPerPage(repo),
  theme: settings.themeDefault(repo),
  palette: settings.paletteDefault(repo),
  paletteCustom: settings.paletteCustom(repo),
  layout: settings.layoutDefault(repo),
});

export function saveSettings(b, set) {
  const pageSize = parseSettingInteger(b.pageSize, { min: 5, max: 100 });
  if (pageSize === null) return '每页条数请填 5—100 之间的整数';
  const homeRecent = parseSettingInteger(b.homeRecent, { min: 0, max: 30 });
  if (homeRecent === null) return '首页条数请填 0—30 之间的整数';

  const commentsPerPage = parseSettingInteger(b.commentsPerPage, { min: 5, max: 100 });
  if (commentsPerPage === null) return '每页评论串数请填 5—100 之间的整数';

  const theme = parseThemeDefault(b.themeDefault);
  if (theme === null) return '默认明暗不合法';

  const palette = parsePaletteDefault(b.palette);
  if (palette === null) return '默认配色不合法';

  const layout = parseLayoutDefault(b.layoutDefault);
  if (layout === null) return '默认版式不合法';

  // 种子三个字段总是收下：站主在预设上拖滑块（还没点「自定义」）时也不该丢参数 ——
  // 下次点「自定义」正好从他拖到的位置接上。
  const seed = parsePaletteCustom({ hue: b.hue, chroma: b.chroma, paper: b.paper });

  set(KEYS.pageSize, String(pageSize));
  set(KEYS.homeRecent, String(homeRecent));
  set(KEYS.commentsPerPage, String(commentsPerPage));
  set(KEYS.themeDefault, theme);
  set(KEYS.paletteDefault, palette);
  set(KEYS.paletteCustom, JSON.stringify(seed));
  set(KEYS.layoutDefault, layout);
  return null;
}

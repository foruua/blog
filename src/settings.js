import { PAGE_SIZE, RECENT, COMMENTS_PER_PAGE, FEEDS_PER_PAGE } from './config.js';
import { isSafeUploadPath } from './util/url.js';
import { isVideoSource } from './media/video.js';

export const KEYS = {
  pageSize: 'page_size',
  homeRecent: 'home_recent',
  commentsPerPage: 'comments_per_page',
  feedsPerPage: 'feeds_per_page',
  paletteDefault: 'palette_default',
  heroImages: 'hero_images',
  heroMode: 'hero_mode',
  heroLayout: 'hero_layout',
  heroTone: 'hero_text_tone',
  themeActive: 'theme_active',
  themeOptionsPrefix: 'theme_options:',
};

/** 主题选项按主题 id 分键存；值是一段 JSON 对象，由主题仓库负责校验与补默认值。 */
export const themeOptionsKey = (id) => `${KEYS.themeOptionsPrefix}${String(id ?? '')}`;

/* 首页封面旧键（单图时代）：写入仍镜像维护（脚本/备份对比还认），读取仅在多图键缺失/损坏时回落。 */
export const HERO_LEGACY_KEYS = { url: 'hero_image', w: 'hero_image_w', h: 'hero_image_h' };

/* 已下线的首页封面选项（封面视频的播放方式）：不再读取，只在「全部移除」时顺手清掉残值。 */
export const HERO_RETIRED_KEYS = ['hero_video_mode'];

/* 首页轮播上限，写死而非设置项：这是封面不是相册，八张还翻不到头就该换内容。 */
export const HERO_MAX = 8;

// 封面文字版式：只给固定几套，位置/字号/遮罩由 CSS 统一控制，避免自由布局做出白字压白图。
export const HERO_LAYOUTS = [
  { key: 'bottom', name: '左下标题', hint: '标题与副标题压在左下角，轻渐变垫底' },
  { key: 'center', name: '居中卡片', hint: '半透明纸片居中，适合一句主标题' },
  { key: 'label', name: '顶部标签', hint: '副标题作小标签，标题紧随其下' },
  { key: 'minimal', name: '极简一行', hint: '只突出标题，底部一条细线' },
];
export const HERO_TONES = [
  { key: 'light', name: '浅色字', hint: '深色图用' },
  { key: 'dark', name: '深色字', hint: '浅色图用' },
];

const HERO_TITLE_MAX = 80;
const HERO_SUBTITLE_MAX = 160;
const HERO_LINK_TEXT_MAX = 24;

const cleanHeroText = (value, max) => String(value ?? '')
  .replace(/\p{Cc}/gu, ' ')
  .replace(/\s+/g, ' ')
  .trim()
  .slice(0, max);

/** 封面按钮链接：站内绝对路径或 http(s)；不放行 javascript:/data:/协议相对地址。 */
export function safeHeroLink(raw) {
  const s = String(raw ?? '').trim().slice(0, 500);
  if (!s || /[\p{Cc}\\]/u.test(s)) return '';
  if (s.startsWith('/')) {
    if (s.startsWith('//') || s.includes('..') || /[?#]/.test(s)) return '';
    return s;
  }
  try {
    const url = new URL(s);
    return url.protocol === 'http:' || url.protocol === 'https:' ? url.href : '';
  } catch { return ''; }
}

export function heroLayout(repo) {
  const value = String(repo.getSetting(KEYS.heroLayout) ?? '').trim().toLowerCase();
  return HERO_LAYOUTS.some((item) => item.key === value) ? value : 'bottom';
}

export function heroTone(repo) {
  const value = String(repo.getSetting(KEYS.heroTone) ?? '').trim().toLowerCase();
  return HERO_TONES.some((item) => item.key === value) ? value : 'light';
}

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
    return PALETTE_KEYS.includes(raw) ? raw : '';
  },

  // 主题 id；不存在时由启动逻辑/渲染前兜底自动切到 themes/ 里的第一个可用主题。
  themeActive: (repo) => String(repo.getSetting(KEYS.themeActive) ?? '').trim().slice(0, 64),
};

// 校验「友圈每页几个源」。与 intOr 不同：不做静默兜底——填 abc/999 要收到"请填 5—100"，
// 而非看似保存成功却悄悄回默认。非法返回 null。
export function parseFeedsPerPage(raw) {
  return parseSettingInteger(raw, FEEDS_PER_PAGE_RANGE);
}


// 「访客默认配色」：只认 PALETTES 的 key（含 '' 素笺），否则 null；旧客户端缺字段回 ''（等于素笺，非篡改）。
export function parsePaletteDefault(raw) {
  const v = String(raw ?? '').trim().toLowerCase();
  return PALETTE_KEYS.includes(v) ? v : null;
}

// 首页封面列表的读取侧（前台渲染、后台表单、媒体库守卫共用）。宽松解析：JSON 坏了或挑不出时回落旧单图键
// （存量站点免迁移）；单条坏只丢那条。路径只认 /uploads/，越界直接扔。
// 封面只收图片：历史数据里可能还留着视频路径（该能力已删除），这里统一滤掉，渲染与后台都当它不存在。
export function heroImages(repo) {
  const raw = String(repo.getSetting(KEYS.heroImages) ?? '').trim();
  if (raw) {
    try {
      const data = JSON.parse(raw);
      if (Array.isArray(data)) {
        const list = data
          .filter((it) => it && typeof it === 'object' && isSafeUploadPath(it.path) && !isVideoSource(it.path))
          .slice(0, HERO_MAX)
          .map((it) => ({
            path: it.path,
            w: /^\d{1,5}$/.test(String(it.w ?? '')) ? Number(it.w) : 0,
            h: /^\d{1,5}$/.test(String(it.h ?? '')) ? Number(it.h) : 0,
            title: cleanHeroText(it.title, HERO_TITLE_MAX),
            subtitle: cleanHeroText(it.subtitle, HERO_SUBTITLE_MAX),
            link: safeHeroLink(it.link),
            linkText: cleanHeroText(it.linkText, HERO_LINK_TEXT_MAX),
          }));
        if (list.length) return list;
      }
    } catch { /* 落到旧键 */ }
  }
  const legacy = String(repo.getSetting(HERO_LEGACY_KEYS.url) ?? '').trim();
  if (!isSafeUploadPath(legacy) || isVideoSource(legacy)) return [];
  const w = String(repo.getSetting(HERO_LEGACY_KEYS.w) ?? '');
  const h = String(repo.getSetting(HERO_LEGACY_KEYS.h) ?? '');
  return [{
    path: legacy,
    w: /^\d{1,5}$/.test(w) ? Number(w) : 0,
    h: /^\d{1,5}$/.test(h) ? Number(h) : 0,
    title: '', subtitle: '', link: '', linkText: '',
  }];
}

export function heroMode(repo) {
  return String(repo.getSetting(KEYS.heroMode) ?? '').trim().toLowerCase() === 'auto' ? 'auto' : 'manual';
}

export const settingsFormState = (repo) => ({
  pageSize: settings.pageSize(repo),
  homeRecent: settings.homeRecent(repo),
  commentsPerPage: settings.commentsPerPage(repo),
  palette: settings.paletteDefault(repo),
});

export function saveSettings(b, set) {
  const pageSize = parseSettingInteger(b.pageSize, { min: 5, max: 100 });
  if (pageSize === null) return '每页条数请填 5—100 之间的整数';
  const homeRecent = parseSettingInteger(b.homeRecent, { min: 0, max: 30 });
  if (homeRecent === null) return '首页条数请填 0—30 之间的整数';

  const commentsPerPage = parseSettingInteger(b.commentsPerPage, { min: 5, max: 100 });
  if (commentsPerPage === null) return '每页评论串数请填 5—100 之间的整数';

  const palette = parsePaletteDefault(b.palette);
  if (palette === null) return '默认配色不合法';

  set(KEYS.pageSize, String(pageSize));
  set(KEYS.homeRecent, String(homeRecent));
  set(KEYS.commentsPerPage, String(commentsPerPage));
  set(KEYS.paletteDefault, palette);
  return null;
}

import { PAGE_SIZE, RECENT, COMMENTS_PER_PAGE, FEEDS_PER_PAGE } from './config.js';
import { isSafeUploadPath } from './util/url.js';

export const KEYS = {
  pageSize: 'page_size',
  homeRecent: 'home_recent',
  commentsPerPage: 'comments_per_page',
  feedsPerPage: 'feeds_per_page',
  paletteDefault: 'palette_default',
  layoutDefault: 'layout_default',
  heroImages: 'hero_images',
  heroOverlay: 'hero_overlay',
  themeActive: 'theme_active',
  themeOptionsPrefix: 'theme_options:',
};

// —— 评论的三个开关 ——
// 原先要用它们得去改环境变量或源码常量：关评论、全部先审、放宽限流都要重启进程。
// 这里只做「站主最常用的三档」，不把 antispam 的每个参数都摊到界面上——
// 最短填写时间这类反机器人参数调松了就是关防护，不该出现在一个点一下就生效的表单里。
export const COMMENT_KEYS = {
  open: 'comments_open',
  moderateAll: 'comments_moderate_all',
  rate: 'comments_rate',
};

// 每 10 分钟、每个来源地址能发几条：1 太容易误伤（读者改一遍错字就没了），20 以上基本等于不限。
export const COMMENT_RATE_RANGE = { min: 1, max: 20, fallback: 5 };

const flagOn = (raw, fallback) => {
  const text = String(raw ?? '').trim();
  if (!text) return fallback;
  return text === '1' || text === 'true';
};

export const commentsOpen = (repo) => flagOn(repo.getSetting(COMMENT_KEYS.open), true);

/** 全部先审：开着时连「老读者」也要过一遍（默认关，保持既有行为：回头客直接发布）。 */
export const commentsModerateAll = (repo) => flagOn(repo.getSetting(COMMENT_KEYS.moderateAll), false);

export const commentsRateLimit = (repo) => intOr(
  repo.getSetting(COMMENT_KEYS.rate), COMMENT_RATE_RANGE,
);

export const commentsFormState = (repo) => ({
  open: commentsOpen(repo),
  moderateAll: commentsModerateAll(repo),
  rate: commentsRateLimit(repo),
});

/** 校验并写入。返回错误文案，null 表示成功。 */
export function saveCommentSettings(form, set) {
  const rate = parseSettingInteger(form.rate, COMMENT_RATE_RANGE);
  if (rate === null) return `评论限流请填 ${COMMENT_RATE_RANGE.min}—${COMMENT_RATE_RANGE.max} 之间的整数`;
  set(COMMENT_KEYS.open, form.open ? '1' : '0');
  set(COMMENT_KEYS.moderateAll, form.moderateAll ? '1' : '0');
  set(COMMENT_KEYS.rate, String(rate));
  return null;
}

/** 主题选项按主题 id 分键存；值是一段 JSON 对象，由主题仓库负责校验与补默认值。 */
export const themeOptionsKey = (id) => `${KEYS.themeOptionsPrefix}${String(id ?? '')}`;

/* 首页封面旧键（单图时代）：写入仍镜像维护（脚本/备份对比还认），读取仅在多图键缺失/损坏时回落。 */
export const HERO_LEGACY_KEYS = { url: 'hero_image', w: 'hero_image_w', h: 'hero_image_h' };

/* 已下线的首页封面选项（视频播放方式、文字版式、文字颜色、轮播方式——已恒为自动轮播）：
   不再读取，只在「全部移除」时顺手清掉残值。 */
export const HERO_RETIRED_KEYS = ['hero_video_mode', 'hero_layout', 'hero_text_tone', 'hero_mode'];

/* 首页轮播上限，写死而非设置项：这是封面不是相册，八张还翻不到头就该换内容。 */
export const HERO_MAX = 8;

// 访客可选配色的唯一真相源：后台校验、配色面板里的色样、THEME_BOOT 白名单都取自这里。
// paper / ink 是两个色样点（面板里那枚小方块），**不是**生成器的输入。
// seed 才是「自定义」滑块从预设接上来的种子，全部由 base.css 的 --bg / --accent 反算 ——
// 手抄一遍 hex 在这里，改令牌时必然忘，于是「从预设拖一下」就跳色。别再手改这些数字：
// 改完 base.css 跑 `node scripts/palette-seeds.mjs`，它会把对不上的地方连色差一起打出来。
//   hue            墨的 OKLCH 色相（不是 HSL —— 两者角度不等价，黛蓝在 HSL 是 213、OKLCH 是 251）
//   chroma / D     墨的绝对彩度（D = 深色那套；暗纸上同一支墨要更饱和才看得出）
//   paper / D      纸的染色强度 0—1（D = 深色那套）
//   inkL / D       墨的明度（生成器默认骨架是 0.48 / 0.79，预设各自不同 —— 这正是跳色的来源）
//   bgL / D        纸的明度（配合 paper 强度还原出 --bg 本身）
// chroma 是「自定义」滑块从预设接上来的浓度（与 palette.js 的 CHROMA_RANGE 同量纲，test-palette 会比对）。
// 整套令牌在 base.css，改配色值要两处同步（test-palette.mjs 与 palette-seeds.mjs 对不上会报错）。
// key '' 即「素笺」，它的令牌是 :root 里那套默认值 —— 也是现行站点的默认配色，故排第一位。
// 宣纸（黑白灰）排第二：它的墨是中灰 —— 灰没有可读的色相，hue 82 是从 #5b564d 实测出来的，拖进「自定义」时不跳色。
export const PALETTES = [
  { key: '',       name: '素笺', paper: '#faf8f4', ink: '#926922',
    seed: { hue: 77,  chroma: 0.100, chromaD: 0.106, paper: 0.159, paperD: 0.118,
            inkL: 0.550, inkLD: 0.781, bgL: 0.984, bgLD: 0.147 } },
  { key: 'xuanzhi', name: '宣纸', paper: '#f7f5f1', ink: '#5b564d',
    seed: { hue: 82,  chroma: 0.016, chromaD: 0.017, paper: 0.159, paperD: 0.073,
            inkL: 0.455, inkLD: 0.821, bgL: 0.975, bgLD: 0.176 } },
  { key: 'qingci', name: '青瓷', paper: '#eef4f1', ink: '#26604f',
    seed: { hue: 171, chroma: 0.067, chromaD: 0.082, paper: 0.208, paperD: 0.286,
            inkL: 0.445, inkLD: 0.790, bgL: 0.968, bgLD: 0.158 } },
  { key: 'dailan', name: '黛蓝', paper: '#eff3f8', ink: '#2f5a86',
    seed: { hue: 251, chroma: 0.087, chromaD: 0.074, paper: 0.221, paperD: 0.397,
            inkL: 0.458, inkLD: 0.788, bgL: 0.969, bgLD: 0.151 } },
  { key: 'qian',   name: '茜色', paper: '#f9f2f0', ink: '#9d3a32',
    seed: { hue: 28,  chroma: 0.134, chromaD: 0.093, paper: 0.223, paperD: 0.394,
            inkL: 0.486, inkLD: 0.763, bgL: 0.972, bgLD: 0.145 } },
  { key: 'ziteng', name: '紫藤', paper: '#f4f2f8', ink: '#5d4685',
    seed: { hue: 299, chroma: 0.102, chromaD: 0.101, paper: 0.228, paperD: 0.479,
            inkL: 0.448, inkLD: 0.791, bgL: 0.971, bgLD: 0.149 } },
];
const PALETTE_KEYS = PALETTES.map((p) => p.key);

// 「自定义配色」不是一套预设，是访客在自己浏览器里算出的一段 CSS（见 public/palette.js）。
// 它进访客白名单，**不进**站主可选清单 —— 站主设了也没用：那份 CSS 只存在于每个访客自己的
// localStorage 里，服务端渲染不出首帧，只会退化成素笺。
export const CUSTOM_PALETTE = 'custom';

// 访客可选版式的唯一真相源：后台下拉、面板按钮、THEME_BOOT 白名单都取自这里。
// 'box' 是现行默认（除首页外的页面收进一只圆角纸匣）；'paper' 是内容直接铺在纸上。
// 与配色同理：站主设的是**默认**，访客选过的存在自己的 localStorage 里，首帧由 THEME_BOOT 覆盖。
export const LAYOUTS = [
  { key: 'box',   name: '素匣', hint: '内页收进一只纸匣，与首页同款' },
  { key: 'paper', name: '纸面', hint: '内容直接铺在纸上' },
];
const LAYOUT_KEYS = LAYOUTS.map((l) => l.key);

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

  // 访客默认版式：'box' 素匣 / 'paper' 纸面。脏值一律回落素匣（等于没设过）。
  layoutDefault: (repo) => {
    const raw = String(repo.getSetting(KEYS.layoutDefault) ?? '').trim().toLowerCase();
    return LAYOUT_KEYS.includes(raw) ? raw : 'box';
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

// 「访客默认版式」：只认 LAYOUTS 的 key，否则 null。空值按素匣处理 —— 旧版后台表单里没有这个
// 下拉，不能让它们一提交就报「版式不合法」，也不能把站点默认悄悄改回纸面（新表单恒提交 box / paper）。
export function parseLayoutDefault(raw) {
  const v = String(raw ?? '').trim().toLowerCase();
  if (!v) return 'box';
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
  palette: settings.paletteDefault(repo),
  layout: settings.layoutDefault(repo),
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

  const layout = parseLayoutDefault(b.layout);
  if (layout === null) return '默认版式不合法';

  set(KEYS.pageSize, String(pageSize));
  set(KEYS.homeRecent, String(homeRecent));
  set(KEYS.commentsPerPage, String(commentsPerPage));
  set(KEYS.paletteDefault, palette);
  set(KEYS.layoutDefault, layout);
  return null;
}

import { decodeEntities } from './entities.js';
import { htmlToPlainText } from './html-text.js';
import { SITE } from '../config.js';

export const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => (
  { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]
));

/** 后台表单的 CSRF 隐藏域：名称、转义与位置只留一份，避免二十多个表单各写一行后漏改。 */
export const csrfField = (csrf = '') => `<input type="hidden" name="_csrf" value="${esc(csrf)}">`;

/** 从一段标签 HTML 里取双引号属性值；灯箱/媒体渲染多处共用，避免各写一份正则。调用方自行 decode。 */
export const htmlAttr = (tag, name) => new RegExp(`\\b${name}="([^"]*)"`, 'i').exec(String(tag ?? ''))?.[1] ?? '';

export const nowIso = () => new Date().toISOString().replace(/\.\d{3}Z$/, 'Z');

export function slugify(s) {
  const out = String(s ?? '').trim().toLowerCase()
    .replace(/[\s_]+/g, '-')
    .replace(/[^\p{Script=Han}\p{Letter}\p{Number}-]+/gu, '')
    .replace(/-{2,}/g, '-')
    .replace(/^-+|-+$/g, '');
  return out || 'untitled';
}

const PAGE_RESERVED_SLUGS = new Set([
  'admin', 'posts', 'notes', 'archive', 'friends', 'links', 'healthz', 'uploads',
  'api', 'p', 'n', 'a', 'go', 'moderate', 'unsubscribe', 'search',
]);
export function validateSlug(slug, kind = 'post') {
  if (typeof slug !== 'string' || slugify(slug) !== slug || slug.length > 160
      || new TextEncoder().encode(slug).length > 240) return 'slug 格式无效或过长（最多 160 字符、240 字节）';
  if (kind === 'page' && PAGE_RESERVED_SLUGS.has(slug)) return `页面地址「${slug}」与系统路由冲突`;
  return null;
}

export function utcDate(value) {
  const input = typeof value === 'string' && /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/.test(value)
    ? value.replace(' ', 'T') + 'Z' : value;
  return new Date(input);
}
const toUtcIso = (d) => utcDate(d).toISOString().replace(/\.\d{3}Z$/, 'Z');

// 文章/笔记路径前缀。只有这一处定义 n/p：postUrl() 拼地址、正文图 lightbox 分组名都用它。别在别处手写
// `kind === 'note' ? 'n' : 'p'`——会漏掉固定页（无前缀），拼出 /p/about/ 这种必然 404。
export const kindPrefix = (kind) => (kind === 'note' ? 'n' : 'p');

export const postUrl = (p) => `/${kindPrefix(p.kind)}/${encodeURIComponent(p.slug)}/`;

// 固定页（kind='page'）走自己的固定路由 `/<slug>`（/about 就这么挂的），不能按文章拼成 /p/<slug>/——那样 /go/ 会 301 到必然 404。
export const pageUrl = (slug) => `/${encodeURIComponent(slug)}`;

// 内容在前台的地址：文章 /p/<slug>/、笔记 /n/<slug>/、固定页 /<slug>。评论表单在此后接 `comment`、提交后
// 303 回该地址，两边须同一口径——以前评论侧写死 postUrl()，固定页就拼成 /p/about/comment。
export const contentUrl = (p) => (p.kind === 'page' ? pageUrl(p.slug) : postUrl(p));

// 站内路径 → 绝对 URL。canonical / og:url / JSON-LD 只认绝对地址；这里只补前缀，不解析、不编码
// （传进来的已经是拼好并编码过的站内路径）。原先 layout.js 与 public.js 各写了一份一模一样的。
export const absUrl = (p) => `${SITE.url}${p.startsWith('/') ? p : `/${p}`}`;

// 评论提交地址。postUrl 自带结尾斜杠、pageUrl 没有，不能简单拼 'comment'（固定页会得 /aboutcomment）。
export const commentAction = (p) => (p.kind === 'page' ? `${pageUrl(p.slug)}/comment` : `${postUrl(p)}comment`);

export const noteHref = (slug) => postUrl({ kind: 'note', slug });

const DATE_ONLY = /^\d{4}-\d{2}-\d{2}$/;
const LOCAL_DT = /^\d{4}-\d{2}-\d{2}[ T]\d{2}:\d{2}(:\d{2})?$/;

// 文件、后台输入与展示共用站点时区，仅支持下列偏移。
const SITE_TZ_OFFSET = process.env.SITE_TZ_OFFSET ?? '+08:00';
const TZ_NAME = { '+08:00': 'Asia/Shanghai', '+00:00': 'UTC', '+09:00': 'Asia/Tokyo' };
const SITE_TIME_ZONE = TZ_NAME[SITE_TZ_OFFSET];
if (!SITE_TIME_ZONE) throw new Error('SITE_TZ_OFFSET 只支持 +08:00、+00:00、+09:00');

export function parseDate(input, offset = SITE_TZ_OFFSET) {
  if (input instanceof Date) return toUtcIso(input);
  const s = String(input ?? '').trim();
  if (DATE_ONLY.test(s)) return toUtcIso(new Date(`${s}T00:00:00${offset}`));
  if (LOCAL_DT.test(s)) {
    const withSec = s.replace(' ', 'T');
    return toUtcIso(new Date(`${withSec.length === 16 ? withSec + ':00' : withSec}${offset}`));
  }
  const d = new Date(s);
  if (Number.isNaN(d.getTime())) throw new Error(`无法解析日期：${input}`);
  return toUtcIso(d);
}

// 构造 Intl.DateTimeFormat 约 20—50µs，是 format() 本身的几十倍；列表/归档每篇都格式化日期，故按「时区+形态」缓存实例（实测快 45 倍）。
const FORMATTERS = new Map();
const DATE_SHAPES = {
  date: { year: 'numeric', month: '2-digit', day: '2-digit' },
  datetime: { year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' },
  second: { year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit' },
};
function formatter(timeZone, shape) {
  const key = `${timeZone}|${shape}`;
  let found = FORMATTERS.get(key);
  if (!found) {
    found = new Intl.DateTimeFormat('sv-SE', { timeZone, ...DATE_SHAPES[shape] });
    FORMATTERS.set(key, found);
  }
  return found;
}

export function formatDay(utcIso, timeZone = SITE_TIME_ZONE) {
  if (!utcIso) return '';
  const date = utcDate(utcIso);
  // 数据库 TEXT 列没有日期约束：手改/导入的脏值可能让 Intl.format() 抛 RangeError。
  // 这里与 relativeDate() 同一口径，解析不了就当空串，不能让一条坏数据把整页打成 500。
  if (Number.isNaN(date.getTime())) return '';
  return formatter(timeZone, 'date').format(date);
}

/** 站内时区的 YYYY-MM-DD 拆成 [年, 月, 日]；列表、归档与友链共用同一口径。 */
/** @returns {[string, string, string]} 年 / 月 / 日，三段原样字符串（月日补零）。 */
export const dayParts = (day) => [day.slice(0, 4), day.slice(5, 7), day.slice(8)];
export const dayLabel = ([y, m, d]) => `${y} 年 ${Number(m)} 月 ${Number(d)} 日`;

/** 中文长日期：与文章刊头的「2026 年 10 月 12 日」同一口径（复用上面的拆段/拼段，免得两处格式各自漂移）。 */
export const formatDayCn = (utcIso, timeZone = SITE_TIME_ZONE) => {
  const day = formatDay(utcIso, timeZone);
  return day ? dayLabel(dayParts(day)) : '';
};

export function formatDateTime(utcIso, timeZone = SITE_TIME_ZONE) {
  if (!utcIso) return '';
  const date = utcDate(utcIso);
  if (Number.isNaN(date.getTime())) return '';
  return formatter(timeZone, 'datetime').format(date);
}

export const rfc822 = (utcIso) => utcDate(utcIso).toUTCString();

export const relativeOrDay = (utcIso, now = Date.now(), withinDays = 30, timeZone = SITE_TIME_ZONE) => {
  const t = utcDate(utcIso).getTime();
  if (Number.isNaN(t)) return '';

  // 严格小于：刚好 30 天前的那条已经算「一个月前」，该显示具体日期而不是「1 个月前」。
  return (now - t) / 86400000 < withinDays
    ? relativeDate(utcIso, now, timeZone)
    : formatDay(utcIso, timeZone);
};

export function relativeDate(utcIso, now = Date.now(), timeZone = SITE_TIME_ZONE) {
  if (!utcIso) return '';
  const t = utcDate(utcIso).getTime();
  if (Number.isNaN(t)) return '';
  const diff = now - t;
  const mins = Math.floor(diff / 60000);
  if (mins < 1) return '刚刚';
  if (mins < 60) return `${mins} 分钟前`;
  const hours = Math.floor(mins / 60);
  if (hours < 24) return `${hours} 小时前`;

  const dayStr = (x) => formatter(timeZone, 'date').format(x);
  const days = Math.round((Date.parse(`${dayStr(new Date(now))}T00:00:00Z`) - Date.parse(`${dayStr(new Date(t))}T00:00:00Z`)) / 86400000);
  if (days <= 1) return '昨天';
  if (days <= 2) return '前天';
  if (days < 30) return `${days} 天前`;
  const months = Math.floor(days / 30);
  if (months < 12) return `${months} 个月前`;
  const years = Math.floor(days / 365);
  return years <= 1 ? '去年' : `${years} 年前`;
}

export const relWhen = (iso, empty = '') => (iso ? esc(relativeDate(iso)) : empty);
export const relExact = (iso) => (iso ? `${esc(relativeDate(iso))}，${esc(formatDateTime(iso))}` : '');

/** 名字首字（印章/头像）：汉字、字母、数字之外的字符落回「·」。大小写由调用方决定。 */
export const markChar = (name) => {
  const ch = String(name ?? '').trim().slice(0, 1);
  return /[\p{Script=Han}\p{Letter}\p{Number}]/u.test(ch) ? ch : '·';
};

export const initialMark = (name) => markChar(name).toUpperCase();

export function wordCount(text) {
  const cjk = (String(text ?? '').match(/[\u3400-\u4dbf\u4e00-\u9fff\u3040-\u30ff]/g) ?? []).length;
  const latin = (String(text ?? '').match(/[A-Za-z0-9_]+/g) ?? []).length;
  return cjk + latin;
}

// 阅读时长（分钟）。wordCount() 已把中日韩字符与拉丁词合成一个数，这里用同一速率折算——不给两种文字各配
// 速率再相加，否则口径一改就跟正文页并排的「N 字」对不上账。300 字/分钟偏保守（代码块也算入）；下限 1 分钟
// （不写「0 分钟」）；空正文返回 0。
const READING_WORDS_PER_MINUTE = 300;
export const readingMinutes = (n) => {
  const words = Number(n);
  return words > 0 ? Math.max(1, Math.round(words / READING_WORDS_PER_MINUTE)) : 0;
};

const MONTHS_CN = ['一月', '二月', '三月', '四月', '五月', '六月',
  '七月', '八月', '九月', '十月', '十一月', '十二月'];

export const monthCn = (mm) => MONTHS_CN[Number(mm) - 1] ?? `${Number(mm)} 月`;

const formatWords = (n) => (n >= 10000 ? `${(n / 10000).toFixed(1)} 万` : String(n));

/** 「1.8 万字」/「2674 字」：万与字是一个词，中间不留空格；普通数字与「字」之间留一档。 */
export const formatWordCount = (n) => {
  const words = Number(n);
  if (!Number.isFinite(words) || words <= 0) return '';
  return words >= 10000 ? `${formatWords(words)}字` : `${formatWords(words)} 字`;
};

export function anchorId(text) {
  const s = String(text ?? '').trim();
  if (!s) return 'h';
  const hasCJK = /[\u3400-\u4dbf\u4e00-\u9fff]/.test(s);
  if (!hasCJK) {
    const ascii = s.toLowerCase().replace(/[^a-z0-9\s-]/g, '').trim().replace(/\s+/g, '-');
    if (ascii) return ascii.slice(0, 60);
  }

  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return `h-${h.toString(36)}`;
}

export function toLocalInput(utcIso, offset = SITE_TZ_OFFSET) {
  if (!utcIso) return '';
  const tz = TZ_NAME[offset];
  if (!tz) throw new Error('不支持的站点时区偏移');
  return formatter(tz, 'second').format(utcDate(utcIso)).replace(' ', 'T');
}

export function fromLocalInput(local, offset = SITE_TZ_OFFSET) {
  if (!local) return null;
  return parseDate(local, offset);
}

export function toIsoOffset(utcIso, offset = SITE_TZ_OFFSET) {
  if (!utcIso) return '';
  return `${toLocalInput(utcIso, offset)}${offset}`;
}

// 「最近 N 天」的起点（库里那种 ISO，可直接比字符串）。只给下界不给上界：时间写错的条目本就顶在最前，
// 排除它会与列表自相矛盾。滚动窗口（此刻往前 N×24 小时）与时区无关，不做换算。
export function recentStartIso(days = 30, nowIso = new Date().toISOString()) {
  const t = utcDate(nowIso).getTime() - Number(days) * 86400000;
  return Number.isFinite(t) ? toUtcIso(new Date(t)) : toUtcIso(new Date(0));
}

// 摘要：从入库正文 HTML 取纯文本。script/style 整块丢；pre 也整块丢（半截代码读不懂还吃光字数预算，行内
// <code> 不丢）；截断按码点而非 UTF-16 码元（切在 emoji 中间会留孤立代理项）。
/** HTML → 纯文本（与 cleanExcerpt 同一口径）。一页要几个不同长度的摘要时，先算这一次再切。 */
export const plainTextOf = (html) => htmlToPlainText(String(html ?? '').replace(/<[^>]*$/, ''), {
  dropPre: true, decodePasses: 1,
})
  .replace(/\s+/g, ' ')
  .trim();

/** 按码点截断并补省略号：切在 emoji 中间会留孤立代理项，所以不用 slice。 */
export const excerptOfText = (text, n = 96) => {
  const src = String(text ?? '');
  const chars = [...src];
  return chars.length > n ? `${chars.slice(0, n).join('').trimEnd()}…` : src;
};

export const cleanExcerpt = (html, n = 96) => excerptOfText(plainTextOf(html), n);

// 检索词来自访客输入，一律当字面量：转义正则元字符，按大小写不敏感匹配。
const regexOf = (term, global = false) => new RegExp(String(term).replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), global ? 'gi' : 'i');

// 检索命中摘要：以第一个命中词为中心取一段（引擎只负责给出纯文本，怎么截是呈现的事）。
// 词表来自访客输入，一律用 indexOf 找、不拼正则 —— `.` `*` `(` 这些字符不该被当元字符，更不该有机会让匹配炸掉。
// 窗口按码点切（与 cleanExcerpt 同一口径）：切在 emoji 中间会留孤立代理项。
// 窗口 120 码点：检索结果列表与文章列表同一套（.list .excerpt 桌面钳 2 行；窄屏检索页在 style.css 放宽到 3 行），
// 命中词落在第 41 个码点左右 —— 桌面 2 行、320/390px 的 3 行都装得下，不会出现「高亮在裁剪线外」。
export function snippetAround(text, terms, { radius = 40, max = 120 } = {}) {
  const src = String(text ?? '').replace(/\s+/g, ' ').trim();
  if (!src) return '';
  const chars = [...src];
  // 大小写不敏感匹配必须让下标落回**原串**：toLowerCase() 对个别字符会改变长度（如 'İ'→2 个码元），
  // 用它的下标去切原串会错位、把高亮塞进错误位置。用 i 标志的正则在原串上匹配，下标天然对齐。
  let at = -1, atLen = 0;
  for (const t of terms ?? []) {
    if (!t) continue;
    const m = regexOf(t).exec(src);
    if (m && (at < 0 || m.index < at)) { at = m.index; atLen = m[0].length; }
  }
  // 只在标题命中（正文里找不到词）时退回开头：仍给一段上下文，只是没有高亮。
  const atCp = at < 0 ? 0 : [...src.slice(0, at)].length;
  const atEndCp = at < 0 ? 0 : atCp + [...src.slice(at, at + atLen)].length;
  let start = Math.max(0, atCp - radius);
  let end = Math.min(chars.length, start + max);
  // 两端各退到最近的空格，但只在 8 个码点内找：拉丁词不被拦腰截断，中文没有空格、退不动就照切。
  // 退位不许越过命中本身（radius 调小到比退位距离还短时，窗口会把要找的词挤出画面）。
  if (start > 0) {
    const gap = chars.slice(start, start + 8).indexOf(' ');
    if (gap >= 0) start = Math.min(atCp, start + gap + 1);
  }
  if (end < chars.length) {
    const from = Math.max(start, end - 8);
    const gap = chars.slice(from, end).lastIndexOf(' ');
    if (gap >= 0) end = Math.max(from + gap + 1, Math.min(chars.length, atEndCp));
  }
  // 起点落在句尾会切出「…惯。第二条很主观」这种孤字开头（中文没有空格，上面那步退不动）。
  // 再往前推到最近的句读之后，最多 16 个码点 —— 推太远说明这句比窗口还长，硬推会把命中词挤出画面。
  // 推到句读之后就不再补前省略号：片段从一句完整的话开始，那个「…」只会让人以为正文被截断在词中间。
  let atSentence = false;
  if (start > 0) {
    if ('。！？；!?;'.includes(chars[start - 1])) {
      atSentence = true;
    } else {
      const stop = Math.min(atCp, start + 16);
      for (let i = start; i < stop; i += 1) {
        if ('。！？；!?;'.includes(chars[i])) { start = i + 1; atSentence = true; break; }
      }
    }
  }
  // 两端各 trim 一次：按空格边界退位后，窗口末尾常会剩一个空格（`…charlie …`）。
  const body = chars.slice(start, end).join('').trim();
  return `${start > 0 && !atSentence ? '…' : ''}${body}${end < chars.length ? '…' : ''}`;
}

// 把命中的词包进 <mark>，其余部分转义。先转义、后包标签，顺序不能反：反过来会把转义出来的 `&amp;`
// 再切碎，页面上印出半截实体。返回的是**已转义的 HTML**，调用方不要再 esc 一遍。
export function highlightTerms(text, terms) {
  const src = String(text ?? '');
  const list = [...new Set(terms ?? [])].filter(Boolean);
  if (!list.length) return esc(src);
  // 同 snippetAround：在原串上做大小写不敏感匹配，下标不错位。lastIndex 手动推进避免每次从头扫描。
  const res = list.map((t) => regexOf(t, true));
  let out = '', i = 0;
  while (i < src.length) {
    let at = -1, len = 0;
    for (const re of res) {
      re.lastIndex = i;
      const m = re.exec(src);
      if (!m) continue;
      // 同一位置命中多个词时取最长的那条：「切词」与「切」都命中时，整词高亮才读得通。
      if (at < 0 || m.index < at || (m.index === at && m[0].length > len)) { at = m.index; len = m[0].length; }
    }
    if (at < 0) break;
    out += `${esc(src.slice(i, at))}<mark>${esc(src.slice(at, at + len))}</mark>`;
    i = at + len;
  }
  return out + esc(src.slice(i));
}

// 属性值里的实体：共用 util/entities.js 同一份表与数字实体防护。以前这里自带一张 5 项的表，与别处结果
// 不一致（大小写、命名实体覆盖面都不同）。
export function decodeHtmlAttribute(value) {
  return decodeEntities(value);
}

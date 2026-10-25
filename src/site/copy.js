import { esc } from '../util/text.js';

// —— 页面文案 ——
// 首页统计行、列表页刊头这几处句子原本焊在渲染代码里，改一个字要动源码。
// 这里只收「最常被改的那几个词」，不做整站文案系统：字段太多会变成一份没人维护的翻译表。
// 默认值必须与改造前的字面量逐字相同——没设置过的站点渲染结果不变。

export const COPY_KEYS = {
  heroPosts: 'copy_hero_posts',
  heroNotes: 'copy_hero_notes',
  recent: 'copy_recent_heading',
  postsTitle: 'copy_posts_title',
  postsDesc: 'copy_posts_desc',
  notesTitle: 'copy_notes_title',
  notesDesc: 'copy_notes_desc',
};

export const COPY_MAX = { word: 12, heading: 20, title: 20, desc: 120 };

export const COPY_DEFAULTS = {
  heroPosts: '篇文章',
  heroNotes: '篇笔记',
  recent: '最近更新',
  postsTitle: '文章',
  postsDesc: '长文。偶尔写，写就写透。',
  notesTitle: '笔记',
  notesDesc: '还没长成文章的碎片、读书记录、临时想法。',
};

const oneLine = (value, max) => String(value ?? '').replace(/[\r\n]+/g, ' ').trim().slice(0, max);

/** 生效值：库里的空串回落默认。标题类**不许为空**（空刊头等于页面没标题），故只在有值时覆盖。 */
export function copyOf(read) {
  const pick = (key, fallback, max) => oneLine(read?.(key), max) || fallback;
  return {
    heroPosts: pick(COPY_KEYS.heroPosts, COPY_DEFAULTS.heroPosts, COPY_MAX.word),
    heroNotes: pick(COPY_KEYS.heroNotes, COPY_DEFAULTS.heroNotes, COPY_MAX.word),
    recent: pick(COPY_KEYS.recent, COPY_DEFAULTS.recent, COPY_MAX.heading),
    postsTitle: pick(COPY_KEYS.postsTitle, COPY_DEFAULTS.postsTitle, COPY_MAX.title),
    postsDesc: pick(COPY_KEYS.postsDesc, COPY_DEFAULTS.postsDesc, COPY_MAX.desc),
    notesTitle: pick(COPY_KEYS.notesTitle, COPY_DEFAULTS.notesTitle, COPY_MAX.title),
    notesDesc: pick(COPY_KEYS.notesDesc, COPY_DEFAULTS.notesDesc, COPY_MAX.desc),
  };
}

export function copyFormState(read) {
  return copyOf(read);
}

export function saveCopy(body, set, val) {
  const words = [
    ['heroPosts', COPY_MAX.word, '首页文章量词'],
    ['heroNotes', COPY_MAX.word, '首页笔记量词'],
    ['recent', COPY_MAX.heading, '「最近更新」标题'],
    ['postsTitle', COPY_MAX.title, '文章页标题'],
    ['notesTitle', COPY_MAX.title, '笔记页标题'],
  ];
  const next = {};
  for (const [field, max, label] of words) {
    const value = oneLine(val(body, field), max);
    if (!value) return `${label}不能为空`;
    next[field] = value;
  }
  next.postsDesc = oneLine(val(body, 'postsDesc'), COPY_MAX.desc);
  next.notesDesc = oneLine(val(body, 'notesDesc'), COPY_MAX.desc);

  for (const [field, key] of Object.entries(COPY_KEYS)) {
    set(key, next[field] === COPY_DEFAULTS[field] ? '' : next[field]);
  }
  return null;
}

// —— 页脚与社交 ——
// 页脚原本只有「© 年份 作者」+ 备案号一行，想加一句自述或几个外链只能去改源码。
// 社交链接是**站外**地址：一律 http(s) 或 mailto，渲染时 nofollow noopener，不给它任何站内权重。

export const FOOTER_KEYS = { text: 'footer_text', links: 'footer_links' };
export const FOOTER_TEXT_MAX = 160;
export const FOOTER_LINK_MAX = 6;

const LINK_LABEL_MAX = 24;
const LINK_HREF_MAX = 300;

/** 只认 http(s) 与 mailto：javascript: / data: 这类会被原样塞进 href，属于自伤型注入面。 */
export function safeLinkHref(raw) {
  const value = String(raw ?? '').trim().slice(0, LINK_HREF_MAX);
  if (!value) return '';
  if (/^mailto:[^\s<>"]+@[^\s<>"]+\.[^\s<>"]+$/i.test(value)) return value;
  try {
    const url = new URL(value);
    if (url.protocol !== 'http:' && url.protocol !== 'https:') return '';
    return url.toString();
  } catch { return ''; }
}

export function footerLinksOf(read) {
  const raw = read?.(FOOTER_KEYS.links);
  if (!raw) return [];
  let list;
  try { list = JSON.parse(raw); } catch { return []; }
  if (!Array.isArray(list)) return [];
  return list.slice(0, FOOTER_LINK_MAX)
    .map((item) => ({
      label: oneLine(item?.label, LINK_LABEL_MAX),
      href: safeLinkHref(item?.href),
    }))
    .filter((item) => item.label && item.href);
}

export function footerOf(read) {
  return {
    text: oneLine(read?.(FOOTER_KEYS.text), FOOTER_TEXT_MAX),
    links: footerLinksOf(read),
  };
}

export function saveFooter(body, set, val) {
  const text = oneLine(val(body, 'footerText'), FOOTER_TEXT_MAX);
  const rows = [];
  for (let i = 0; i < FOOTER_LINK_MAX; i += 1) {
    const label = oneLine(val(body, `linkLabel${i}`), LINK_LABEL_MAX);
    const raw = val(body, `linkHref${i}`).trim();
    if (!label && !raw) continue;
    if (!label || !raw) return `第 ${i + 1} 条链接的「名称」和「地址」都要填`;
    const href = safeLinkHref(raw);
    if (!href) return `第 ${i + 1} 条链接的地址不合法：${raw}（只支持 http(s):// 与 mailto:）`;
    rows.push({ label, href });
  }
  set(FOOTER_KEYS.text, text);
  set(FOOTER_KEYS.links, rows.length ? JSON.stringify(rows) : '');
  return null;
}

/** 页脚社交链接的标记：与页脚法务行同层，图标一律 aria-hidden，链接的可访问名就是那个词。 */
export const footerLinksHtml = (links) => (links?.length
  ? `        <p class="foot-links">${links.map((l) => `<a href="${esc(l.href)}"${/^https?:/i.test(l.href) ? ' target="_blank" rel="noopener nofollow"' : ''}>${esc(l.label)}</a>`).join('<span class="sep" aria-hidden="true">·</span>')}</p>`
  : '');

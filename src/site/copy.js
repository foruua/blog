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

// —— 外链规范化 ——
// 导航里的自定义链接是**站外**地址：只认 http(s) 与 mailto，渲染时一律 nofollow noopener，
// 不给它任何站内权重。javascript: / data: 这类会被原样塞进 href，属于自伤型注入面。
export const LINK_HREF_MAX = 300;

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

import { pageUrl } from '../util/text.js';

// —— 导航菜单 ——
// 原先是 render/layout.js 里的两个常量数组：三个一级项 + 「页面」下拉里的三项，再自动追加所有固定页。
// 改名、换顺序、临时藏起来、加一条站外链接，全都得改源码。现在搬进 settings 表。
//
// 存的是**覆盖量**而不是整份清单：只记顺序、名称、分组、显隐。
// 固定页不进库 —— 新建一篇页面自动出现在菜单末尾，删掉就自动消失，不需要回后台点一次「同步」。

export const NAV_KEY = 'nav_items';
export const NAV_MORE_LABEL_KEY = 'nav_more_label';
export const NAV_MORE_LABEL_MAX = 8;
export const NAV_MAX = 24;
const NAV_LABEL_MAX = 20;

/** 一级项（页头常驻）与二级项（「页面」下拉）的划分由这个字段决定。 */
export const NAV_GROUPS = ['main', 'more'];
export const NAV_GROUP_LABEL = { main: '顶栏', more: '「页面」里' };

export const NAV_DEFAULTS = [
  { key: 'home', label: '首页', href: '/', group: 'main' },
  { key: 'posts', label: '文章', href: '/posts/', group: 'main' },
  { key: 'notes', label: '笔记', href: '/notes/', group: 'main' },
  { key: 'friends', label: '友圈', href: '/friends/', group: 'more' },
  { key: 'links', label: '友链', href: '/links/', group: 'more' },
  { key: 'archive', label: '归档', href: '/archive/', group: 'more' },
];

const BUILTIN_KEYS = new Set(NAV_DEFAULTS.map((item) => item.key));
const LINK_KEY_RE = /^link:[a-z0-9]{1,16}$/;

const clean = (value, max) => String(value ?? '').replace(/[\r\n]+/g, ' ').trim().slice(0, max);

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

/** 自定义链接的 key：站主删了再加一条也不会撞上原来的位置。 */
const newLinkKey = () => `link:${Date.now().toString(36).slice(-6)}${Math.random().toString(36).slice(2, 5)}`;

function parseStored(read) {
  const raw = String(read?.(NAV_KEY) ?? '').trim();
  if (!raw) return [];
  let list;
  try { list = JSON.parse(raw); } catch { return []; }
  if (!Array.isArray(list)) return [];
  return list.slice(0, NAV_MAX).map((item) => {
    if (!item || typeof item !== 'object') return null;
    const key = String(item.key ?? '').trim().slice(0, 64);
    if (!key) return null;
    const group = NAV_GROUPS.includes(item.group) ? item.group : null;
    const show = item.show === 0 || item.show === '0' || item.show === false ? 0 : 1;
    if (LINK_KEY_RE.test(key)) {
      const href = safeLinkHref(item.href);
      const label = clean(item.label, NAV_LABEL_MAX);
      if (!href || !label) return null;
      return { key, label, href, group: group ?? 'more', show, custom: true };
    }
    return { key, label: clean(item.label, NAV_LABEL_MAX), group, show };
  }).filter(Boolean);
}

/**
 * 合并「库里的覆盖量」+「内置项」+「当前固定页」，得到最终菜单。
 * 规则：库里记了顺序就按它排；库里没有的（新页面、升级后的旧库）按默认顺序追加在末尾。
 */
export function navItemsOf(read, pages = []) {
  const pageItems = (Array.isArray(pages) ? pages : [])
    .filter((p) => p && p.slug && !BUILTIN_KEYS.has(p.slug))
    .map((p) => ({ key: p.slug, label: clean(p.title, NAV_LABEL_MAX) || p.slug, href: pageUrl(p.slug), group: 'more' }));
  const base = [...NAV_DEFAULTS, ...pageItems];
  const baseMap = new Map(base.map((item) => [item.key, item]));

  const out = [];
  const seen = new Set();
  for (const item of parseStored(read)) {
    if (item.custom) {
      out.push({ ...item, icon: 'page' });
      continue;
    }
    const preset = baseMap.get(item.key);
    if (!preset || seen.has(item.key)) continue;
    seen.add(item.key);
    out.push({
      key: item.key,
      label: item.label || preset.label,
      href: preset.href,
      group: item.group ?? preset.group,
      show: item.show,
      icon: BUILTIN_KEYS.has(item.key) ? item.key : 'page',
    });
  }
  for (const preset of base) {
    if (seen.has(preset.key)) continue;
    out.push({ ...preset, show: 1, icon: BUILTIN_KEYS.has(preset.key) ? preset.key : 'page' });
  }
  return out;
}

/** 实际渲染用的三份：顶栏、下拉、抽屉（= 两者拼起来）。show=0 的只在这里被滤掉，后台表单仍能看到。 */
export function visibleNavOf(items) {
  const shown = items.filter((item) => item.show);
  return {
    main: shown.filter((item) => item.group === 'main'),
    more: shown.filter((item) => item.group !== 'main'),
    all: [...shown.filter((item) => item.group === 'main'), ...shown.filter((item) => item.group !== 'main')],
  };
}

export const navMoreLabelOf = (read) => clean(read?.(NAV_MORE_LABEL_KEY), NAV_MORE_LABEL_MAX) || '页面';

/** 后台表单状态：完整清单（含隐藏项 + 自定义链接），顺序即渲染顺序。 */
export function navFormState(read, pages = []) {
  return { items: navItemsOf(read, pages), moreLabel: navMoreLabelOf(read) };
}

/**
 * 保存。表单是「整份清单」提交：每行带 key / label / group / show，顺序就是行的顺序。
 * 隐藏项也要提交（否则一旦藏起来就再也点不回来），故后台渲染时不用 disabled。
 */
export function saveNav({ keys, labels, groups, shows, hrefs = [], moreLabel, removeKey, move, newLabel, newHref, newGroup }, set) {
  const rows = [];
  for (let i = 0; i < keys.length; i += 1) {
    const key = String(keys[i] ?? '').trim();
    if (!key) continue;
    const label = clean(labels[i], NAV_LABEL_MAX);
    if (!label) return `第 ${i + 1} 项的名称不能为空`;
    const group = NAV_GROUPS.includes(groups[i]) ? groups[i] : 'more';
    const show = shows[i] ? 1 : 0;
    const custom = LINK_KEY_RE.test(key);
    if (custom) {
      // 自定义链接的地址不在表单里可改（改名/换位是常态，换域名请删了重加）：从隐藏字段原样带回来。
      const href = safeLinkHref(hrefs[i]);
      if (!href) return `第 ${i + 1} 项的地址已失效，请删掉重新添加`;
      rows.push({ key, label, group, show, custom, href });
      continue;
    }
    rows.push({ key, label, group, show, custom });
  }

  // 移除：只允许删自定义链接。内置项和固定页用「隐藏」表达，删掉会让下次渲染又按默认补回来。
  const removable = new Set(rows.filter((row) => row.custom).map((row) => row.key));
  const remaining = removeKey && removable.has(removeKey) ? rows.filter((row) => row.key !== removeKey) : rows;
  // 读取侧只取前 NAV_MAX 项；写入也必须同口径，别让一次伪造的长表单把整份 JSON 写进 settings。
  if (remaining.length > NAV_MAX) return `导航最多 ${NAV_MAX} 项`;
  // 上移/下移：一次一格，越界就原样不动。
  if (move && /^-?\d+$/.test(String(move.index)) && (move.dir === -1 || move.dir === 1)) {
    const from = Number(move.index);
    const to = from + move.dir;
    if (from >= 0 && from < remaining.length && to >= 0 && to < remaining.length) {
      [remaining[from], remaining[to]] = [remaining[to], remaining[from]];
    }
  }

  const label = clean(newLabel, NAV_LABEL_MAX);
  const href = String(newHref ?? '').trim();
  if (label || href) {
    if (!label || !href) return '新增链接的「名称」和「地址」都要填';
    const safe = safeLinkHref(href);
    if (!safe) return `新增链接的地址不合法：${href}（只支持 http(s):// 与 mailto:）`;
    if (remaining.length >= NAV_MAX) return `导航最多 ${NAV_MAX} 项`;
    remaining.push({ key: newLinkKey(), label, href: safe, group: NAV_GROUPS.includes(newGroup) ? newGroup : 'more', show: 1, custom: true });
  }

  const more = clean(moreLabel, NAV_MORE_LABEL_MAX);
  if (!more) return '「页面」下拉的名称不能为空';

  set(NAV_MORE_LABEL_KEY, more === '页面' ? '' : more);
  set(NAV_KEY, JSON.stringify(remaining.map((row) => {
    const out = { key: row.key, label: row.label, group: row.group, show: row.show };
    if (row.custom) out.href = row.href;
    return out;
  })));
  return null;
}

export { BUILTIN_KEYS, NAV_LABEL_MAX };

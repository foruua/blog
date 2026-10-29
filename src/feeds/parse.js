// 友圈解析层：把 RSS 2.0 / RSS 1.0(RDF) / Atom 摘成统一条目。
//
// 自写而不引库：只读几个标签又保持 0 依赖；不解析 DTD 内部子集与外部实体，天然免疫 XXE 与实体炸弹。
// 宽容优先（真实 feed 多不合规），但拿不到 http(s) 链接的条目一律丢弃；失败给人话，方便后台排障。

// 提取逻辑版本号：凡会改变「落库内容」的改动都要 +1。库里那些行是旧规则算的，而条件请求（ETag/
// Last-Modified）会让它们一路 304、永不重算——版本一变，刷新层就作废所有条件请求缓存、逼下轮全量重抓。
export const PARSER_VERSION = 3;

const MAX_DEPTH = 40;
const MAX_NODES = 6000;
const MAX_ITEM_TEXT = 200_000;
const MAX_ITEMS = 30;

export class FeedParseError extends Error {
  constructor(message, code = 'parse') {
    super(message);
    this.name = 'FeedParseError';
    this.code = code;
  }
}

import { decodeEntities } from '../util/entities.js';
import { stripHtmlTags } from '../util/html-text.js';

/* 标签名与属性 */

const localName = (name) => {
  const i = name.indexOf(':');
  return (i < 0 ? name : name.slice(i + 1)).toLowerCase();
};

function parseStartTag(body) {
  const m = /^\s*([^\s/>]+)/.exec(body);
  const name = m ? m[1] : '';
  const attrs = {};
  const rest = m ? body.slice(m[0].length) : '';
  const re = /([^\s=/]+)\s*=\s*("([^"]*)"|'([^']*)'|([^\s"'>]+))|([^\s=/]+)/g;
  let a;
  while ((a = re.exec(rest))) {
    const key = a[1] ?? a[6];
    if (!key) continue;
    const raw = a[3] ?? a[4] ?? a[5] ?? '';
    attrs[localName(key)] = decodeEntities(raw);
  }
  return { name, attrs };
}

function tagEnd(src, from) {
  let quote = '';
  for (let i = from; i < src.length; i++) {
    const ch = src[i];
    if (quote) { if (ch === quote) quote = ''; continue; }
    if (ch === '"' || ch === "'") { quote = ch; continue; }
    if (ch === '>') return i;
  }
  return -1;
}

function skipDoctype(src, from) {
  let depth = 0;
  for (let i = from; i < src.length; i++) {
    const ch = src[i];
    if (ch === '[') depth++;
    else if (ch === ']') depth--;
    else if (ch === '>' && depth <= 0) return i + 1;
  }
  return src.length;
}

// 解析成树。文本解析时即完成实体解码（CDATA 段保持原样），这样后续 stripHtml 不会把 CDATA 里的 `&lt;` 二次解码。
function parseXml(src) {
  const root = { name: '#document', attrs: {}, children: [], text: '' };
  const stack = [root];
  let i = 0;
  let nodes = 0;
  const push = (node) => {
    if (++nodes > MAX_NODES) throw new FeedParseError('XML 太复杂，已放弃', 'too-complex');
    stack[stack.length - 1].children.push(node);
  };
  const addText = (text) => {
    const top = stack[stack.length - 1];
    if (top.text.length + text.length > MAX_ITEM_TEXT) return;
    top.text += text;
  };

  while (i < src.length) {
    const lt = src.indexOf('<', i);
    if (lt < 0) { addText(decodeEntities(src.slice(i))); break; }
    if (lt > i) addText(decodeEntities(src.slice(i, lt)));

    if (src.startsWith('<!--', lt)) {
      const end = src.indexOf('-->', lt + 4);
      i = end < 0 ? src.length : end + 3;
      continue;
    }
    if (src.startsWith('<![CDATA[', lt)) {
      const end = src.indexOf(']]>', lt + 9);
      addText(src.slice(lt + 9, end < 0 ? src.length : end));
      i = end < 0 ? src.length : end + 3;
      continue;
    }
    if (src.startsWith('<!', lt)) { i = skipDoctype(src, lt + 2); continue; }
    if (src.startsWith('<?', lt)) {
      const end = src.indexOf('?>', lt + 2);
      i = end < 0 ? src.length : end + 2;
      continue;
    }
    if (src.startsWith('</', lt)) {
      const end = src.indexOf('>', lt + 2);
      if (end < 0) break;
      const name = localName(src.slice(lt + 2, end).trim());
      for (let d = stack.length - 1; d > 0; d--) {
        if (localName(stack[d].name) === name) { stack.length = d; break; }
      }
      i = end + 1;
      continue;
    }
    if (!/[A-Za-z_/]/.test(src[lt + 1] ?? '')) { addText('<'); i = lt + 1; continue; }

    const end = tagEnd(src, lt + 1);
    if (end < 0) { addText(src.slice(lt)); break; }
    const raw = src.slice(lt + 1, end);
    const selfClosing = raw.trimEnd().endsWith('/');
    const { name, attrs } = parseStartTag(selfClosing ? raw.trimEnd().slice(0, -1) : raw);
    if (!name) { i = end + 1; continue; }
    const node = { name, attrs, children: [], text: '' };
    push(node);
    if (!selfClosing) {
      if (stack.length >= MAX_DEPTH) throw new FeedParseError('XML 太复杂，已放弃', 'too-complex');
      stack.push(node);
    }
    i = end + 1;
  }
  return root;
}

/* 取值工具 */

const kidsOf = (node, name) => {
  const want = localName(name);
  return (node?.children ?? []).filter((c) => localName(c.name) === want);
};
const firstKid = (node, ...names) => {
  for (const n of names) { const hit = kidsOf(node, n)[0]; if (hit) return hit; }
  return null;
};

function textOf(node, depth = 0) {
  if (!node || depth > 8) return '';
  let out = node.text ?? '';
  for (const child of node.children ?? []) {
    const t = textOf(child, depth + 1);
    if (t) out += (out && !/\s$/.test(out) ? ' ' : '') + t;
  }
  return out;
}

// eslint-disable-next-line no-control-regex -- 要清理的正是控制字符，必须把它们写进字符类（保留 \t \n \r）
const CONTROL_RE = /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g;

export function cleanText(input, max = 200) {
  const text = String(input ?? '')
    .replace(CONTROL_RE, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  // 按码点截断：UTF-16 slice 切在 emoji/代理对中间会留下孤立代理项。
  return [...text].slice(0, max).join('');
}

/* 花括号短代码：Typecho/WordPress 主题会把 `{mx_post_card type="local" cid="178"}`、`{mx_photo}` 写进正文，
   抓全文当摘要时会带到卡片上。判定刻意收紧，宁可漏不可误伤（摘要里出现代码很正常）：`{` 后必须紧跟小写
   标识符、不留空格（`{ console.log(1) }` 免疫），且要有 `key="value"` 属性或名字带下划线才算短代码。 */
const SC_ATTR = String.raw`[a-z_][\w-]*\s*=\s*(?:"[^"]*"|'[^']*'|[\w-]+)`;
const SC_BLOCK = new RegExp(String.raw`^([a-z][a-z0-9_]*)((?:\s+${SC_ATTR})*)\s*$`);
const SC_TAIL = new RegExp(String.raw`\{[a-z][a-z0-9_]*(?:\s+[a-z_][\w-]*\s*=\s*(?:"[^"]*"?|'[^']*'?|[\w-]+)?|\s+)?[^{}]*$`);

function stripShortcodes(text) {
  return String(text ?? '')
    .replace(/\{([^{}]*)\}/g, (whole, inner) => {
      const m = SC_BLOCK.exec(inner);
      if (!m) return whole;
      const [, name, attrs] = m;
      return attrs.trim() || name.includes('_') ? ' ' : whole;
    })
    .replace(SC_TAIL, ' ');
}

export function htmlToText(input, max = 220) {
  // 远端 feed 常见二次编码（&amp;lt;）：与旧实现一样「剥标签 → 解实体」两轮，
  // 第二轮会把第一轮解出来的 <script> 再剥掉，而不是把它当纯文本留下。
  let text = String(input ?? '');
  for (let pass = 0; pass < 2; pass++) { text = stripHtmlTags(text); text = decodeEntities(text); }
  return cleanText(text, max);
}

function httpUrl(raw, base) {
  const s = decodeEntities(String(raw ?? '').trim()).replace(/\s+/g, '');
  if (!s || s.length > 2000) return '';
  let url;
  try { url = new URL(s, /^https?:/i.test(base ?? '') ? base : undefined); } catch { return ''; }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') return '';
  if (url.username || url.password) return '';
  return url.href.length > 2000 ? '' : url.href;
}

function parseWhen(raw) {
  const s = String(raw ?? '').trim();
  if (!s || s.length > 100) return null;
  const t = Date.parse(s);
  if (!Number.isFinite(t)) return null;
  const d = new Date(t);
  const year = d.getUTCFullYear();
  // 时区写错的源会出现 1970/9999 这种年份，会把前台时间轴整体带偏。
  if (year < 1990 || year > 2100) return null;
  return d.toISOString().replace(/\.\d{3}Z$/, 'Z');
}

const authorName = (raw) => {
  const s = cleanText(raw, 80);
  const m = /\(([^)]+)\)\s*$/.exec(s);   // RSS 的老写法：someone@example.com (Someone)
  return m ? cleanText(m[1], 80) : s;
};

function atomLink(node) {
  let fallback = '';
  for (const link of kidsOf(node, 'link')) {
    const href = link.attrs.href ?? textOf(link);
    if (!href) continue;
    const rel = (link.attrs.rel ?? 'alternate').toLowerCase();
    if (rel === 'alternate' || rel === '') return href;
    if (!fallback && rel !== 'self' && rel !== 'enclosure') fallback = href;
  }
  return fallback;
}

/* 提取 */

function mapItem(node, format, baseUrl) {
  const pick = (...names) => firstKid(node, ...names);

  const title = cleanText(textOf(pick('title')), 300);
  let link = format === 'atom' ? atomLink(node) : textOf(pick('link'));
  if (!link) link = pick('enclosure')?.attrs?.url ?? '';
  if (!link && format !== 'atom') link = textOf(pick('guid', 'id'));
  const abs = httpUrl(link, baseUrl);
  if (!abs) return null;

  const guid = cleanText(textOf(pick('guid', 'id')), 300) || abs;
  const publishedAt = parseWhen(textOf(pick('pubDate', 'published', 'updated', 'dc:date', 'date', 'issued', 'created')));

  const SUMMARY_MAX = 300;
  const summary = [pick('description'), pick('summary'), pick('content'), pick('encoded'), pick('subtitle')]
    .filter(Boolean)
    .map((node) => cleanText(stripShortcodes(htmlToText(textOf(node), SUMMARY_MAX)), SUMMARY_MAX))
    .reduce((best, text) => (text.length > best.length ? text : best), '');

  return {
    guid,
    title: title || '(无标题)',
    link: abs,
    author: authorName(textOf(pick('author', 'creator')) || pick('author')?.attrs?.name || ''),
    summary,
    publishedAt,
  };
}

const looksLikeHtml = (src) => /^\s*(<!doctype\s+html|<html[\s>])/i.test(src);

function extractRss(doc, format, baseUrl) {
  const channel = firstKid(doc, 'channel') ?? doc;
  const siteUrl = httpUrl(textOf(firstKid(channel, 'link')), baseUrl);
  const rawItems = format === 'rdf' ? kidsOf(doc, 'item') : kidsOf(channel, 'item');
  return {
    title: cleanText(textOf(firstKid(channel, 'title')), 120),
    siteUrl,
    items: rawItems,
  };
}

function extractAtom(doc, baseUrl) {
  return {
    title: cleanText(textOf(firstKid(doc, 'title')), 120),
    siteUrl: httpUrl(atomLink(doc), baseUrl),
    items: kidsOf(doc, 'entry'),
  };
}

export function parseFeed(xml, { baseUrl = '', maxItems = MAX_ITEMS } = {}) {
  const src = String(xml ?? '').replace(/^\uFEFF/, '');
  if (!src.trim()) throw new FeedParseError('对方返回了空内容', 'empty');

  const root = parseXml(src);
  const doc = (root.children ?? [])[0];
  if (!doc) throw new FeedParseError('不是有效的 XML', 'parse');

  const name = localName(doc.name);
  if (name === 'html' || looksLikeHtml(src)) {
    throw new FeedParseError('这是网页，不是订阅源（可以改填站点主页）', 'html');
  }

  let format;
  let extracted;
  if (name === 'rss') { format = 'rss'; extracted = extractRss(doc, 'rss', baseUrl); }
  else if (name === 'rdf') { format = 'rdf'; extracted = extractRss(doc, 'rdf', baseUrl); }
  else if (name === 'feed') { format = 'atom'; extracted = extractAtom(doc, baseUrl); }
  else throw new FeedParseError(`不是 RSS / Atom 源（根元素是 <${cleanText(doc.name, 40)}>）`, 'format');

  const items = [];
  const seen = new Set();
  for (const node of extracted.items.slice(0, maxItems * 3)) {
    const item = mapItem(node, format, baseUrl);
    if (!item) continue;
    // 同一源里重复 guid 很常见（改后重发），先去重再交给 SQLite upsert。
    if (seen.has(item.guid)) continue;
    seen.add(item.guid);
    items.push(item);
    if (items.length >= maxItems) break;
  }
  if (!items.length && !extracted.items.length) {
    throw new FeedParseError('源里没有条目', 'empty-feed');
  }
  return { format, title: extracted.title, siteUrl: extracted.siteUrl, items };
}

import { contentUrl, nowIso } from '../util/text.js';
import { htmlToPlainText } from '../util/html-text.js';

// 全站检索：只搜已发布的文章与笔记。内容量小（个人博客几十到几百篇），索性不建索引、不切词：
// 查询时现读现匹配——把标题与正文的纯文本取出来，按子串判断是否包含每个词。
// 中文天然可搜（子串匹配本来就不受分词影响），也就不需要 FTS5、切词版本号与增量维护那一整套。

// 单次查询最多返回多少条：命中太多时列表没有下限，截断并给一句"再具体一点"比无限翻页更简单。
export const SEARCH_LIMIT = 50;

// 「已发布」口径与 db/repo.js 的 LIVE_ANY 一致（这里连 kind 一起钉死）：草稿、未到时间、页面与评论都不搜。
const LIVE = `draft = 0 AND published_at IS NOT NULL AND published_at <= ? AND kind IN ('post','note')`;

// 块级标签变空格而非删掉：'</p><p>' 直接删会让前后两词黏成一个不存在的词。
// 入库 HTML → 纯文本（匹配用）。具体规则集中在 util/html-text.js。
export function plainText(html) {
  return htmlToPlainText(html, {
    dropPre: true, blockBoundaries: true, tagReplacement: '', decodePasses: 1,
  }).replace(/\s+/g, ' ').trim();
}

// 输入 → 词表：按空白切开、去掉引号、去重、小写。多个词是 AND（全部命中才算）。
// 词数上限防止有人用 200 个短词把每个命中项的 highlight/snippet 拖成 O(词数×正文)。
const MAX_TERMS = 12;
export function parseQuery(raw) {
  const text = String(raw ?? '').trim().slice(0, 200);
  const terms = [...new Set(text.toLowerCase().match(/[^\s"]+/g) ?? [])].slice(0, MAX_TERMS);
  return { text, terms, empty: terms.length === 0 };
}

export function createSearch(db) {
  // 列表查询只取元数据：body_html 动辄几 MB，纯文本一旦缓存住就不该每查一次再拖一遍全站 HTML。
  // 正文按 id 单独取，只在缓存未命中（新文章/刚编辑过）时发生。
  const q = db.prepare(`SELECT id, slug, kind, title, version, updated_at, file_hash, published_at, word_count
    FROM posts WHERE ${LIVE} ORDER BY published_at DESC, id DESC`);
  const qBody = db.prepare('SELECT body_html FROM posts WHERE id = ?');
  const bodyStmts = new Map();
  const bodyStmt = (n) => {
    let stmt = bodyStmts.get(n);
    if (!stmt) {
      stmt = db.prepare(`SELECT id, body_html FROM posts WHERE id IN (${Array.from({ length: n }, () => '?').join(',')})`);
      bodyStmts.set(n, stmt);
    }
    return stmt;
  };

  // 按 (id, version) 缓存纯文本与「标题+正文」的小写匹配串：两者都在 version 不变时恒定。
  // 小写串以前是每次查询现拼一遍整站语料，现在跟着纯文本一起缓存，命中路径零分配。
  // 条目被编辑时 version 变化即失效；查询结束时顺手删掉已不在结果集里的 id（文章删除后的残留）。
  // 再加一道硬上限兜底：缓存里存的是整站正文纯文本，万一裁剪路径没走到（异常/提前返回），
  // 不该让它无界长下去。超了就按插入序丢最老的——退化成现算，而不是把内存吃掉。
  // 上限按「整站正文纯文本」的实际体量来定：中文文章 10KB 正文 × 500 篇，加上小写匹配串
  // 约 10MB；8MB 会把中型站点整批淘汰，之后每次检索都重新 htmlToPlainText 全站。32MB 覆盖
  // 常见规模，仍远小于一个进程的其它常驻开销。
  const TEXT_CACHE_MAX = 1000;
  const TEXT_CACHE_MAX_BYTES = 32 * 1024 * 1024;
  const textCache = new Map();
  let textCacheBytes = 0;
  // 条目里同时存 text 与 hay（标题+正文的小写串），后者几乎和正文一样大。
  // JS 字符串按 UTF-16 存储，按 length（字符数）记账会把内存低估约一半；统一按 2 字节/码元估算。
  const entryBytes = (entry) => (entry.text.length + entry.hay.length) * 2;
  const evictOldest = () => {
    const first = textCache.keys().next();
    if (first.done) return;
    const old = textCache.get(first.value);
    textCache.delete(first.value);
    textCacheBytes -= old ? entryBytes(old) : 0;
  };
  const entryKey = (row) => `${row.version}:${row.updated_at ?? ''}:${row.file_hash ?? ''}`;
  const entryOf = (row, cachedBody) => {
    const cached = textCache.get(row.id);
    // 不能只认 id + version：删除最大 id 后 SQLite 可能把该 rowid 复用给新文章，version 又从 1 开始，
    // 会命中上一篇文章的正文。把 updated_at/file_hash 一起纳入，复用 rowid 的新行必然换 key。
    const key = entryKey(row);
    if (cached && cached.key === key) return cached;
    const text = plainText(cachedBody !== undefined ? cachedBody : qBody.get(row.id)?.body_html);
    const entry = { key, version: row.version, text, hay: `${row.title}\n${text}`.toLowerCase() };
    if (cached) { textCacheBytes -= entryBytes(cached); textCache.delete(row.id); }
    textCache.set(row.id, entry);
    textCacheBytes += entryBytes(entry);
    while (textCache.size > TEXT_CACHE_MAX || textCacheBytes > TEXT_CACHE_MAX_BYTES) evictOldest();
    return entry;
  };

  const item = (row, text) => ({
    type: row.kind,
    id: Number(row.id),
    slug: row.slug,
    title: row.title,
    url: contentUrl({ kind: row.kind, slug: row.slug }),
    ts: row.published_at,
    words: row.word_count,
    // 正文纯文本，只给渲染摘要用（截多长、怎么高亮是呈现的事，引擎不参与）。每行本来就要算它来匹配，
    // 顺手带上等于白送；带的是纯文本而非 HTML，渲染侧不必再解析一遍。
    text,
  });

  // 检索。命中的按发布时间从新到旧；超过上限时截断并置 truncated。
  function query({ q: raw, limit = SEARCH_LIMIT } = {}) {
    const parsed = parseQuery(raw);
    if (parsed.empty) return { parsed, hits: [], total: 0, truncated: false };

    const rows = q.all(nowIso());
    // 冷缓存时按 200 篇一批取正文：既避免每篇一次 SELECT，也不会把全站 body_html 同时堆进内存。
    // 文本缓存本身有 8MB（按 UTF-16 估算）上限；批次外只保留命中项需要的纯文本。
    const hits = [];
    let total = 0;
    for (let start = 0; start < rows.length; start += 200) {
      const chunk = rows.slice(start, start + 200);
      const missing = [];
      for (const row of chunk) {
        const cached = textCache.get(row.id);
        if (!cached || cached.key !== entryKey(row)) missing.push(row.id);
      }
      const bodies = new Map();
      if (missing.length) {
        for (const row of bodyStmt(missing.length).all(...missing)) bodies.set(row.id, row.body_html);
      }
      for (const row of chunk) {
        const entry = entryOf(row, bodies.has(row.id) ? bodies.get(row.id) : undefined);
        if (!parsed.terms.every((t) => entry.hay.includes(t))) continue;
        total += 1;
        if (hits.length < limit) hits.push(item(row, entry.text));
      }
    }
    if (textCache.size > rows.length) {
      const live = new Set(rows.map((r) => r.id));
      for (const id of textCache.keys()) {
        if (!live.has(id)) {
          const old = textCache.get(id);
          textCache.delete(id);
          textCacheBytes -= old ? entryBytes(old) : 0;
        }
      }
    }
    return { parsed, hits, total, truncated: total > hits.length };
  }

  return { query, parseQuery };
}

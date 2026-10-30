import { slugify, kindPrefix, parseDate, nowIso } from '../src/util/text.js';
import { createTx } from './tx.js';
import { parseCursorParts } from './cursor.js';

const NOW = `strftime('%Y-%m-%dT%H:%M:%SZ','now')`;

// 「已发布」口径、列表列、评论计数、游标条件各只一份定义（原先在十条分页语句里逐字重复）。LIVE_ONLY 是
// 唯一可见性判据：非草稿 + 有发布时间 + 时间已到。以前 pageBySlug/byTitle/isLive 额外容忍 published_at IS NULL
// （列表看不见、直链却进得去），那种行只可能来自旧数据或手工 SQL。
const LIVE_ONLY = `draft = 0 AND published_at IS NOT NULL AND published_at <= ${NOW}`;
const LIVE_ANY = `kind IN ('post','note') AND ${LIVE_ONLY}`;
const LIST_COLS = `id, slug, kind, title, published_at, word_count,
      substr(body_html, 1, 480) AS body_head`;
// Feed 只要渲染 RSS/Atom/JSON 用到的列：body_md/toc_json 可能很大，feed 每 20 篇都拖一遍很浪费。
const FEED_COLS = `id, slug, kind, title, description, body_html, published_at, updated_at`;
const COMMENT_COUNT = `(SELECT COUNT(*) FROM comments c WHERE c.post_id = p.id AND c.status = 'approved') AS comments`;
const CURSOR_AFTER = '(published_at < ? OR (published_at = ? AND id < ?))';

export function createRepo(db) {
  const tx = createTx(db, 'repo');

  const POST_COLS = [
    'slug', 'kind', 'title', 'description', 'body_md', 'body_html', 'toc_json', 'lang', 'comments_on',
    'draft', 'source', 'file_path', 'file_hash', 'word_count', 'published_at',
  ];

  const q = {
    byId: db.prepare('SELECT * FROM posts WHERE id = ?'),
    bySlug: db.prepare('SELECT * FROM posts WHERE slug = ?'),
    // 同步预检只需要哈希与写入要用的元数据，不取 body_html/toc_json：那是大字段，启动同步时
    // 全站正文会跟着进内存。未变化的文件根本不会进入 writePost 的参数拼装。
    bySlugMeta: db.prepare(`SELECT id, slug, kind, file_path, file_hash, missing_file, version,
      word_count FROM posts WHERE slug = ?`),
    byFilePath: db.prepare('SELECT * FROM posts WHERE file_path = ?'),

    feedFirst: db.prepare(`SELECT ${FEED_COLS} FROM posts
      WHERE ${LIVE_ANY}
      ORDER BY published_at DESC, id DESC LIMIT ?`),
    // body_head 只取前 480 字符：首页「最近更新」与 404 的主题数据要 excerpt，
    // 但不该为一小段摘要把整篇正文拖出来。
    recentEntries: db.prepare(`SELECT id, slug, kind, title, lang, published_at, substr(body_html, 1, 480) AS body_head FROM posts
      WHERE ${LIVE_ANY} ORDER BY published_at DESC, id DESC LIMIT ?`),
    feedAfter: db.prepare(`SELECT ${FEED_COLS} FROM posts
      WHERE ${LIVE_ANY} AND ${CURSOR_AFTER}
      ORDER BY published_at DESC, id DESC LIMIT ?`),

    listFirst: db.prepare(`SELECT ${LIST_COLS}, ${COMMENT_COUNT}
      FROM posts p WHERE ${LIVE_ANY}
      ORDER BY published_at DESC, id DESC LIMIT ?`),
    listAfter: db.prepare(`SELECT ${LIST_COLS}, ${COMMENT_COUNT}
      FROM posts p WHERE ${LIVE_ANY} AND ${CURSOR_AFTER}
      ORDER BY published_at DESC, id DESC LIMIT ?`),

    listKindFirst: db.prepare(`SELECT ${LIST_COLS}, ${COMMENT_COUNT}
      FROM posts p WHERE kind = ? AND ${LIVE_ONLY}
      ORDER BY published_at DESC, id DESC LIMIT ?`),

    listKindAfter: db.prepare(`SELECT ${LIST_COLS}, ${COMMENT_COUNT}
      FROM posts p WHERE kind = ? AND ${LIVE_ONLY} AND ${CURSOR_AFTER}
      ORDER BY published_at DESC, id DESC LIMIT ?`),

    kindFirst: db.prepare(`SELECT ${FEED_COLS} FROM posts
      WHERE kind = ? AND ${LIVE_ONLY}
      ORDER BY published_at DESC, id DESC LIMIT ?`),
    kindAfter: db.prepare(`SELECT ${FEED_COLS} FROM posts
      WHERE kind = ? AND ${LIVE_ONLY} AND ${CURSOR_AFTER}
      ORDER BY published_at DESC, id DESC LIMIT ?`),

    publishedAll: db.prepare(`SELECT id, slug, kind, updated_at, published_at FROM posts
      WHERE ${LIVE_ANY}
      ORDER BY published_at DESC`),
    archiveAll: db.prepare(`SELECT id, slug, kind, title, published_at FROM posts
      WHERE ${LIVE_ANY} ORDER BY published_at DESC, id DESC`),
    publishedBetween: db.prepare(`SELECT ${LIST_COLS}, ${COMMENT_COUNT} FROM posts p
      WHERE ${LIVE_ANY} AND published_at >= ? AND published_at < ?
      ORDER BY published_at DESC, id DESC`),

    pageBySlug: db.prepare(`SELECT * FROM posts WHERE slug = ? AND kind = ? AND ${LIVE_ONLY}`),
    // 评论提交要按 slug 找「任意可评论的已发布内容」：slug 全局唯一，没必要 post/note/page 各查一次。
    liveBySlug: db.prepare(`SELECT * FROM posts WHERE slug = ? AND kind IN ('post','note','page') AND ${LIVE_ONLY}`),

    pages: db.prepare(`SELECT slug, title, updated_at, published_at FROM posts
      WHERE kind = 'page' AND ${LIVE_ONLY}
      ORDER BY published_at, id`),

    insertPost: db.prepare(`INSERT INTO posts (${POST_COLS.join(', ')})
      VALUES (${POST_COLS.map(() => '?').join(',')}) RETURNING id, version`),
    updatePost: db.prepare(`UPDATE posts SET
       ${POST_COLS.map((c) => `${c}=?`).join(', ')}, updated_at=${NOW}, version=version+1, missing_file=0
       WHERE id=? RETURNING id, version`),
    // 全量重渲染（渲染器/媒体修订号变化）只更新派生 HTML，不算内容修改：保留 updated_at，
    // 否则每上传一张图再重启，RSS 里所有旧文都会显示成“今天更新”，sitemap 的 lastmod 也会集体跳。
    updatePostKeepTime: db.prepare(`UPDATE posts SET
       ${POST_COLS.map((c) => `${c}=?`).join(', ')}, version=version+1, missing_file=0
       WHERE id=? RETURNING id, version`),
    listFiles: db.prepare(`SELECT id, file_path FROM posts WHERE source = 'file' AND file_path IS NOT NULL AND missing_file=0`),
    fileRows: db.prepare(`SELECT id, slug, kind, file_path, file_hash FROM posts
      WHERE source = 'file' AND file_path IS NOT NULL AND missing_file = 0`),
    pageFiles: db.prepare(`SELECT file_path FROM posts WHERE kind = 'page' AND source = 'file' AND file_path IS NOT NULL AND missing_file = 0`),
    setFilePath: db.prepare('UPDATE posts SET file_path = ? WHERE id = ?'),

    counts: db.prepare(`SELECT
      (SELECT COUNT(*) FROM posts WHERE ${LIVE_ANY}) AS published,
      (SELECT COUNT(*) FROM posts WHERE draft = 1 AND kind IN ('post','note')) AS drafts,
      (SELECT COUNT(*) FROM posts WHERE kind IN ('post','note')) AS total`),
    aliases: db.prepare(`SELECT p.slug, p.kind FROM aliases a JOIN posts p ON p.id = a.post_id WHERE a.path = ? AND ${LIVE_ONLY}`),

    // 标题可能重复（同一篇改写、或文章与笔记同名）。没有 ORDER BY 时 SQLite 返回哪一行取决于查询计划，
    // 换个索引就可能换个结果——[[Regression]] 会时而跳到这篇、时而跳到那篇。这里钉死「最新的一篇」。
    byTitle: db.prepare(`SELECT * FROM posts WHERE title = ? AND ${LIVE_ONLY} ORDER BY published_at DESC, id DESC LIMIT 1`),
    newerOf: db.prepare(`SELECT slug, kind, title FROM posts
      WHERE kind = ? AND ${LIVE_ONLY} AND (published_at > ? OR (published_at = ? AND id > ?))
      ORDER BY published_at ASC, id ASC LIMIT 1`),
    olderOf: db.prepare(`SELECT slug, kind, title FROM posts
      WHERE kind = ? AND ${LIVE_ONLY} AND (published_at < ? OR (published_at = ? AND id < ?))
      ORDER BY published_at DESC, id DESC LIMIT 1`),
    addAliasPath: db.prepare('INSERT OR REPLACE INTO aliases(path, post_id) VALUES(?,?)'),
    // 固定页（kind='page'）不算"内容"：统计只看文章与笔记，否则刊头/后台篇数会被顶高
    publishedStats: db.prepare(`SELECT kind, COUNT(*) AS n, COALESCE(SUM(word_count),0) AS words,
      MIN(published_at) AS first, MAX(published_at) AS last FROM posts
      WHERE ${LIVE_ANY} GROUP BY kind`),
    allSettings: db.prepare('SELECT key, value FROM settings'),
    contentRevision: db.prepare('SELECT rev FROM content_revision WHERE id = 1'),
    setSetting: db.prepare(
      `INSERT INTO settings(key, value) VALUES(?, ?)
       ON CONFLICT(key) DO UPDATE SET value = excluded.value`),
    deleteSetting: db.prepare('DELETE FROM settings WHERE key=?'),
  };

  // —— settings 全量快照 ——
  // settings 表只有几十行，一页却要读 4–6 个键（首页 homeRecent / heroImages（含旧键回落）/ paletteDefault，
  // 文章页再加 commentsPerPage）。写入大多经过 setSetting/deleteSetting（写完即失效），但仍有绕开 repo 的
  // 直接改库（auth.js 的 clearPassword、脚本、测试），所以用两个计数器兜住：
  //   · total_changes() 管本连接自己的写 —— 每次 getSetting 比对一次（约 0.2µs，比逐键点查便宜一个数量级）；
  //   · PRAGMA data_version 管别的连接的写 —— 在请求入口比对一次（清口令、restore 这类跨进程改动要立刻生效）。
  const SETTINGS_TTL_MS = 60_000;
  const dataVersion = db.prepare('PRAGMA data_version');
  const totalChanges = db.prepare('SELECT total_changes() AS n');
  // 内容修订号单独由 042 的触发器维护：只统计 posts/comments/settings/media/aliases/feeds/feed_items/link_sites，
  // 发信队列等后台写入不再让整站 HTML/Feed 缓存失效。
  const contentStamp = () => String(q.contentRevision.get()?.rev ?? 0);
  let settingsMap = null;
  let settingsDataVersion = -1;
  let settingsChanges = 0;
  let settingsLoadedAt = 0;

  function loadSettings() {
    // 先取戳再读：读的过程中若有人写，下次比对会因戳对不上而重读（宁可多读一次，不要一直读旧值）。
    settingsChanges = totalChanges.get().n;
    settingsDataVersion = dataVersion.get().data_version;
    settingsMap = new Map(q.allSettings.all().map((row) => [row.key, row.value]));
    settingsLoadedAt = Date.now();
  }

  // 每个请求进来调一次：别的连接改过库就重读，否则只花一次 pragma。
  function refreshSettings() {
    if (!settingsMap || dataVersion.get().data_version !== settingsDataVersion) loadSettings();
    else settingsLoadedAt = Date.now();
  }

  function getSetting(key) {
    if (!settingsMap
      || totalChanges.get().n !== settingsChanges
      || Date.now() - settingsLoadedAt > SETTINGS_TTL_MS) loadSettings();
    return settingsMap.get(key) ?? null;
  }

  // 分页游标统一为「published_at|id」。旧格式/截断/手改的游标回第一页：
  // 以前返回空列表会让 /posts/、/notes/ 永久显示「还没有内容」，还没有恢复入口。
  function parseCursor(before) {
    const cursor = parseCursorParts(before);
    return cursor ? [cursor.ts, cursor.ts, cursor.id] : null;
  }

  const decorate = (row) => {
    if (!row) return null;
    let toc = [];
    try { toc = row.toc_json ? JSON.parse(row.toc_json) : []; } catch { toc = []; }
    return { ...row, toc };
  };

  function feed({ limit = 20, before = null, kind = null } = {}) {
    const cursor = parseCursor(before);
    if (kind) return cursor ? q.kindAfter.all(kind, ...cursor, limit) : q.kindFirst.all(kind, limit);
    return cursor ? q.feedAfter.all(...cursor, limit) : q.feedFirst.all(limit);
  }

  function list({ limit = 20, before = null, kind = null } = {}) {
    const cursor = parseCursor(before);
    if (kind) return (cursor ? q.listKindAfter.all(kind, ...cursor, limit) : q.listKindFirst.all(kind, limit)).map(decorate);
    return (cursor ? q.listAfter.all(...cursor, limit) : q.listFirst.all(limit)).map(decorate);
  }

  function getPost(slug, kind = null) {
    const row = kind ? q.pageBySlug.get(slug, kind) : q.bySlug.get(slug);
    if (!row) return null;
    const post = decorate(row);
    return post;
  }

  function getPostMeta(slug) {
    return q.bySlugMeta.get(slug) ?? null;
  }

  // 评论提交用：一次查询拿到任意 kind 的可发布内容。
  const getAnyLive = (slug) => q.liveBySlug.get(slug) ?? null;

  // 与 LIVE_ONLY 一一对应的 JS 版（用于「行已在手、不想再查库」的路径）：两处必须同时改，published_at 为
  // NULL 一律算未发布——与 SQL 口径完全一致。
  const isLive = (p) => Boolean(p) && p.draft === 0
    && p.published_at != null
    && p.published_at <= nowIso();

  function resolveWikiLink(name) {
    const direct = q.bySlug.get(name);
    if (isLive(direct)) return direct;
    // 先试「这个名字本身能不能当 slug」：[[Regression]] 最可能是想指 slug 为 regression 的那篇。
    // 顺序反过来的话，标题一旦重名就会盖掉 slug 更精确的匹配（两篇文章同名时尤其明显）。
    const s = slugify(name);
    if (s !== name) {
      const bySlugified = q.bySlug.get(s);
      if (isLive(bySlugified)) return bySlugified;
    }
    return q.byTitle.get(name) ?? null;
  }

  const allPublished = () => q.publishedAll.all();

  function publishedInYear(year) {
    if (!/^\d{4}$/.test(String(year))) return [];
    // 时间存 UTC，年界线必须按站点时区换算，不能对 published_at 直接取年份。
    const start = parseDate(`${year}-01-01`);
    const nextYear = String(Number(year) + 1).padStart(4, '0');
    const end = Number(year) === 9999 ? ':' : parseDate(`${nextYear}-01-01`);
    return q.publishedBetween.all(start, end).map(decorate);
  }

  const stats = () => q.counts.get();

  const findAlias = (p) => {
    // alias 按"解码后"路径存查（c.req.path 已被 Hono 解码）；老版本存 encodeURIComponent 结果，故两种形态
    // 都试一次——非 ASCII 存量数据免迁移也能继续 301。
    const lookup = (v) => q.aliases.get(v) ?? q.aliases.get(encodeURI(v));
    const withSlash = p.endsWith('/') ? p : `${p}/`;
    const without = p.replace(/\/+$/, '');
    return lookup(p) ?? lookup(withSlash) ?? lookup(without);
  };

  function neighbours(post) {
    return {
      newer: q.newerOf.get(post.kind, post.published_at, post.published_at, post.id),
      older: q.olderOf.get(post.kind, post.published_at, post.published_at, post.id),
    };
  }

  function upsertFromFile(rec, opts = {}) {
    return writePost(rec, opts);
  }

  function writePost(rec, { force = false, ignoreHash = false, expectedVersion = null, preserveUpdatedAt = false } = {}) {
    return tx(() => {
      // rec.id 只由后台显式传（syncContent 不传）。改名与换类型同时发生时新路径和新 slug 都匹配不到旧行，只按
      // filePath/slug 找会插出重复记录，原件那行下次启动会被标 missing_file 转草稿。
      // rec.existing 是同步预检已经查到的元数据（内部路径），给了就不再回表。
      const existing = rec.existing
        ?? (rec.id != null ? q.byId.get(rec.id) : null)
        ?? (rec.filePath ? q.byFilePath.get(rec.filePath) : null)
        ?? (rec.slug ? q.bySlug.get(rec.slug) : null);
      if (force && existing && expectedVersion !== null && Number(expectedVersion) !== existing.version) {
        const error = new Error('文章已在其他页面更新，请比较版本后再保存'); error.status = 409; throw error;
      }
      if (!force && existing?.file_path && rec.filePath !== existing.file_path && !rec.allowMove) {
        throw new Error(`slug 已被其他文件占用：${rec.slug}`);
      }
      if (!force) {
        // 这里曾有 `existing.source === 'admin' → 跳过` 的分支但从未生效：后台保存是 commitPost → 先写 .md 再
        // upsertFromFile，落库时 source 一律 'file'。文件即真相，同步覆盖它才对。
        if (!ignoreHash && existing && existing.file_hash === rec.fileHash && existing.kind === rec.kind && existing.slug === rec.slug && !existing.missing_file) {

          if (rec.filePath && existing.file_path !== rec.filePath) {
            q.setFilePath.run(rec.filePath, existing.id);
            return { action: 'moved', id: existing.id };
          }
          return { action: 'skipped', id: existing.id };
        }
      }

      const params = [
        rec.slug, rec.kind, rec.title, rec.description ?? '', rec.bodyMd, rec.bodyHtml, JSON.stringify(rec.toc ?? []),
        rec.lang ?? 'zh', rec.commentsOn === false ? 0 : 1,
        rec.draft ? 1 : 0, rec.source ?? 'file', rec.filePath, rec.fileHash, rec.wordCount, rec.publishedAt,
      ];

      if (params.length !== POST_COLS.length) {
        throw new Error(`posts 参数数量 ${params.length} 与列数 ${POST_COLS.length} 不符`);
      }

      let id;
      let action;
      let version;
      if (existing) {
        // 只有源文件哈希不变（纯重渲染）才保留 updated_at；内容真改了仍然走正常更新时间。
        const keepTime = preserveUpdatedAt && existing.file_hash === rec.fileHash;
        const updated = (keepTime ? q.updatePostKeepTime : q.updatePost).get(...params, existing.id);
        if (!updated) throw Object.assign(new Error('文章在保存过程中被删除'), { status: 404 });
        version = updated.version;
        id = existing.id;
        action = 'updated';
      } else {
        const r = q.insertPost.get(...params);
        id = Number(r.id);
        version = r.version;
        action = 'inserted';
      }

      if (existing && (existing.slug !== rec.slug || existing.kind !== rec.kind)) {
        // 存"解码后"路径，与 findAlias 查表形态对齐（只对非 ASCII slug 有区别：以前存 encodeURIComponent，中文
        // slug 改名后旧地址就只剩 404）。这里不能用 postUrl()/contentUrl()（那是要编码进 HTML 的）。
        const oldUrl = existing.kind === 'page'
          ? `/${existing.slug}`
          : `/${kindPrefix(existing.kind)}/${existing.slug}/`;
        q.addAliasPath.run(oldUrl, id);
      }
      return { action, id, version };
    });
  }

  // 批量标记缺失：整目录被移除时 stale 可能有几百行，逐行 UPDATE 就是几百条语句。按批拼 IN，语句按批量缓存复用。
  const pruneStmts = new Map();
  function markMissingBatch(ids) {
    let stmt = pruneStmts.get(ids.length);
    if (!stmt) {
      stmt = db.prepare(`UPDATE posts SET draft=1, missing_file=1, version=version+1
        WHERE missing_file=0 AND id IN (${ids.map(() => '?').join(',')})`);
      pruneStmts.set(ids.length, stmt);
    }
    stmt.run(...ids);
  }

  function pruneMissingFiles(presentPaths) {
    const present = new Set(presentPaths);
    const stale = q.listFiles.all().filter((r) => !present.has(r.file_path));
    if (!stale.length) return 0;
    return tx(() => {
      const ids = stale.map((r) => r.id);
      for (let i = 0; i < ids.length; i += 500) markMissingBatch(ids.slice(i, i + 500));
      return stale.length;
    });
  }

  return {

    feed, list, getPost, getPostMeta, getAnyLive, resolveWikiLink, allPublished, publishedInYear, contentStamp,
    archiveEntries: () => q.archiveAll.all(),
    recentEntries: (limit = 8) => q.recentEntries.all(limit),
    stats, neighbours, findAlias,
    // 后台保存时按 slug 做占用检查：这里返回未经过 LIVE_ONLY 过滤的原始行，与后台的「谁占用了 slug」口径一致。
    bySlug: (slug) => q.bySlug.get(slug) ?? null,
    pages: () => q.pages.all(),

    upsertFromFile, pruneMissingFiles, transaction: tx,
    fileRows: () => q.fileRows.all(),
    pageFiles: () => q.pageFiles.all(),
    publishedStats: () => q.publishedStats.all(),
    deleteSetting: (k) => { settingsMap = null; q.deleteSetting.run(k); },
    // settings 全表只有几十行；recoverWrites 用它找没有日志文件对应的孤儿键。
    settingKeysLike: (prefix) => q.allSettings.all().map((row) => row.key).filter((key) => key.startsWith(prefix)),

    getSetting, refreshSettings,
    setSetting: (k, v) => { settingsMap = null; q.setSetting.run(k, String(v)); },
  };
}

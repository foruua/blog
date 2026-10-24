// 友圈的存储层：feeds（登记地址）与 feed_items（抓回的条目）。写操作故意不走 server.js 的 mutate 队列：
// 取舍是刷新「先抓几秒网络、再写几毫秒库」，网络那段塞进队列会卡住评论、落库再入队会自锁。
// 备份现在只校验内容/上传/主题的文件树，feed 只写库，不会让备份失败；server 的后台写屏障仍会在快照期间
// 暂缓刷新落库，避免数据库快照里出现半轮数据。
import { createTx } from './tx.js';
import { parseCursorParts } from './cursor.js';
import { FRIENDS_PER_SOURCE } from '../src/config.js';
import { nowIso } from '../src/util/text.js';

export function createFeedRepo(db) {
  const RANKED_INNER = `
      SELECT i.id, i.feed_id, i.title, i.link, i.published_at, i.fetched_at,
             COALESCE(i.published_at, i.fetched_at) AS ts,
             f.title AS feed_title, f.site_url AS feed_site,
             ROW_NUMBER() OVER (PARTITION BY i.feed_id
               ORDER BY COALESCE(i.published_at, i.fetched_at) DESC, i.id DESC) AS rn,
             COUNT(*) OVER (PARTITION BY i.feed_id) AS feed_total,
             MAX(COALESCE(i.published_at, i.fetched_at)) OVER (PARTITION BY i.feed_id) AS feed_ts
        FROM feed_items i JOIN feeds f ON f.id = i.feed_id
        WHERE f.enabled = 1`;

  const rankedQuery = (bounds, filter = '') => `WITH ranked AS (${RANKED_INNER}${filter})
    SELECT id, feed_id, title, link, published_at, fetched_at, feed_title, feed_site, feed_total
      FROM ranked
     WHERE rn <= ?${bounds}
     ORDER BY ts DESC, id DESC`;

  // 朋友队列：分页按「朋友」切页，节序 = 朋友最近更新倒序，同刻并列按 feed_id（与条目层同套 (ts, feed_id) 字典序，游标比较才不会错位）。
  const FRIENDS_QUEUE = `
      SELECT i.feed_id AS feed_id,
             MAX(COALESCE(i.published_at, i.fetched_at)) AS ts
        FROM feed_items i JOIN feeds f ON f.id = i.feed_id
       WHERE f.enabled = 1
       GROUP BY i.feed_id`;

  const q = {
    list: db.prepare('SELECT * FROM feeds ORDER BY sort_order, id'),
    listEnabled: db.prepare('SELECT * FROM feeds WHERE enabled = 1 ORDER BY sort_order, id'),
    get: db.prepare('SELECT * FROM feeds WHERE id = ?'),
    getByUrl: db.prepare('SELECT * FROM feeds WHERE url = ?'),
    count: db.prepare('SELECT COUNT(*) AS n FROM feeds'),
    insert: db.prepare(`INSERT INTO feeds(url, site_url, title, sort_order, enabled, display_limit, created_at)
      VALUES(?, ?, ?, ?, 1, ?, ?)`),
    update: db.prepare(`UPDATE feeds SET url = ?, title = ?, sort_order = ?,
      display_limit = COALESCE(?, display_limit), version = version + 1 WHERE id = ?`),
    resetSource: db.prepare(`UPDATE feeds SET site_url = '', etag = NULL, last_modified = NULL,
      resolved_url = NULL, last_fetch_at = NULL, last_ok_at = NULL, fail_count = 0, last_error = NULL WHERE id = ?`),
    remove: db.prepare('DELETE FROM feeds WHERE id = ?'),
    setEnabled: db.prepare('UPDATE feeds SET enabled = ?, version = version + 1 WHERE id = ?'),
    // 成功：etag 存下供下次条件请求；站名/站点主页只在空时回填——站主手改过的名字不能被下次抓取冲掉。
    // resolved_url 用 COALESCE：只在这次真的自动发现订阅地址时才写入。
    markOk: db.prepare(`UPDATE feeds SET etag = ?, last_modified = ?, last_fetch_at = ?, last_ok_at = ?,
        fail_count = 0, last_error = NULL,
        title = CASE WHEN title = '' THEN ? ELSE title END,
        site_url = CASE WHEN site_url = '' THEN ? ELSE site_url END,
        resolved_url = COALESCE(?, resolved_url)
      WHERE id = ?`),
    markFail: db.prepare(`UPDATE feeds SET last_fetch_at = ?, fail_count = fail_count + 1, last_error = ?
      WHERE id = ?`),
    resetAllCaches: db.prepare('UPDATE feeds SET etag = NULL, last_modified = NULL'),
    friendsQueueFirst: db.prepare(`SELECT feed_id, ts FROM (${FRIENDS_QUEUE})
       ORDER BY ts DESC, feed_id DESC LIMIT ?`),
    friendsQueueAfter: db.prepare(`SELECT feed_id, ts FROM (${FRIENDS_QUEUE})
       WHERE (ts < ? OR (ts = ? AND feed_id < ?))
       ORDER BY ts DESC, feed_id DESC LIMIT ?`),
    countItemsOf: db.prepare('SELECT COUNT(*) AS n FROM feed_items WHERE feed_id = ?'),
    clearItemsOf: db.prepare('DELETE FROM feed_items WHERE feed_id = ?'),
    clearAllItems: db.prepare('DELETE FROM feed_items'),
    bumpVersion: db.prepare('UPDATE feeds SET version = version + 1, etag = NULL, last_modified = NULL WHERE id = ?'),
    bumpAllVersions: db.prepare('UPDATE feeds SET version = version + 1, etag = NULL, last_modified = NULL'),
    // 用匿名 `?` 而非 `?1`/`?2`（同参数出现两次就传两次）：编号参数在 node:sqlite 早于 22.22 的版本里是坏的
    // （22.13.0 直接抛 "column index out of range"，表现为每次刷新订阅源都失败）。
    pruneOf: db.prepare(`DELETE FROM feed_items WHERE feed_id = ? AND id NOT IN (
        SELECT id FROM feed_items WHERE feed_id = ?
        ORDER BY COALESCE(published_at, fetched_at) DESC, id DESC LIMIT ?)`),
    stats: db.prepare(`SELECT
      (SELECT COUNT(*) FROM feeds WHERE enabled = 1) AS sources,
      (SELECT COUNT(*) FROM feed_items i JOIN feeds f ON f.id = i.feed_id AND f.enabled = 1) AS items`),
    countSince: db.prepare(`SELECT COUNT(*) AS n FROM feed_items i
      JOIN feeds f ON f.id = i.feed_id AND f.enabled = 1
      WHERE COALESCE(i.published_at, i.fetched_at) >= ?`),
  };

  // 事务原语与 repo 共用（db/tx.js）：以前这里用 BEGIN/COMMIT，一旦被包进别人开的事务里就抛 "cannot start
  // a transaction within a transaction"；SAVEPOINT 可任意嵌套。
  const tx = createTx(db, 'feeds');

  const DEFAULT_KEEP = 20;

  // 一轮刷新可能有几十上百条；逐条 execute 会把主线程占得更久。按 100 条一批做多行 upsert，
  // 语句形状只由批量大小决定，缓存后复用。
  const upsertBatches = new Map();
  function upsertMany(feedId, items, at) {
    for (let start = 0; start < items.length; start += 100) {
      const chunk = items.slice(start, start + 100);
      let stmt = upsertBatches.get(chunk.length);
      if (!stmt) {
        const values = chunk.map(() => '(?,?,?,?,?,?,?,?)').join(',');
        stmt = db.prepare(`INSERT INTO feed_items(feed_id, guid, title, link, author, summary, published_at, fetched_at)
          VALUES ${values}
          ON CONFLICT(feed_id, guid) DO UPDATE SET
            title = excluded.title, link = excluded.link, author = excluded.author,
            summary = excluded.summary, published_at = excluded.published_at, fetched_at = excluded.fetched_at`);
        upsertBatches.set(chunk.length, stmt);
      }
      const params = [];
      for (const item of chunk) {
        params.push(feedId, item.guid, item.title, item.link, item.author, item.summary, item.publishedAt ?? null, at);
      }
      stmt.run(...params);
    }
  }

  function saveItems(feedId, items, { keep = DEFAULT_KEEP } = {}) {
    const at = nowIso();
    return tx(() => {
      upsertMany(feedId, items, at);
      q.pruneOf.run(feedId, feedId, keep);
      return { seen: items.length, kept: q.countItemsOf.get(feedId).n };
    });
  }

  // 前台分页（按「朋友」切页）——游标口径与 repo.js 共用 db/cursor.js。唯一差别：坏游标不返回空结果而是回第一页（友圈空态文案是「还没有抓到文章」）。
  function parseCursor(before) {
    const cursor = parseCursorParts(before, { defaultId: '' });
    return cursor ? { ts: cursor.ts, feedId: cursor.id } : null;
  }

  function friendsPageFeeds({ perPage, before = null } = {}) {
    const cursor = parseCursor(before);
    const rows = cursor
      ? q.friendsQueueAfter.all(cursor.ts, cursor.ts, cursor.feedId, perPage + 1)
      : q.friendsQueueFirst.all(perPage + 1);
    return {
      feeds: rows.slice(0, perPage).map((r) => ({ feedId: r.feed_id, ts: r.ts })),
      hasMore: rows.length > perPage,
      cursor,
    };
  }

  // 分页时只扫本页朋友的条目。旧实现用窗口函数给所有启用源排名，再丢掉不在本页的行；
  // 订阅多时每翻一页都要全表排名。这里把 feed_id 过滤下推到 CTE，只给本页 20 个源算 rn。
  const itemsForFeedsStmts = new Map();
  function itemsForFeeds(feedIds, { perSource = FRIENDS_PER_SOURCE, before = null, until = null } = {}) {
    const ids = [...new Set((feedIds ?? []).map(Number))].filter((id) => Number.isInteger(id) && id > 0)
      .sort((a, b) => a - b);
    if (!ids.length || !until) return [];
    const filter = ` AND i.feed_id IN (${ids.map(() => '?').join(',')})`;
    const bounds = before
      ? `\n       AND (feed_ts < ? OR (feed_ts = ? AND feed_id < ?))\n       AND (feed_ts > ? OR (feed_ts = ? AND feed_id >= ?))`
      : `\n       AND (feed_ts > ? OR (feed_ts = ? AND feed_id >= ?))`;
    // SQL 形状只由“几个 id、有没有 before 上界”决定；id/游标都是绑定参数。以前把完整 id 列表和时间戳
    // 拼进 key，友圈每刷新一次 until.ts 就变，语句缓存几乎永远 miss。
    const key = `${perSource}|${ids.length}|${before ? 'after' : 'until'}`;
    let stmt = itemsForFeedsStmts.get(key);
    if (!stmt) {
      if (itemsForFeedsStmts.size >= 50) itemsForFeedsStmts.clear();
      stmt = db.prepare(rankedQuery(bounds, filter));
      itemsForFeedsStmts.set(key, stmt);
    }
    const bound = (c) => [c.ts, c.ts, c.feedId];
    // 参数顺序按 SQL 出现顺序：内层 IN 的 feed ids → 外层 rn → 分页边界。
    return stmt.all(...ids, perSource, ...(before ? [...bound(before), ...bound(until)] : bound(until)));
  }

  return {
    list: () => q.list.all(),
    listEnabled: () => q.listEnabled.all(),
    get: (id) => q.get.get(Number(id)) ?? null,
    getByUrl: (url) => q.getByUrl.get(url) ?? null,
    count: () => q.count.get().n,
    stats: () => q.stats.get(),
    countSince: (from) => q.countSince.get(from).n,

    add: ({ url, title = '', sortOrder = 0 }) => {
      const info = q.insert.run(url, '', title, sortOrder, FRIENDS_PER_SOURCE, nowIso());
      return q.get.get(Number(info.lastInsertRowid));
    },
    update: (id, { url, title = '', sortOrder = 0 }) => {
      return tx(() => {
        const previous = q.get.get(Number(id));
        // display_limit 当前没有后台入口，保留旧值，别每次编辑都重置回全局常量。
        q.update.run(url, title, sortOrder, null, Number(id));
        // title 是本次表单的明确配置；新源的站点地址与健康记录必须重新取得。
        if (previous && previous.url !== url) {
          q.clearItemsOf.run(Number(id));
          q.resetSource.run(Number(id));
        }
        return q.get.get(Number(id)) ?? null;
      });
    },
    remove: (id) => q.remove.run(Number(id)).changes,
    setEnabled: (id, on) => q.setEnabled.run(on ? 1 : 0, Number(id)).changes,

    markOk: (id, { etag = null, lastModified = null, title = '', siteUrl = '', resolvedUrl = null } = {}) => {
      q.markOk.run(etag, lastModified, nowIso(), nowIso(), title, siteUrl, resolvedUrl, Number(id));
    },
    markFail: (id, message) => q.markFail.run(nowIso(), String(message ?? '').slice(0, 200), Number(id)),
    resetAllCaches: () => q.resetAllCaches.run().changes,

    saveItems,
    itemsForFeeds,
    friendsPageFeeds,
    countItemsOf: (feedId) => q.countItemsOf.get(Number(feedId)).n,
    clearItems: (feedId = null) => tx(() => {
      const changed = feedId == null ? q.clearAllItems.run().changes : q.clearItemsOf.run(Number(feedId)).changes;
      if (feedId == null) q.bumpAllVersions.run();
      else q.bumpVersion.run(Number(feedId));
      return changed;
    }),
    transaction: tx,
  };
}

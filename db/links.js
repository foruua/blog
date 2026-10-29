// 友链页存储层。刻意只做两件事：把 comments 聚合成「谁来过、几条」的名单（派生态，永远与评论区一致），
// 以及读写 link_sites 的「对方站还开不开」健康记录。没有「加入/移除友链」的方法——站被移除也只是评论被删，
// 所谓「自动删除」只是 health 表的 alive 开关。写操作与 db/feeds.js 同套取舍（同步 SQLite、不走 mutate 队列）。
import { createTx } from './tx.js';
import { nowIso } from '../src/util/text.js';

// 前台名单口径只写一次：approved + 填了网址 + 不是博主本人。
const PUBLIC_WHERE = `status = 'approved' AND is_author = 0
        AND website_host IS NOT NULL AND website_host <> ''
        AND post_id IN (SELECT id FROM posts
          WHERE draft = 0 AND published_at IS NOT NULL
            AND published_at <= strftime('%Y-%m-%dT%H:%M:%SZ','now'))`;

/** agg —— 按 host 归并（几条留言、最近一次、几个昵称）；latest —— 每 host 最近一条评论；live —— 两份
 *  拼上健康记录，得友链页真正要的表。 */
const HEALTH_COLUMNS = `CASE WHEN v.source_url = l.website THEN COALESCE(NULLIF(v.url, ''), l.website) ELSE l.website END AS url,
         l.website AS source_url,
         CASE WHEN v.source_url = l.website THEN v.title END AS site_title,
         CASE WHEN v.source_url = l.website THEN v.alive ELSE 1 END AS alive, v.hidden,
         CASE WHEN v.source_url = l.website THEN v.fail_count ELSE 0 END AS fail_count,
         CASE WHEN v.source_url = l.website THEN v.checked_at END AS checked_at,
         CASE WHEN v.source_url = l.website THEN v.last_ok_at END AS last_ok_at,
         CASE WHEN v.source_url = l.website THEN v.last_error END AS last_error`;

const LIVE_CTE = `WITH agg AS (
    SELECT website_host AS host, COUNT(*) AS n, MAX(created_at) AS last_at,
           COUNT(DISTINCT author) AS people
      FROM comments WHERE ${PUBLIC_WHERE}
     GROUP BY website_host
  ), latest AS (
    SELECT c.website_host AS host, c.author, c.website, c.email_enc, c.email_hash,
           ROW_NUMBER() OVER (PARTITION BY c.website_host ORDER BY c.created_at DESC, c.id DESC) AS rn
      FROM comments c WHERE ${PUBLIC_WHERE}
  )
  SELECT a.host, a.n, a.last_at, a.people, l.author, l.website, l.email_enc, l.email_hash,
         ${HEALTH_COLUMNS}
    FROM agg a
    JOIN latest l ON l.host = a.host AND l.rn = 1
    LEFT JOIN link_sites v ON v.host = a.host`;

// 前台可见 = 站主没手动藏、且没因连续失败被自动下线；从没检查过的默认可见。两个字段都要 IFNULL：直接
// 写 `hidden = 0` 会把 NULL 判成假，导致「所有还没探过的站集体消失」（实测踩过）。
const VISIBLE = `IFNULL(hidden, 0) = 0 AND IFNULL(alive, 1) = 1`;

// recentStartIso() 输出 YYYY-MM-DDTHH:MM:SSZ；comments.created_at 是 SQLite 的 YYYY-MM-DD HH:MM:SS。
const sqliteTime = (iso) => String(iso ?? '').replace('T', ' ').replace(/Z$/, '');

export function createLinkRepo(db) {
  const tx = createTx(db, 'links');
  const q = {
    getSite: db.prepare(`SELECT l.website_host AS host, ${HEALTH_COLUMNS}
      FROM (SELECT website_host, website FROM comments WHERE ${PUBLIC_WHERE} AND website_host = ?
        ORDER BY created_at DESC, id DESC LIMIT 1) l
      LEFT JOIN link_sites v ON v.host = l.website_host`),
    // 只取「最近一条评论者的网址」当 source_url：不必为这一个字段跑整条 LIVE_CTE（那会聚合全部评论）。
    latestSource: db.prepare(`SELECT website AS source_url FROM comments
      WHERE ${PUBLIC_WHERE} AND website_host = ?
      ORDER BY created_at DESC, id DESC LIMIT 1`),
    resetSource: db.prepare(`UPDATE link_sites SET source_url = ?, url = '', title = '', alive = 1,
      fail_count = 0, checked_at = NULL, last_ok_at = NULL, last_error = NULL
      WHERE host = ? AND source_url <> ?`),
    setSource: db.prepare('UPDATE link_sites SET source_url = ? WHERE host = ?'),
    publicList: db.prepare(`SELECT * FROM (${LIVE_CTE}) AS live WHERE ${VISIBLE}
      ORDER BY n DESC, last_at DESC, host ASC LIMIT ? OFFSET ?`),
    // 一页列表连刊头统计一起出：visible 只算一次；「最近 N 天几条留言」也塞进同一条语句，
    // 免得每次翻页再为它单跑一次聚合（原先一页最多要跑三次 LIVE_CTE）。
    publicPage: db.prepare(`WITH live AS (${LIVE_CTE}),
      visible AS (SELECT * FROM live WHERE ${VISIBLE}),
      stats AS (SELECT COUNT(*) AS total, COALESCE(SUM(n), 0) AS all_comments,
                       MAX(last_at) AS all_last_at FROM visible)
      SELECT visible.*, stats.total, stats.all_comments, stats.all_last_at,
        (SELECT COUNT(*) FROM comments c
           LEFT JOIN link_sites v ON v.host = c.website_host
          WHERE ${PUBLIC_WHERE} AND c.created_at >= ?
            AND IFNULL(v.hidden, 0) = 0 AND IFNULL(v.alive, 1) = 1) AS recent
        FROM visible
        CROSS JOIN stats
       ORDER BY n DESC, last_at DESC, host ASC LIMIT ? OFFSET ?`),
    publicCount: db.prepare(`SELECT COUNT(*) AS n FROM (${LIVE_CTE}) AS live WHERE ${VISIBLE}`),
    publicStats: db.prepare(`SELECT COUNT(*) AS links, COALESCE(SUM(n), 0) AS comments, MAX(last_at) AS last_at
      FROM (${LIVE_CTE}) AS live WHERE ${VISIBLE}`),
    // 刊头「最近 N 天几条留言」：起点由调用方算好（与友圈同口径），这里只比下界，只数名单上看得见的站。
    // 不要用 datetime(c.created_at) >= datetime(?)：包住列会让 idx_comments_status(status, created_at) 失效，
    // 评论量上来后每次打开友链页都要扫所有带网址的评论。调用方先把 ISO 转成 SQLite 的
    // YYYY-MM-DD HH:MM:SS，再直接比较列，索引才能用上。
    // 直接 JOIN link_sites 判断可见性即可：当前这条评论本身就证明该 host 有公开评论，
    // 不必再跑一遍整条 LIVE_CTE（原先一页要算三次）。
    publicRecent: db.prepare(`SELECT COUNT(*) AS n FROM comments c
      LEFT JOIN link_sites v ON v.host = c.website_host
      WHERE ${PUBLIC_WHERE} AND c.created_at >= ?
        AND IFNULL(v.hidden, 0) = 0 AND IFNULL(v.alive, 1) = 1`),
    // 检查器工作清单：所有已知站点（含隐藏与已下线）——隐藏中的站也要照常探，否则它悄悄活过来站主也不知道。排序「最久没查的在前」。
    allSites: db.prepare(`SELECT host, url, source_url, site_title, alive, hidden, fail_count, checked_at, last_ok_at
      FROM (${LIVE_CTE}) AS live
      ORDER BY (checked_at IS NULL) DESC, checked_at ASC, host ASC`),
    adminList: db.prepare(`SELECT * FROM (${LIVE_CTE}) AS live ORDER BY n DESC, last_at DESC, host ASC`),
    adminPage: db.prepare(`SELECT * FROM (${LIVE_CTE}) AS live
      ORDER BY n DESC, last_at DESC, host ASC LIMIT ? OFFSET ?`),
    adminCount: db.prepare(`SELECT COUNT(*) AS n FROM (${LIVE_CTE}) AS live`),
    // 后台一页同时要总数与三组计数：合并成一条，避免为同一份 LIVE_CTE 跑三遍。
    adminSnapshot: db.prepare(`SELECT
        COUNT(*) AS total,
        SUM(CASE WHEN IFNULL(hidden, 0) = 0 AND IFNULL(alive, 1) <> 0 THEN 1 ELSE 0 END) AS live,
        SUM(CASE WHEN IFNULL(hidden, 0) = 0 AND IFNULL(alive, 1) = 0 THEN 1 ELSE 0 END) AS dead,
        SUM(CASE WHEN IFNULL(hidden, 0) = 1 THEN 1 ELSE 0 END) AS hidden
      FROM (${LIVE_CTE}) AS live`),

    markOk: db.prepare(`INSERT INTO link_sites(host, url, title, alive, fail_count, checked_at, last_ok_at, created_at)
      VALUES(?, ?, ?, 1, 0, ?, ?, ?)
      ON CONFLICT(host) DO UPDATE SET
        url = excluded.url,
        -- 站名只在这次真抓到时覆盖：挑战页/空标题不该冲掉上一次的好标题。
        title = CASE WHEN excluded.title <> '' THEN excluded.title ELSE link_sites.title END,
        alive = 1, fail_count = 0,
        checked_at = excluded.checked_at, last_ok_at = excluded.last_ok_at, last_error = NULL`),
    markFail: db.prepare(`INSERT INTO link_sites(host, url, alive, hidden, fail_count, checked_at, last_error, created_at)
      VALUES(?, ?, 1, 0, 1, ?, ?, ?)
      ON CONFLICT(host) DO UPDATE SET
        url = excluded.url,
        fail_count = link_sites.fail_count + 1,
        checked_at = excluded.checked_at,
        last_error = excluded.last_error,
        alive = CASE WHEN link_sites.fail_count + 1 >= ? THEN 0 ELSE link_sites.alive END`),
    // 「不明」：对方在应答（403/429/5xx）只是不让读——既不加失败次数也不复原，一次 Cloudflare 挑战不该把攒到门槛的失败清零、更不该踢人下线。
    markUnknown: db.prepare(`INSERT INTO link_sites(host, url, checked_at, last_error, created_at)
      VALUES(?, ?, ?, ?, ?)
      ON CONFLICT(host) DO UPDATE SET
        url = excluded.url, checked_at = excluded.checked_at, last_error = excluded.last_error`),
    setHidden: db.prepare(`INSERT INTO link_sites(host, hidden, created_at)
      VALUES(?, ?, ?)
      ON CONFLICT(host) DO UPDATE SET hidden = excluded.hidden`),
    // 站主手动隐藏的站即使评论暂时全部待审/标垃圾，也保留健康记录（隐藏偏好、失败计数、站名）：
    // 否则评论恢复后它会以全新状态出现，手动隐藏失效。
    prune: db.prepare(`DELETE FROM link_sites
      WHERE IFNULL(hidden, 0) = 0
        AND host NOT IN (SELECT DISTINCT website_host FROM comments WHERE ${PUBLIC_WHERE})`),
    // 统计按真实名单算（非 link_sites 行数）：启动日志那行数字要与名单对得上。
    stats: db.prepare(`SELECT
        COUNT(*) AS total,
        SUM(CASE WHEN ${VISIBLE} THEN 1 ELSE 0 END) AS shown,
        SUM(CASE WHEN IFNULL(alive, 1) = 0 THEN 1 ELSE 0 END) AS dead,
        SUM(CASE WHEN IFNULL(hidden, 0) = 1 THEN 1 ELSE 0 END) AS hidden
      FROM (${LIVE_CTE}) AS live`),
  };

  function writeHealth(host, sourceUrl, write) {
    return tx(() => {
      const source = sourceUrl ?? q.latestSource.get(host)?.source_url ?? '';
      q.resetSource.run(source, host, source);
      write();
      q.setSource.run(source, host);
    });
  }

  return {
    getSite: (host) => q.getSite.get(host) ?? null,
    publicList: ({ limit = 24, offset = 0 } = {}) => q.publicList.all(limit, offset),
    publicPage: ({ limit = 24, offset = 0, recentSince = 0 } = {}) => q.publicPage.all(sqliteTime(recentSince), limit, offset),
    publicCount: () => q.publicCount.get().n,
    publicStats: () => q.publicStats.get(),
    publicRecent: (since) => q.publicRecent.get(sqliteTime(since)).n,
    adminList: () => q.adminList.all(),
    adminPage: ({ limit = 60, offset = 0 } = {}) => q.adminPage.all(limit, offset),
    adminCount: () => q.adminCount.get().n,
    adminSnapshot: () => {
      const row = q.adminSnapshot.get() ?? {};
      return {
        total: Number(row.total) || 0,
        counts: { live: Number(row.live) || 0, dead: Number(row.dead) || 0, hidden: Number(row.hidden) || 0 },
      };
    },
    adminGroupCounts: () => {
      const row = q.adminSnapshot.get() ?? {};
      return { live: Number(row.live) || 0, dead: Number(row.dead) || 0, hidden: Number(row.hidden) || 0 };
    },

    listSites: () => q.allSites.all(),

    markOk: (host, { url = '', title = '', sourceUrl = null } = {}) => {
      const at = nowIso();
      writeHealth(host, sourceUrl, () => q.markOk.run(host, url, String(title ?? '').slice(0, 120), at, at, at));
    },
    markFail: (host, { url = '', message = '', sourceUrl = null, failLimit = 3 } = {}) => {
      writeHealth(host, sourceUrl, () => q.markFail.run(host, url, nowIso(), String(message ?? '').slice(0, 200), nowIso(), Number(failLimit)));
    },
    markUnknown: (host, { url = '', message = '', sourceUrl = null } = {}) => {
      writeHealth(host, sourceUrl, () => q.markUnknown.run(host, url, nowIso(), String(message ?? '').slice(0, 200), nowIso()));
    },
    setHidden: (host, on) => q.setHidden.run(host, on ? 1 : 0, nowIso()).changes > 0,

    pruneOrphans: () => q.prune.run().changes,

    stats: () => q.stats.get(),
  };
}

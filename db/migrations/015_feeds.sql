-- 友圈：后台登记的博客地址（RSS/Atom）与抓回的条目。两张表分开：feeds 是站主手写配置，feed_items 是抓取
-- 产物（每次刷新重写、可清空重来）；混在一张表抓取失败时容易把配置一起写坏。
-- 时间列一律存 JS 侧生成的 UTC ISO（…Z），不用 datetime('now')：后者产出带空格的 'YYYY-MM-DD HH:MM:SS'，
-- 与 published_at 混排就没法比较；抓不到发布时间的源退回 fetched_at，两者格式必须一致。

CREATE TABLE IF NOT EXISTS feeds (
  id            INTEGER PRIMARY KEY,
  url           TEXT    NOT NULL UNIQUE,          -- 订阅源地址（RSS/Atom，或站点主页，抓取时自动发现）
  site_url      TEXT    NOT NULL DEFAULT '',      -- 站点主页，抓取后回填
  title         TEXT    NOT NULL DEFAULT '',      -- 站名：站主填过就永远不覆盖
  note          TEXT    NOT NULL DEFAULT '',      -- 一句话介绍，只做展示
  enabled       INTEGER NOT NULL DEFAULT 1,
  sort_order    INTEGER NOT NULL DEFAULT 0,       -- 友链展示顺序，小的在前
  etag          TEXT,                             -- 条件请求：省流量，也避免把对方站点打疼
  last_modified TEXT,
  last_fetch_at TEXT,                             -- 最近一次尝试（无论成败），退避计时基于它
  last_ok_at    TEXT,                             -- 最近一次成功
  fail_count    INTEGER NOT NULL DEFAULT 0,       -- 连续失败次数，成功后归零
  last_error    TEXT,                             -- 给站主看的失败原因（已截断）
  created_at    TEXT    NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_feeds_on ON feeds(enabled, sort_order, id);

CREATE TABLE IF NOT EXISTS feed_items (
  id           INTEGER PRIMARY KEY,
  feed_id      INTEGER NOT NULL REFERENCES feeds(id) ON DELETE CASCADE,
  guid         TEXT    NOT NULL,                  -- 源的 guid/id，缺失时退化用链接
  title        TEXT    NOT NULL DEFAULT '',
  link         TEXT    NOT NULL,
  author       TEXT    NOT NULL DEFAULT '',
  summary      TEXT    NOT NULL DEFAULT '',       -- 纯文本（去标签、解实体、截断），不存远端 HTML
  published_at TEXT,                              -- 抓不到就是 NULL，展示与排序退回 fetched_at
  fetched_at   TEXT    NOT NULL,
  UNIQUE(feed_id, guid)
);
CREATE INDEX IF NOT EXISTS idx_feed_items_time ON feed_items(published_at DESC, id DESC);
CREATE INDEX IF NOT EXISTS idx_feed_items_feed ON feed_items(feed_id, published_at DESC, id DESC);

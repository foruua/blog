-- 合并 posts 与 feed_items 上重叠的索引。
--
-- posts：原有三个几乎同义的索引
--   idx_posts_pub       (draft, published_at DESC)
--   idx_posts_kind      (kind, draft, published_at DESC)
--   idx_posts_kind_pub  (kind, published_at DESC, id DESC)
-- 它们都缺 ORDER BY 的 id 兜底列，谁也不能完整覆盖列表查询。换成两个「等值列 + 排序全序」的索引：
--   idx_posts_live       (draft, published_at DESC, id DESC)         —— 不限 kind 的列表/归档/Feed
--   idx_posts_live_kind  (kind, draft, published_at DESC, id DESC)   —— 按 kind 过滤的列表
--
-- feed_items：全部查询都按 COALESCE(published_at, fetched_at) 排序，原始列上的两个索引
--   idx_feed_items_time  (published_at DESC, id DESC)
--   idx_feed_items_feed  (feed_id, published_at DESC, id DESC)
-- 表达式索引无法被 ORDER BY published_at 命中，留着只增加每次刷新的写放大，直接删掉。
DROP INDEX IF EXISTS idx_posts_pub;
DROP INDEX IF EXISTS idx_posts_kind;
DROP INDEX IF EXISTS idx_posts_kind_pub;
CREATE INDEX IF NOT EXISTS idx_posts_live      ON posts(draft, published_at DESC, id DESC);
CREATE INDEX IF NOT EXISTS idx_posts_live_kind ON posts(kind, draft, published_at DESC, id DESC);

DROP INDEX IF EXISTS idx_feed_items_time;
DROP INDEX IF EXISTS idx_feed_items_feed;

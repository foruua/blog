-- 补齐三处缺失索引，并统一后台列表排序口径。1) aliases.post_id——外键（CASCADE 按它找子行）+ aliasesOf 反查，
-- 001 只给了 path 主键。2) feed_items 的 COALESCE(published_at, fetched_at)——友圈排序/裁剪/countSince 全用它，
-- 015 的裸列索引命中不了。3) posts(kind, published_at DESC, id DESC)——后台按 kind 过滤排序；原 ORDER BY
-- COALESCE(...) 用不上 idx_posts_kind，查询侧已改成直接 ORDER BY published_at DESC（NULL 在 DESC 下同样排最后）。

CREATE INDEX IF NOT EXISTS idx_aliases_post          ON aliases(post_id);
CREATE INDEX IF NOT EXISTS idx_feed_items_ts_by_feed ON feed_items(feed_id, COALESCE(published_at, fetched_at) DESC, id DESC);
CREATE INDEX IF NOT EXISTS idx_feed_items_ts         ON feed_items(COALESCE(published_at, fetched_at) DESC, id DESC);
CREATE INDEX IF NOT EXISTS idx_posts_kind_pub        ON posts(kind, published_at DESC, id DESC);
CREATE INDEX IF NOT EXISTS idx_media_created         ON media(created_at DESC, id DESC);

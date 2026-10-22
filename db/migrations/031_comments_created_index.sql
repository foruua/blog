-- 后台「最近评论」列表按 created_at DESC, id DESC 排序且不带 status 过滤；现有评论索引（post_id / status+created_at /
-- email / parent / website_host）都无法提供该排序，SQLite 只能全表扫描后排序。补一条覆盖排序的索引。
CREATE INDEX IF NOT EXISTS idx_comments_created ON comments(created_at DESC, id DESC);

-- 清理四个冗余/无用索引（理由都用 grep 核过引用）：1) idx_media_created 与 001 的 idx_media_created_id 定义完全
-- 一致，026 又建了一遍。2) idx_rev_created：读它的语句都先按 post_id 过滤（idx_rev_post 已覆盖）。3) idx_comments_ip：
-- ip_hash 只写不读。4) idx_feed_items_time：026 的 idx_feed_items_ts 已覆盖。

DROP INDEX IF EXISTS idx_media_created;
DROP INDEX IF EXISTS idx_rev_created;
DROP INDEX IF EXISTS idx_comments_ip;
DROP INDEX IF EXISTS idx_feed_items_time;

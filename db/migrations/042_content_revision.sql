-- 页面/Feed 缓存的「内容修订号」：只统计会改变前台 HTML 的表。
--
-- 之前缓存用 total_changes()，发信队列的一次退避、一次 markSent 也会让整站页面与 Feed 缓存失效；
-- 高频重试时缓存命中率被无关写入拖垮。SQLite 没有按表的 total_changes，这里用行级触发器维护一个
-- 单行计数表：mail_outbox / write_journal 等后台表不在列表里，就不会打扰页面缓存。
--
-- 注意：触发器是逐行的；feed_items 一轮刷新会多写几千次计数，但省下的是整站 HTML 重渲染，
-- 对个人博客仍是划算的。新增会影响前台的表时，记得同时补三条触发器。
CREATE TABLE IF NOT EXISTS content_revision (
  id  INTEGER PRIMARY KEY CHECK (id = 1),
  rev INTEGER NOT NULL DEFAULT 0
);
INSERT OR IGNORE INTO content_revision(id, rev) VALUES (1, 0);

CREATE TRIGGER IF NOT EXISTS content_rev_posts_insert AFTER INSERT ON posts
BEGIN UPDATE content_revision SET rev = rev + 1 WHERE id = 1; END;
CREATE TRIGGER IF NOT EXISTS content_rev_posts_update AFTER UPDATE ON posts
BEGIN UPDATE content_revision SET rev = rev + 1 WHERE id = 1; END;
CREATE TRIGGER IF NOT EXISTS content_rev_posts_delete AFTER DELETE ON posts
BEGIN UPDATE content_revision SET rev = rev + 1 WHERE id = 1; END;

CREATE TRIGGER IF NOT EXISTS content_rev_comments_insert AFTER INSERT ON comments
BEGIN UPDATE content_revision SET rev = rev + 1 WHERE id = 1; END;
CREATE TRIGGER IF NOT EXISTS content_rev_comments_update AFTER UPDATE ON comments
BEGIN UPDATE content_revision SET rev = rev + 1 WHERE id = 1; END;
CREATE TRIGGER IF NOT EXISTS content_rev_comments_delete AFTER DELETE ON comments
BEGIN UPDATE content_revision SET rev = rev + 1 WHERE id = 1; END;

CREATE TRIGGER IF NOT EXISTS content_rev_settings_insert AFTER INSERT ON settings
BEGIN UPDATE content_revision SET rev = rev + 1 WHERE id = 1; END;
CREATE TRIGGER IF NOT EXISTS content_rev_settings_update AFTER UPDATE ON settings
BEGIN UPDATE content_revision SET rev = rev + 1 WHERE id = 1; END;
CREATE TRIGGER IF NOT EXISTS content_rev_settings_delete AFTER DELETE ON settings
BEGIN UPDATE content_revision SET rev = rev + 1 WHERE id = 1; END;

CREATE TRIGGER IF NOT EXISTS content_rev_media_insert AFTER INSERT ON media
BEGIN UPDATE content_revision SET rev = rev + 1 WHERE id = 1; END;
CREATE TRIGGER IF NOT EXISTS content_rev_media_update AFTER UPDATE ON media
BEGIN UPDATE content_revision SET rev = rev + 1 WHERE id = 1; END;
CREATE TRIGGER IF NOT EXISTS content_rev_media_delete AFTER DELETE ON media
BEGIN UPDATE content_revision SET rev = rev + 1 WHERE id = 1; END;

CREATE TRIGGER IF NOT EXISTS content_rev_aliases_insert AFTER INSERT ON aliases
BEGIN UPDATE content_revision SET rev = rev + 1 WHERE id = 1; END;
CREATE TRIGGER IF NOT EXISTS content_rev_aliases_update AFTER UPDATE ON aliases
BEGIN UPDATE content_revision SET rev = rev + 1 WHERE id = 1; END;
CREATE TRIGGER IF NOT EXISTS content_rev_aliases_delete AFTER DELETE ON aliases
BEGIN UPDATE content_revision SET rev = rev + 1 WHERE id = 1; END;

CREATE TRIGGER IF NOT EXISTS content_rev_feeds_insert AFTER INSERT ON feeds
BEGIN UPDATE content_revision SET rev = rev + 1 WHERE id = 1; END;
CREATE TRIGGER IF NOT EXISTS content_rev_feeds_update AFTER UPDATE ON feeds
BEGIN UPDATE content_revision SET rev = rev + 1 WHERE id = 1; END;
CREATE TRIGGER IF NOT EXISTS content_rev_feeds_delete AFTER DELETE ON feeds
BEGIN UPDATE content_revision SET rev = rev + 1 WHERE id = 1; END;

CREATE TRIGGER IF NOT EXISTS content_rev_feed_items_insert AFTER INSERT ON feed_items
BEGIN UPDATE content_revision SET rev = rev + 1 WHERE id = 1; END;
CREATE TRIGGER IF NOT EXISTS content_rev_feed_items_update AFTER UPDATE ON feed_items
BEGIN UPDATE content_revision SET rev = rev + 1 WHERE id = 1; END;
CREATE TRIGGER IF NOT EXISTS content_rev_feed_items_delete AFTER DELETE ON feed_items
BEGIN UPDATE content_revision SET rev = rev + 1 WHERE id = 1; END;

CREATE TRIGGER IF NOT EXISTS content_rev_link_sites_insert AFTER INSERT ON link_sites
BEGIN UPDATE content_revision SET rev = rev + 1 WHERE id = 1; END;
CREATE TRIGGER IF NOT EXISTS content_rev_link_sites_update AFTER UPDATE ON link_sites
BEGIN UPDATE content_revision SET rev = rev + 1 WHERE id = 1; END;
CREATE TRIGGER IF NOT EXISTS content_rev_link_sites_delete AFTER DELETE ON link_sites
BEGIN UPDATE content_revision SET rev = rev + 1 WHERE id = 1; END;

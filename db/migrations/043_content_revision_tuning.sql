-- 042 的两处细化：
--   1. settings 触发器只统计会影响前台 HTML 的键；备份状态、发信队列/退订、后台会话与
--      write_journal 都是纯后台数据，不该让页面/Feed 缓存失效。
--   2. feed_items 的逐行触发器在订阅多时会把一轮刷新放大成几百上千次计数写入；
--      改为在 db/feeds.js 的 saveItems 事务里统一 bump 一次。
DROP TRIGGER IF EXISTS content_rev_settings_insert;
DROP TRIGGER IF EXISTS content_rev_settings_update;
DROP TRIGGER IF EXISTS content_rev_settings_delete;

CREATE TRIGGER IF NOT EXISTS content_rev_settings_insert AFTER INSERT ON settings
WHEN NEW.key NOT GLOB 'admin_*'
 AND NEW.key NOT GLOB 'mail_*'
 AND NEW.key NOT GLOB 'backup_*'
 AND NEW.key NOT GLOB 'write_journal:*'
BEGIN UPDATE content_revision SET rev = rev + 1 WHERE id = 1; END;

CREATE TRIGGER IF NOT EXISTS content_rev_settings_update AFTER UPDATE ON settings
WHEN NEW.key NOT GLOB 'admin_*'
 AND NEW.key NOT GLOB 'mail_*'
 AND NEW.key NOT GLOB 'backup_*'
 AND NEW.key NOT GLOB 'write_journal:*'
BEGIN UPDATE content_revision SET rev = rev + 1 WHERE id = 1; END;

CREATE TRIGGER IF NOT EXISTS content_rev_settings_delete AFTER DELETE ON settings
WHEN OLD.key NOT GLOB 'admin_*'
 AND OLD.key NOT GLOB 'mail_*'
 AND OLD.key NOT GLOB 'backup_*'
 AND OLD.key NOT GLOB 'write_journal:*'
BEGIN UPDATE content_revision SET rev = rev + 1 WHERE id = 1; END;

DROP TRIGGER IF EXISTS content_rev_feed_items_insert;
DROP TRIGGER IF EXISTS content_rev_feed_items_update;
DROP TRIGGER IF EXISTS content_rev_feed_items_delete;

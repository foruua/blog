-- 后台媒体引用缓存的失效版本：只跟随 posts/media 的变化，不再用连接级 total_changes()。
-- 评论、设置、友圈刷新都不影响“正文引用了哪些附件”，不应让媒体页重建全站索引。
INSERT OR IGNORE INTO settings(key, value) VALUES('usage_revision', '0');

CREATE TRIGGER IF NOT EXISTS posts_usage_ai AFTER INSERT ON posts BEGIN
  UPDATE settings SET value = CAST(value AS INTEGER) + 1 WHERE key = 'usage_revision';
END;
CREATE TRIGGER IF NOT EXISTS posts_usage_au AFTER UPDATE ON posts BEGIN
  UPDATE settings SET value = CAST(value AS INTEGER) + 1 WHERE key = 'usage_revision';
END;
CREATE TRIGGER IF NOT EXISTS posts_usage_ad AFTER DELETE ON posts BEGIN
  UPDATE settings SET value = CAST(value AS INTEGER) + 1 WHERE key = 'usage_revision';
END;

CREATE TRIGGER IF NOT EXISTS media_usage_ai AFTER INSERT ON media BEGIN
  UPDATE settings SET value = CAST(value AS INTEGER) + 1 WHERE key = 'usage_revision';
END;
CREATE TRIGGER IF NOT EXISTS media_usage_au AFTER UPDATE ON media BEGIN
  UPDATE settings SET value = CAST(value AS INTEGER) + 1 WHERE key = 'usage_revision';
END;
CREATE TRIGGER IF NOT EXISTS media_usage_ad AFTER DELETE ON media BEGIN
  UPDATE settings SET value = CAST(value AS INTEGER) + 1 WHERE key = 'usage_revision';
END;

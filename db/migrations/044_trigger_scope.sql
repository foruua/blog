-- 044：把「只写状态」的后台刷新从内容修订号里摘出去。
--
-- 042 给 feeds / link_sites 装的是无条件 UPDATE 触发器：订阅源每轮刷新（哪怕对方回 304、
-- 只是把 last_fetch_at 挪一下）、友链每轮探测（只是 checked_at 变了）都会让 rev + 1，
-- 于是 HTML 页面、feed、sitemap 缓存整站失效 —— 刷新间隔一到就清一次缓存，命中率被无关写入拖垮。
-- 043 本意就是修这个，但只收敛了 settings 与 feed_items，漏了这两张表。
--
-- 改成「只在前台真正显示的列变化时才计数」：用 IS NOT 而不是 <>，因为 IS NOT 对 NULL 也成立，
-- 而 etag / last_modified / last_error 这些列经常是 NULL，用 <> 会漏掉 NULL → 值的变更。
-- 注意：触发器是逐行的，新增会影响前台展示的列时，记得同步加进这里的 WHEN 子句。

DROP TRIGGER IF EXISTS content_rev_feeds_update;
CREATE TRIGGER content_rev_feeds_update AFTER UPDATE ON feeds
WHEN NEW.url        IS NOT OLD.url
  OR NEW.title      IS NOT OLD.title
  OR NEW.site_url   IS NOT OLD.site_url
  OR NEW.enabled    IS NOT OLD.enabled
  OR NEW.sort_order IS NOT OLD.sort_order
BEGIN UPDATE content_revision SET rev = rev + 1 WHERE id = 1; END;

DROP TRIGGER IF EXISTS content_rev_link_sites_update;
CREATE TRIGGER content_rev_link_sites_update AFTER UPDATE ON link_sites
WHEN NEW.url    IS NOT OLD.url
  OR NEW.title  IS NOT OLD.title
  OR NEW.alive  IS NOT OLD.alive
  OR NEW.hidden IS NOT OLD.hidden
BEGIN UPDATE content_revision SET rev = rev + 1 WHERE id = 1; END;

-- usage_revision 是 038 给后台媒体引用缓存用的计数器，由 posts / media 的触发器自己维护。
-- 它在 settings 里，每保存一篇文章都会跟着写一次；不排除的话内容修订号要 +2，
-- 白算一遍（虽不致命，但让「一次保存 = 一次失效」这个不变量失真）。
DROP TRIGGER IF EXISTS content_rev_settings_insert;
DROP TRIGGER IF EXISTS content_rev_settings_update;
DROP TRIGGER IF EXISTS content_rev_settings_delete;

CREATE TRIGGER content_rev_settings_insert AFTER INSERT ON settings
WHEN NEW.key NOT GLOB 'admin_*'
 AND NEW.key NOT GLOB 'mail_*'
 AND NEW.key NOT GLOB 'backup_*'
 AND NEW.key NOT GLOB 'write_journal:*'
 AND NEW.key <> 'usage_revision'
BEGIN UPDATE content_revision SET rev = rev + 1 WHERE id = 1; END;

CREATE TRIGGER content_rev_settings_update AFTER UPDATE ON settings
WHEN NEW.key NOT GLOB 'admin_*'
 AND NEW.key NOT GLOB 'mail_*'
 AND NEW.key NOT GLOB 'backup_*'
 AND NEW.key NOT GLOB 'write_journal:*'
 AND NEW.key <> 'usage_revision'
BEGIN UPDATE content_revision SET rev = rev + 1 WHERE id = 1; END;

CREATE TRIGGER content_rev_settings_delete AFTER DELETE ON settings
WHEN OLD.key NOT GLOB 'admin_*'
 AND OLD.key NOT GLOB 'mail_*'
 AND OLD.key NOT GLOB 'backup_*'
 AND OLD.key NOT GLOB 'write_journal:*'
 AND OLD.key <> 'usage_revision'
BEGIN UPDATE content_revision SET rev = rev + 1 WHERE id = 1; END;

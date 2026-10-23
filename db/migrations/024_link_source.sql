-- 旧记录没有绑定原始网址，无法确认缓存跳转是否仍有效；下次按最新评论重新探测。hidden 不受影响，手动隐藏始终保留。
ALTER TABLE link_sites ADD COLUMN source_url TEXT NOT NULL DEFAULT '';

-- 单站最新留言通过索引定位，无需重新聚合全部评论。IF EXISTS：老库里这个索引可能已经被手工删掉，
-- 没有 IF EXISTS 时整条迁移会抛错、把启动卡死在版本 24 之前。
DROP INDEX IF EXISTS idx_comments_website_host;
CREATE INDEX idx_comments_website_host ON comments(website_host, status, is_author, created_at DESC, id DESC);

-- 旧记录没有绑定原始网址，无法确认缓存跳转是否仍有效；下次按最新评论重新探测。hidden 不受影响，手动隐藏始终保留。
ALTER TABLE link_sites ADD COLUMN source_url TEXT NOT NULL DEFAULT '';

-- 单站最新留言通过索引定位，无需重新聚合全部评论。
DROP INDEX idx_comments_website_host;
CREATE INDEX idx_comments_website_host ON comments(website_host, status, is_author, created_at DESC, id DESC);

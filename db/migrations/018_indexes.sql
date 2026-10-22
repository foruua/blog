-- 补齐两处缺失索引。1) comments.parent_id——自引用外键（CASCADE）又是建树递归 JOIN 的连接列，001 没给它索引、
-- 一直全表扫（建树 O(条数²) + 级联删除逐行扫）。2) posts.title——/go/<标题> wiki-link 解析与 slugify 兜底都按
-- title 精确匹配，同样全表扫；title 不唯一，故是普通索引而非 UNIQUE。

CREATE INDEX IF NOT EXISTS idx_comments_parent ON comments(parent_id);
CREATE INDEX IF NOT EXISTS idx_posts_title     ON posts(title);

-- 移除 comments.ip_hash：全库检索确认该列只写不读（限流/封禁判定都发生在写入前的内存层），
-- 027 已删掉它的索引。保留它唯一的「收益」是让评论者 IP 哈希随每次备份与异地副本永久扩散——
-- 无功能回报的隐私负债，直接删列。评论者身份关联仍走 email_hash（其原有用途不变）。
-- SQLite ≥ 3.35 支持 DROP COLUMN（Node 22 内置为 3.4x）。

ALTER TABLE comments DROP COLUMN ip_hash;

-- 启动同步会反复查「文件来源且未缺失」的文章（fileRows / listFiles / pageFiles）。此前只有
-- posts(file_path) 普通索引，source/missing_file 过滤仍要扫全表；这里补一个部分索引。
CREATE INDEX IF NOT EXISTS idx_posts_file_sync
  ON posts(file_path)
  WHERE source = 'file' AND missing_file = 0 AND file_path IS NOT NULL;

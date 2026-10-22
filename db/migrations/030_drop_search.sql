-- 检索改为查询时现读现匹配（见 src/search/index.js）：倒排索引表与切词版本号一并撤掉。
-- 025 保持不动（迁移链只追加不改写），这里把当初为 FTS5 建的东西收干净。
DROP TABLE IF EXISTS search_index;
DELETE FROM settings WHERE key = 'search_index_version';

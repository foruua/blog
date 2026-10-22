-- 全站检索（FTS5 虚表）。不用 external content + 触发器同步：这张表存切词后的串（汉字压一元组 + 二元组，见
-- src/search/index.js），切词只有 JS 能做（SQL 触发器算不出二元组），snippet()/highlight() 也用不上——命中片段
-- 改由查询时对 posts.body_html 现算，这张表只负责"谁能被匹配到"。列序就是 bm25 权重位序（title_grams = 3.0 /
-- body_grams = 1.0）：调整列序必须同步改 bm25(search_index, 3.0, 1.0) 那句，否则权重落到 0 权重的 doc/ref 上、
-- 静默失效。doc / ref / parent 是 UNINDEXED 存储列：不参与匹配，只回指原文（post → posts.id；comment →
-- comments.id，parent = posts.id）。分词器用 unicode61；换 trigram 会把二元组再切碎，且要求 ≥3 字，「搜索」
-- 「笔记」这类中文两字词会整片漏掉（实测过）。

CREATE VIRTUAL TABLE IF NOT EXISTS search_index USING fts5(
  title_grams,
  body_grams,
  doc UNINDEXED,
  ref UNINDEXED,
  parent UNINDEXED,
  tokenize = 'unicode61 remove_diacritics 2'
);

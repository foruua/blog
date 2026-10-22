-- 014：让「固定页」成为第三种内容（kind = 'page'）。固定页存进同一张 posts 表（沿用索引/修订/渲染管线），
-- 但 001 的 CHECK 只允许 'post'/'note'；SQLite 改不了 CHECK，只能整表重建。migrate() 会 PRAGMA
-- foreign_keys = OFF 并在提交前 foreign_key_check，故带外键的子表（aliases/comments/revisions/media）不受影响。

CREATE TABLE posts_new (
  id           INTEGER PRIMARY KEY,
  slug         TEXT    NOT NULL UNIQUE,
  kind         TEXT    NOT NULL DEFAULT 'post'
                       CHECK (kind IN ('post','note','page')),
  title        TEXT    NOT NULL DEFAULT '',
  body_md      TEXT    NOT NULL DEFAULT '',
  body_html    TEXT,
  toc_json     TEXT,
  lang         TEXT    NOT NULL DEFAULT 'zh',
  comments_on  INTEGER NOT NULL DEFAULT 1,
  draft        INTEGER NOT NULL DEFAULT 1,
  source       TEXT    NOT NULL DEFAULT 'admin'
                       CHECK (source IN ('file','admin')),
  file_path    TEXT,
  file_hash    TEXT,
  word_count   INTEGER NOT NULL DEFAULT 0,
  published_at TEXT,
  created_at   TEXT    NOT NULL DEFAULT (datetime('now')),
  updated_at   TEXT    NOT NULL DEFAULT (datetime('now')),
  version      INTEGER NOT NULL DEFAULT 1,
  missing_file INTEGER NOT NULL DEFAULT 0
);

INSERT INTO posts_new (id, slug, kind, title, body_md, body_html, toc_json, lang, comments_on,
                       draft, source, file_path, file_hash, word_count, published_at,
                       created_at, updated_at, version, missing_file)
SELECT id, slug, kind, title, body_md, body_html, toc_json, lang, comments_on,
       draft, source, file_path, file_hash, word_count, published_at,
       created_at, updated_at, version, missing_file
FROM posts;

DROP TABLE posts;
ALTER TABLE posts_new RENAME TO posts;

CREATE INDEX IF NOT EXISTS idx_posts_pub  ON posts(draft, published_at DESC);
CREATE INDEX IF NOT EXISTS idx_posts_kind ON posts(kind, draft, published_at DESC);
CREATE INDEX IF NOT EXISTS idx_posts_file ON posts(file_path);

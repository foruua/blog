-- 最终态建库脚本：把 001–012 整条迁移链压平后的结果，新装的机器直接建出最终结构。
-- 升级注意：已记录 version 1 的库（跑过旧链的）会跳过本文件；停在 2–11 的库会出问题（压缩后那些中间文件
-- 已不存在），请先用压缩前的迁移链升到 12，或直接用 `npm run restore` 恢复。

CREATE TABLE IF NOT EXISTS posts (
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
CREATE INDEX IF NOT EXISTS idx_posts_pub  ON posts(draft, published_at DESC);
CREATE INDEX IF NOT EXISTS idx_posts_kind ON posts(kind, draft, published_at DESC);
CREATE INDEX IF NOT EXISTS idx_posts_file ON posts(file_path);

CREATE TABLE IF NOT EXISTS aliases (
  path    TEXT PRIMARY KEY,
  post_id INTEGER NOT NULL REFERENCES posts(id) ON DELETE CASCADE
);

-- links 表已废弃（019 删除）：只写不读，`[[目标]]` 走 /go/ 实时解析；这里不再建它。
CREATE TABLE IF NOT EXISTS comments (
  id               INTEGER PRIMARY KEY,
  post_id          INTEGER NOT NULL REFERENCES posts(id) ON DELETE CASCADE,
  parent_id        INTEGER REFERENCES comments(id) ON DELETE CASCADE,
  author           TEXT    NOT NULL,
  email_hash       TEXT,
  website          TEXT,
  body_md          TEXT    NOT NULL,
  status           TEXT    NOT NULL DEFAULT 'pending'
                   CHECK (status IN ('pending','approved','spam','deleted')),
  ip_hash          TEXT,
  created_at       TEXT    NOT NULL DEFAULT (datetime('now')),
  email_enc        TEXT,
  is_author        INTEGER NOT NULL DEFAULT 0,
  moderation_nonce TEXT
);
CREATE INDEX IF NOT EXISTS idx_comments_post   ON comments(post_id, status, created_at);
CREATE INDEX IF NOT EXISTS idx_comments_ip     ON comments(ip_hash);
CREATE INDEX IF NOT EXISTS idx_comments_email  ON comments(email_hash);
CREATE INDEX IF NOT EXISTS idx_comments_status ON comments(status, created_at);

CREATE TABLE IF NOT EXISTS media (
  id         INTEGER PRIMARY KEY,
  path       TEXT NOT NULL UNIQUE,
  width      INTEGER, height INTEGER, bytes INTEGER, mime TEXT,
  hash       TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  filename   TEXT,
  alt        TEXT,
  thumbnail  TEXT
);
CREATE INDEX IF NOT EXISTS idx_media_hash ON media(hash);
CREATE INDEX IF NOT EXISTS idx_media_created_id ON media(created_at DESC, id DESC);

CREATE TABLE IF NOT EXISTS revisions (
  id         INTEGER PRIMARY KEY,
  post_id    INTEGER NOT NULL REFERENCES posts(id) ON DELETE CASCADE,
  title      TEXT    NOT NULL DEFAULT '',
  body_md    TEXT    NOT NULL,
  note       TEXT    NOT NULL DEFAULT '',
  created_at TEXT    NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_rev_post    ON revisions(post_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_rev_created ON revisions(created_at DESC);

CREATE TABLE IF NOT EXISTS settings (
  key   TEXT PRIMARY KEY,
  value TEXT NOT NULL
);

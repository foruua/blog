// 后台列表的标题/文件名搜索：FTS5 trigram 索引按子串匹配，替代对每行做 instr() 的全表扫描。
// 运行时创建而不是写死进迁移：FTS5 不是所有 SQLite 构建都编译进来，失败时调用方自动退回旧查询。
// 表是派生索引，真正数据仍在 posts/media；triggers 负责随写入维护。
const POSTS_TABLE = 'admin_posts_fts';
const MEDIA_TABLE = 'admin_media_fts';

export function createAdminSearch(db, { log = () => {} } = {}) {
  let ready = false;
  try {
    const hadPosts = Boolean(db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name=?").get(POSTS_TABLE));
    db.exec(`
      CREATE VIRTUAL TABLE IF NOT EXISTS ${POSTS_TABLE}
        USING fts5(title, slug, content='posts', content_rowid='id', tokenize='trigram');
      CREATE VIRTUAL TABLE IF NOT EXISTS ${MEDIA_TABLE}
        USING fts5(filename, path, content='media', content_rowid='id', tokenize='trigram');

      CREATE TRIGGER IF NOT EXISTS admin_posts_fts_ai AFTER INSERT ON posts BEGIN
        INSERT INTO ${POSTS_TABLE}(rowid, title, slug) VALUES (new.id, new.title, new.slug);
      END;
      CREATE TRIGGER IF NOT EXISTS admin_posts_fts_ad AFTER DELETE ON posts BEGIN
        INSERT INTO ${POSTS_TABLE}(${POSTS_TABLE}, rowid, title, slug)
          VALUES ('delete', old.id, old.title, old.slug);
      END;
      CREATE TRIGGER IF NOT EXISTS admin_posts_fts_au AFTER UPDATE OF title, slug ON posts BEGIN
        INSERT INTO ${POSTS_TABLE}(${POSTS_TABLE}, rowid, title, slug)
          VALUES ('delete', old.id, old.title, old.slug);
        INSERT INTO ${POSTS_TABLE}(rowid, title, slug) VALUES (new.id, new.title, new.slug);
      END;

      CREATE TRIGGER IF NOT EXISTS admin_media_fts_ai AFTER INSERT ON media BEGIN
        INSERT INTO ${MEDIA_TABLE}(rowid, filename, path)
          VALUES (new.id, COALESCE(new.filename, ''), new.path);
      END;
      CREATE TRIGGER IF NOT EXISTS admin_media_fts_ad AFTER DELETE ON media BEGIN
        INSERT INTO ${MEDIA_TABLE}(${MEDIA_TABLE}, rowid, filename, path)
          VALUES ('delete', old.id, COALESCE(old.filename, ''), old.path);
      END;
      CREATE TRIGGER IF NOT EXISTS admin_media_fts_au AFTER UPDATE OF filename, path ON media BEGIN
        INSERT INTO ${MEDIA_TABLE}(${MEDIA_TABLE}, rowid, filename, path)
          VALUES ('delete', old.id, COALESCE(old.filename, ''), old.path);
        INSERT INTO ${MEDIA_TABLE}(rowid, filename, path)
          VALUES (new.id, COALESCE(new.filename, ''), new.path);
      END;
    `);
    // 首次启用/从旧库升级时重建一次；之后 triggers 会增量维护。外部内容表 COUNT(*) 会读 content 表，
    // 不能靠行数判断索引是否已填充，这里用一次性 settings 标记。
    const key = 'admin_search_fts_version';
    const version = '1';
    if (!hadPosts || db.prepare('SELECT value FROM settings WHERE key = ?').get(key)?.value !== version) {
      db.exec(`INSERT INTO ${POSTS_TABLE}(${POSTS_TABLE}) VALUES('rebuild')`);
      db.exec(`INSERT INTO ${MEDIA_TABLE}(${MEDIA_TABLE}) VALUES('rebuild')`);
      db.prepare(`INSERT INTO settings(key, value) VALUES(?, ?)
        ON CONFLICT(key) DO UPDATE SET value = excluded.value`).run(key, version);
    }
    ready = true;
  } catch (error) {
    // FTS5 不可用 / 只读连接等：保持 ready=false，搜索走旧 instr 路径。
    log(JSON.stringify({ event: 'admin.search-fts-unavailable', code: error?.code ?? 'FTS' }));
  }

  const phrase = (q) => `"${String(q).replace(/"/g, '""')}"`;
  const postQuery = ready ? db.prepare(`SELECT p.id, p.slug, p.kind, p.title, p.draft, p.missing_file, p.published_at,
      (SELECT COUNT(*) FROM comments c WHERE c.post_id=p.id AND c.status='approved') AS comments,
      (SELECT COUNT(*) FROM comments c WHERE c.post_id=p.id AND c.status='pending') AS pending_comments
    FROM posts p JOIN ${POSTS_TABLE} f ON f.rowid = p.id
    WHERE p.kind=? AND ${POSTS_TABLE} MATCH ?
      AND (?='all' OR (?='draft' AND p.draft=1)
        OR (?='scheduled' AND p.draft=0 AND p.published_at IS NOT NULL AND p.published_at>strftime('%Y-%m-%dT%H:%M:%SZ','now'))
        OR (?='published' AND p.draft=0 AND p.published_at IS NOT NULL AND p.published_at<=strftime('%Y-%m-%dT%H:%M:%SZ','now')))
    ORDER BY p.published_at DESC, p.id DESC LIMIT ? OFFSET ?`) : null;
  const mediaQuery = ready ? db.prepare(`SELECT m.* FROM media m JOIN ${MEDIA_TABLE} f ON f.rowid = m.id
    WHERE ${MEDIA_TABLE} MATCH ?
    ORDER BY m.created_at DESC, m.id DESC LIMIT ? OFFSET ?`) : null;

  return {
    ready,
    // trigram 需要至少 3 个字符；短词/特殊输入返回 null，让调用方走精确的 instr 回退。
    posts(kind, search, status, offset, limit) {
      if (!ready || String(search).length < 3 || !/[\p{L}\p{N}]/u.test(String(search))) return null;
      try { return postQuery.all(kind, phrase(search), status, status, status, status, limit, offset); }
      catch { return null; }
    },
    media(search, offset, limit) {
      if (!ready || String(search).length < 3 || !/[\p{L}\p{N}]/u.test(String(search))) return null;
      try { return mediaQuery.all(phrase(search), limit, offset); }
      catch { return null; }
    },
  };
}

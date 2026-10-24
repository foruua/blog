import { ADMIN_PAGE_SIZE } from '../src/config.js';
import { usageOf, indexUploads, createUsageCache } from '../src/media/usage.js';
import { createTx } from './tx.js';
import { createAdminSearch } from './admin-search.js';

export function createAdminRepo(db) {
  const tx = createTx(db, 'admin');
  const searchApi = createAdminSearch(db);
  const q = {

    getById: db.prepare('SELECT * FROM posts WHERE id = ?'),
    deletePost: db.prepare('DELETE FROM posts WHERE id = ?'),

    addAlias: db.prepare('INSERT OR REPLACE INTO aliases(path, post_id) VALUES(?, ?)'),
    aliasesOf: db.prepare('SELECT path FROM aliases WHERE post_id = ?'),

    revAdd: db.prepare('INSERT INTO revisions(post_id, title, body_md, note) VALUES(?,?,?,?)'),
    revList: db.prepare(`SELECT id, post_id, title, note, created_at, length(body_md) AS bytes
      FROM revisions WHERE post_id = ? ORDER BY created_at DESC, id DESC LIMIT ?`),
    revGet: db.prepare('SELECT * FROM revisions WHERE id = ?'),
    revTrim: db.prepare(`DELETE FROM revisions WHERE post_id = ? AND id NOT IN
      (SELECT id FROM revisions WHERE post_id = ? AND (note = 'autosave') = ? ORDER BY created_at DESC, id DESC LIMIT ?) AND (note = 'autosave') = ?`),
    revLast: db.prepare(`SELECT id, created_at, title, body_md FROM revisions
      WHERE post_id = ? ORDER BY created_at DESC, id DESC LIMIT 1`),

    // 清空历史是一次性的全量维护动作：两张表都只按行数上报，不按文章/笔记/页面细分。
    historyCounts: db.prepare(`SELECT
      (SELECT COUNT(*) FROM revisions) AS revisions,
      (SELECT COUNT(*) FROM aliases) AS aliases`),
    purgeRevisions: db.prepare('DELETE FROM revisions'),
    purgeAliases: db.prepare('DELETE FROM aliases'),

    mediaAdd: db.prepare(`INSERT INTO media(path, width, height, bytes, original_bytes, mime, hash, filename, alt, thumbnail, variants, animated)
      VALUES(?,?,?,?,?,?,?,?,?,?,?,?)`),
    mediaSetOriginalBytes: db.prepare('UPDATE media SET original_bytes = ? WHERE id = ? AND original_bytes IS NULL'),
    mediaByHash: db.prepare('SELECT * FROM media WHERE hash = ? LIMIT 1'),
    mediaByPath: db.prepare('SELECT * FROM media WHERE path=?'),
    mediaById: db.prepare('SELECT * FROM media WHERE id = ?'),
    mediaDelete: db.prepare('DELETE FROM media WHERE id = ?'),

    // 列表页只需要元数据：显式列，别用 p.* 把每篇的 body_html/body_md（数百 KB）也拉出来。
    pagePosts: db.prepare(`SELECT p.id, p.slug, p.kind, p.title, p.draft, p.missing_file, p.published_at,
      (SELECT COUNT(*) FROM comments c WHERE c.post_id=p.id AND c.status='approved') AS comments,
      (SELECT COUNT(*) FROM comments c WHERE c.post_id=p.id AND c.status='pending') AS pending_comments
      FROM posts p WHERE p.kind=? AND (instr(p.title,?)>0 OR instr(p.slug,?)>0)
      AND (?='all' OR (?='draft' AND p.draft=1)
        OR (?='scheduled' AND p.draft=0 AND p.published_at IS NOT NULL AND p.published_at>strftime('%Y-%m-%dT%H:%M:%SZ','now'))
        OR (?='published' AND p.draft=0 AND p.published_at IS NOT NULL AND p.published_at<=strftime('%Y-%m-%dT%H:%M:%SZ','now')))
      ORDER BY p.published_at DESC, p.id DESC LIMIT ${ADMIN_PAGE_SIZE + 1} OFFSET ?`),
    pageMedia: db.prepare(`SELECT * FROM media WHERE instr(COALESCE(filename,''),?)>0 OR instr(path,?)>0
      ORDER BY created_at DESC,id DESC LIMIT ${ADMIN_PAGE_SIZE + 1} OFFSET ?`),

    mediaReferences: db.prepare(`SELECT id, slug, kind, title, draft, published_at, missing_file, body_md FROM posts
      WHERE instr(body_md, 'uploads') > 0
      ORDER BY published_at DESC, id DESC`),
    mediaCount: db.prepare('SELECT COUNT(*) AS n, COALESCE(SUM(COALESCE(original_bytes, bytes)),0) AS bytes FROM media'),

    pendingComments: db.prepare(`SELECT c.*, p.slug AS post_slug, p.title AS post_title, p.kind AS post_kind
      FROM comments c JOIN posts p ON p.id = c.post_id
      WHERE c.status = 'pending' ORDER BY c.created_at ASC, c.id ASC LIMIT ${ADMIN_PAGE_SIZE} OFFSET ?`),
    recentComments: db.prepare(`SELECT c.*, p.slug AS post_slug, p.title AS post_title, p.kind AS post_kind
      FROM comments c JOIN posts p ON p.id = c.post_id
      ORDER BY c.created_at DESC, c.id DESC LIMIT ${ADMIN_PAGE_SIZE} OFFSET ?`),
    commentFull: db.prepare(`SELECT c.*, p.slug AS post_slug, p.title AS post_title, p.kind AS post_kind
      FROM comments c JOIN posts p ON p.id = c.post_id WHERE c.id = ?`),
    // parent_id 是级联外键，删一条会带走整棵子树——必须递归数出全部子孙，只数直接子节点会让"连同 N 条回复"严重少报。
    // depth 上限 64：数据脏了（parent 成环）也不会死循环。
    repliesOf: db.prepare(`WITH RECURSIVE tree(id, d) AS (
      SELECT id, 0 FROM comments WHERE parent_id = ?
      UNION ALL
      SELECT c.id, t.d + 1 FROM comments c JOIN tree t ON c.parent_id = t.id WHERE t.d < 64
    ) SELECT COUNT(*) AS n FROM tree`),
    purgeComment: db.prepare('DELETE FROM comments WHERE id = ?'),
    commentCounts: db.prepare('SELECT status, COUNT(*) AS n FROM comments GROUP BY status'),

    counts: db.prepare(`SELECT
      (SELECT COUNT(*) FROM posts WHERE kind = ?) AS total,
      (SELECT COUNT(*) FROM posts WHERE kind = ? AND draft = 1) AS drafts,
      (SELECT COUNT(*) FROM posts WHERE kind = ? AND draft = 0 AND published_at > strftime('%Y-%m-%dT%H:%M:%SZ','now')) AS scheduled`),
  };

  const REV_KEEP = 60;
  const references = createUsageCache();
  // 由 038 迁移的触发器维护：只有 posts/media 写入会 bump usage_revision。评论/设置/feed 不再把
  // 媒体引用缓存冲掉；外部 SQL 直接改 posts.title 也会触发，不会缓存住旧标题。
  const usageRevision = db.prepare("SELECT value FROM settings WHERE key = 'usage_revision'");
  const externalChanges = db.prepare('PRAGMA data_version');
  let usageSignature = '', usageIndex;
  const usage = (items) => {
    const signature = `${usageRevision.get()?.value ?? '0'}:${externalChanges.get().data_version}`;
    // 旧版 Node 22 的 DatabaseSync 没有 isTransaction 属性（undefined），所以用 !== 而非 ===：
    const canCache = db.isTransaction !== true;
    if (!canCache || signature !== usageSignature || !usageIndex) {
      usageIndex = indexUploads(q.mediaReferences.all(), references);
      usageSignature = canCache ? signature : '';
    }
    return usageOf(items, usageIndex);
  };

  return {
    listPage: (kind, { page = 1, search = '', status = 'all' } = {}) => {
      const offset = (page - 1) * ADMIN_PAGE_SIZE;
      return searchApi.posts(kind, search, status, offset, ADMIN_PAGE_SIZE + 1)
        ?? q.pagePosts.all(kind, search, search, status, status, status, status, offset);
    },
    get: (id) => q.getById.get(Number(id)),
    deletePost: (id) => q.deletePost.run(Number(id)),
    addAlias: (p, id) => q.addAlias.run(p, Number(id)),
    aliasesOf: (id) => q.aliasesOf.all(Number(id)).map((r) => r.path),

    addRevision: (postId, title, bodyMd, note = 'manual') => tx(() => {
      q.revAdd.run(Number(postId), String(title ?? ''), String(bodyMd ?? ''), note);
      q.revTrim.run(Number(postId), Number(postId), note === 'autosave' ? 1 : 0, REV_KEEP / 2, note === 'autosave' ? 1 : 0);
    }),
    revisions: (postId, limit = 30) => q.revList.all(Number(postId), limit),
    revision: (id) => q.revGet.get(Number(id)),
    lastRevision: (postId) => q.revLast.get(Number(postId)),
    historyCounts: () => q.historyCounts.get(),
    // 事务里一并清空，避免只删掉一半（revisions 与 aliases 是配套的历史数据）。
    clearHistory: () => tx(() => ({
      revisions: q.purgeRevisions.run().changes,
      aliases: q.purgeAliases.run().changes,
    })),

    mediaAdd: (m) => Number(q.mediaAdd.run(
      m.path, m.width ?? null, m.height ?? null, m.bytes ?? null, m.originalBytes ?? null,
      m.mime ?? null, m.hash ?? null, m.filename ?? null, m.alt ?? null,
      m.thumbnail ?? null, m.variants ?? null, m.animated == null ? null : (m.animated ? 1 : 0),
    ).lastInsertRowid),
    mediaSetOriginalBytes: (id, bytes) => q.mediaSetOriginalBytes.run(Number(bytes), Number(id)),
    mediaByPath: (p) => q.mediaByPath.get(p),
    mediaPage: ({ page = 1, search = '' } = {}) => {
      const offset = (page - 1) * ADMIN_PAGE_SIZE;
      return searchApi.media(search, offset, ADMIN_PAGE_SIZE + 1)
        ?? q.pageMedia.all(search, search, offset);
    },
    mediaByHash: (h) => q.mediaByHash.get(h),
    mediaById: (id) => q.mediaById.get(Number(id)),
    mediaDelete: (id) => q.mediaDelete.run(Number(id)),
    mediaUsage: usage,
    postsUsingPath: (p) => {
      const item = q.mediaByPath.get(String(p)) ?? { id: 0, path: String(p) };
      return usage([item]).get(item.id);
    },
    mediaStats: () => q.mediaCount.get(),

    // 评论页两个列表都分页：只取当前页（页长 ADMIN_PAGE_SIZE），页码与「还有没有下一页」由路由按计数算（见 routes/admin/comments.js）。created_at 相同的按 id 兜底排序，否则翻页时同一行会在两页各出现一次或被跳过。
    pendingComments: ({ offset = 0 } = {}) => q.pendingComments.all(offset),
    recentComments: ({ offset = 0 } = {}) => q.recentComments.all(offset),
    commentFull: (id) => q.commentFull.get(Number(id)),
    repliesOf: (id) => q.repliesOf.get(Number(id))?.n ?? 0,

    purgeComment: (id) => q.purgeComment.run(Number(id)),
    commentCounts: () => Object.fromEntries(q.commentCounts.all().map((r) => [r.status, r.n])),

    counts: (kind) => q.counts.get(kind, kind, kind),
  };
}

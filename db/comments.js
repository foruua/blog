import crypto from 'node:crypto';
import { websiteHost } from '../src/util/url.js';

// 数据层允许的评论树深度（顶层 = 1）。渲染层另有更小的"缩进层数"上限，这里是硬上限：防止有人拿 parent_id 造出几千层的链（渲染与上溯会变慢）。
export const MAX_DEPTH = 6;

export function createCommentRepo(db) {
  const q = {
    insert: db.prepare(`INSERT INTO comments
      (post_id, parent_id, author, email_hash, email_enc, website, website_host, body_md, status, is_author, moderation_nonce, submission_id)
      VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`),
    byId: db.prepare('SELECT * FROM comments WHERE id = ?'),
    bySubmission: db.prepare('SELECT * FROM comments WHERE post_id = ? AND submission_id = ? LIMIT 1'),
    approvedOfPost: db.prepare(`SELECT * FROM comments
      WHERE post_id = ? AND status = 'approved' ORDER BY created_at ASC, id ASC`),
    countApproved: db.prepare(`SELECT COUNT(*) AS n FROM comments WHERE post_id = ? AND status = 'approved'`),
    setStatus: db.prepare('UPDATE comments SET status = ?, moderation_nonce = ? WHERE id = ?'),
    countsByStatus: db.prepare('SELECT status, COUNT(*) AS n FROM comments GROUP BY status'),

    knownReader: db.prepare(`SELECT 1 AS ok FROM comments
      WHERE status = 'approved' AND is_author = 0 AND author = ? AND email_hash = ?
      LIMIT 1`),
    readerProfile: db.prepare(`SELECT author, website FROM comments
      WHERE status = 'approved' AND is_author = 0 AND email_hash = ?
      ORDER BY created_at DESC, id DESC LIMIT 1`),
    spamEmail: db.prepare(`SELECT 1 AS ok FROM comments
      WHERE status = 'spam' AND email_hash IS NOT NULL AND email_hash = ?
      LIMIT 1`),
    // 同一邮箱每次加密的 IV 都不同，DISTINCT email_enc 等于不去重；按 email_hash 分组只取一条代表密文，
    // 让头像“已知集合”的重建量从 O(评论数) 降到 O(邮箱数)。
    approvedEmailEncs: db.prepare(`SELECT MIN(email_enc) AS email_enc FROM comments
      WHERE status = 'approved' AND email_enc IS NOT NULL AND email_hash IS NOT NULL
      GROUP BY email_hash`),

    parentEmail: db.prepare('SELECT email_enc, author, post_id FROM comments WHERE id = ?'),
    postSlug: db.prepare('SELECT slug, kind, title FROM posts WHERE id = ?'),

    // —— 评论分页 —— 单位是"讨论串"（一条根评论 + 整棵子树），绝不把线程拆到两页。vis = 页面显示成"顶层"的：
    // 根评论，或父评论已不可见（软删/垃圾）而被提升上来的——必须与 threadOf() 的孤儿提升语义一致，否则被删父
    // 评论的子回复会从所有页里凭空消失。
    pageThreads: db.prepare(`WITH RECURSIVE
      vis(id) AS (
        SELECT c.id FROM comments c LEFT JOIN comments p ON p.id = c.parent_id
        WHERE c.post_id = ? AND c.status = 'approved'
          AND (c.parent_id IS NULL OR p.id IS NULL OR p.status <> 'approved')
        ORDER BY c.created_at, c.id LIMIT ? OFFSET ?
      ),
      tree(id) AS (
        SELECT id FROM vis
        UNION
        SELECT c.id FROM comments c JOIN tree t ON c.parent_id = t.id WHERE c.status = 'approved'
      )
      SELECT c.* FROM tree t CROSS JOIN comments c ON c.id = t.id ORDER BY c.created_at, c.id`),
    countThreads: db.prepare(`SELECT COUNT(*) AS n FROM comments c LEFT JOIN comments p ON p.id = c.parent_id
      WHERE c.post_id = ? AND c.status = 'approved'
        AND (c.parent_id IS NULL OR p.id IS NULL OR p.status <> 'approved')`),
    threadHead: db.prepare(`WITH RECURSIVE up(id, parent_id, created_at, d) AS (
        SELECT id, parent_id, created_at, 0 FROM comments WHERE id = ?
        UNION ALL
        SELECT c.id, c.parent_id, c.created_at, up.d + 1 FROM comments c JOIN up ON c.id = up.parent_id
        WHERE c.status = 'approved' AND up.d < 64
      ) SELECT id, created_at FROM up ORDER BY d DESC LIMIT 1`),
    threadsBefore: db.prepare(`SELECT COUNT(*) AS n FROM comments c LEFT JOIN comments p ON p.id = c.parent_id
      WHERE c.post_id = ? AND c.status = 'approved'
        AND (c.parent_id IS NULL OR p.id IS NULL OR p.status <> 'approved')
        AND (c.created_at, c.id) < (?, ?)`),

    // 沿 parent_id 上溯收集祖先链（含自身），一条递归 CTE 取回，不再逐层点查。depth 上限 64：数据脏了（parent 成环）也不会死循环。ORDER BY depth ASC → [自身, 父, …]。
    ancestorChain: db.prepare(`WITH RECURSIVE up(id, parent_id, depth) AS (
        SELECT id, parent_id, 0 FROM comments WHERE id = ?
        UNION ALL
        SELECT c.id, c.parent_id, up.depth + 1 FROM comments c JOIN up ON c.id = up.parent_id
        WHERE up.depth < 64
      ) SELECT id FROM up ORDER BY depth ASC`),
  };

  const ofPostsStmts = new Map();

  function ancestorChain(id) {
    return q.ancestorChain.all(id).map((r) => r.id);
  }

  // 深度保护：超上限时把新评论挂到"上限那层的祖先"上，而非拒绝提交（不丢用户内容）。放在 add() 里，保证
  // 前台评论、后台作者回复、邮件审核页三条写入路径都受同一约束。
  function clampParent(parentId, maxDepth = MAX_DEPTH) {
    if (parentId == null) return null;
    const chain = ancestorChain(parentId);
    if (!chain.length) return null;
    if (chain.length < maxDepth) return parentId;      // 父的深度 < 上限，直接挂
    return chain[chain.length - maxDepth + 1];         // 否则挂到深度恰为 maxDepth-1 的祖先
  }

  return {

    add(c) {
      // 同一次页面提交的 submission_id 重复到达时直接返回已有评论，不重复插入/通知。
      if (c.submissionId) {
        const existing = q.bySubmission.get(c.postId, c.submissionId);
        if (existing) return existing.id;
      }
      // website_host 在这里派生，不劳调用方传：它是 comments 表的一部分（访客页归并键），让四条写入路径各自
      // 记得带迟早会漏一条——那时会出现「有人在评论区却不在访客页」的错。
      const r = q.insert.run(
        c.postId, clampParent(c.parentId ?? null), c.author, c.emailHash ?? null, c.emailEnc ?? null,
        c.website ?? null, websiteHost(c.website), c.bodyMd, c.status, c.isAuthor ? 1 : 0, crypto.randomUUID(),
        c.submissionId ?? null,
      );
      const id = Number(r.lastInsertRowid);
      return id;
    },
    get: (id) => q.byId.get(id),
    bySubmission: (postId, submissionId) => q.bySubmission.get(postId, submissionId) ?? null,
    ofPost: (postId) => q.approvedOfPost.all(postId),
    pageThreadsOf(ids, limit = 20) {
      if (!ids.length) return new Map();
      const sql = `WITH RECURSIVE roots AS (
        SELECT c.id, c.post_id,
          ROW_NUMBER() OVER (PARTITION BY c.post_id ORDER BY c.created_at,c.id) AS rn,
          COUNT(*) OVER (PARTITION BY c.post_id) AS thread_count
        FROM comments c LEFT JOIN comments p ON p.id=c.parent_id
        WHERE c.status='approved' AND c.post_id IN (${ids.map(() => '?').join(',')})
          AND (c.parent_id IS NULL OR p.id IS NULL OR p.status<>'approved')
      ), tree(id,post_id) AS (
        SELECT id,post_id FROM roots WHERE rn<=?
        UNION
        SELECT c.id,c.post_id FROM comments c JOIN tree t ON c.parent_id=t.id AND c.post_id=t.post_id
        WHERE c.status='approved'
      ) SELECT c.*, (SELECT MAX(thread_count) FROM roots r WHERE r.post_id=c.post_id) AS thread_count
        FROM tree t CROSS JOIN comments c ON c.id=t.id ORDER BY c.created_at,c.id`;
      const stmt = ofPostsStmts.get(sql) ?? db.prepare(sql);
      ofPostsStmts.set(sql, stmt);
      const groups = new Map(ids.map((id) => [id, []]));
      for (const row of stmt.all(...ids, Math.max(1, limit))) groups.get(row.post_id).push(row);
      return groups;
    },
    countOfPost: (postId) => q.countApproved.get(postId).n,
    // 一批文章的已通过评论数（列表行右下角那枚「N 条评论」）：一条 IN 查询取回，不逐篇点查。
    // 语句随批大小变化，与 pageThreadsOf 共用同一张缓存表。
    countsOf(ids) {
      if (!ids.length) return new Map();
      const sql = `SELECT post_id, COUNT(*) AS n FROM comments
        WHERE status = 'approved' AND post_id IN (${ids.map(() => '?').join(',')}) GROUP BY post_id`;
      const stmt = ofPostsStmts.get(sql) ?? db.prepare(sql);
      ofPostsStmts.set(sql, stmt);
      return new Map(stmt.all(...ids).map((r) => [r.post_id, r.n]));
    },
    counts: () => Object.fromEntries(q.countsByStatus.all().map((r) => [r.status, r.n])),
    // 每次改状态都换掉 moderation_nonce：审核链接因此一次性，邮件被转发也翻不动状态；站主不受影响，页面会用
    // 续签的新链接（routes/comments.js）。
    setStatus: (id, status) => q.setStatus.run(status, crypto.randomUUID(), id),
    isKnown: (author, emailHash) => Boolean(author) && Boolean(emailHash) && Boolean(q.knownReader.get(author, emailHash)),
    readerProfile: (emailHash) => q.readerProfile.get(emailHash) ?? null,
    hasSpam: (emailHash) => Boolean(emailHash) && Boolean(q.spamEmail.get(emailHash)),
    approvedEmailEncs: () => q.approvedEmailEncs.all().map((row) => row.email_enc),

    pageThreads(postId, limit = 20, page = 1) {
      const rows = q.pageThreads.all(Number(postId), Math.max(1, limit), Math.max(0, (Math.max(1, page) - 1) * limit));
      return threadOf(rows);
    },
    threadCount: (postId) => q.countThreads.get(Number(postId)).n,
    threadPageOf({ postId, commentId, limit = 20 }) {
      const head = q.threadHead.get(Number(commentId));
      if (!head) return null;
      const before = q.threadsBefore.get(Number(postId), head.created_at, head.id).n;
      return { page: Math.floor(before / Math.max(1, limit)) + 1, headId: head.id };
    },
    parentEmail: (id) => q.parentEmail.get(id),
    postOf: (postId) => q.postSlug.get(postId),
  };
}

// 把扁平行列表还原成任意深度的评论树。入参必须按 created_at,id 升序（SQL 已这么排），同级回复才自然保持时间顺序。
export function threadOf(comments) {
  const nodes = new Map(comments.map((c) => [c.id, { ...c, replies: [] }]));
  const roots = [];
  for (const c of comments) {
    const parent = c.parent_id == null ? null : nodes.get(c.parent_id);
    // 父评论已不可见（软删/标垃圾）时提升为顶层，否则整棵子树会跟着消失
    if (parent) parent.replies.push(nodes.get(c.id));
    else roots.push(nodes.get(c.id));
  }
  return roots;
}

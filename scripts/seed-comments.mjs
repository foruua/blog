import { parseFlags } from './_cli.mjs';
import { acquireMaintenanceLock } from '../src/util/lock.js';
import fs from 'node:fs';
import path from 'node:path';
import { open, close } from '../db/driver.js';
import { snapshot, DEFAULT_DIR } from '../src/backup.js';
import { DATA_DIR, DB_FILE, CONTENT_DIR, UPLOADS_DIR } from '../src/config.js';

// 造一批评论数据，肉眼验收「多级嵌套 + 评论分页」。用法：node scripts/seed-comments.mjs [--slug <slug>] [--threads <1-200>，默认 34] [--clear]。
// 只写数据库、不碰 Markdown 与附件；插入的 id 记在 data/seed-comments.json，可精确回滚。运行前请先停掉服务（它也要拿维护锁）。
const { argv, opt } = parseFlags();
const SLUG = opt('--slug', 'sqlite-as-blog');
// `--threads abc` 会得到 NaN，接着循环一次都不跑、写出一份空记账并报「已插入 0 条」、退出码 0。
const THREADS_RAW = opt('--threads', 34);
const THREADS = Number(THREADS_RAW);
if (!Number.isInteger(THREADS) || THREADS < 1 || THREADS > 200) {
  console.error(`✗ --threads 需要 1—200 的整数，收到：${THREADS_RAW}`);
  process.exit(2);
}
const CLEAR = argv.includes('--clear');
const manifestPath = path.join(DATA_DIR, 'seed-comments.json');

// 固定种子的 LCG：同样的参数每次造出同一批数据，便于对照
let seed = 20261005;
const rnd = (n) => { seed = (seed * 1103515245 + 12345) & 0x7fffffff; return seed % n; };
const pick = (arr) => arr[rnd(arr.length)];

const AUTHORS = ['林一', 'wood', 'kwan', '阿澈', '老周', 'Mia', '山有木兮', '陈默', '叶子', '九十九',
  '路人甲', '苏晚', '观山', '小满', 'Nori', '桃桃'];
const OPENERS = [
  '这个说法我第一次听到，但挺有道理。',
  '正好在踩同一个坑，记一下。',
  '我持相反意见：这里其实要看使用频率。',
  '请问这个结论有数据支撑吗？',
  '看完去翻了下源码，确实是这样。',
  '写得真清楚，转给我同事看了。',
  '补充一点：还有第三种情况会被忽略。',
  '这个我试过，失败了，可能环境不同。',
];
const REPLIES = [
  '同意，我也是这么理解的。',
  '你这条提醒很关键，我差点漏掉。',
  '不完全同意，边界条件不太一样。',
  '对，我后来也发现了。',
  '有道理，我改天试试看。',
  '这里还要考虑移动端的表现。',
  '谢谢补充，我更新到正文里了。',
  '这取决于你用哪个版本，我这边表现不同。',
];
const LONG_PARA = '补充一个细节：这个行为在并发下更明显，尤其是写入和读取交错的时候。'
  + '我当时用最笨的办法加了一层队列，问题就消失了 —— 当然代价是吞吐降了一些。';

const stamp = (minutesAgo) => {
  // 与 SQLite datetime('now') 同格式（UTC、无毫秒），避免和其他评论的时间戳串味
  const d = new Date(Date.now() - minutesAgo * 60000);
  return d.toISOString().slice(0, 19).replace('T', ' ');
};

const db = open(DB_FILE);
// process.exit() 不会跑 finally —— 这几条退出路径以前都不关库，WAL 也就没机会 checkpoint。
let closed = false;
const bail = (code) => { if (!closed) { closed = true; close(db); } process.exit(code); };
// 锁获取失败也要先关库，否则 WAL 句柄会一直挂着（脚本随后抛错退出）。
const lock = (label) => {
  try { return acquireMaintenanceLock([DB_FILE, CONTENT_DIR, UPLOADS_DIR], label); }
  catch (error) { if (!closed) { closed = true; close(db); } throw error; }
};
try {
  if (CLEAR) {
    if (!fs.existsSync(manifestPath)) {
      console.log('没有 data/seed-comments.json，说明本脚本没造过数据，无需清理。');
      bail(0);
    }
    const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
    const ids = manifest.comments ?? [];
    lock('clear-comments');
    // parent_id 是级联外键：删根评论会带走整棵子树，所以 changes 统计的是讨论串数，实际消失条数看删前删后总数差。
    const beforeTotal = db.prepare('SELECT COUNT(*) AS n FROM comments').get().n;
    for (const id of ids) db.prepare('DELETE FROM comments WHERE id = ?').run(Number(id));
    const afterTotal = db.prepare('SELECT COUNT(*) AS n FROM comments').get().n;
    fs.unlinkSync(manifestPath);
    console.log(`已删除 ${beforeTotal - afterTotal} 条测试评论（记账的 ${ids.length} 个 id，级联覆盖其余回复）`);
    console.log(`剩余评论 ${afterTotal} 条；已移除 ${path.relative(process.cwd(), manifestPath)}`);
    bail(0);
  }

  lock('seed-comments');
  const post = db.prepare('SELECT id, slug, title, kind FROM posts WHERE slug = ?').get(SLUG);
  if (!post) {
    console.error(`找不到 slug 为「${SLUG}」的内容，可用 --slug 指定。现有文章：`);
    for (const r of db.prepare("SELECT slug FROM posts WHERE kind='post' ORDER BY published_at DESC LIMIT 10").all()) console.error('  ' + r.slug);
    bail(1);
  }

  const before = await snapshot(db, { dir: path.join(DEFAULT_DIR, 'before-seed-comments'), keep: 3, label: 'pre-seed-comments', allowMissingFiles: true });
  console.log(`插入前快照：${before.gzFile}`);

  const insert = db.prepare(`INSERT INTO comments
    (post_id, parent_id, author, email_hash, email_enc, website, body_md, status, is_author, moderation_nonce, created_at)
    VALUES (?, ?, ?, NULL, NULL, ?, ?, 'approved', ?, ?, ?)`);

  const created = [];
  let at = THREADS * 90;  for (let t = 1; t <= THREADS; t++) {
    const slug = `${SLUG}-seed-${t}`;
    // 讨论串形状：多数是 0—2 条回复，少数几条拉长（第 3 条刻意做成 6 层，用来验收缩进封顶与 @ 标注）
    const shape = t === 3 ? 5 : t % 7 === 0 ? 3 : t % 3 === 0 ? 2 : t % 2 === 0 ? 1 : 0;
    let parentId = null;
    let lastAuthor = null;
    for (let d = 0; d <= shape; d++) {
      const asAuthor = d > 0 && t % 5 === 0;      let author = '博主';
      if (!asAuthor) {
        // 同一串里不要连着同一个人：否则「回复 @某人」会变成「林一 回复 @林一」，肉眼没法验收
        do { author = pick(AUTHORS); } while (author === lastAuthor && AUTHORS.length > 1);
      }
      lastAuthor = author;
      // 同一串里每条都要换一句话：否则一屏全是「同意，我也是这么理解的」，看不出设计好坏
      const body = d === 0 ? OPENERS[(t + d) % OPENERS.length]
        : (t % 4 === 0 && d === 1 ? LONG_PARA : REPLIES[(t * 3 + d * 5) % REPLIES.length]);
      const website = !asAuthor && d === 0 && t % 4 === 1 ? 'https://example.com/' + t : null;
      at -= 3;
      parentId = Number(insert.run(
        post.id, parentId, author, website, body, asAuthor ? 1 : 0, `${slug}-${d}`, stamp(at),
      ).lastInsertRowid);
      created.push({ id: parentId, depth: d, author });
    }
    console.log(`  ✓ 讨论串 ${String(t).padStart(2)}/${THREADS}  ${created.length} 条累计`);
  }

  // 记账要合并而不是覆盖：跑第二次（换个 --slug）时覆盖会让上一批永远无法用 --clear 撤销。
  const previous = (() => {
    try {
      const m = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
      return Array.isArray(m.comments) ? m.comments : [];
    } catch { return []; }
  })();
  const manifest = {
    version: 1,
    createdAt: new Date().toISOString(),
    slug: post.slug,
    comments: [...new Set([...previous, ...created.map((c) => c.id)])],
  };
  fs.writeFileSync(manifestPath, JSON.stringify(manifest, null, 2) + '\n');
  if (previous.length) console.log(`  · 记账与已有的 ${previous.length} 个 id 合并（共 ${manifest.comments.length} 个）`);

  // 从每条评论各自往上走到根，取最大值 —— 只看最后插入的一条并不能代表最深的那一串
  const deepest = db.prepare(`WITH RECURSIVE up(id, parent_id, d) AS (
      SELECT id, parent_id, 0 FROM comments WHERE id IN (${created.map(() => '?').join(',')})
      UNION ALL SELECT c.id, c.parent_id, up.d + 1 FROM comments c JOIN up ON c.id = up.parent_id WHERE up.parent_id IS NOT NULL
    ) SELECT COALESCE(MAX(d), -1) + 1 AS n FROM up`).get(...created.map((c) => c.id)).n;
  console.log(`\n已插入 ${created.length} 条评论，分布在 ${THREADS} 个讨论串（最深的一串 ${deepest} 层）`);
  console.log(`内容：${post.kind} / ${post.slug}（${post.title}）`);
  console.log(`记账：${path.relative(process.cwd(), manifestPath)}`);
  console.log(`撤销：node scripts/seed-comments.mjs --clear`);
} finally {
  if (!closed) close(db);
}

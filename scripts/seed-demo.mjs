import { acquireMaintenanceLock } from '../src/util/lock.js';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import zlib from 'node:zlib';
import { open, close } from '../db/driver.js';
import { migrate } from '../db/migrate.js';
import { createRepo } from '../db/repo.js';
import { createAdminRepo } from '../db/admin.js';
import { createCommentRepo } from '../db/comments.js';
import { createCrypto } from '../src/auth.js';
import { syncContent } from '../src/content/sync.js';
import { writePostFile, planFilePath } from '../src/content/write.js';
import { snapshot, DEFAULT_DIR } from '../src/backup.js';
import { DATA_DIR, DB_FILE, CONTENT_DIR, UPLOADS_DIR, SITE } from '../src/config.js';

acquireMaintenanceLock([DB_FILE, CONTENT_DIR, UPLOADS_DIR], 'seed-demo');
const db = open(DB_FILE);
try {
  migrate(db, { log() {} });
  const repo = createRepo(db), admin = createAdminRepo(db), comments = createCommentRepo(db), crypt = createCrypto(db);
  // 用配置好的备份目录（BACKUP_DIR ?? data/backups）下的子目录，别再自造一个 cwd 相对的 memory/。
  const backupDir = path.join(DEFAULT_DIR, 'before-demo-seed');
  const before = await snapshot(db, { dir: backupDir, keep: 3, label: 'pre-demo-seed', allowMissingFiles: true });
  console.log(`修改前备份：${before.gzFile}`);
  const manifestPath = path.join(DATA_DIR, 'demo-seed.json');
  const manifest = fs.existsSync(manifestPath) ? JSON.parse(fs.readFileSync(manifestPath, 'utf8'))
    : { version: 1, createdAt: new Date().toISOString(), posts: [], media: [], comments: [], revisions: [], aliases: [] };
  const topics = ['界面设计', '代码维护', '阅读记录', '写作习惯', '性能优化', '数据备份', '时间管理', '城市观察', '摄影手记', '小工具'];
  const images = [];
  const crc32 = (buf) => {
    let crc = 0xffffffff;
    for (const byte of buf) { crc ^= byte; for (let i = 0; i < 8; i++) crc = (crc >>> 1) ^ (0xedb88320 & -(crc & 1)); }
    return (crc ^ 0xffffffff) >>> 0;
  };
  const chunk = (type, data) => {
    const name = Buffer.from(type); const len = Buffer.alloc(4); len.writeUInt32BE(data.length);
    const crc = Buffer.alloc(4); crc.writeUInt32BE(crc32(Buffer.concat([name, data])));
    return Buffer.concat([len, name, data, crc]);
  };
  const makePng = (width, height, variant) => {
    const raw = Buffer.alloc(height * (1 + width * 3));
    for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) {
      const at = y * (1 + width * 3) + 1 + x * 3;
      const stripe = Math.floor(x / 40) % 2 === Math.floor(y / 40) % 2 ? 28 : 0;
      raw[at] = (70 + variant * 17 + Math.floor(x / width * 80) + stripe) % 256;
      raw[at + 1] = (90 + variant * 11 + Math.floor(y / height * 80)) % 256;
      raw[at + 2] = (140 + variant * 7 + stripe) % 256;
    }
    const header = Buffer.alloc(13); header.writeUInt32BE(width); header.writeUInt32BE(height, 4); header[8] = 8; header[9] = 2;
    return Buffer.concat([Buffer.from([137,80,78,71,13,10,26,10]), chunk('IHDR', header), chunk('IDAT', zlib.deflateSync(raw)), chunk('IEND', Buffer.alloc(0))]);
  };
  for (let i = 0; i < 12; i++) {
    const [width, height] = [[800,450],[450,800],[480,480],[1200,400]][i % 4];
    const raw = makePng(width, height, i), hash = crypto.createHash('sha256').update(raw).digest('hex');
    const url = `/uploads/demo/${hash.slice(0,16)}.png`, file = path.join(UPLOADS_DIR, 'demo', path.basename(url));
    fs.mkdirSync(path.dirname(file), { recursive: true });
    if (!fs.existsSync(file)) fs.writeFileSync(file, raw);
    if (!admin.mediaByHash(hash)) {
      admin.mediaAdd({ path: url, width, height, bytes: raw.length, mime: 'image/png', hash, filename: `demo-${i + 1}.png`, alt: `测试图 ${i + 1}` });
      manifest.media.push({ path: url, file, hash });
    }
    images.push(url);
  }
  const paragraph = (topic, i) => `关于${topic}，我想把观察和实践放在一起记录。一个细节是否有效，往往要看它在真实使用中的表现。第 ${i + 1} 次记录里，我保留了过程，也记下了还没有解决的问题。`;
  const longBody = (topic, i) => {
    const paragraphs = Array.from({ length: i % 8 === 0 ? 18 : 5 }, (_, n) => paragraph(topic, n));
    return `## 从一个细节开始\n\n${paragraphs.slice(0, 2).join('\n\n')}\n\n### 做了什么\n\n- 记录原来的行为\n- 调整一个变量\n- 再看一次结果\n\n> 先把问题看清楚，再动手改变。\n\n## 实践记录\n\n${paragraphs.slice(2).join('\n\n')}\n\n\`\`\`javascript\nconst entries = ['观察', '实践', '复盘'];\nconsole.log(entries.join(' → '));\n\`\`\`\n\n| 阶段 | 记录 | 状态 |\n| --- | --- | --- |\n| 观察 | 发现细节 | 完成 |\n| 实践 | 做一次调整 | 完成 |\n| 复盘 | 保留结论 | 进行中 |\n\n${i % 3 === 0 ? `![测试图片 ${i + 1}](${images[i % images.length]})\n\n` : ''}## 继续阅读\n\n[[demo-post-01]] · [[demo-post-02]] · [[about]]\n\n**关键记录**：这是用于页面测试的虚构内容。`;
  };
  const records = [];
  const now = new Date();
  const dateFor = (i, scheduled) => {
    if (scheduled) return new Date(now.getTime() + (i + 1) * 7 * 86400000).toISOString().replace(/\.\d{3}Z$/, 'Z');
    if (i < 24) return new Date(now.getTime() - 86400000).toISOString().replace(/\.\d{3}Z$/, 'Z');
    return new Date(Date.UTC(2022 + i % 4, i % 12, 1 + i % 27, i % 24)).toISOString().replace(/\.\d{3}Z$/, 'Z');
  };
  for (const [kind, count, published, drafts] of [['post',48,36,6],['note',32,24,4]]) {
    for (let i = 0; i < count; i++) {
      const topic = topics[i % topics.length], draft = i >= published && i < published + drafts;
      const scheduled = i >= published + drafts;
      records.push({ kind, slug: `demo-${kind}-${String(i + 1).padStart(2,'0')}`, state: draft ? 'draft' : scheduled ? 'scheduled' : 'published',
        front: { title: `【测试】${topic} · ${kind === 'note' ? '笔记' : '文章'} ${i + 1}${i === 3 ? '：一个较长的标题，用来检查列表换行、编辑器宽度与移动端布局' : ''}`,
          date: draft && i % 2 === 0 ? undefined : dateFor(i, scheduled), draft: draft || undefined,
          comments: i % 9 === 0 ? false : undefined,
          demo: true },
        body: kind === 'post' ? longBody(topic, i) : `${paragraph(topic, i)}\n\n${i % 4 === 0 ? `![笔记配图](${images[i % images.length]})\n\n` : ''}${i % 3 === 0 ? '> 把一件小事记下来。\n\n' : ''}[[demo-post-${String(1 + i % 12).padStart(2,'0')}]]\n\n这是用于测试的虚构笔记。` });
    }
  }
  let inserted = 0;
  for (const record of records) {
    const filePath = planFilePath({ kind: record.kind, slug: record.slug });
    if (repo.getPost(record.slug) || fs.existsSync(filePath)) continue;
    writePostFile({ filePath, front: { ...record.front, slug: record.slug }, body: record.body });
    manifest.posts.push({ slug: record.slug, file: filePath, kind: record.kind, state: record.state }); inserted++;
  }
  const sync = syncContent(repo, { quiet: true });
  if (sync.errors.length) throw new Error(sync.errors.join('\n'));
  const interactive = manifest.posts.map((record) => repo.getPost(record.slug))
    .filter((p) => p && p.draft === 0 && p.published_at <= now.toISOString() && p.comments_on === 1).slice(0,24);
  db.exec('BEGIN');
  try {
    for (let i = 0; i < interactive.length; i++) {
      const p = interactive[i];
      if (db.prepare("SELECT 1 FROM comments WHERE post_id = ? AND author = '【测试】读者甲'").get(p.id)) continue;
      const baseTime = Date.now() - (i + 1) * 3600000;
      const add = (author, bodyMd, status, offset, parentId = null, isAuthor = false) => {
        const email = isAuthor ? null : `demo-reader-${i}@example.com`;
        const id = comments.add({ postId: p.id, parentId, author, bodyMd, status, isAuthor,
          website: i % 3 === 0 ? 'https://example.com' : null,
          emailHash: email ? crypt.fingerprint(email) : null, emailEnc: email ? crypt.encrypt(email) : null,
          ipHash: crypt.ipHash(`demo-${i}`) });
        db.prepare('UPDATE comments SET created_at = ? WHERE id = ?').run(new Date(baseTime + offset * 60000).toISOString(), id);
        manifest.comments.push(id); return id;
      };
      const root = add('【测试】读者甲','读完有些新的想法。**这个细节很有意思**，可以继续展开。','approved',0);
      add('【测试】读者乙','补充一个不同的观察：\n\n> 结果也受到使用场景影响。\n\n这里可以再做一次对照。','approved',1,root);
      add(`【测试】${SITE.author || '博主'}`,'谢谢补充，下一次记录会把这个场景加进去。','approved',2,root,true);
      add('【测试】待审读者','这条评论保留在待审核状态，供后台操作测试。','pending',3);
      add('【测试】垃圾样例','虚构的垃圾评论样例，不会显示在前台。','spam',4);
      add('【测试】已删除读者','这条评论是用于恢复操作的已删除样例。','deleted',5);
      add('【测试】独立讨论','代码片段 `const ok = true` 和 [示例链接](https://example.com) 的展示也可以检查一下。','approved',6);
    }
    for (const record of manifest.posts.filter((p) => p.kind === 'post').slice(0,12)) {
      const p = repo.getPost(record.slug); if (!p || admin.revisions(p.id).length) continue;
      for (const [note, body] of [['manual','## 初稿\n\n这是最早的版本。'],['autosave','## 第二稿\n\n补充了一些实践记录。'],['publish',p.body_md]]) {
        admin.addRevision(p.id,p.title,body,note);
        manifest.revisions.push(admin.lastRevision(p.id).id);
      }
      const old = `/p/demo-old-${record.slug}/`;
      if (!repo.findAlias(old)) { admin.addAlias(old,p.id); manifest.aliases.push(old); }
    }
    db.exec('COMMIT');
  } catch (err) { db.exec('ROLLBACK'); throw err; }
  fs.mkdirSync(DATA_DIR, { recursive: true });
  fs.writeFileSync(manifestPath, JSON.stringify(manifest,null,2)+'\n');
  const counts = db.prepare("SELECT kind, draft, COUNT(*) AS n FROM posts WHERE slug LIKE 'demo-%' OR id IN (SELECT id FROM posts WHERE file_path LIKE '%/demo-%') GROUP BY kind,draft").all();
  console.log(JSON.stringify({ added: inserted, content: manifest.posts.length, media: manifest.media.length,
    comments: manifest.comments.length, revisions: manifest.revisions.length, aliases: manifest.aliases.length, counts, manifest: manifestPath },null,2));
} finally { close(db); }

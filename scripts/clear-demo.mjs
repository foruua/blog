import { snapshot } from '../src/backup.js';
import { acquireMaintenanceLock } from '../src/util/lock.js';
import fs from 'node:fs';
import path from 'node:path';
import { parseFrontmatter } from '../src/content/frontmatter.js';
import { open, close } from '../db/driver.js';
import { createRepo } from '../db/repo.js';
import { syncContent } from '../src/content/sync.js';
import { parseVariants } from '../src/media/variants.js';
import { bumpMediaRevision } from '../src/media/revision.js';
import { CONTENT_DIR, DATA_DIR, DB_FILE, UPLOADS_DIR } from '../src/config.js';

const DRY = process.argv.includes('--dry-run');
const manifestPath = path.join(DATA_DIR, 'demo-seed.json');
const manifest = fs.existsSync(manifestPath) ? JSON.parse(fs.readFileSync(manifestPath, 'utf8')) : null;

function demoFiles() {
  const out = [];
  for (const kind of ['posts', 'notes']) {
    const dir = path.join(CONTENT_DIR, kind);
    if (!fs.existsSync(dir)) continue;
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      if (!entry.isFile() || !/\.md$/i.test(entry.name)) continue;
      const file = path.join(dir, entry.name);
      let flagged = false;
      try {
        flagged = parseFrontmatter(fs.readFileSync(file, 'utf8')).data.demo === true;
      } catch { flagged = false; }
      if (flagged) out.push(file);
    }
  }
  return out;
}

const files = demoFiles();

console.log(`演示文件：${files.length} 个${DRY ? '（--dry-run，不删）' : ''}`);
if (!files.length && !manifest) {
  console.log('没有演示数据可清。');
  process.exit(0);
}

acquireMaintenanceLock([DB_FILE, CONTENT_DIR, UPLOADS_DIR], 'clear-demo');
const db = open(DB_FILE);
try {
  const repo = createRepo(db);
  const before = {
    posts: db.prepare('SELECT count(*) n FROM posts').get().n,
    comments: db.prepare('SELECT count(*) n FROM comments').get().n,
    media: db.prepare('SELECT count(*) n FROM media').get().n,
  };

  if (!DRY) {
    const backup = await snapshot(db, { label: 'before-clear-demo' });
    console.log(`清理前备份：${backup.gzFile}`);

    for (const f of files) {
      const abs = path.resolve(f);
      if (!abs.startsWith(path.resolve(CONTENT_DIR) + path.sep)) {
        throw new Error(`拒绝删除 content/ 之外的文件：${abs}`);
      }
      fs.unlinkSync(abs);
    }
    console.log(`已删除 ${files.length} 个 markdown`);

    const res = syncContent(repo, { log: (m) => console.log('  ' + m) });
    console.log(`索引同步：removed=${res.removed} updated=${res.updated} total=${res.total}`);

    const media = db.prepare("SELECT id, path, thumbnail, variants FROM media WHERE path LIKE '/uploads/demo/%'").all();
    let filesGone = 0;
    // 和上面删 Markdown 一样：数据库里的路径不可信，删之前必须确认落在 uploads/ 之内
    const uploadsRoot = path.resolve(UPLOADS_DIR);
    const insideUploads = (rel) => {
      const abs = path.resolve(uploadsRoot, String(rel).replace(/^\/uploads\//, ''));
      if (!abs.startsWith(uploadsRoot + path.sep)) throw new Error(`拒绝删除 uploads/ 之外的文件：${abs}`);
      return abs;
    };
    for (const m of media) {
      // 派生物（.thumb.webp 与 .w640/.w1280.webp）也是这次演示生成的，得一起删 —— 以前只删原图，它们成了孤儿、目录永远清不空。
      const targets = [m.path, m.thumbnail, ...parseVariants(m.variants).map((v) => v.path)].filter(Boolean);
      for (const rel of new Set(targets)) {
        const abs = insideUploads(rel);
        if (fs.existsSync(abs)) { fs.unlinkSync(abs); filesGone++; }
      }
    }
    db.prepare("DELETE FROM media WHERE path LIKE '/uploads/demo/%'").run();
    // 媒体行没了，存量正文里指向它们的 srcset 也该失效：下一次内容同步会重渲染一遍。
    bumpMediaRevision(repo);
    const demoDir = path.join(UPLOADS_DIR, 'demo');
    if (fs.existsSync(demoDir) && !fs.readdirSync(demoDir).length) fs.rmdirSync(demoDir);
    console.log(`已删除媒体行 ${media.length} 条、文件 ${filesGone} 个`);

    if (fs.existsSync(manifestPath)) { fs.unlinkSync(manifestPath); console.log('已删除 data/demo-seed.json'); }
  }

  const after = {
    posts: db.prepare('SELECT count(*) n FROM posts').get().n,
    comments: db.prepare('SELECT count(*) n FROM comments').get().n,
    media: db.prepare('SELECT count(*) n FROM media').get().n,
  };
  console.log('\n           清空前行数 → 清空后行数');
  for (const k of Object.keys(before)) console.log(`  ${k.padEnd(10)} ${String(before[k]).padStart(5)} → ${after[k]}`);
  const left = db.prepare('SELECT kind, count(*) n FROM posts GROUP BY kind').all();
  console.log('  剩余内容：', left.length ? left.map((r) => `${r.kind} ${r.n}`).join('，') : '（空）');
} finally {
  close(db);
}

import './_test-env.mjs';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import sharp from 'sharp';
import { spawnSync } from 'node:child_process';
import { DatabaseSync } from 'node:sqlite';
import { migrate } from '../db/migrate.js';
import { createRepo } from '../db/repo.js';
import { createAdminRepo } from '../db/admin.js';
import { createCommentRepo } from '../db/comments.js';
import { syncContent } from '../src/content/sync.js';
import { CONTENT_DIR } from '../src/config.js';
import { mediaFile } from '../src/media/paths.js';
import { obsoleteMediaPlan } from '../src/media/cleanup.js';
import { acquireMaintenanceLock } from '../src/util/lock.js';
import { createBackupSummaryCache } from '../src/backup.js';
import { errorRecord } from '../src/util/errors.js';
import { runSuite } from './_run-suite.mjs';
import { staleOutputPlan } from '../src/util/output.js';

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'blog-operations-'));
try {
  {
    const db = new DatabaseSync(':memory:'); migrate(db, { log() {} });
    const repo = createRepo(db), comments = createCommentRepo(db);
    let file = path.join(CONTENT_DIR, 'posts', 'column-move.md');
    const raw = '---\ntitle: Move\nslug: column-move\ndate: 2025-01-01\n---\nunchanged body';
    fs.writeFileSync(file, raw); assert.deepEqual(syncContent(repo, { quiet: true }).errors, []);
    const original = repo.getPost('column-move');
    const comment = comments.add({ postId: original.id, author: 'reader', bodyMd: 'preserved', status: 'approved' });
    for (const [directory, kind, oldPath] of [['notes', 'note', '/p/column-move/'], ['pages', 'page', '/n/column-move/']]) {
      const next = path.join(CONTENT_DIR, directory, 'column-move.md'); fs.renameSync(file, next); file = next;
      assert.deepEqual(syncContent(repo, { quiet: true }).errors, []);
      const post = repo.getPost('column-move');
      assert.equal(post.kind, kind); assert.equal(post.id, original.id); assert.equal(post.file_path, next);
      assert.equal(post.file_hash, original.file_hash); assert.ok(post.version > original.version);
      assert.equal(comments.get(comment).post_id, original.id);
      assert.equal(repo.findAlias(oldPath).kind, kind);
    }
    assert.equal(repo.findAlias('/p/column-move/').kind, 'page');
    fs.rmSync(file); db.close();
    console.log('✓ 未改字节的文章跨笔记与固定页移动，保留记录和评论并更新旧地址');
  }

  {
    const db = new DatabaseSync(':memory:'); migrate(db, { log() {} }); const repo = createRepo(db);
    const insert = db.prepare("INSERT INTO posts(slug,kind,title,draft,published_at) VALUES(?,'note',?,0,?)");
    for (let i = 0; i < 65; i++) insert.run('rank-' + i, 'rank', '2025-01-01T00:00:00Z');
    db.prepare("UPDATE posts SET draft=1 WHERE slug='rank-0'").run();
    db.prepare("UPDATE posts SET published_at='2099-01-01T00:00:00Z' WHERE slug='rank-1'").run();
    const order = db.prepare("SELECT id,slug,published_at FROM posts WHERE draft=0 AND published_at<'2099' ORDER BY published_at DESC,id DESC").all();
    // /notes/ 与 /posts/ 共用同一套 ?before= 游标：按 published_at|id 排，同秒也不会重复或漏条。
    const page = repo.list({ kind: 'note', limit: 20 });
    assert.deepEqual(page.map((row) => row.id), order.slice(0, 20).map((row) => row.id));
    const boundary = order[19];
    const next = repo.list({ kind: 'note', limit: 20, before: `${boundary.published_at}|${boundary.id}` });
    assert.deepEqual(next.map((row) => row.id), order.slice(20, 40).map((row) => row.id));
    assert.ok(!next.some((row) => row.slug === 'rank-0' || row.slug === 'rank-1'), '草稿与定时内容不该出现在列表里');
    db.close(); console.log('✓ 笔记列表使用统一游标分页，同秒排序、草稿和定时内容正确');
  }

  const dbFile = path.join(root, 'operations.db');
  const db = new DatabaseSync(dbFile); migrate(db, { log() {} });
  try {
    let reads = 0; const prepare = db.prepare.bind(db);
    db.prepare = (sql) => {
      const statement = prepare(sql);
      if (sql.includes("instr(body_md, 'uploads')")) {
        const all = statement.all.bind(statement); statement.all = (...args) => { reads++; return all(...args); };
      }
      return statement;
    };
    const admin = createAdminRepo(db);
    const id = Number(db.prepare("INSERT INTO posts(slug,title,body_md) VALUES('usage','before','![](/uploads/sample.png)')").run().lastInsertRowid);
    const media = { id: 1, path: '/uploads/sample.png' };
    assert.equal(admin.mediaUsage([media]).get(1)[0].title, 'before');
    admin.mediaUsage([media]); assert.equal(reads, 1);
    db.prepare("UPDATE posts SET title='after' WHERE id=?").run(id);
    assert.equal(admin.mediaUsage([media]).get(1)[0].title, 'after'); assert.equal(reads, 2);
    db.prepare("UPDATE posts SET body_md='![](/uploads/otherx.png)' WHERE id=?").run(id);
    assert.equal(admin.mediaUsage([media]).get(1).length, 0); assert.equal(reads, 3);
    const external = new DatabaseSync(dbFile);
    try { external.prepare("UPDATE posts SET body_md='![](/uploads/sample.png)' WHERE id=?").run(id); }
    finally { external.close(); }
    assert.equal(admin.mediaUsage([media]).get(1).length, 1); assert.equal(reads, 4);
    db.exec('BEGIN');
    db.prepare("UPDATE posts SET title='uncommitted' WHERE id=?").run(id);
    assert.equal(admin.mediaUsage([media]).get(1)[0].title, 'uncommitted');
    db.exec('ROLLBACK');
    assert.equal(admin.mediaUsage([media]).get(1)[0].title, 'after');
    console.log('✓ 媒体引用重复读取复用索引，正文、标题、外部写入和事务回滚立即失效');

    const uploads = path.join(root, 'uploads'), content = path.join(root, 'content');
    fs.mkdirSync(uploads); fs.mkdirSync(path.join(content, 'posts'), { recursive: true });
    const png = await sharp({ create: { width: 16, height: 16, channels: 3, background: 'red' } }).png().toBuffer();
    fs.writeFileSync(path.join(uploads, 'sample.png'), png);
    const oldFiles = ['thumb.webp', 'w240.webp', 'w480.webp', 'w640.webp', 'w800.webp', 'w960.webp', 'v2-w1200.webp', 'thumb-v2.webp', 'v3-w16.webp'];
    for (const suffix of [...oldFiles, 'thumb-v3.webp', 'v4-w16.webp']) fs.writeFileSync(path.join(uploads, 'sample.png.' + suffix), png);
    db.prepare('INSERT INTO media(path,thumbnail,variants) VALUES(?,?,?)').run('/uploads/sample.png', '/uploads/sample.png.thumb-v3.webp', JSON.stringify([{ w: 480, path: '/uploads/sample.png.w480.webp' }]));
    db.prepare('UPDATE posts SET body_md=?,body_html=? WHERE id=?').run('[old](/uploads/sample.png.w240.webp?q=1)', '<img srcset="/uploads/sample.png.w640.webp 640w">', id);
    db.prepare("INSERT INTO settings(key,value) VALUES('hero_image','/uploads/sample.png.w800.webp')").run();
    fs.writeFileSync(path.join(content, 'posts', 'unsynced.md'), '![](/uploads/sample.png.w960.webp)');
    const outside = path.join(root, 'outside'); fs.mkdirSync(outside);
    fs.writeFileSync(path.join(outside, 'external.png'), png); fs.symlinkSync(outside, path.join(uploads, 'linked'));
    assert.throws(() => mediaFile('/uploads/linked/new.webp', uploads), /附件路径无效/);
    assert.throws(() => mediaFile('/uploads/../outside/external.png', uploads), /附件路径无效/);
    assert.throws(() => mediaFile('/uploads/linked/external.png', uploads), /附件路径无效/);
    assert.equal(mediaFile('/uploads/missing.png', path.join(root, 'missing-uploads')), path.join(root, 'missing-uploads', 'missing.png'));
    const plan = obsoleteMediaPlan(db, { uploadsDir: uploads, contentDir: content });
    assert.deepEqual(plan.map((item) => item.path), ['/uploads/sample.png.thumb.webp', '/uploads/sample.png.thumb-v2.webp', '/uploads/sample.png.v2-w1200.webp', '/uploads/sample.png.v3-w16.webp'].sort((a, b) => a.localeCompare(b)));
    // 分批判扫（每批 200 行）：第 200 行之后的引用也必须保留，游标不能漏掉后半张表。
    const insComment = db.prepare("INSERT INTO comments(post_id, author, body_md, status) VALUES(?, 'cursor', ?, 'approved')");
    for (let i = 0; i < 249; i++) insComment.run(id, '无引用');
    insComment.run(id, '![](/uploads/sample.png.w240.webp)');
    const planAfterBatch = obsoleteMediaPlan(db, { uploadsDir: uploads, contentDir: content });
    assert.ok(!planAfterBatch.some((item) => item.path === '/uploads/sample.png.w240.webp'),
      '第 200 行之后的评论引用被分批判扫漏掉了');
    const env = { ...process.env, DB_FILE: dbFile, DATA_DIR: root, CONTENT_DIR: content, UPLOADS_DIR: uploads };
    const run = (script, ...args) => spawnSync(process.execPath, ['scripts/' + script + '.mjs', ...args], { env, encoding: 'utf8' });
    assert.equal(run('cleanup-media').status, 0); assert.ok(fs.existsSync(path.join(uploads, 'sample.png.thumb.webp')));
    assert.equal(run('cleanup-media', '--apply').status, 0); assert.ok(!fs.existsSync(path.join(uploads, 'sample.png.thumb.webp')));
    const manifest = JSON.parse(fs.readFileSync(path.join(root, 'cleanup-media', fs.readdirSync(path.join(root, 'cleanup-media'))[0]), 'utf8'));
    for (const item of manifest.files) assert.ok(fs.existsSync(item.trash));
    assert.ok(fs.existsSync(path.join(uploads, 'sample.png.w240.webp')));
    db.prepare("INSERT INTO media(path) VALUES('/uploads/linked/external.png')").run();
    const unsafe = run('backfill-media', '--apply');
    assert.notEqual(unsafe.status, 0); assert.deepEqual(fs.readdirSync(outside), ['external.png']);
    const release = acquireMaintenanceLock([dbFile, uploads, content], 'test-restore');
    try {
      assert.notEqual(run('backfill-media', '--apply').status, 0);
      assert.notEqual(run('cleanup-media', '--apply').status, 0);
    } finally { release(); }
    console.log('✓ 回填拒绝目录外软链，回填与恢复互斥；清理保留所有引用和原图并写恢复映射');
  } finally { db.close(); }

  {
    let now = 0, lists = 0;
    const cache = createBackupSummaryCache({ dir: root, now: () => now, ttlMs: 100, list: () => { lists++; return []; } });
    cache.get(); cache.get(); assert.equal(lists, 1);
    now = 100; cache.get(); assert.equal(lists, 2);
    cache.invalidate(); cache.get(); assert.equal(lists, 3);
    const record = errorRecord(new Error('secret@example.com https://blog.example/moderate/secret password=private'), { requestId: 'request-123' });
    assert.equal(record.requestId, 'request-123'); assert.ok(record.frames.length);
    assert.ok(!JSON.stringify(record).includes('secret')); assert.ok(!JSON.stringify(record).includes('private'));
    console.log('✓ 备份摘要缓存按到期和事件失效，错误日志保留定位信息而不输出敏感文本');
  }

  if (process.platform !== 'win32') {
    const project = path.join(root, 'timeout'); fs.mkdirSync(path.join(project, 'scripts'), { recursive: true });
    const pidFile = path.join(project, 'child.pid');
    fs.writeFileSync(path.join(project, 'scripts', 'hang.mjs'), `import {spawn} from 'node:child_process';import fs from 'node:fs';const child=spawn(process.execPath,['-e','setInterval(()=>{},1000)'],{stdio:'ignore'});fs.writeFileSync(process.env.CHILD_PID,String(child.pid));setInterval(()=>{},1000);`);
    assert.equal(await runSuite('hang', { cwd: project, timeoutMs: 500, env: { ...process.env, CHILD_PID: pidFile }, stdio: 'ignore', log() {} }), 1);
    const pid = Number(fs.readFileSync(pidFile, 'utf8'));
    let running = true;
    for (let i = 0; i < 20; i++) {
      // ps 在受限环境（进程数打满、沙箱）可能直接起不来：spawnSync 会置 error 且 stdout 为 null。
      // 此时退回 kill(pid, 0) 只判存活、不判僵尸，别让「查不了」变成 TypeError。
      const probe = spawnSync('ps', ['-o', 'stat=', '-p', String(pid)], { encoding: 'utf8' });
      if (probe.error || probe.stdout == null) {
        try { process.kill(pid, 0); }
        catch (error) { if (error.code === 'ESRCH') { running = false; break; } }
      } else {
        const stat = probe.stdout.trim();
        if (!stat || stat.startsWith('Z')) { running = false; break; }
      }
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
    assert.equal(running, false); console.log('✓ 套件超时结束服务器子进程，不遗留后台进程');
  }
  {
    const output = path.join(root, 'output'); fs.mkdirSync(output);
    fs.mkdirSync(path.join(output, 'tencent-deploy'));
    for (const name of ['old.png', 'new.png', 'before.tar.gz', 'tencent-deploy/old.png']) {
      const file = path.join(output, name); fs.writeFileSync(file, 'fixture');
      fs.utimesSync(file, 0, name === 'new.png' ? 2 : 0);
    }
    fs.symlinkSync(path.join(output, 'old.png'), path.join(output, 'link.png'));
    assert.deepEqual(staleOutputPlan(output, { now: 2000, maxAgeMs: 1000 }).map((file) => file.path), ['old.png']);
    console.log('✓ 输出清理只选择过期截图日志，保留近期文件、归档、部署目录与软链');
  }
  {
    const bad = spawnSync(process.execPath, ['scripts/rotate-logs.mjs', '--max-mb', 'abc', '--dry-run'], { encoding: 'utf8' });
    assert.equal(bad.status, 2);
    assert.match(bad.stderr, /--max-mb/);
    console.log('✓ 日志轮转拒绝非法 --max-mb，而不是把 NaN 当成“全都超限”');
  }
} finally { fs.rmSync(root, { recursive: true, force: true }); }

#!/usr/bin/env node

import fs from 'node:fs';
import os from 'node:os';
import net from 'node:net';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { parseFlags } from './_cli.mjs';
import { open, close } from '../db/driver.js';
import { SITE } from '../src/config.js';
import { listBackups, isRecoverableBackup, verifyBackup, restoreBackup, DEFAULT_DIR } from '../src/backup.js';

const { argv, opt } = parseFlags();
const DIR = opt('--dir') ?? DEFAULT_DIR;
const KEEP_WORK = argv.includes('--keep-work');

let step = 0;
const fail = [];
const ok = (msg) => console.log(`  ✓ ${msg}`);
const bad = (msg) => { fail.push(msg); console.log(`  ✗ ${msg}`); };
const head = (msg) => console.log(`\n${++step}. ${msg}`);

console.log('\n恢复演练');
console.log('═'.repeat(56));

const started = Date.now();
head('定位最新备份');
const backups = listBackups(DIR);
if (!backups.length) {
  bad(`备份目录里没有完整备份：${DIR}`);
  process.exit(1);
}
const latest = backups.find(isRecoverableBackup);
if (!latest) { bad('没有可用于完整恢复的备份'); process.exit(1); }
ok(`找到 ${latest.name}（${backups.length} 份可用）`);
const ageH = (Date.now() - Date.parse(latest.createdAt)) / 3600000;
ok(`备份时间 ${latest.createdAt}，距今 ${ageH.toFixed(1)} 小时  ← 这就是 RPO`);
if (ageH > 48) bad(`备份已超过 48 小时（RPO 超标）：${ageH.toFixed(1)}h`);

head('校验备份完整性');
const work = fs.mkdtempSync(path.join(os.tmpdir(), 'blog-drill-'));
if (KEEP_WORK) console.log(`  · --keep-work：解压后的数据库与附件保留在 ${work}，确认后请手动删除（含私有数据）`);
process.once('exit', () => { if (!KEEP_WORK) fs.rmSync(work, { recursive: true, force: true }); });
const v = verifyBackup(latest.name, { dir: DIR, workDir: work });
if (v.ok) ok('sha256 与大小均与 manifest 一致（未被截断或改动）');
else { bad(`校验失败：${v.reasons.join('；')}`); process.exit(1); }
ok(`解压后 ${(v.bytes / 1024).toFixed(1)}KB → ${v.dbPath}`);

const recovered = restoreBackup(v, {
  dbFile: path.join(work, 'recovered', 'blog.db'),
  contentDir: path.join(work, 'recovered', 'content'),
  uploadsDir: path.join(work, 'recovered', 'uploads'),
  themesDir: path.join(work, 'recovered', 'themes'),
  // 演练目标是临时目录，写权限没问题，所以这里连主题一起还原，尽量贴近生产恢复后的状态。
  // 生产上的 npm run restore 默认不碰 themes/（见 backup.js 的 restoreBackup 注释）。
  withThemes: true,
});
v.dbPath = recovered.dbFile;
ok('数据库、Markdown、附件与主题已还原到独立空目录');

head('打开还原后的数据库');
const restored = open(v.dbPath);
const integrity = restored.prepare('PRAGMA integrity_check').get().integrity_check;
integrity === 'ok' ? ok('PRAGMA integrity_check = ok') : bad(`integrity_check = ${integrity}`);

const counted = (sql) => { try { return restored.prepare(sql).get().n; } catch { return null; } };
const counts = {
  posts: restored.prepare('SELECT COUNT(*) AS n FROM posts').get().n,
  comments: restored.prepare('SELECT COUNT(*) AS n FROM comments').get().n,
  published: restored.prepare("SELECT COUNT(*) AS n FROM posts WHERE draft = 0 AND kind IN ('post','note')").get().n,
  // 友圈表是 015/016 才有的：旧备份查不到，counted() 返回 null 就跳过比对，而非让整个演练以「表不存在」失败。
  feeds: counted('SELECT COUNT(*) AS n FROM feeds'),
  feedItems: counted('SELECT COUNT(*) AS n FROM feed_items'),
};
const m = latest.counts ?? {};
for (const k of ['posts', 'comments', 'feeds', 'feedItems']) {
  if (counts[k] == null) continue;
  if (m[k] != null && counts[k] !== m[k]) bad(`行数不符：${k} manifest=${m[k]} 实际=${counts[k]}`);
  else ok(`${k} = ${counts[k]}`);
}

const sample = restored.prepare("SELECT slug, title FROM posts WHERE draft = 0 AND kind = 'post' AND published_at <= ? ORDER BY published_at DESC LIMIT 1").get(new Date().toISOString());
if (sample) ok(`抽样文章：${sample.title}（/${sample.slug}/）`);

const schemaV = restored.prepare('SELECT MAX(version) AS v FROM schema_version').get().v;
ok(`schema 版本 ${schemaV}`);
close(restored);

head('用还原后的数据库启动服务（临时端口）');
const port = await new Promise((resolve) => {
  const srv = net.createServer();
  srv.listen(0, '127.0.0.1', () => { const p = srv.address().port; srv.close(() => resolve(p)); });
});

const bootStart = Date.now();
// DATA_DIR 必须一起隔离：它是写日志（.write-journal）与日志目录的根。不覆盖的话，子进程启动时的 recoverWrites()
// 会照着**真实 data/ 遗留的写日志**改写线上 content —— 演练就成了对生产的静默写入，与 README 承诺相反。
fs.mkdirSync(path.join(work, 'data'), { recursive: true });
const child = spawn(process.execPath, ['--no-warnings', 'server.js'], {
  cwd: process.cwd(),
  env: {
    ...process.env,
    DB_FILE: v.dbPath,
    DATA_DIR: path.join(work, 'data'),
    CONTENT_DIR: recovered.contentDir,
    UPLOADS_DIR: recovered.uploadsDir,
    THEMES_DIR: recovered.themesDir ?? path.join(work, 'recovered', 'themes'),
    BACKUP_ON_PUBLISH: 'false', BACKUP_REMOTE: '', BACKUP_HOOK: '',
    // 演练只验证启动/页面，不向外抓订阅、探友链、拉头像；慢于 20 秒也不会污染 RTO。
    FEED_REFRESH_MS: '0', LINK_CHECK_MS: '0', AVATAR_UPSTREAMS: '', WATCHDOG_INTERVAL_MS: '0',
    LOG_ROTATE_INTERVAL_MS: '0', BLOG_LOG_DIR: path.join(work, 'logs'),
    PORT: String(port),
    HOST: '127.0.0.1',
    SITE_URL: `http://127.0.0.1:${port}`,
    NODE_ENV: 'production',
  },
  stdio: ['ignore', 'pipe', 'pipe'],
});

let bootLog = '';
child.stdout.on('data', (d) => { bootLog += d.toString(); });
child.stderr.on('data', (d) => { bootLog += d.toString(); });

const base = `http://127.0.0.1:${port}`;
const waitUp = async (timeoutMs = 20000) => {
  const t = Date.now();
  while (Date.now() - t < timeoutMs) {
    if (child.exitCode != null) return false;
    try {
      const r = await fetch(`${base}/`, { signal: AbortSignal.timeout(1500) });
      if (r.status === 200) return true;
    } catch {  }
    await new Promise((r) => setTimeout(r, 200));
  }
  return false;
};

let up = false;
try {
  up = await waitUp();
  if (!up) bad(`服务在 20 秒内没有就绪。子进程日志：\n${bootLog.slice(-800)}`);
  else ok(`服务已就绪，冷启动到可服务 ${Date.now() - bootStart}ms`);

  if (up) {

    head('对还原后的站点打真实请求');
    const pageDb = open(v.dbPath);
    const TABLES = { posts: 'posts', comments: 'comments', feeds: 'feeds', feedItems: 'feed_items' };
    for (const [key, table] of Object.entries(TABLES)) {
      if (counts[key] == null) continue;      const actual = pageDb.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get().n;
      actual === counts[key] ? ok(`启动同步后 ${key} 行数保持 ${actual}`) : bad(`启动同步删除了 ${key} 记录`);
    }
    close(pageDb);
    for (const file of v.bundle.uploads) {
      const response = await fetch(base + '/uploads/' + file.path.split('/').map(encodeURIComponent).join('/'));
      const bytes = Buffer.from(await response.arrayBuffer());
      if (response.status !== 200 || !bytes.equals(Buffer.from(file.data, 'base64'))) bad(`附件还原失败：${file.path}`);
      else ok(`附件还原并可访问：${file.path}`);
    }

    const checks = [
      ['/', (r) => r.status === 200, '首页'],
      ...(sample ? [[`/p/${encodeURIComponent(sample.slug)}/`, (r) => r.status === 200, '文章详情']] : []),
      ['/feed.xml', (r) => r.status === 200, 'RSS'],
      ['/friends/', (r) => r.status === 200, '友圈'],
      ['/links/', (r) => r.status === 200, '友链'],
    ];
    for (const [p, assert, label] of checks) {
      const r = await fetch(base + p);
      const text = await r.text();
      if (assert(r) && text.length > 200) ok(`${label} ${p} → ${r.status}（${text.length} 字节）`);
      else bad(`${label} ${p} → ${r.status}（${text.length} 字节）`);
    }
    const feed = await (await fetch(`${base}/feed.xml`)).text();
    if (sample) feed.includes('<item>') ? ok('RSS 里有条目') : bad('RSS 是空的');
    const home = await (await fetch(`${base}/`)).text();

    const homeOk = home.includes('class="hero"')
      && home.includes(SITE.identity)
      && home.includes('href="/posts/"');
    homeOk ? ok('首页渲染出真实内容（首屏 + 身份 + 内容入口）') : bad('首页没有预期内容');
  }
} finally {
  child.kill('SIGTERM');
  await new Promise((r) => setTimeout(r, 400));
  if (child.exitCode == null) child.kill('SIGKILL');
  if (!KEEP_WORK) fs.rmSync(work, { recursive: true, force: true });
  else console.log(`  工作目录保留在 ${work}`);
}

const rto = ((Date.now() - started) / 1000).toFixed(1);
console.log('\n' + '═'.repeat(56));
console.log(`  RTO（本次演练总耗时）  ${rto}s`);
console.log(`  RPO（备份年龄）        ${ageH.toFixed(1)}h`);
if (fail.length) {
  console.log(`\n  ✗ 演练失败，${fail.length} 项不通过：`);
  for (const f of fail) console.log(`      · ${f}`);
  console.log('');
  process.exit(1);
}
console.log('\n  ✓ 演练全部通过 —— 这份备份确实可以拿来恢复\n');
process.exit(0);

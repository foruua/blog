#!/usr/bin/env node
import './_test-env.mjs';

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { open, close } from '../db/driver.js';
import { DB_FILE } from '../src/config.js';

const DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'blog-bkt-'));
const keep = [];
const { createChecker } = await import('./_check.mjs');
const { check, report } = createChecker();

check('T0 测试环境已断掉异地备份（防止 --delete 误伤生产）',
  !process.env.BACKUP_REMOTE && !process.env.BACKUP_HOOK,
  `BACKUP_REMOTE=${process.env.BACKUP_REMOTE ? '非空' : '空'} BACKUP_HOOK=${process.env.BACKUP_HOOK ? '非空' : '空'}`);

const run = (script, args = []) => spawnSync(
  process.execPath, ['--no-warnings', script, ...args],
  { encoding: 'utf8', env: { ...process.env, BACKUP_DIR: DIR } },
);

const files = () => fs.readdirSync(DIR).sort();
const names = () => files().filter((f) => f.endsWith('.db.gz')).map((f) => f.replace(/\.db\.gz$/, ''));
const mkBackup = (label) => run('scripts/backup.mjs', ['--dir', DIR, '--label', label]);

console.log('\n备份 / 恢复演练 测试');
console.log('─'.repeat(56));
console.log(`  临时备份目录 ${DIR}\n`);

{
  const r = mkBackup('test');
  check('T1a backup.mjs 退出码为 0', r.status === 0, `status=${r.status} ${(r.stderr || '').slice(0, 200)}`);
  const n = names();
  check('T1b 生成了一份备份', n.length === 1, JSON.stringify(n));
  if (n.length) keep.push(n[0]);
  const base = n[0];
  check('T1c 同时生成 .db.gz 与 .json', base && fs.existsSync(path.join(DIR, `${base}.db.gz`)) && fs.existsSync(path.join(DIR, `${base}.json`)));
  check('T1d 输出里报告了自检通过', (r.stdout || '').includes('自检通过'), (r.stdout || '').slice(-200));

  const mf = JSON.parse(fs.readFileSync(path.join(DIR, `${base}.json`), 'utf8'));
  check('T1e manifest 记录了 sha256 与大小', Boolean(mf.sha256) && mf.dbBytes > 0 && mf.gzBytes > 0);
  check('T1f manifest 记录了 SQLite 版本', Boolean(mf.sqliteVersion), mf.sqliteVersion);

  const db = open(DB_FILE);
  const livePosts = db.prepare('SELECT COUNT(*) AS n FROM posts').get().n;
  close(db);
  check('T1g manifest 行数与线上库一致', mf.counts.posts === livePosts, `manifest=${mf.counts.posts} 实际=${livePosts}`);

  const zlib = await import('node:zlib');
  const raw = zlib.gunzipSync(fs.readFileSync(path.join(DIR, `${base}.db.gz`)));
  const sha = crypto.createHash('sha256').update(raw).digest('hex');
  check('T1h manifest 的 sha256 与文件实际内容一致', sha === mf.sha256);
}

{
  const r = run('scripts/restore-drill.mjs', ['--dir', DIR]);
  check('T2a 演练在完好备份上退出码为 0', r.status === 0, `status=${r.status}`);
  const o = r.stdout || '';
  check('T2b 演练报告了 integrity_check', o.includes('integrity_check = ok'));
  check('T2c 演练真的启动了服务', /服务已就绪/.test(o), o.slice(-300));
  check('T2d 演练打了真实 HTTP 断言', o.includes('首页 / → 200') && o.includes('RSS'), '');
  check('T2e 演练输出了 RTO 与 RPO', o.includes('RTO') && o.includes('RPO'));
}

{
  const base = keep[0];
  const gz = path.join(DIR, `${base}.db.gz`);
  const mf = path.join(DIR, `${base}.json`);
  const good = fs.readFileSync(gz);
  const goodMf = fs.readFileSync(mf);

  {
    const bad = Buffer.from(good);
    bad[Math.floor(bad.length / 2)] ^= 0xff;
    fs.writeFileSync(gz, bad);
    const r = run('scripts/restore-drill.mjs', ['--dir', DIR]);
    check('T3 内容被篡改时演练失败', r.status !== 0, `status=${r.status}`);
    check('T3b 失败原因指向完整性', /sha256|无法解压/.test(r.stdout || ''), (r.stdout || '').slice(-200));
    fs.writeFileSync(gz, good);
  }

  {
    fs.writeFileSync(gz, good.subarray(0, Math.floor(good.length * 0.6)));
    const r = run('scripts/restore-drill.mjs', ['--dir', DIR]);
    check('T4 文件被截断时演练失败', r.status !== 0, `status=${r.status}`);
    fs.writeFileSync(gz, good);
  }

  {
    fs.rmSync(mf);
    const r = run('scripts/restore-drill.mjs', ['--dir', DIR]);
    check('T5 缺 manifest 时演练失败', r.status !== 0, `status=${r.status}`);
    fs.writeFileSync(mf, goodMf);
  }

  {
    const m = JSON.parse(goodMf);
    m.sha256 = 'f'.repeat(64);
    fs.writeFileSync(mf, JSON.stringify(m));
    const r = run('scripts/restore-drill.mjs', ['--dir', DIR]);
    check('T6 manifest 的 sha256 被篡改时演练失败', r.status !== 0, `status=${r.status}`);
    fs.writeFileSync(mf, goodMf);
  }

  {
    const r = run('scripts/restore-drill.mjs', ['--dir', DIR]);
    check('T7 恢复现场后演练重新通过', r.status === 0, `status=${r.status}`);
  }
}

{
  for (let i = 0; i < 3; i++) mkBackup(`retention-${i}`);
  const before = names().length;
  run('scripts/backup.mjs', ['--dir', DIR, '--keep', '2']);
  const after = names().length;
  check('T8a 超过保留份数会清理旧备份', after <= 2, `清理前 ${before} 份，--keep 2 后 ${after} 份`);
  check('T8b 清理后仍留有可用备份', after >= 1, `${after} 份`);
  const d = run('scripts/restore-drill.mjs', ['--dir', DIR]);
  check('T8c 清理后演练依然通过', d.status === 0, `status=${d.status}`);
}

{
  const r = run('scripts/backup.mjs', ['--list', '--dir', DIR]);
  check('T9 --list 退出码为 0 并列出备份', r.status === 0 && (r.stdout || '').includes('共'), (r.stdout || '').slice(0, 200));
}

{
  const empty = fs.mkdtempSync(path.join(os.tmpdir(), 'blog-empty-'));
  const r = run('scripts/restore-drill.mjs', ['--dir', empty]);
  check('T10 没有备份时演练失败（不会假通过）', r.status !== 0, `status=${r.status}`);
  fs.rmSync(empty, { recursive: true, force: true });
}

{
  // T11/T12：服务启动时的「欠账补做」。背景：`setInterval` 从本次启动开始计时，只要「启动后不到一个间隔又重启」，自动备份就永远排不上
  // （2026-10-08 线上真发生过：最新一份停在 06:11，到 16:59 已 10.8 小时）。夹具全隔离（自有 DATA / CONTENT / UPLOADS / BACKUP 目录），
  // 所以单跑 `npm run test:backup` 也不会去抢线上那套维护锁。
  const work = fs.mkdtempSync(path.join(os.tmpdir(), 'blog-catchup-'));
  const bdir = path.join(work, 'backups');
  fs.mkdirSync(bdir, { recursive: true });
  fs.mkdirSync(path.join(work, 'content', 'posts'), { recursive: true });
  fs.mkdirSync(path.join(work, 'content', 'notes'), { recursive: true });
  fs.mkdirSync(path.join(work, 'content', 'pages'), { recursive: true });
  fs.mkdirSync(path.join(work, 'uploads'), { recursive: true });
  fs.writeFileSync(path.join(work, 'content', 'posts', 'catchup-fixture.md'),
    '---\ntitle: 补备份夹具\nslug: catchup-fixture\ndate: 2025-01-01\n---\n正文。\n');
  const env = {
    DATA_DIR: path.join(work, 'data'),
    DB_FILE: path.join(work, 'data', 'blog.db'),
    CONTENT_DIR: path.join(work, 'content'),
    UPLOADS_DIR: path.join(work, 'uploads'),
    BACKUP_DIR: bdir,
    ADMIN_PASSWORD: 'disposable-test-password',
    BACKUP_ON_PUBLISH: 'true',
    // 间隔下限就是 60s（`Math.max(60000, …)`），而补做的延时 = 间隔/20 再夹到 5s，所以等 5s 就够。
    BACKUP_INTERVAL_MS: '60000',
  };
  const countBk = () => fs.readdirSync(bdir).filter((f) => f.endsWith('.db.gz')).length;
  const { startServer } = await import('./_server.mjs');

  const s1 = await startServer({ env });
  try {
    let n = countBk();
    for (let i = 0; i < 40 && !s1.log().includes('"backup.completed"') && !s1.log().includes('"backup.failed"'); i++) {
      await new Promise((r) => setTimeout(r, 500));
      n = countBk();
    }
    check('T11a 启动时欠账会补做一次备份', n === 1, `20s 内备份数=${n}`);
    check('T11b 日志里留了 backup.catchup', s1.log().includes('"backup.catchup"'), s1.log().slice(-300));
    check('T11c 备份真的跑完并自检（backup.completed）', s1.log().includes('"backup.completed"'), s1.log().slice(-300));
  } finally { await s1.stop(); }

  // T12：刚备份过就不该再补 —— 否则每次重启都白跑一趟（备份还会短暂接管写队列）
  const before = countBk();
  const s2 = await startServer({ env });
  try {
    await new Promise((r) => setTimeout(r, 6000));
    check('T12a 不欠账时启动不再补做', countBk() === before, `启动前后 ${before} → ${countBk()} 份`);
    check('T12b 此时日志里没有 backup.catchup', !s2.log().includes('"backup.catchup"'), s2.log().slice(-300));
  } finally { await s2.stop(); }
  fs.rmSync(work, { recursive: true, force: true });
}

fs.rmSync(DIR, { recursive: true, force: true });

process.exit(report() ? 1 : 0);

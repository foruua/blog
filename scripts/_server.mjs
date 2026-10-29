import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import net from 'node:net';
import { spawn } from 'node:child_process';
import { DatabaseSync } from 'node:sqlite';
import { once } from 'node:events';
import { hasFixtures } from './_fixtures.mjs';

export function freePort() {
  return new Promise((resolve, reject) => {
    const srv = net.createServer();
    srv.on('error', reject);
    srv.listen(0, '127.0.0.1', () => {
      const p = srv.address().port;
      srv.close(() => resolve(p));
    });
  });
}

export function cloneDb(src, clearTables = ['comments', 'mail_outbox']) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'blog-testdb-'));
  const dst = path.join(dir, 'blog.db');
  const db = new DatabaseSync(src, { readOnly: true });
  try { db.exec(`VACUUM INTO '${dst.replace(/'/g, "''")}'`); }
  finally { db.close(); }

  if (clearTables.length) {
    const t = new DatabaseSync(dst);
    for (const name of clearTables) {
      try { t.exec(`DELETE FROM ${name}`); } catch { }
    }
    t.close();
  }
  return { dir, dst };
}

async function startServerOnce({ env = {}, isolateDb, timeoutMs = 20000 } = {}) {
  const port = await freePort();
  const base = `http://127.0.0.1:${port}`;

  // 先合并调用方 env，再决定克隆哪个库；否则 isolateDb 会克隆 process.env 的库、
  // 子进程却用 env.DB_FILE 的另一个库（测试实际读写真实数据）。
  const childEnv = {
    ...process.env,
    PORT: String(port),
    HOST: '127.0.0.1',
    SITE_URL: base,
    NODE_ENV: 'production', BACKUP_ON_PUBLISH: 'false',
    // 测试一律发源码：一批用例按可读格式断言线上 CSS/JS。想验精简请显式传 SERVE_MINIFIED: '1'。
    SERVE_MINIFIED: '0',
    // 测试默认静默所有后台轮次（此前各套件各自传一遍，改一处忘一处）；要测后台任务的套件显式覆盖。
    FEED_REFRESH_MS: '0', LINK_CHECK_MS: '0', WATCHDOG_INTERVAL_MS: '0',
    LOG_ROTATE_INTERVAL_MS: '0', AVATAR_UPSTREAMS: '', BACKUP_REMOTE: '', BACKUP_HOOK: '',
    ...env,
  };
  // dbFile 一律绝对路径：相对 "data/blog.db" 就是真实库，当临时副本写会改掉用户数据（ui-audit 出过事故）。
  childEnv.DB_FILE = path.resolve(childEnv.DB_FILE ?? 'data/blog.db');
  // 默认要不要再克隆一份：已经在 fixture 临时根里（_fixtures 给每个套件建的私有目录）就不必克隆 ——
  // 再克隆一次还会 DELETE comments，把 fixture 预置的评论静默丢掉。只有直接对着 data/blog.db 跑
  // （手工执行某个套件、没走 _test-env）才需要副本。需要「干净评论表」的套件显式传 true。
  const isolate = isolateDb ?? !hasFixtures();
  let tmp = null;
  // 源库还不存在（全新 DATA_DIR）时没什么可克隆的：让服务自己建库并迁移，
  // 别去 VACUUM 一个不存在的文件（以前会直接抛 unable to open database file）。
  if (isolate && fs.existsSync(childEnv.DB_FILE)) {
    tmp = cloneDb(childEnv.DB_FILE);
    childEnv.DB_FILE = tmp.dst;
  }
  const dbFile = childEnv.DB_FILE;
  // 临时库的清理必须与「子进程有没有提前退出」无关：测试失败路径里 process.exit 很常见。
  const dropTmp = () => { if (tmp) { fs.rmSync(tmp.dir, { recursive: true, force: true }); tmp = null; } };

  const child = spawn(process.execPath, ['--no-warnings', 'server.js'], {
    cwd: process.cwd(),
    env: childEnv,
    stdio: ['ignore', 'pipe', 'pipe'],
  });

  let buf = '';
  let spawnError;
  child.on('error', (error) => { spawnError = error; });
  const collect = (d) => { buf = (buf + d.toString()).slice(-65536); };
  child.stdout.on('data', collect);
  child.stderr.on('data', collect);
  const running = () => child.exitCode === null && child.signalCode === null && !spawnError;
  const terminate = async (signal) => {
    if (!running()) return;
    const exited = once(child, 'exit');
    child.kill(signal);
    await exited;
  };

  const deadline = Date.now() + timeoutMs;
  let ready = false;
  while (Date.now() < deadline) {
    if (!running()) break;
    try {
      const r = await fetch(`${base}/`, { signal: AbortSignal.timeout(1200) });
      if (r.status === 200) { ready = true; break; }
    } catch { }
    await new Promise((r) => setTimeout(r, 150));
  }

  if (!ready) {
    await terminate('SIGKILL');
    dropTmp();
    if (spawnError) throw spawnError;
    // 最常见失败原因是本机已有实例占着维护锁；翻译成一句能照做的提示，别甩原始堆栈。
    if (/\.blog-lock|资源正在使用|资源已被本进程占用/.test(buf)) {
      throw new Error(
        '受控服务起不来：维护锁被占用 —— 本机已经有一个实例在运行（多半是你 npm start 起的服务）。\n'
        + '  处理方式二选一：先停掉正在运行的服务；或者用 `npm test`（它会自建隔离的 DATA_DIR/CONTENT_DIR/UPLOADS_DIR）。\n'

      );
    }
    throw new Error(`受控服务在 ${timeoutMs}ms 内没有就绪：\n${buf.slice(-1500)}`);
  }

  // 收尾：先确认子进程没了再删临时库。注意不能靠 `if (child.exitCode != null) return;` 判断 ——
  // 子进程自己退出（测试里的 process.exit）时会跳过清理，$TMPDIR 就堆一串 blog-testdb-*。
  const stop = async () => {
    if (running()) {
      child.kill('SIGTERM');
      for (let i = 0; i < 20 && running(); i++) await new Promise((r) => setTimeout(r, 100));
      await terminate('SIGKILL');
    }
    dropTmp();
    process.off('exit', onExit);
    process.off('SIGINT', onSignal);
    process.off('SIGTERM', onSignal);
  };

  // 信号处理：杀掉子进程 + 摘掉监听后重新抛出信号 —— 否则会顶掉 Node 默认的「收到信号就退出」，Ctrl-C 不掉。
  const killChild = () => { try { child.kill('SIGKILL'); } catch { } };
  // 进程退出时也要删临时库：套件在 stop() 之前 process.exit / 抛错都会走到这里，否则 $TMPDIR 堆一串 blog-testdb-*。
  const onExit = () => { killChild(); dropTmp(); };
  const onSignal = (signal) => {
    killChild();
    process.off(signal, onSignal);
    process.kill(process.pid, signal);
  };
  process.on('exit', onExit);
  process.on('SIGINT', onSignal);
  process.on('SIGTERM', onSignal);

  return { base, port, dbFile, child, log: () => buf, stop };
}

// freePort() 先监听再关闭，和子进程真正绑定之间有一个极小窗口；并发套件多时可能撞端口。
// 只对「端口被抢」失败重试，其他启动错误（维护锁、语法错）原样抛出。
export async function startServer(options = {}) {
  for (let attempt = 0; ; attempt++) {
    try { return await startServerOnce(options); }
    catch (error) {
      if (attempt >= 2 || !/EADDRINUSE|address already in use/i.test(String(error?.message ?? error))) throw error;
    }
  }
}

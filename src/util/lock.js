import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { execFileSync } from 'node:child_process';

// 进程启动时间（近似）：仅用于识别 PID 复用，不参与业务。ps 的 lstart 只到秒，比较时留 5 秒容差。
const PROCESS_STARTED_AT = Date.now() - process.uptime() * 1000;
function processStartedAt(pid) {
  try {
    const out = execFileSync('ps', ['-o', 'lstart=', '-p', String(pid)], {
      encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'], timeout: 2000,
      env: { ...process.env, LC_ALL: 'C', LANG: 'C' },
    }).trim();
    const started = Date.parse(out);
    return Number.isFinite(started) ? started : null;
  } catch { return null; }
}

const owned = new Map();
// 进程在「创建 .reclaim」与「finally 删除」之间被 SIGKILL/断电时，reclaim 会永久残留。
// 超过这个时间仍存在就视为上次恢复留下的垃圾：锁本身已确认陈旧，可以安全清掉重试。
const STALE_RECLAIM_MS = 5 * 60 * 1000;
// Locks live beside each resource, so replacing the resource cannot remove its lock.
export function acquireMaintenanceLock(resources, label = 'maintenance') {
  const releases = [];
  try {
    for (const resource of [...new Set(resources.map((p) => path.resolve(p)))].sort()) {
      const dir = resource + '.blog-lock';
      if (owned.has(dir)) throw new Error(`资源已被本进程占用：${resource}`);
      fs.mkdirSync(path.dirname(dir), { recursive: true });
      for (let attempt = 0; ; attempt++) {
        try { fs.mkdirSync(dir, { mode: 0o700 }); break; }
        catch (err) {
          if (err.code !== 'EEXIST') throw err;
          const inspect = () => {
            let stat;
            try { stat = fs.statSync(dir); }
            catch (e) { if (e.code === 'ENOENT') return null; throw e; }   // 目录刚被别的进程回收
            let raw = null, owner = null;
            try { raw = fs.readFileSync(path.join(dir, 'owner.json'), 'utf8'); owner = JSON.parse(raw); } catch { /* 未完成或损坏的锁 */ }
            let alive = Date.now() - stat.mtimeMs < 60000;
            if (Number.isInteger(owner?.pid) && owner.pid > 0) {
              alive = true;
              try { process.kill(owner.pid, 0); } catch (e) { if (e.code === 'ESRCH') alive = false; }
              // PID 活着不代表还是原来那个进程：重启/崩溃后 PID 可能被复用，把别人的锁当成自己的会永久卡死维护操作。
              if (alive && Number.isFinite(owner.startedAt)) {
                const started = processStartedAt(owner.pid);
                if (started != null && Math.abs(started - owner.startedAt) > 5000) alive = false;
              }
            }
            return { stat, raw, owner, alive };
          };
          const previous = inspect();
          // 拿到 EEXIST 之后、stat 之前锁目录被回收：重试一次 mkdir，而不是当成获取失败。
          if (!previous) continue;
          const { owner, alive } = previous;
          if (alive || attempt > 0) throw new Error(`资源正在使用（${owner?.label ?? '锁未完成'}），请先停止占用进程：${resource}`, { cause: err });
          const reclaim = dir + '.reclaim';
          try { fs.mkdirSync(reclaim, { mode: 0o700 }); }
          catch (e) {
            if (e.code !== 'EEXIST') throw new Error(`资源锁正在恢复，请稍后重试：${resource}`, { cause: e });
            // 上一次恢复进程在清理完锁之前被杀：reclaim 目录会永远留着。
            // 锁本身已经确认不存活，reclaim 又超过保鲜期，就可以安全回收后重新走一遍。
            let stale = false;
            try {
              stale = Date.now() - fs.statSync(reclaim).mtimeMs > STALE_RECLAIM_MS;
            } catch (statError) {
              if (statError.code !== 'ENOENT') throw new Error(`资源锁正在恢复，请稍后重试：${resource}`, { cause: statError });
              stale = true;
            }
            if (!stale) throw new Error(`资源锁正在恢复，请稍后重试：${resource}`, { cause: e });
            try { fs.rmSync(reclaim, { recursive: true, force: true }); }
            catch { throw new Error(`资源锁正在恢复，请稍后重试：${resource}`, { cause: e }); }
            attempt = -1;   // for 循环递增后回到第 0 次重试
            continue;
          }
          try {
            const current = inspect();
            if (!current || current.alive || current.raw !== previous.raw
                || current.stat.dev !== previous.stat.dev || current.stat.ino !== previous.stat.ino
                || current.stat.mtimeMs !== previous.stat.mtimeMs) {
              throw new Error(`资源锁已变更，请稍后重试：${resource}`, { cause: err });
            }
            fs.rmSync(dir, { recursive: true });
          } finally { fs.rmSync(reclaim, { recursive: true, force: true }); }
        }
      }
      const token = crypto.randomUUID();
      try { fs.writeFileSync(path.join(dir, 'owner.json'), JSON.stringify({ pid: process.pid, startedAt: PROCESS_STARTED_AT, token, label }), { mode: 0o600 }); }
      catch (e) { fs.rmSync(dir, { recursive: true, force: true }); throw e; }
      owned.set(dir, token);
      releases.push(() => {
        if (owned.get(dir) !== token) return;
        owned.delete(dir);
        fs.rmSync(dir, { recursive: true, force: true });
      });
    }
  } catch (e) { releases.reverse().forEach((release) => release()); throw e; }
  let released = false;
  const release = () => { if (!released) { released = true; releases.reverse().forEach((fn) => fn()); } };
  process.once('exit', release);
  return () => { process.off('exit', release); release(); };
}

export function createMutationQueue() {
  let tail = Promise.resolve();
  return (fn) => {
    const result = tail.then(fn);
    tail = result.catch(() => {});
    return result;
  };
}

// 暂停后台任务的同步落库阶段；网络抓取不占内容写队列。
export function createWriteBarrier() {
  let pending = null, resume = null;
  return {
    wait: () => pending ?? Promise.resolve(),
    run: async (write) => {
      while (pending) await pending;
      // 检查屏障和同步写入在同一任务内完成，期间不能插入 pause。
      return write();
    },
    pause: () => {
      if (pending) throw new Error('写屏障已经启用');
      pending = new Promise((resolve) => { resume = resolve; });
      return () => { const done = resume; pending = null; resume = null; done?.(); };
    },
  };
}

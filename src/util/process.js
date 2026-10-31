import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
function runCommand(command, args, { timeoutMs = 60000 } = {}) {
  return new Promise((resolve) => {
    const child = spawn(command, args, { detached: process.platform !== 'win32', stdio: ['ignore', 'ignore', 'pipe'],
      env: { ...process.env, GIT_TERMINAL_PROMPT: '0', GIT_ASKPASS: 'true', GIT_EDITOR: 'true' } });
    let error = ''; let timedOut = false;
    child.stderr.on('data', (data) => { error = (error + data.toString()).slice(-2048); });
    const timer = setTimeout(() => {
      timedOut = true;
      try { process.kill(process.platform === 'win32' ? child.pid : -child.pid, 'SIGKILL'); } catch { child.kill('SIGKILL'); }
    }, timeoutMs); timer.unref?.();
    child.once('error', (/** @type {any} */ e) => { clearTimeout(timer); resolve({ ok: false, reason: e.code }); });
    child.once('exit', (code, signal) => { clearTimeout(timer); resolve({ ok: code === 0 && !signal && !timedOut,
      reason: timedOut ? 'timeout' : signal || error.trim().split('\n')[0] || String(code) }); });
  });
}

// 备份目录里除了备份族，还可能躺着恢复过程留下的目录；异地只该拿到真正的备份。
const MIRROR_EXCLUDES = ['.blog-restore-*', 'pre-restore-raw-*', '*.pre-restore-*', '.*.tmp', '.*.tmp.db'];

export async function uploadBackup(result, {
  remote = process.env.BACKUP_REMOTE ?? '',
  hook = process.env.BACKUP_HOOK ?? '',
} = {}) {
  // 测试夹具会把 BLOG_TEST_ROOT 指向临时目录；即使环境变量漏关，也绝不把临时备份镜像到真实异地目录。
  if (process.env.BLOG_TEST_ROOT) return { ok: true, skipped: '测试环境禁止异地备份' };
  const files = [result.gzFile, result.assetsFile, result.manifestFile];
  // 不用 --protect-args：macOS 自带的 openrsync 不认这个选项，而 launchd 下 PATH 就是 /usr/bin。
  // 备份文件名由 snapshot() 生成（时间戳 + 短哈希，不含空格/通配符），远端目录来自 .env，参数不会被 shell 二次拆分。
  if (remote) {
    const dir = path.dirname(result.gzFile);
    const target = remote.replace(/\/$/, '');
    // 资产包自 033 起按内容哈希命名并被多份备份共享，异地必须与本地**同构**：本地按引用计数回收，
    // 异地照抄这一份，才不会出现「删了还被引用」或「留着一堆指向已删资产包的旧备份」。
    // 代价是异地也只剩 keep 份；但按 mtime 删的旧策略在共享资产包下必然把还能用的备份删坏。
    const hasComplete = fs.readdirSync(dir).some((f) => f.endsWith('.db.gz')) && result.complete !== false;
    // --delay-updates：数据先写远端临时名，传输完成后再统一改名；中断不会留下「新清单 + 旧数据」的半成品镜像。
    const args = ['-a', '--delay-updates', ...(hasComplete ? ['--delete'] : []), '--timeout=30',
      ...MIRROR_EXCLUDES.flatMap((pattern) => ['--exclude', pattern]),
      '-e', 'ssh -o BatchMode=yes -o ConnectTimeout=10', '--', `${dir}/`, `${target}/`];
    // 33MB 级的上传在慢链路上会超过默认的 60 秒；被 SIGKILL 掉还会让备份看起来"失败"。
    return runCommand('rsync', args, { timeoutMs: 10 * 60 * 1000 });
  }
  if (hook) {
    for (const file of files) {
      const quoted = "'" + file.replace(/'/g, "'\\''") + "'";
      const out = await runCommand('sh', ['-c', hook.replace(/\{\}/g, () => quoted)]);
      if (!out.ok) return out;
    }
    return { ok: true };
  }
  return { ok: true, skipped: '未配置异地备份' };
}

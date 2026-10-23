import { spawn } from 'node:child_process';
import { TEST_ENV_SCRUB } from './_fixtures.mjs';

// POSIX 子进程继承套件的进程组，超时或取消时一并结束服务器子进程。
export function runSuite(suite, { cwd, timeoutMs = 10 * 60 * 1000, env = process.env, stdio = 'inherit', log = console.error } = {}) {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, ['--no-warnings', `scripts/${suite}.mjs`], {
      cwd, env: {
        // 先洗掉开发机上可能导出的真实邮件/监控/日志配置，再让调用方显式传入的值覆盖。
        ...TEST_ENV_SCRUB, ...env, BLOG_TEST_ROOT: '',
        // 套件即使没走 _fixtures（或父进程显式传了生产值），也不允许把临时备份同步到真实异地目录。
        BACKUP_REMOTE: '', BACKUP_HOOK: '',
      }, stdio, detached: process.platform !== 'win32',
    });
    let expired = false;
    const killTree = () => {
      try {
        if (process.platform === 'win32') spawn('taskkill', ['/PID', String(child.pid), '/T', '/F'], { stdio: 'ignore' }).on('error', () => child.kill('SIGKILL'));
        else process.kill(-child.pid, 'SIGKILL');
      } catch { child.kill('SIGKILL'); }
    };
    const onSignal = (signal) => {
      killTree();
      process.off(signal, onSignal);
      process.kill(process.pid, signal);
    };
    const timer = setTimeout(() => {
      expired = true;
      log(`\n  ✗ ${suite} 超时，已结束套件及其子进程`);
      killTree();
    }, timeoutMs);
    const cleanup = () => {
      clearTimeout(timer);
      process.off('exit', killTree);
      process.off('SIGINT', onSignal);
      process.off('SIGTERM', onSignal);
    };
    process.once('exit', killTree);
    process.on('SIGINT', onSignal);
    process.on('SIGTERM', onSignal);
    child.once('error', (error) => { cleanup(); log(`✗ ${suite} 启动失败：${error.code}`); resolve(1); });
    child.once('exit', (code) => { killTree(); cleanup(); resolve(expired ? 1 : code ?? 1); });
  });
}

// 站点自监控：探自己的公网地址 + 本地备份新鲜度，状态翻转时发一封邮件。
//
// 为什么放在进程内而不是只靠外部定时任务：真正出过事的是 Cloudflare Tunnel 断开——服务进程活得好好的，
// 但公网 530。外部探针能发现，可一旦这台机器上没有任何外部定时器（launchd 装不上、cron 被禁用），
// 就永远没人知道。进程内探自己的公网 URL 恰好覆盖这个盲区：进程还活着才探得动，而隧道断了它照样探得动。
// 进程本身挂掉由 launchd 的 KeepAlive 兜底（10 秒内拉起），恢复后看门狗会继续工作。

const DEFAULT_MAX_AGE_SEC = 48 * 3600;

// 单次 HTTP 探测。token 只用来拿备份字段；拿不到备份字段是「没授权」，不是「没备份」，两者不能混。
export async function probe({ url, token = process.env.MONITOR_TOKEN, maxAgeSec = DEFAULT_MAX_AGE_SEC, requireOffsite = false, timeoutMs = 10000 }) {
  try {
    const headers = token ? { 'x-monitor-token': token } : {};
    const response = await fetch(url, { headers, signal: AbortSignal.timeout(timeoutMs), redirect: 'error' });
    if (!response.ok) return { ok: false, reason: `HTTP ${response.status}` };
    const health = await response.json();
    if (health.ok !== true) return { ok: false, reason: '站点自检失败' };
    const age = health.latestRecoverableBackupAgeSec;
    if (age === undefined) return { ok: false, reason: '读不到备份状态：MONITOR_TOKEN 未配置或与服务端不一致' };
    if (!Number.isFinite(age) || age < 0) return { ok: false, reason: '没有可完整恢复的备份' };
    if (age > maxAgeSec) return { ok: false, reason: '可恢复备份已过期' };
    if (requireOffsite) {
      const offsite = health.offsiteBackup;
      const elapsed = (Date.now() - Date.parse(offsite?.checkedAt)) / 1000;
      if (offsite?.state !== 'ok' || !Number.isFinite(elapsed) || elapsed > maxAgeSec || elapsed < -60)
        return { ok: false, reason: '异地备份未成功或已过期' };
    }
    return { ok: true, reason: '站点和可恢复备份正常' };
  } catch { return { ok: false, reason: '探测连接、超时或响应解析失败' }; }
}

// 连续失败多少次才告警：一次抖动（隧道重连、部署重启）不值得半夜发信。
const FAIL_THRESHOLD = 2;

export function createWatchdog({
  url, token = process.env.MONITOR_TOKEN, intervalMs, maxAgeSec = DEFAULT_MAX_AGE_SEC,
  requireOffsite = false, checkLocal = null, check = null, notify, log = () => {}, now = Date.now,
}) {
  // 状态只有「已经告警过 / 没有」两种。以「是否已通知」而不是「上次探测结果」为基准：
  // 否则一次失败后恢复正常会被当成「故障→恢复」的翻转，白发一封恢复信。
  let alerted = false;
  let failStreak = 0;
  let timer = null;
  let running = false;

  async function runCheck() {
    // 本地能直接读库，备份年龄不必绕一圈 HTTP；公网可达性才必须走网络。
    const local = checkLocal ? checkLocal({ maxAgeSec, requireOffsite, now }) : null;
    if (local && !local.ok) return local;
    if (!url) return { ok: true, reason: '未配置公网地址，仅检查本地备份' };
    return probe({ url, token, maxAgeSec, requireOffsite });
  }

  async function tick() {
    if (running) return;
    running = true;
    try {
      let result;
      try {
        result = await (check ?? runCheck)();
      } catch (error) {
        // 本地备份目录不可读之类的问题会从 checkLocal 抛出来；不能让 setInterval 的 Promise rejection
        // 把进程直接带走（Node 默认会），把它当作一次失败探测，连续两次仍然告警。
        result = { ok: false, reason: '监控自检异常' };
        log(JSON.stringify({ event: 'watchdog.error', code: error?.code ?? 'INTERNAL' }));
      }
      if (result.ok) {
        failStreak = 0;
        if (alerted) {
          alerted = false;
          log(JSON.stringify({ event: 'watchdog.recovered', reason: result.reason }));
          try { await notify(result, { recovered: true }); }
          catch (error) { log(JSON.stringify({ event: 'watchdog.notify-failed', code: error?.code ?? 'INTERNAL' })); }
        }
        return;
      }

      failStreak++;
      if (!alerted && failStreak >= FAIL_THRESHOLD) {
        alerted = true;
        log(JSON.stringify({ event: 'watchdog.failed', reason: result.reason, streak: failStreak }));
        try { await notify(result, { recovered: false }); }
        catch (error) {
          // 告警邮件没发出去就不能算“已通知”，否则这次故障永远不会再提醒。
          alerted = false;
          log(JSON.stringify({ event: 'watchdog.notify-failed', code: error?.code ?? 'INTERNAL' }));
        }
        return;
      }
      log(JSON.stringify({ event: 'watchdog.probe-failed', reason: result.reason, streak: failStreak }));
    } finally { running = false; }
  }

  return {
    start() {
      if (timer || !(intervalMs > 0)) return;
      // 启动后先等一轮：部署重启期间站点短暂不可用是常态，别把自己吓一跳。
      timer = setInterval(() => { void tick(); }, intervalMs);
      timer.unref?.();
    },
    stop() { if (timer) { clearInterval(timer); timer = null; } },
    tick,
    state: () => ({ failStreak, alerted }),
  };
}

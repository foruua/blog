import fs from 'node:fs';
import path from 'node:path';

// 站点自监控：探自己的公网地址 + 本地备份新鲜度，状态翻转时发一封邮件。
//
// 为什么放在进程内而不是只靠外部定时任务：真正出过事的是公网入口断开——服务进程活得好好的，
// 但反向代理或 DNS 出问题导致公网不可达。外部探针能发现，可一旦这台机器上没有任何外部定时器，
// 就永远没人知道。进程内探自己的公网 URL 恰好覆盖这个盲区：进程还活着才探得动，而公网入口断了它照样探得动。
// 进程本身挂掉由 systemd 的 Restart 兜底（3 秒后拉起），恢复后看门狗会继续工作。

const DEFAULT_MAX_AGE_SEC = 48 * 3600;

// 生产机只负责本地备份；异地副本由另一台机器 pull 到自己的目录。
// 那台机器上的探针直接看目录里最新清单的 mtime，不再依赖生产机自报的异地状态。
export function offsiteBackupAge(dir, { now = Date.now } = {}) {
  let newest = 0;
  let names;
  try {
    names = fs.readdirSync(dir);
  } catch (error) {
    return { ok: false, reason: `异地备份目录不可读：${error.code ?? 'ERROR'}` };
  }
  for (const name of names) {
    if (!name.endsWith('.json')) continue;
    try {
      const stat = fs.statSync(path.join(dir, name));
      if (stat.mtimeMs > newest) newest = stat.mtimeMs;
    } catch { /* 拉取中途消失的文件，忽略 */ }
  }
  if (!newest) return { ok: false, reason: '异地备份目录为空' };
  return { ok: true, ageSec: Math.max(0, Math.round((now() - newest) / 1000)) };
}

// 通知去重指纹：只收「状态」，不收每次都变的测量值。
// offsiteAgeSec 每 5 分钟都会变；把它（或结果里的其它秒数、小时数）算进指纹，
// 每一拍都会被判成「状态翻转」，恢复信就会每 5 分钟发一封。数字统一抹掉，
// 这样失败类别变了（HTTP 500 → 备份过期）仍会提醒，只是同一类故障内部的数值波动不重复打扰。
export function stateFingerprint(url, result) {
  return JSON.stringify({
    url: url ?? null,
    ok: result?.ok === true,
    reason: String(result?.reason ?? '').replace(/\d+/g, '#'),
  });
}

// 拉取进行中：pull-offsite.sh 在目标目录里用 .pull-lock 目录锁。rsync --delete 会先删掉旧清单、
// 再落新清单，中间那几秒目录里可能一个 *.json 都没有 —— 这时判「异地备份目录为空」是假警报。
// 锁超过 2 小时按残留处理（脚本下一轮会自己清掉），照常判新鲜度，不让坏锁把告警永久遮住。
const OFFSITE_PULL_LOCK = '.pull-lock';
// 注意默认参数是函数本身而不是它的返回值：写成 `now = Date.now()` 会先求出数字，
// 函数体再 now() 就抛 TypeError，被下面的 catch 吞掉后永远返回 false —— 生产上拉取锁等于不存在。
export function pullInProgress(dir, now = Date.now) {
  try {
    const stat = fs.statSync(path.join(dir, OFFSITE_PULL_LOCK));
    return now() - stat.mtimeMs < 2 * 3600e3;
  } catch { return false; }
}

// 异地备份新鲜度判定（唯一口径）：server.js 的 localHealth 与下面的 probe 共用，
// 避免同一段校验写两份后各自漂移。elapsed < -60 容忍轻微时钟偏移。
export function offsiteStale(offsite, maxAgeSec, now = Date.now()) {
  const elapsed = (now - Date.parse(offsite?.checkedAt)) / 1000;
  return offsite?.state !== 'ok' || !Number.isFinite(elapsed) || elapsed > maxAgeSec || elapsed < -60;
}

// 单次 HTTP 探测。token 只用来拿备份字段；拿不到备份字段是「没授权」，不是「没备份」，两者不能混。
export async function probe({ url, token = process.env.MONITOR_TOKEN, maxAgeSec = DEFAULT_MAX_AGE_SEC, requireOffsite = false, timeoutMs = 10000 }) {
  try {
    const headers = token ? { 'x-monitor-token': token } : {};
    const response = await fetch(url, { headers, signal: AbortSignal.timeout(timeoutMs), redirect: 'error' });
    // 503 也带健康原因（磁盘/WAL/备份卡住）；先读 body 再判断 status，别把可执行的诊断丢成裸 HTTP 状态码。
    let health = null;
    try { health = await response.json(); } catch { /* 非 JSON 响应按状态码处理 */ }
    if (!response.ok) {
      const reason = health?.healthReason ? `HTTP ${response.status}：${health.healthReason}` : `HTTP ${response.status}`;
      return { ok: false, reason };
    }
    if (!health || health.ok !== true) {
      return { ok: false, reason: health?.healthReason ? `站点自检失败：${health.healthReason}` : '站点自检失败' };
    }
    const age = health.latestRecoverableBackupAgeSec;
    if (age === undefined) return { ok: false, reason: '读不到备份状态：MONITOR_TOKEN 未配置或与服务端不一致' };
    if (!Number.isFinite(age) || age < 0) return { ok: false, reason: '没有可完整恢复的备份' };
    if (age > maxAgeSec) return { ok: false, reason: '可恢复备份已过期' };
    if (requireOffsite && offsiteStale(health.offsiteBackup, maxAgeSec))
      return { ok: false, reason: '异地备份未成功或已过期' };
    return { ok: true, reason: '站点和可恢复备份正常' };
  } catch { return { ok: false, reason: '探测连接、超时或响应解析失败' }; }
}

// 连续失败多少次才告警：一次抖动（反向代理重连、部署重启）不值得半夜发信。
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
  let active = null;

  async function runCheck() {
    // 本地能直接读库，备份年龄不必绕一圈 HTTP；公网可达性才必须走网络。
    const local = checkLocal ? checkLocal({ maxAgeSec, requireOffsite, now }) : null;
    if (local && !local.ok) return local;
    if (!url) return { ok: true, reason: '未配置公网地址，仅检查本地备份' };
    return probe({ url, token, maxAgeSec, requireOffsite });
  }

  function tick() {
    if (active) return active;
    active = (async () => {
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
    })().finally(() => { active = null; });
    return active;
  }

  return {
    start() {
      if (timer || !(intervalMs > 0)) return;
      // 启动后先等一轮：部署重启期间站点短暂不可用是常态，别把自己吓一跳。
      timer = setInterval(() => { void tick(); }, intervalMs);
      timer.unref?.();
    },
    stop() { if (timer) { clearInterval(timer); timer = null; } },
    drain: () => active ?? Promise.resolve(),
    tick,
    state: () => ({ failStreak, alerted }),
  };
}

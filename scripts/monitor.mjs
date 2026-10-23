import fs from 'node:fs';
import path from 'node:path';
import { atomicWrite } from '../src/util/files.js';
import { DATA_DIR } from '../src/config.js';
import { probe, offsiteBackupAge, stateFingerprint } from '../src/monitor.js';

// 外部定时探针（launchd / cron / 另一台机器都能跑）：单次探测，失败非零，
// 状态变化时才通知。进程内那份看门狗见 src/monitor.js，两者共用 probe()。
export { probe };

// 告警渠道：webhook 需要额外申请地址，而站点的 SMTP 早就在后台配好了（评论通知一直在用）。
// 所以默认走邮件——复用 src/mail.js 的配置与解密，不另起一套 SMTP 逻辑。
async function notifyByMail(result, { recovered }) {
  const { DatabaseSync } = await import('node:sqlite');
  const { DB_FILE, SITE } = await import('../src/config.js');
  const { createCrypto } = await import('../src/auth.js');
  const { initMail, send } = await import('../src/mail.js');

  const db = new DatabaseSync(DB_FILE, { readOnly: true });
  try {
    const getSetting = (key) => db.prepare('SELECT value FROM settings WHERE key = ?').get(key)?.value ?? null;
    // 站点启动时已把密钥放到 DATA_DIR/.app-secret（或 APP_SECRET），只读连接不会触发建密钥的写操作。
    initMail({ getSetting, crypt: createCrypto(db) });
    const subject = recovered ? `[恢复] ${SITE.identity} 监控恢复正常` : `[告警] ${SITE.identity} 监控异常`;
    const text = [
      recovered ? '站点与备份已恢复正常。' : '站点或备份出现异常。',
      '',
      `原因：${result.reason}`,
      `地址：${result.url ?? ''}`,
      `时间：${new Date().toISOString()}`,
      '',
      '（由监控脚本自动发出，状态变化时才会提醒。）',
    ].join('\n');
    return await send({ subject, text });
  } finally { db.close(); }
}

async function main() {
  const url = process.env.MONITOR_URL ?? new URL('/healthz', process.env.SITE_URL ?? 'http://127.0.0.1:8787').href;
  const maxAgeSec = Number(process.env.MONITOR_BACKUP_MAX_AGE_SEC ?? 172800);
  if (!Number.isFinite(maxAgeSec) || maxAgeSec <= 0) throw new Error('MONITOR_BACKUP_MAX_AGE_SEC 必须为正数');
  const stateFile = path.resolve(process.env.MONITOR_STATE_FILE ?? path.join(DATA_DIR, 'monitor-state.json'));
  const offsiteDir = process.env.MONITOR_OFFSITE_DIR;
  let result = await probe({ url, maxAgeSec, requireOffsite: !offsiteDir && process.env.MONITOR_REQUIRE_OFFSITE === 'true' });
  // 异地副本在另一台机器上时，生产机的 offsiteBackup 状态没有意义；改为检查本地拉取目录。
  if (result.ok && offsiteDir) {
    const offsite = offsiteBackupAge(path.resolve(offsiteDir));
    if (!offsite.ok) result = { ok: false, reason: offsite.reason };
    else if (offsite.ageSec > maxAgeSec)
      result = { ok: false, reason: `异地备份已过期（${Math.round(offsite.ageSec / 3600)} 小时）` };
    else result = { ...result, offsiteAgeSec: offsite.ageSec };
  }
  // 指纹不能直接 JSON.stringify(result)：offsiteAgeSec 每拍都在变，会把「状态未变」全判成翻转。
  const fingerprint = stateFingerprint(url, result);
  let previous;
  try { previous = JSON.parse(fs.readFileSync(stateFile, 'utf8')); } catch { }
  const webhook = process.env.MONITOR_WEBHOOK_URL;
  const mail = process.env.MONITOR_MAIL === 'true';
  const changed = previous?.fingerprint !== fingerprint;
  let notified = (!webhook && !mail) || (!changed && previous?.notified === true);
  if ((webhook || mail) && !notified) {
    // 通知失败不标记成功，下次探测重试；首次健康结果不发通知。
    if (!previous && result.ok) notified = true;
    else {
      const recovered = previous !== undefined && result.ok;
      if (webhook) {
        const response = await fetch(webhook, { method: 'POST', redirect: 'error', signal: AbortSignal.timeout(10000),
          headers: { 'content-type': 'application/json' }, body: JSON.stringify({ ...result, url, checkedAt: new Date().toISOString() }) });
        if (!response.ok) throw new Error(`通知失败：HTTP ${response.status}`);
      }
      let mailFailed = false;
      if (mail) {
        // 邮件发不出去不能标记为已通知，否则这次故障告警会永久丢失（下一拍还会重试）。
        const sent = await notifyByMail({ ...result, url }, { recovered });
        if (!sent?.sent) {
          mailFailed = true;
          console.error(JSON.stringify({ event: 'monitor.mail-failed', reason: sent?.reason ?? 'unknown' }));
        }
      }
      // 有渠道失败就保持 notified=false；下一拍会重试（webhook 可能因此重复一次，优先保证告警不丢）。
      if (!mailFailed) notified = true;
    }
  }
  atomicWrite(stateFile, JSON.stringify({ fingerprint, notified, checkedAt: new Date().toISOString() }));
  console.log(JSON.stringify({ ...result, url }));
  process.exitCode = result.ok ? 0 : 1;
}

if (process.argv[1] && import.meta.url === new URL(`file://${path.resolve(process.argv[1])}`).href) {
  main().catch((error) => { console.error(error.message); process.exitCode = 1; });
}

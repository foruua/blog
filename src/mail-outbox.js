import { envInt } from './util/env.js';
import { ownerEmail } from './mail.js';

// 发信队列（mail_outbox）：通知先落库，再由定时器重试。解决两个旧问题：
//   1. send() 是 fire-and-forget，SMTP 抖动一次，站主就永久漏掉一条待审提醒；
//   2. 没有全局限流，分布式 IP 可以靠大量评论把站主邮箱打爆。
// 队列与站点共用 SQLite：随备份一起走，重启不丢；后台「设置」页能看到待发/失败与最近错误。

const RETRY_STEPS = [
  60_000,          // 1 分钟
  5 * 60_000,      // 5 分钟
  15 * 60_000,     // 15 分钟
  60 * 60_000,     // 1 小时
  6 * 3600_000,    // 6 小时
  12 * 3600_000,   // 12 小时
  24 * 3600_000,   // 24 小时
];
const TERMINAL_REASONS = new Set(['not-configured', 'no-recipient', 'no-transport']);
// 超过这个年龄的待发信直接作废：审核链接 7 天有效，离线一周后补发的通知没有意义，还可能带旧内容。
const MAX_AGE_MS = 7 * 86400_000;
const nowIso = (ms) => new Date(ms).toISOString();
const cleanHeader = (value) => String(value ?? '').replace(/[\r\n]/g, '').trim();

export function createMailOutbox({
  db,
  deliver,
  log = () => {},
  now = Date.now,
  intervalMs = envInt(process.env.MAIL_RETRY_INTERVAL_MS, 60_000, { min: 5_000, max: 3600_000 }),
  maxPerHour = envInt(process.env.MAIL_MAX_PER_HOUR, 30, { min: 1, max: 10_000 }),
  maxAttempts = 8,
} = {}) {
  const q = {
    insert: db.prepare(`INSERT INTO mail_outbox
      (to_addr, subject, text_body, html_body, headers_json, status, attempts, next_attempt_at, created_at)
      VALUES (?,?,?,?,?, 'pending', 0, ?, ?)`),
    due: db.prepare(`SELECT * FROM mail_outbox
      WHERE status = 'pending' AND next_attempt_at <= ? ORDER BY next_attempt_at, id LIMIT ?`),
    dueForce: db.prepare(`SELECT * FROM mail_outbox
      WHERE status = 'pending' ORDER BY next_attempt_at, id LIMIT ?`),
    markSent: db.prepare(`UPDATE mail_outbox SET status = 'sent', sent_at = ?, last_error = NULL WHERE id = ?`),
    markSkipped: db.prepare(`UPDATE mail_outbox SET status = 'skipped', sent_at = ?, last_error = ? WHERE id = ?`),
    markFailed: db.prepare(`UPDATE mail_outbox SET status = 'failed', attempts = ?, next_attempt_at = ?, last_error = ? WHERE id = ?`),
    markRetry: db.prepare(`UPDATE mail_outbox SET attempts = ?, next_attempt_at = ?, last_error = ? WHERE id = ?`),
    counts: db.prepare('SELECT status, COUNT(*) AS n FROM mail_outbox GROUP BY status'),
    sentLastHour: db.prepare(`SELECT COUNT(*) AS n FROM mail_outbox
      WHERE status = 'sent' AND sent_at IS NOT NULL AND sent_at >= ?`),
    lastError: db.prepare(`SELECT created_at, last_error FROM mail_outbox
      WHERE last_error IS NOT NULL AND status IN ('pending', 'failed', 'skipped')
      ORDER BY id DESC LIMIT 1`),
    retryFailed: db.prepare(`UPDATE mail_outbox
      SET status = 'pending', attempts = 0, next_attempt_at = ?, last_error = NULL WHERE status = 'failed'`),
    prune: db.prepare(`DELETE FROM mail_outbox
      WHERE status IN ('sent', 'skipped') AND sent_at IS NOT NULL AND sent_at < ?`),
  };

  let flushing = null;
  let pendingWake = false;
  let timer = null;
  let lastPrune = 0;

  const backoff = (attempts) => RETRY_STEPS[Math.min(Math.max(0, attempts - 1), RETRY_STEPS.length - 1)];
  const sentInLastHour = () => Number(q.sentLastHour.get(nowIso(now() - 3600_000)).n) || 0;

  function maybePrune() {
    if (now() - lastPrune < 3600_000) return;
    lastPrune = now();
    try { q.prune.run(nowIso(now() - 30 * 86400_000)); } catch { /* 清理失败不影响发信 */ }
  }

  function payloadOf(row) {
    let headers;
    if (row.headers_json) {
      try { headers = JSON.parse(row.headers_json); } catch { /* 坏 JSON 不阻断投递 */ }
    }
    return {
      to: row.to_addr,
      subject: row.subject,
      text: row.text_body,
      ...(row.html_body ? { html: row.html_body } : {}),
      ...(headers ? { headers } : {}),
    };
  }

  /** 入队；默认立即尝试一次。返回 { queued, id } 或 { queued:false, reason }。 */
  function enqueue(msg, { autoFlush = true } = {}) {
    const to = cleanHeader(msg?.to || ownerEmail());
    const subject = String(msg?.subject ?? '').trim();
    const text = String(msg?.text ?? '');
    if (!subject && !text) return { queued: false, reason: 'empty' };
    const at = nowIso(now());
    try {
      const result = q.insert.run(
        to, subject, text,
        msg?.html == null ? null : String(msg.html),
        msg?.headers ? JSON.stringify(msg.headers) : null,
        at, at,
      );
      if (autoFlush) void flush().catch((error) => log(JSON.stringify({ event: 'mail.flush-failed', code: error?.code ?? 'INTERNAL' })));
      return { queued: true, id: Number(result.lastInsertRowid) };
    } catch (error) {
      log(JSON.stringify({ event: 'mail.enqueue-failed', code: error?.code ?? 'INTERNAL' }));
      return { queued: false, reason: error?.code ?? 'INTERNAL' };
    }
  }

  /** 发送到点的邮件；force 会无视 next_attempt_at（后台「立即重试」用）。单飞，避免并发重复投递。 */
  function flush({ force = false } = {}) {
    if (flushing) { pendingWake = true; return flushing; }
    flushing = (async () => {
      let sent = 0;
      let attempted = 0;
      let first = force;
      for (;;) {
        const budget = maxPerHour - sentInLastHour();
        if (budget <= 0 || attempted >= 40) break;
        const rows = first ? q.dueForce.all(20) : q.due.all(nowIso(now()), 20);
        first = false;
        if (!rows.length) break;
        for (const row of rows) {
          if (sent >= budget || attempted >= 40) break;
          attempted++;
          const createdAt = Date.parse(row.created_at);
          if (!Number.isFinite(createdAt) || now() - createdAt > MAX_AGE_MS) {
            q.markSkipped.run(nowIso(now()), 'expired', row.id);
            log(JSON.stringify({ event: 'mail.expired', id: row.id }));
            continue;
          }
          let result;
          try { result = await deliver(payloadOf(row)); }
          catch (error) { result = { sent: false, reason: error?.message ?? 'deliver-failed' }; }
          if (result?.sent) {
            q.markSent.run(nowIso(now()), row.id);
            sent++;
            continue;
          }
          const reason = String(result?.reason ?? 'unknown').slice(0, 500);
          if (TERMINAL_REASONS.has(reason)) {
            q.markSkipped.run(nowIso(now()), reason, row.id);
            log(JSON.stringify({ event: 'mail.skipped', id: row.id, reason }));
            continue;
          }
          const attempts = Number(row.attempts) + 1;
          if (attempts >= maxAttempts) {
            q.markFailed.run(attempts, nowIso(now()), reason, row.id);
            log(JSON.stringify({ event: 'mail.failed', id: row.id, attempts, reason }));
          } else {
            q.markRetry.run(attempts, nowIso(now() + backoff(attempts)), reason, row.id);
            log(JSON.stringify({ event: 'mail.retry', id: row.id, attempts, reason }));
          }
        }
        if (rows.length < 20) break;
      }
      maybePrune();
      return sent;
    })().finally(() => {
      flushing = null;
      if (pendingWake) {
        pendingWake = false;
        void flush().catch((error) => log(JSON.stringify({ event: 'mail.flush-failed', code: error?.code ?? 'INTERNAL' })));
      }
    });
    return flushing;
  }

  function retryFailed() {
    try { return q.retryFailed.run(nowIso(now())).changes ?? 0; }
    catch { return 0; }
  }

  function stats() {
    let counts = {};
    try { counts = Object.fromEntries(q.counts.all().map((row) => [row.status, Number(row.n)])); }
    catch { /* 迁移前的库没有表：按空队列展示 */ }
    let lastError = null;
    try {
      const row = q.lastError.get();
      if (row) lastError = { at: row.created_at, message: String(row.last_error ?? '').slice(0, 300) };
    } catch { /* 同上 */ }
    let sentLastHour = 0;
    try { sentLastHour = sentInLastHour(); } catch { /* 迁移前的库没有表：按 0 展示 */ }
    return {
      pending: counts.pending ?? 0,
      failed: counts.failed ?? 0,
      skipped: counts.skipped ?? 0,
      sent: counts.sent ?? 0,
      sentLastHour,
      maxPerHour,
      lastError,
    };
  }

  function start() {
    if (timer || !(intervalMs > 0)) return;
    void flush().catch((error) => log(JSON.stringify({ event: 'mail.flush-failed', code: error?.code ?? 'INTERNAL' })));
    timer = setInterval(() => {
      void flush().catch((error) => log(JSON.stringify({ event: 'mail.flush-failed', code: error?.code ?? 'INTERNAL' })));
    }, intervalMs);
    timer.unref?.();
  }

  function stop() {
    if (timer) { clearInterval(timer); timer = null; }
  }

  return { enqueue, flush, retryFailed, stats, start, stop };
}

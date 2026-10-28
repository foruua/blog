#!/usr/bin/env node
// 发信队列：失败退避、强制重试、终态跳过、每小时限流与统计。
import './_test-env.mjs';
import { DatabaseSync } from 'node:sqlite';
import { migrate } from '../db/migrate.js';
import { createMailOutbox } from '../src/mail-outbox.js';
import { createChecker } from './_check.mjs';

const { check, report } = createChecker();
const freshDb = () => {
  const db = new DatabaseSync(':memory:');
  migrate(db, { log() {} });
  return db;
};

try {
  const db = freshDb();
  let calls = 0;
  const delivered = [];
  const outbox = createMailOutbox({
    db,
    deliver: async (msg) => {
      calls++;
      if (calls === 1) return { sent: false, reason: 'smtp-down' };
      delivered.push(msg);
      return { sent: true };
    },
    log: () => {},
    maxPerHour: 30,
  });

  const first = outbox.enqueue({ to: 'owner@example.com', subject: 's1', text: 'body' }, { autoFlush: false });
  check('T1 入队成功并拿到 id', first.queued && first.id > 0, JSON.stringify(first));
  await outbox.flush({ force: true });
  const row = db.prepare('SELECT * FROM mail_outbox WHERE id = ?').get(first.id);
  check('T2 首次失败进入退避，状态仍为 pending',
    row?.status === 'pending' && row.attempts === 1, JSON.stringify(row));
  check('T3 退避时间在未来', Date.parse(row.next_attempt_at) > Date.now(), row.next_attempt_at);
  const statsDown = outbox.stats();
  check('T4 统计能看到最近错误', statsDown.pending === 1 && statsDown.lastError?.message === 'smtp-down', JSON.stringify(statsDown));

  await outbox.flush({ force: true });
  const sentRow = db.prepare('SELECT * FROM mail_outbox WHERE id = ?').get(first.id);
  check('T5 强制重试成功后标记 sent', sentRow?.status === 'sent' && Boolean(sentRow.sent_at), JSON.stringify(sentRow));
  check('T6 投递内容完整', delivered.length === 1 && delivered[0].to === 'owner@example.com'
    && delivered[0].subject === 's1' && delivered[0].text === 'body', JSON.stringify(delivered[0]));

  const db2 = freshDb();
  const skipped = createMailOutbox({
    db: db2,
    deliver: async () => ({ sent: false, reason: 'not-configured' }),
    log: () => {},
  });
  const s = skipped.enqueue({ to: 'owner@example.com', subject: 'skip', text: 'x' }, { autoFlush: false });
  await skipped.flush({ force: true });
  const skipRow = db2.prepare('SELECT * FROM mail_outbox WHERE id = ?').get(s.id);
  check('T7 未配置 SMTP 是终态 skipped，不再无限重试',
    skipRow?.status === 'skipped' && skipRow.last_error === 'not-configured', JSON.stringify(skipRow));

  const db3 = freshDb();
  const budget = createMailOutbox({
    db: db3,
    deliver: async () => ({ sent: true }),
    log: () => {},
    maxPerHour: 1,
  });
  for (let i = 0; i < 3; i++) budget.enqueue({ to: 'owner@example.com', subject: `b${i}`, text: 'x' }, { autoFlush: false });
  await budget.flush();
  const bstats = budget.stats();
  check('T8 每小时预算生效：只发一封，其余留在队列', bstats.sentLastHour === 1 && bstats.pending === 2, JSON.stringify(bstats));
  await budget.flush();
  check('T9 预算用尽后再次 flush 也不会超发', budget.stats().sentLastHour === 1, JSON.stringify(budget.stats()));

  const db4 = freshDb();
  let fail = true;
  const failThenSucceed = createMailOutbox({
    db: db4,
    deliver: async () => (fail ? { sent: false, reason: 'smtp-down' } : { sent: true }),
    log: () => {},
    maxAttempts: 1,
  });
  const f = failThenSucceed.enqueue({ to: 'owner@example.com', subject: 'f', text: 'x' }, { autoFlush: false });
  await failThenSucceed.flush({ force: true });
  check('T10 达到最大尝试次数进入 failed', db4.prepare('SELECT status FROM mail_outbox WHERE id = ?').get(f.id)?.status === 'failed');
  fail = false;
  const retried = failThenSucceed.retryFailed();
  await failThenSucceed.flush({ force: true });
  check('T11 后台「重试失败邮件」可把 failed 重新排队并发出',
    retried === 1 && db4.prepare('SELECT status FROM mail_outbox WHERE id = ?').get(f.id)?.status === 'sent',
    `retried=${retried} status=${db4.prepare('SELECT status FROM mail_outbox WHERE id = ?').get(f.id)?.status}`);

  const db5 = freshDb();
  const expired = createMailOutbox({ db: db5, deliver: async () => ({ sent: true }), log: () => {} });
  const old = expired.enqueue({ to: 'owner@example.com', subject: 'old', text: 'x' }, { autoFlush: false });
  db5.prepare("UPDATE mail_outbox SET created_at = '2020-01-01T00:00:00.000Z' WHERE id = ?").run(old.id);
  await expired.flush({ force: true });
  check('T12 离线超过 7 天的待发信直接作废，不再补发旧审核链接',
    db5.prepare('SELECT status, last_error FROM mail_outbox WHERE id = ?').get(old.id)?.last_error === 'expired');

  // 收件人为空的行不能占住每轮的前 20 个名额：以前它们被「留在 pending 等配置」原地跳过，
  // 同一条 due 查询每轮又捞回来，攒够 20 条就再也发不出后面的正常邮件。
  {
    const dbBlank = freshDb();
    const blankDelivered = [];
    const blankBox = createMailOutbox({
      db: dbBlank,
      deliver: async (msg) => { blankDelivered.push(msg); return { sent: true }; },
      log: () => {},
    });
    for (let i = 0; i < 25; i++) blankBox.enqueue({ to: '', subject: `blank-${i}`, text: 'x' }, { autoFlush: false });
    blankBox.enqueue({ to: 'owner@example.com', subject: 'after-blanks', text: 'x' }, { autoFlush: false });
    await blankBox.flush();
    check('T12b 空收件人行不会饿死后面的正常邮件',
      blankDelivered.length === 1 && blankDelivered[0].subject === 'after-blanks',
      `delivered=${JSON.stringify(blankDelivered.map((m) => m.subject))}`);
    const stillPending = dbBlank.prepare("SELECT COUNT(*) AS n FROM mail_outbox WHERE to_addr = '' AND status = 'pending'").get().n;
    check('T12c 空收件人行被延后而不是终态丢弃', stillPending === 25, String(stillPending));
    await blankBox.flush({ force: true });
    check('T12d 强制重试不会反复捞空收件人行', blankDelivered.length === 1, String(blankDelivered.length));
    dbBlank.close();
  }

  // 收件人加密：队列表会随备份/异地副本走，明文邮箱等于把读者地址摊在备份里。
  {
    const db6 = freshDb();
    const sealed = [];
    const fakeCrypt = {
      encrypt: (s) => `v1.${Buffer.from(s, 'utf8').toString('base64url')}`,
      decrypt: (b) => Buffer.from(String(b).replace(/^v1\./, ''), 'base64url').toString('utf8'),
    };
    const box = createMailOutbox({
      db: db6,
      crypt: fakeCrypt,
      deliver: async (msg) => { sealed.push(msg); return { sent: true }; },
      log: () => {},
      intervalMs: 0,
    });
    const e = box.enqueue({ to: 'Reader <reader@example.com>', subject: 'sealed', text: 'x' }, { autoFlush: false });
    const stored = db6.prepare('SELECT to_addr FROM mail_outbox WHERE id = ?').get(e.id)?.to_addr ?? '';
    check('T13 队列里的收件人是密文，备份里看不到明文邮箱',
      stored.startsWith('enc:') && !stored.includes('reader@example.com'), stored);

    // 迁移前入队的明文行：启动时补加密，且照样投递得出去。
    const at = new Date().toISOString();
    db6.prepare(`INSERT INTO mail_outbox (to_addr, subject, text_body, status, attempts, next_attempt_at, created_at)
      VALUES (?,?,?, 'pending', 0, ?, ?)`).run('legacy@example.com', 'legacy', 'y', at, at);
    box.start(); box.stop();
    const legacyRow = db6.prepare("SELECT to_addr FROM mail_outbox WHERE subject = 'legacy'").get()?.to_addr ?? '';
    check('T14 启动时把历史明文收件人补加密',
      legacyRow.startsWith('enc:') && !legacyRow.includes('legacy@example.com'), legacyRow);

    await box.flush({ force: true });
    check('T15 加密后的行仍按原地址投递', sealed.length === 2
      && sealed[0].to === 'Reader <reader@example.com>' && sealed[1].to === 'legacy@example.com',
      JSON.stringify(sealed.map((m) => m.to)));

    // 密钥换了：解不出收件人的行要进终态，不能每轮都重试。
    const db7 = freshDb();
    const broken = createMailOutbox({
      db: db7,
      crypt: { encrypt: fakeCrypt.encrypt, decrypt: () => null },
      deliver: async () => ({ sent: true }),
      log: () => {},
      intervalMs: 0,
    });
    const b = broken.enqueue({ to: 'owner@example.com', subject: 'lost-key', text: 'x' }, { autoFlush: false });
    await broken.flush({ force: true });
    const brokenRow = db7.prepare('SELECT status, last_error FROM mail_outbox WHERE id = ?').get(b.id);
    check('T16 密钥解不开时进 skipped（unreadable-recipient），不再无限重试',
      brokenRow?.status === 'skipped' && brokenRow.last_error === 'unreadable-recipient', JSON.stringify(brokenRow));
    db6.close(); db7.close();
  }

  for (const database of [db, db2, db3, db4, db5]) database.close();
} catch (error) {
  console.error(error);
  process.exit(1);
}

process.exit(report() ? 1 : 0);

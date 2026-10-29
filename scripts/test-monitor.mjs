#!/usr/bin/env node
// 看门狗状态机：抖动容忍、连续失败告警、恢复告警、不重复打扰。
// 这部分逻辑出错的两个方向都很糟——不告警等于没监控，乱告警会让人把邮件全标成已读。
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createChecker } from './_check.mjs';
import { createWatchdog, offsiteBackupAge, stateFingerprint, pullInProgress, probe } from '../src/monitor.js';

const { check, report } = createChecker();

console.log('\n看门狗状态机');
console.log('─'.repeat(56));

const quiet = () => {};
const make = (results) => {
  const sent = [];
  let i = 0;
  const dog = createWatchdog({
    url: null, intervalMs: 0,
    check: async () => results[Math.min(i++, results.length - 1)],
    notify: async (result, meta) => { sent.push({ reason: result.reason, recovered: meta.recovered }); },
    log: quiet,
  });
  return { dog, sent };
};

const OK = { ok: true, reason: '正常' };
const BAD = { ok: false, reason: '隧道断开' };

{
  const { dog, sent } = make([BAD, OK, OK]);
  await dog.tick();
  check('T1 首次探测失败不立刻告警（还不知道之前是否正常）', sent.length === 0, JSON.stringify(sent));
  await dog.tick();
  check('T2 一次失败后又恢复，不发告警', sent.length === 0, JSON.stringify(sent));
}

{
  const { dog, sent } = make([BAD, BAD, BAD, BAD, OK]);
  await dog.tick();                          // 基线
  await dog.tick();                          // 连续第 2 次失败 → 告警
  check('T3 连续失败达到阈值时告警一次', sent.length === 1 && sent[0].recovered === false, JSON.stringify(sent));
  await dog.tick();                          // 继续失败
  check('T4 持续故障不重复告警', sent.length === 1, JSON.stringify(sent));
  await dog.tick();                          // 仍然失败
  check('T5 仍然只有一封', sent.length === 1, JSON.stringify(sent));
  await dog.tick();                          // 恢复
  check('T6 恢复后补发一封恢复通知', sent.length === 2 && sent[1].recovered === true, JSON.stringify(sent));
}

{
  const { dog, sent } = make([OK, BAD, OK, OK]);
  await dog.tick();
  await dog.tick();
  check('T7 单次抖动（正常→失败→正常）不告警', sent.length === 0, JSON.stringify(sent));
}

{
  // 首轮就坏、且一直坏：阈值到了必须告警，不能因为"没基线"永远沉默。
  const { dog, sent } = make([BAD, BAD, BAD]);
  await dog.tick();
  await dog.tick();
  check('T8 启动即故障且持续时仍会告警', sent.length === 1, JSON.stringify(sent));
}

{
  // 本地备份检查失败要能独立拦住，且不必依赖公网探测（url 故意填一个必然连不上的地址）。
  const sent = [];
  const dog = createWatchdog({
    url: 'https://example.invalid/healthz', intervalMs: 0,
    checkLocal: () => ({ ok: false, reason: '可恢复备份已过期' }),
    notify: async (result, meta) => { sent.push({ reason: result.reason, recovered: meta.recovered }); },
    log: quiet,
  });
  await dog.tick(); await dog.tick();
  check('T9 本地备份过期时告警，且原因是本地判定而非网络失败',
    sent.length === 1 && sent[0].recovered === false && sent[0].reason === '可恢复备份已过期', JSON.stringify(sent));
}

{
  // 内部检查抛异常（如备份目录不可读）时，tick 必须自己接住；否则 Node 的未处理 rejection 会终止进程。
  const sent = [];
  const dog = createWatchdog({
    url: null, intervalMs: 0,
    check: async () => { const e = new Error('EACCES'); e.code = 'EACCES'; throw e; },
    notify: async (result, meta) => { sent.push({ reason: result.reason, recovered: meta.recovered }); },
    log: quiet,
  });
  await dog.tick();
  check('T11 内部检查异常首轮不告警', sent.length === 0, JSON.stringify(sent));
  await dog.tick();
  check('T11b 连续异常会按失败处理并告警', sent.length === 1 && sent[0].reason === '监控自检异常', JSON.stringify(sent));
}

{
  let notified = 0;
  const dog = createWatchdog({ url: null, intervalMs: 0, check: async () => OK, notify: async () => { notified++; }, log: quiet });
  dog.start();
  await new Promise((r) => setTimeout(r, 50));
  check('T10 intervalMs=0 时不启动定时器、不探测', notified === 0 && dog.state().failStreak === 0);
  dog.stop();
}

{
  // 异地备份由本机 pull：探针直接看目录里最新清单的年龄，不看生产机自报状态。
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'blog-offsite-'));
  try {
    check('T12 异地目录为空时明确报未就绪', !offsiteBackupAge(dir).ok, JSON.stringify(offsiteBackupAge(dir)));
    const now = Date.now();
    const file = path.join(dir, 'blog-test.json');
    fs.writeFileSync(file, '{}');
    fs.utimesSync(file, new Date(now - 3600_000), new Date(now - 3600_000));
    fs.writeFileSync(path.join(dir, 'asset.db.gz'), 'ignored');
    const aged = offsiteBackupAge(dir, { now: () => now });
    check('T13 按最新清单计算异地备份年龄', aged.ok && aged.ageSec === 3600, JSON.stringify(aged));
    fs.writeFileSync(path.join(dir, 'blog-newer.json'), '{}');
    fs.utimesSync(path.join(dir, 'blog-newer.json'), new Date(now - 60_000), new Date(now - 60_000));
    const fresh = offsiteBackupAge(dir, { now: () => now });
    check('T14 多个清单取最新的一份', fresh.ok && fresh.ageSec === 60, JSON.stringify(fresh));
    // 拉取窗口：rsync --delete 换清单的瞬间目录可能是空的。锁还新时这一拍不判，
    // 锁超过 2 小时按残留处理（照常判，坏锁不能长期遮住告警）。
    const lock = path.join(dir, '.pull-lock');
    check('T14b 没有锁时不在拉取中', pullInProgress(dir) === false);
    fs.mkdirSync(lock);
    fs.utimesSync(lock, new Date(now - 60_000), new Date(now - 60_000));
    check('T14c 新锁视为拉取进行中', pullInProgress(dir, () => now) === true);
    fs.utimesSync(lock, new Date(now - 3 * 3600_000), new Date(now - 3 * 3600_000));
    check('T14d 超过 2 小时的锁按残留处理，不再遮住告警', pullInProgress(dir, () => now) === false);
    fs.rmSync(lock, { recursive: true, force: true });
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

{
  // 去重指纹里不能有「每拍都在变」的测量值：offsiteAgeSec 一变，恢复信就会每 5 分钟发一封。
  const ok = { ok: true, reason: '站点和可恢复备份正常' };
  const first = stateFingerprint('https://example.com/healthz', { ...ok, offsiteAgeSec: 300 });
  const later = stateFingerprint('https://example.com/healthz', { ...ok, offsiteAgeSec: 600 });
  check('T15 备份年龄变化不算状态变化', first === later, `${first} vs ${later}`);

  const expired1 = stateFingerprint('u', { ok: false, reason: '异地备份已过期（13 小时）' });
  const expired2 = stateFingerprint('u', { ok: false, reason: '异地备份已过期（14 小时）' });
  const http1 = stateFingerprint('u', { ok: false, reason: 'HTTP 500' });
  const http2 = stateFingerprint('u', { ok: false, reason: 'HTTP 502' });
  check('T16 同类故障内部数值波动不重复提醒', expired1 === expired2 && http1 === http2,
    `${expired1} ${expired2} ${http1} ${http2}`);
  check('T17 健康与故障、不同故障类别之间仍是状态变化',
    first !== http1 && http1 !== expired1, `${first} ${http1} ${expired1}`);
}

{
  // 503 也必须解析 body 里的 healthReason：外部探针不该把可执行的诊断丢成裸 HTTP 状态码。
  const original = globalThis.fetch;
  try {
    globalThis.fetch = async () => ({ ok: false, status: 503, json: async () => ({ ok: false, healthReason: 'SQLite WAL 过大' }) });
    const r503 = await probe({ url: 'https://example.invalid/healthz' });
    check('T18 503 探针带出 healthReason', !r503.ok && r503.reason.includes('SQLite WAL 过大'), r503.reason);
    globalThis.fetch = async () => ({ ok: true, json: async () => ({ ok: false, healthReason: '数据库读取失败' }) });
    const rBody = await probe({ url: 'https://example.invalid/healthz' });
    check('T19 200 但自检失败时也带出 healthReason', !rBody.ok && rBody.reason.includes('数据库读取失败'), rBody.reason);
  } finally { globalThis.fetch = original; }
}

process.exit(report() ? 1 : 0);

import crypto from 'node:crypto';
import { SITE } from './config.js';
import { headerValue } from './util/validation.js';

export const KEYS = {
  host: 'mail_smtp_host',
  port: 'mail_smtp_port',
  tls: 'mail_smtp_tls',
  user: 'mail_smtp_user',
  pass: 'mail_smtp_pass',
  to: 'mail_to',
  from: 'mail_from',
};

export const DEFAULTS = { host: '', port: 465, tls: 'ssl' };

export const TLS_MODES = ['ssl', 'starttls', 'none'];

export const TLS_LABEL = { ssl: 'SSL', starttls: 'STARTTLS', none: '不加密' };

export const PRESETS = [
  { id: 'qq', label: 'QQ 邮箱', host: 'smtp.qq.com', port: 465, tls: 'ssl',
    note: '账号填完整地址（如 123456@qq.com），密码用 16 位「授权码」' },
  { id: 'exmail', label: '腾讯企业邮', host: 'smtp.exmail.qq.com', port: 465, tls: 'ssl',
    note: '需要一个自己的域名邮箱' },
  { id: 'aliyun', label: '阿里云企业邮', host: 'smtp.qiye.aliyun.com', port: 465, tls: 'ssl', note: '' },
  { id: '163', label: '网易 163 / 126', host: 'smtp.163.com', port: 465, tls: 'ssl',
    note: '用客户端授权码，不是登录密码' },
  { id: 'gmail', label: 'Gmail', host: 'smtp.gmail.com', port: 587, tls: 'starttls',
    note: '需要应用专用密码。国内直连通常不通' },
  { id: 'outlook', label: 'Outlook / Office 365', host: 'smtp.office365.com', port: 587, tls: 'starttls', note: '' },
  { id: 'local', label: '本机中继（不加密）', host: '127.0.0.1', port: 25, tls: 'none',
    note: '适合服务器上另跑 postfix 之类的中继' },
  { id: 'custom', label: '自定义', host: '', port: 465, tls: 'ssl', note: '' },
];

export function tlsOptions(mode) {
  if (mode === 'starttls') return { secure: false, requireTLS: true, ignoreTLS: false };
  if (mode === 'none') return { secure: false, requireTLS: false, ignoreTLS: true };
  return { secure: true, requireTLS: false, ignoreTLS: false };
}

let deps = null;

export function initMail(injected) { deps = injected; }

const dbGet = (key) => {
  try { return deps?.getSetting?.(key) ?? null; } catch { return null; }
};

function tlsFromLegacy(port) {
  return port === 465 ? 'ssl' : 'starttls';
}

function normalizeTls(raw, port) {
  const v = String(raw ?? '').trim();
  return TLS_MODES.includes(v) ? v : tlsFromLegacy(port);
}

function configFromDb() {
  const host = String(dbGet(KEYS.host) ?? '').trim();
  if (!host) return null;
  const port = Number(dbGet(KEYS.port) ?? DEFAULTS.port) || DEFAULTS.port;
  const tls = normalizeTls(dbGet(KEYS.tls), port);
  const user = String(dbGet(KEYS.user) ?? '').trim();
  let pass = '';
  try {
    const blob = dbGet(KEYS.pass);
    pass = blob ? (deps?.crypt?.decrypt(blob) ?? '') : '';
  } catch { pass = ''; }
  return {
    host, port, tls, ...tlsOptions(tls),
    auth: user ? { user, pass: pass ?? '' } : undefined,
  };
}

function configFromEnv() {
  const host = process.env.SMTP_HOST;
  if (!host) return null;
  const port = Number(process.env.SMTP_PORT ?? 465) || 465;

  const raw = process.env.SMTP_TLS ?? (process.env.SMTP_SECURE ? (process.env.SMTP_SECURE === 'false' ? 'starttls' : 'ssl') : '');
  const tls = raw ? normalizeTls(raw, port) : tlsFromLegacy(port);
  return {
    host, port, tls, ...tlsOptions(tls),
    auth: process.env.SMTP_USER
      ? { user: process.env.SMTP_USER, pass: process.env.SMTP_PASS ?? '' }
      : undefined,
  };
}

export const smtpConfig = () => configFromDb() ?? configFromEnv();

export function configSource() {
  if (configFromDb()) return 'page';
  if (configFromEnv()) return 'env';
  return 'none';
}

// 收件人同样剥掉 CR/LF：mail_to 可由恢复不可信备份带进来，头注入不该从这里进入。
export const ownerEmail = () => headerValue(String(dbGet(KEYS.to) ?? '').trim() || String(process.env.OWNER_EMAIL ?? '').trim());

export function fromAddress() {
  const explicit = String(dbGet(KEYS.from) ?? '').trim() || String(process.env.MAIL_FROM ?? '').trim();
  let value = explicit;
  if (!value) {
    const user = smtpConfig()?.auth?.user;
    value = user ? `${SITE.identity} <${user}>` : '';
  }
  // 头部注入：站点名 / SMTP 用户名里混入 CR/LF 会把 From 头劈成两行、凭空多出收件人。
  return headerValue(value);
}

let cached = { sig: '', promise: null };

const signature = (cfg) => JSON.stringify([
  cfg.host, cfg.port, cfg.secure, cfg.requireTLS, cfg.ignoreTLS,
  cfg.auth?.user ?? '', crypto.createHash('sha256').update(cfg.auth?.pass ?? '').digest('hex'),
]);

// 换 transport 前先关旧的：配置变动或 resetTransport 会整个替换缓存对象，不 close 则反复改 SMTP 会泄漏连接。
function closeQuietly(transportPromise) {
  if (!transportPromise) return;
  void transportPromise.then((t) => { try { t?.close?.(); } catch { /* 关闭失败无所谓 */ } }).catch(() => {});
}

function getTransport(cfg) {
  const sig = signature(cfg);
  if (cached.promise && cached.sig === sig) return cached.promise;
  closeQuietly(cached.promise);
  cached = {
    sig,
    promise: (async () => {
      try {
        const mod = await import('nodemailer');
        const nodemailer = mod.default ?? mod;

        return nodemailer.createTransport({
          ...cfg,
          connectionTimeout: 8000,
          greetingTimeout: 8000,
          socketTimeout: 12000,
        });
      } catch (err) {
        console.warn(`[mail] nodemailer 不可用（${err.message}），邮件将只打印`);
        // 瞬时加载失败不能永久缓存成 null：否则同一配置下后续所有投递都拿不到 transport。
        if (cached.sig === sig) cached = { sig: '', promise: null };
        return null;
      }
    })(),
  };
  return cached.promise;
}

export function resetTransport() { closeQuietly(cached.promise); cached = { sig: '', promise: null }; }

// 立即投递：后台「保存并测试发信」、外部监控脚本仍需要同步结果；评论/看门狗的通知走 mail-outbox 队列。
// 队列的 deliver 参数直接引用它，失败时由队列负责退避重试。
export async function deliver(msg) {
  const cfg = smtpConfig();
  const to = msg.to || ownerEmail();
  if (!cfg) {
    logToConsole({ ...msg, to }, '未配置 SMTP');
    return { sent: false, reason: 'not-configured' };
  }
  if (!to) {
    logToConsole(msg, '未设置收件人');
    return { sent: false, reason: 'no-recipient' };
  }
  try {
    const t = await getTransport(cfg);
    if (!t) { logToConsole({ ...msg, to }, 'nodemailer 不可用'); return { sent: false, reason: 'no-transport' }; }
    await t.sendMail({
      from: fromAddress(),
      to: headerValue(to),
      subject: headerValue(msg.subject),
      text: msg.text,
      html: msg.html,
      headers: msg.headers,
    });
    return { sent: true };
  } catch (err) {
    console.error(JSON.stringify({ event: 'mail.failed', code: err.code ?? 'SEND_FAILED' }));
    logToConsole({ ...msg, to }, '发送失败，以下为原文');
    return { sent: false, reason: `邮件发送失败（${err.code ?? 'SEND_FAILED'}）` };
  }
}

// 兼容旧调用方：既要立即投递又要拿到结果的地方（后台测试、外部探针）继续用 send()。
export const send = deliver;

function logToConsole(msg, why) {
  console.log(JSON.stringify({ event: 'mail.not-sent', messageId: crypto.randomUUID(), reason: why }));
  if (process.env.NODE_ENV !== 'production' && process.env.MAIL_DEBUG === 'true') {
    const text = String(msg.text ?? '').replace(/https?:\/\/[^\s]+\/(?:moderate|unsubscribe)\/[^\s]+/g, '[带签名的链接已隐藏]')
      .replace(/[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/gi, '[邮箱已隐藏]');
    console.log(text);
  }
}

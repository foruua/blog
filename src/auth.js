import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { DATA_DIR } from './config.js';
import { atomicWrite } from './util/files.js';

// 邮箱只以密文落库；需要明文时统一走这里——decrypt 自身已吞异常并回 null，解不开就当空串。
export const decryptEmail = (crypt, enc) => crypt?.decrypt(enc) ?? '';

const KEY = 'app_secret';
// 密钥不能再跟着数据库走：数据库是备份的一部分，密钥若也在里面，拿到备份的人就能解开所有邮箱与 SMTP 密码。
// 默认放 DATA_DIR/.app-secret（600）；也可以用 APP_SECRET 或 APP_SECRET_FILE 覆盖。
const SECRET_FILE = path.resolve(process.env.APP_SECRET_FILE ?? path.join(DATA_DIR, '.app-secret'));

function readSecretFile(file) {
  try {
    const value = fs.readFileSync(file, 'utf8').trim();
    return value || null;
  } catch { return null; }
}

function writeSecretFile(file, secret) {
  atomicWrite(file, `${secret}\n`, 0o600);
  try { fs.chmodSync(file, 0o600); } catch { /* Windows / 权限受限时至少不阻断启动 */ }
}

const aesKeyOf = (secret) => crypto.createHash('sha256').update(`${secret}:email`).digest();

function decryptWith(key, blob) {
  const [v, ivB, encB, tagB] = String(blob).split('.');
  if (v !== 'v1') return null;
  const d = crypto.createDecipheriv('aes-256-gcm', key, Buffer.from(ivB, 'base64url'));
  d.setAuthTag(Buffer.from(tagB, 'base64url'));
  return Buffer.concat([d.update(Buffer.from(encB, 'base64url')), d.final()]).toString('utf8');
}

export function createCrypto(db, { secretFile = SECRET_FILE } = {}) {
  const legacy = db.prepare('SELECT value FROM settings WHERE key = ?').get(KEY)?.value ?? null;
  const envSecret = String(process.env.APP_SECRET ?? '').trim() || null;
  const fileSecret = readSecretFile(secretFile);
  let primary = envSecret ?? fileSecret;

  if (!primary) {
    // 老库的 app_secret 是原先唯一的密钥：先搬进文件再停用数据库里的那份，已有密文才不会被解坏。
    primary = legacy || crypto.randomBytes(32).toString('hex');
    try { writeSecretFile(secretFile, primary); }
    catch (error) {
      if (!legacy) throw new Error('无法创建 APP_SECRET：请配置 APP_SECRET 或 APP_SECRET_FILE', { cause: error });
      console.warn(JSON.stringify({ event: 'crypto.secret-file-failed', code: error?.code ?? 'FS' }));
    }
  }

  // 同一个密钥不需要在库里留副本；密钥不同（例如刚设置 APP_SECRET）则保留旧值作为解密回退。
  if (legacy === primary) {
    try { db.prepare('DELETE FROM settings WHERE key = ?').run(KEY); } catch { /* 只读连接（外部探针）忽略 */ }
  }

  const aesKey = aesKeyOf(primary);
  const decryptKeys = [...new Set([primary, legacy, fileSecret].filter(Boolean))].map(aesKeyOf);
  const hmac = (s) => crypto.createHmac('sha256', primary).update(s).digest('base64url');

  return {

    sign(data, ttlSec = 7 * 24 * 3600) {
      const payload = { ...data, exp: Math.floor(Date.now() / 1000) + ttlSec };
      const body = Buffer.from(JSON.stringify(payload), 'utf8').toString('base64url');
      return `${body}.${hmac(body)}`;
    },

    verify(token) {
      const parts = String(token ?? '').split('.');
      if (parts.length !== 2 || parts[0].length > 4096) return null;
      const [body, sig] = parts;
      if (!body || !sig) return null;
      const expect = hmac(body);

      const a = Buffer.from(sig);
      const b = Buffer.from(expect);
      if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) return null;
      try {
        const payload = JSON.parse(Buffer.from(body, 'base64url').toString('utf8'));
        if (!payload || typeof payload !== 'object' || !Number.isFinite(payload.exp) || payload.exp <= Math.floor(Date.now() / 1000)) return null;
        return payload;
      } catch { return null; }
    },

    encrypt(plain) {
      if (!plain) return null;
      const iv = crypto.randomBytes(12);
      const c = crypto.createCipheriv('aes-256-gcm', aesKey, iv);
      const enc = Buffer.concat([c.update(String(plain), 'utf8'), c.final()]);
      return `v1.${iv.toString('base64url')}.${enc.toString('base64url')}.${c.getAuthTag().toString('base64url')}`;
    },

    decrypt(blob) {
      if (!blob) return null;
      for (const key of decryptKeys) {
        try { return decryptWith(key, blob); } catch { /* 换下一把旧密钥 */ }
      }
      return null;
    },

    fingerprint(email) {
      const norm = String(email ?? '').trim().toLowerCase();
      if (!norm) return null;
      return crypto.createHmac('sha256', primary).update(`email:${norm}`).digest('hex').slice(0, 32);
    },

    ipHash(ip) {
      const norm = String(ip ?? '').trim();
      if (!norm) return null;
      return crypto.createHmac('sha256', primary).update(`ip:${norm}`).digest('hex').slice(0, 32);
    },
  };
}

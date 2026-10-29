import crypto from 'node:crypto';
import { getCookie, setCookie, deleteCookie } from 'hono/cookie';
import { promisify } from 'node:util';
import { cookieBase, readBody } from '../util/http.js';
import { ADMIN_COOKIE } from '../http/cookies.js';
import { createAntispam } from '../comments/antispam.js';

const PW_KEY = 'admin_password_hash';
const EP_KEY = 'admin_session_epoch';
const COOKIE = ADMIN_COOKIE;
const SESSION_TTL = 30 * 24 * 3600;

const SCRYPT = { N: 32768, r: 8, p: 1, keylen: 64, maxmem: 256 * 1024 * 1024 };

export function hashPassword(pw) {
  const salt = crypto.randomBytes(16);
  const key = crypto.scryptSync(String(pw), salt, SCRYPT.keylen, SCRYPT);
  return ['scrypt', SCRYPT.N, SCRYPT.r, SCRYPT.p, salt.toString('base64url'), key.toString('base64url')].join('$');
}

// 用 hash 里记录的 N/r/p 去验（常量存在的意义就是存下当时的参数），否则调强参数会让存量密码静默验不过、后台锁死；但参数必须落区间：被篡改的 hash 不能靠超大 N 打爆内存。
function scryptParams(stored) {
  const [scheme, N, r, p, saltB, keyB] = String(stored).split('$');
  if (scheme !== 'scrypt') return null;
  const n = Number(N), rr = Number(r), pp = Number(p);
  if (!Number.isInteger(n) || !Number.isInteger(rr) || !Number.isInteger(pp)) return null;
  if (n < 1 << 14 || n > 1 << 20 || (n & (n - 1)) !== 0) return null;
  if (rr < 1 || rr > 32 || pp < 1 || pp > 16) return null;
  if (n * rr > 1 << 21) return null;                       // 128·N·r ≤ 256MB
  const salt = Buffer.from(saltB, 'base64url');
  const expected = Buffer.from(keyB, 'base64url');
  if (salt.length < 8 || expected.length < 16 || expected.length > 128) return null;
  return { n, r: rr, p: pp, salt, expected, maxmem: Math.max(SCRYPT.maxmem, 256 * n * rr) };
}

export function verifyPassword(pw, stored) {
  try {
    const params = scryptParams(stored);
    if (!params) return false;
    const key = crypto.scryptSync(String(pw), params.salt, params.expected.length,
      { N: params.n, r: params.r, p: params.p, maxmem: params.maxmem });
    return key.length === params.expected.length && crypto.timingSafeEqual(key, params.expected);
  } catch { return false; }
}

const scryptAsync = promisify(crypto.scrypt);

// 改密码时用它：同步 scrypt 会在请求路径上阻塞事件循环（约几十毫秒），登录验证已经是异步的，
// 这里没有理由再退回去。scripts/set-password 仍用同步版（CLI 没有并发请求）。
async function hashPasswordAsync(pw) {
  const salt = crypto.randomBytes(16);
  const key = await scryptAsync(String(pw), salt, SCRYPT.keylen,
    { N: SCRYPT.N, r: SCRYPT.r, p: SCRYPT.p, maxmem: SCRYPT.maxmem });
  return ['scrypt', SCRYPT.N, SCRYPT.r, SCRYPT.p, salt.toString('base64url'), key.toString('base64url')].join('$');
}

async function verifyPasswordAsync(pw, stored) {
  try {
    const params = scryptParams(stored);
    if (!params) return false;
    const key = await scryptAsync(String(pw), params.salt, params.expected.length,
      { N: params.n, r: params.r, p: params.p, maxmem: params.maxmem });
    return key.length === params.expected.length && crypto.timingSafeEqual(key, params.expected);
  } catch { return false; }
}
export function clearPassword(db) {
  db.exec('BEGIN IMMEDIATE');
  try {
    db.prepare('DELETE FROM settings WHERE key=?').run(PW_KEY);
    db.prepare(`INSERT INTO settings(key,value) VALUES(?, '1') ON CONFLICT(key) DO UPDATE SET value=CAST(value AS INTEGER)+1`).run(EP_KEY);
    db.exec('COMMIT');
  } catch (e) { db.exec('ROLLBACK'); throw e; }
}

export function createAdminAuth({ db, crypt }) {
  // 登录失败限流与全站 antispam 共用同一实现（含 sweep、MAX_KEYS 硬淘汰），
  // 不再自建一份会漂移的滑动窗口。blocked() 只查不记，失败在验证后由 recordFailure 记账。
  const loginLimiter = createAntispam({ windowMs: 15 * 60 * 1000, maxPerWindow: 5 });
  const loginBlocked = (ipHash) => loginLimiter.blocked(ipHash);
  const recordFailure = (ipHash) => { loginLimiter.rateLimited(ipHash); };
  // scrypt 单次约 32MB 内存；同时最多跑 2 个，超出的请求短暂排队，而不是直接判失败把站主也锁在门外。
  const SLOT_LIMIT = 2;
  const SLOT_WAIT_MS = 1500;
  let checking = 0;
  const slotWaiters = [];
  const activeIps = new Map();

  function releaseSlot() {
    const next = slotWaiters.shift();
    if (next) {
      clearTimeout(next.timer);
      next.resolve(releaseSlot);   // 槽位直接转交，checking 不变
      return;
    }
    checking = Math.max(0, checking - 1);
  }
  function takeSlot() {
    if (checking < SLOT_LIMIT) { checking++; return Promise.resolve(releaseSlot); }
    // 队列也有上限：大量 IP 打满时不能让等待者无限堆积。
    if (slotWaiters.length >= 64) return Promise.resolve(null);
    return new Promise((resolve) => {
      const waiter = { resolve, timer: null };
      waiter.timer = setTimeout(() => {
        const index = slotWaiters.indexOf(waiter);
        if (index >= 0) slotWaiters.splice(index, 1);
        resolve(null);
      }, SLOT_WAIT_MS);
      waiter.timer.unref?.();
      slotWaiters.push(waiter);
    });
  }
  // 同一 IP 同时只允许一个登录校验：一个来源不能独占两个全局槽。
  function enterIp(ipHash) {
    const key = ipHash || 'unknown';
    if ((activeIps.get(key) ?? 0) > 0) return false;
    activeIps.set(key, 1);
    return true;
  }
  function leaveIp(ipHash) {
    const key = ipHash || 'unknown';
    const n = (activeIps.get(key) ?? 1) - 1;
    if (n > 0) activeIps.set(key, n);
    else activeIps.delete(key);
  }

  const settingQuery = db.prepare('SELECT value FROM settings WHERE key = ?');
  const getSetting = (k) => settingQuery.get(k)?.value ?? null;


  const epoch = () => Number(getSetting(EP_KEY) ?? 0);

  const cookieExtra = () => ({ ...cookieBase(), maxAge: SESSION_TTL });

  // 撤销记录保留至 cookie 到期；兼容旧版仅存 SID 的记录。
  const REVOKED_KEY = 'admin_revoked_sids';
  const readRevoked = () => {
    const now = Math.floor(Date.now() / 1000);
    // 名单是后台写的 JSON，可能被手改坏或写一半；解析失败退化成空集，否则 logout 里 revoke(readRevoked()) 会直接 500——登录态撤销不了、cookie 却已删。
    let value;
    try { value = JSON.parse(getSetting(REVOKED_KEY) ?? '[]'); }
    catch { return []; }
    if (!Array.isArray(value)) return [];
    return value.map((item) => typeof item === 'string' ? { sid: item, exp: now + SESSION_TTL } : item)
      .filter((item) => item && typeof item.sid === 'string' && Number.isFinite(item.exp) && item.exp > now);
  };
  function revoke(payload) {
    if (!payload?.sid) return;
    const list = [...readRevoked().filter((item) => item.sid !== payload.sid), { sid: payload.sid, exp: payload.exp }];
    db.prepare(`INSERT INTO settings(key,value) VALUES(?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value`)
      .run(REVOKED_KEY, JSON.stringify(list));
  }

  // 过期撤销记录只会在下一次 revoke 时被顺带写回；登录成功时也清一次，避免长期不登出时名单无限积累。
  function pruneRevoked() {
    const stored = getSetting(REVOKED_KEY);
    if (!stored) return;
    const list = readRevoked();
    const normalized = JSON.stringify(list);
    if (normalized !== stored) {
      db.prepare(`INSERT INTO settings(key,value) VALUES(?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value`)
        .run(REVOKED_KEY, normalized);
    }
  }

  function issue(c, ipHash) {
    const csrf = crypto.randomBytes(18).toString('base64url');
    const sid = crypto.randomUUID();
    const token = crypt.sign({ uid: 'owner', ep: epoch(), csrf, sid }, SESSION_TTL);
    setCookie(c, COOKIE, token, cookieExtra());
    if (ipHash) loginLimiter.clear(ipHash);
    try { pruneRevoked(); } catch { /* 清理失败不影响本次登录 */ }
    return token;
  }

  function resolveSession(c) {
    const raw = getCookie(c, COOKIE);
    if (!raw || !getSetting(PW_KEY)) return null;
    const payload = crypt.verify(raw);
    if (!payload || payload.uid !== 'owner') return null;
    if (Number(payload.ep ?? -1) !== epoch()) return null;
    try { if (payload.sid && readRevoked().some((item) => item.sid === payload.sid)) return null; }
    catch { return null; }
    return payload;
  }

  // session() 同一请求会被问好几遍（每次三次 settings 查询 + 撤销名单解析），按请求记忆化；null 也合法，用 undefined 判「没算过」。
  function session(c) {
    let cached = c.get('adminSession');
    if (cached === undefined) { cached = resolveSession(c); c.set('adminSession', cached); }
    return cached;
  }

  function logout(c) {
    revoke(session(c));
    deleteCookie(c, COOKIE, { path: '/' });
  }

  // 登录与改密码共用的旧密码校验：限流、同 IP 单飞、scrypt 槽位、失败记账都只留这一份。
  async function verifyOwnerPassword(password, ipHash) {
    const stored = getSetting(PW_KEY);
    if (!stored) return { ok: false, reason: 'not-configured' };
    if (loginBlocked(ipHash)) return { ok: false, reason: 'rate-limited' };
    // 槽满时短暂排队（最多 1.5s），让站主在攻击流量之间也能轮到一次；同一个 IP 只占一个槽。
    if (!enterIp(ipHash)) return { ok: false, reason: 'rate-limited' };
    let valid;
    try {
      const release = await takeSlot();
      if (!release) return { ok: false, reason: 'rate-limited' };
      try { valid = await verifyPasswordAsync(password, stored); } finally { release(); }
    } finally { leaveIp(ipHash); }
    // Password may have been cleared or rotated while the hash was being computed.
    if (!valid || stored !== getSetting(PW_KEY)) {
      recordFailure(ipHash);
      return { ok: false, reason: 'bad-password' };
    }
    return { ok: true, stored };
  }

  async function attemptLogin(c, password, ipHash) {
    const verified = await verifyOwnerPassword(password, ipHash);
    if (!verified.ok) return verified;
    issue(c, ipHash);
    return { ok: true };
  }

  /**
   * 改密码：验旧密码走与登录完全同一条路径（verifyOwnerPassword），
   * 通过后换 hash、把 epoch +1（其它设备上的会话立即失效），再用新 epoch 重签当前会话——
   * 否则改完密码第一件事就是被自己踢下线。
   */
  async function changePassword(c, currentPw, nextPw, ipHash) {
    const verified = await verifyOwnerPassword(currentPw, ipHash);
    if (!verified.ok) return verified;
    const blob = await hashPasswordAsync(nextPw);
    db.exec('BEGIN IMMEDIATE');
    try {
      db.prepare(`INSERT INTO settings(key,value) VALUES(?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value`).run(PW_KEY, blob);
      db.prepare(`INSERT INTO settings(key,value) VALUES(?, '1') ON CONFLICT(key) DO UPDATE SET value=CAST(value AS INTEGER)+1`).run(EP_KEY);
      db.exec('COMMIT');
    } catch (error) {
      db.exec('ROLLBACK');
      throw error;
    }
    issue(c, ipHash);
    return { ok: true };
  }

  function csrfOf(c) {
    return session(c)?.csrf ?? '';
  }

  function csrfOk(c, provided) {
    const expect = csrfOf(c);
    if (!expect) return false;
    const got = String(provided ?? '');
    const a = Buffer.from(got); const b = Buffer.from(expect);
    return a.length === b.length && crypto.timingSafeEqual(a, b);
  }

  function requireOwner() {
    return async (c, next) => {
      if (!session(c)) {

        if (c.req.path.startsWith('/admin/api/')) {
          return c.json({ ok: false, error: 'unauthorized' }, 401);
        }
        const to = encodeURIComponent(c.req.path);
        return c.redirect(`/admin/login?to=${to}`, 303);
      }

      if (c.req.method !== 'GET' && c.req.method !== 'HEAD') {
        // 上传前端用 x-csrf-token 且 body 是原始二进制：不能为了再读一次 _csrf 把已流式消费/落盘的 body 当表单解析。
        let provided = c.req.header('x-csrf-token');
        if (!provided) {
          const parsed = await readBody(c);
          provided = parsed instanceof FormData ? String(parsed.get('_csrf') ?? '') : String(parsed?._csrf ?? '');
        }
        if (!csrfOk(c, provided)) return c.json({ ok: false, error: 'csrf' }, 403);
      }
      await next();
    };
  }

  return {
    configured: () => Boolean(getSetting(PW_KEY)),
    issue, session, logout,
    attemptLogin,
    changePassword,
    csrfOf,
    csrfOk,
    requireOwner,
  };
}

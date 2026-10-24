import { previewSourceOf } from '../../media/variants.js';
import { externalWrite, bodyOf, val, notice } from './shared.js';
import { subscriberCount, clearSubscribers } from '../../comments/subscribers.js';
import { settingsFormState, saveSettings, KEYS, HERO_MAX, HERO_OVERLAY_MAX, HERO_LEGACY_KEYS, HERO_RETIRED_KEYS, heroImages, heroOverlay } from '../../settings.js';
import {
  KEYS as MAIL_KEYS, DEFAULTS as MAIL_DEFAULTS, TLS_MODES, TLS_LABEL, PRESETS,
  configSource, smtpConfig, ownerEmail, fromAddress,
  resetTransport, send as sendMail,
} from '../../mail.js';
import { systemPage } from '../../admin/views/system.js';
import { EMAIL_LOOSE_RE } from '../../util/validation.js';
import { isSafeUploadPath } from '../../util/url.js';
import { smtpTestLetter } from '../../email/letters.js';


export function registerSettingsRoutes(app, { repo, crypt, adminRepo, mutate = (fn) => fn(), outbox = null }, { ctx }) {
  function mailFormState() {
    const source = configSource();
    const eff = smtpConfig();
    return {
      source,
      presets: PRESETS,

      host: repo.getSetting(MAIL_KEYS.host) || (eff?.host ?? ''),
      port: repo.getSetting(MAIL_KEYS.port) || String(eff?.port ?? MAIL_DEFAULTS.port),
      tls: repo.getSetting(MAIL_KEYS.tls) || (eff?.tls ?? MAIL_DEFAULTS.tls),
      user: repo.getSetting(MAIL_KEYS.user) || (eff?.auth?.user ?? ''),
      to: repo.getSetting(MAIL_KEYS.to) || ownerEmail(),
      from: repo.getSetting(MAIL_KEYS.from) || fromAddress(),
      hasPass: Boolean(repo.getSetting(MAIL_KEYS.pass) || process.env.SMTP_PASS),
      queue: outbox?.stats() ?? null,
    };
  }

  const EMAIL_RE = EMAIL_LOOSE_RE;
  const HOST_RE = /^[A-Za-z0-9._-]+$/;

  function saveMailConfig(b) {
    const host = val(b, 'host').trim();
    const portRaw = val(b, 'port').trim();
    const user = val(b, 'user').trim();
    const pass = val(b, 'pass');
    const tls = val(b, 'tls').trim();
    const to = val(b, 'to').trim();
    const from = val(b, 'from').trim();

    if (!host) return 'SMTP 主机不能为空（要清空配置请点「清除页面配置」）';
    if (!HOST_RE.test(host) || host.length > 253) return `SMTP 主机格式不对：${host}`;
    const port = Number(portRaw || MAIL_DEFAULTS.port);
    if (!Number.isInteger(port) || port < 1 || port > 65535) return `端口不合法：${portRaw}`;
    if (to && !EMAIL_RE.test(to)) return `收件人不像邮箱地址：${to}`;
    // from 可能带显示名，故不整串校验邮箱；但必须挡换行/控制字符，否则可注入邮件头（以前只查 includes('@')），并要求确实有地址。
    if (from && (/[\r\n\0]/.test(from) || from.length > 320)) return `发信人里含有非法字符：${from}`;
    if (from && !/[^\s@<>]+@[^\s@<>]+\.[^\s@<>]+/.test(from)) return `发信人里必须带一个邮箱地址：${from}`;
    if (!TLS_MODES.includes(tls)) return `加密方式不合法：${tls}（只能是 ${TLS_MODES.join(' / ')}）`;
    if (pass && pass !== pass.trim()) return '授权码首尾不能有空白字符';
    if (user && !EMAIL_RE.test(user) && !/^\d+$/.test(user)) return `账号不像邮箱地址也不像 QQ 号：${user}`;

    const blob = pass ? crypt.encrypt(pass) : null;
    if (pass && !blob) return '授权码加密失败，未保存';
    repo.transaction(() => {
      repo.setSetting(MAIL_KEYS.host, host);
      repo.setSetting(MAIL_KEYS.port, String(port));
      repo.setSetting(MAIL_KEYS.tls, tls);
      repo.setSetting(MAIL_KEYS.user, user);
      repo.setSetting(MAIL_KEYS.to, to);
      repo.setSetting(MAIL_KEYS.from, from);
      if (pass) repo.setSetting(MAIL_KEYS.pass, blob);
    });
    resetTransport();
    return null;
  }

  async function saveMailAndVerify(c, alwaysVerify) {
    const body = await bodyOf(c);
    const err = await mutate(() => saveMailConfig(body));
    if (err) {
      // 校验失败时用刚提交的值重渲染，别把整张表单清回数据库里的旧配置。
      const mail = {
        ...mailFormState(),
        host: val(body, 'host'), port: val(body, 'port'), tls: val(body, 'tls'),
        user: val(body, 'user'), to: val(body, 'to'), from: val(body, 'from'),
        hasPass: Boolean(val(body, 'pass') || mailFormState().hasPass),
      };
      return systemHtml(c, { notice: `✗ ${err}`, mail });
    }
    if (!alwaysVerify && val(body, 'verify') !== '1') {
      return notice(c, '/admin/system', '✓ 邮件配置已保存');
    }
    const cfg = smtpConfig();
    const to = ownerEmail();
    if (!cfg) return notice(c, '/admin/system', '✓ 已保存（没配 SMTP 主机，跳过测试邮件）');
    if (!to) return notice(c, '/admin/system', '✓ 已保存（没填通知收件人，跳过测试邮件）');

    const r = await sendMail({
      to,
      ...smtpTestLetter({
        to,
        host: cfg.host,
        port: cfg.port,
        tlsLabel: TLS_LABEL[cfg.tls] ?? cfg.tls,
        from: fromAddress(),
        at: new Date().toISOString(),
      }),
    });
    const msg = r.sent
      ? `✓ 已保存，测试邮件已发送到 ${to}`
      : `✓ 已保存，但测试邮件发送失败：${r.reason}`;
    return notice(c, '/admin/system', msg);
  }

  externalWrite(app, '/admin/mail', (c) => saveMailAndVerify(c, false));
  externalWrite(app, '/admin/mail/test', (c) => saveMailAndVerify(c, true));

  // 退订名单只在此显示人数；读写都走 subscribers.js（唯一入口）。
  const unsubCount = () => subscriberCount(repo);

  app.post('/admin/mail/unsub/clear', async (c) => {
    await clearSubscribers(repo);
    return notice(c, '/admin/system', '✓ 已清空退订名单');
  });

  app.post('/admin/mail/clear', (c) => {
    repo.transaction(() => { for (const k of Object.values(MAIL_KEYS)) repo.setSetting(k, ''); });
    resetTransport();
    return notice(c, '/admin/system', '✓ 已清除页面配置');
  });

  // 发信队列：只把终态失败的重新排队，接着立即尝试一轮。仍在退避中的 pending 不改 next_attempt_at，
  // 避免站主连点把「重试」变成绕过退避的轰炸按钮。
  externalWrite(app, '/admin/mail/queue/retry', async (c) => {
    if (!outbox) return notice(c, '/admin/system', '✗ 发信队列未启用');
    const retried = outbox.retryFailed();
    // 不在请求里等 SMTP：失败邮件多时每封都可能等满连接超时，先把它们放回队列再后台跑。
    void outbox.flush({ force: true }).catch((error) => console.error(JSON.stringify({ event: 'mail.manual-retry-failed', code: error?.code ?? 'INTERNAL' })));
    const q = outbox.stats();
    return notice(c, '/admin/system', `✓ 已把 ${retried} 封失败邮件放回队列；当前待发 ${q.pending} / 失败 ${q.failed}`);
  });

  app.post('/admin/settings', async (c) => {

    const b = await bodyOf(c);
    const err = repo.transaction(() => saveSettings({
      pageSize: val(b, 'pageSize'),
      homeRecent: val(b, 'homeRecent'),
      commentsPerPage: val(b, 'commentsPerPage'),
      palette: val(b, 'palette'),
    }, (k, v) => repo.setSetting(k, v)));
    return notice(c, '/admin/system', err ? `✗ ${err}` : '✓ 设置已保存');
  });

  const HERO_KEYS = HERO_LEGACY_KEYS;

  function systemHtml(c, { notice = '', mail = null, hero = null } = {}) {
    return c.html(systemPage(ctx(c, {
      notice,
      mail: mail ?? mailFormState(),
      hero: hero ?? heroFormState(),
      site: settingsFormState(repo),
      history: adminRepo.historyCounts(),
      unsub: unsubCount(),
    })));
  }

  function heroUrlOk(u) {
    return isSafeUploadPath(u);
  }

  // 封面只能是图片：优先看媒体库记录的 MIME；记录已被清掉的老路径退回扩展名判断。
  const IMAGE_EXT_RE = /\.(?:png|jpe?g|gif|webp|avif)(?:$|[?#])/i;
  function heroImageOk(path) {
    if (!heroUrlOk(path)) return false;
    const mime = String(adminRepo.mediaByPath(path)?.mime ?? '');
    return mime ? mime.startsWith('image/') : IMAGE_EXT_RE.test(path);
  }

  function heroFormState() {
    return {
      images: heroImages(repo).map((im) => {
        const item = adminRepo.mediaByPath(im.path);
        return { ...im, thumbnail: previewSourceOf(item, 960) };
      }),
      overlay: heroOverlay(repo),
    };
  }

  /** 表单里那份 JSON：只收 {path,w,h}，路径必须是站内上传的图片地址，同一张图不重复。 */
  function parseHeroList(raw) {
    let data;
    try { data = JSON.parse(raw); } catch { return '首页封面数据不是合法的 JSON'; }
    if (!Array.isArray(data)) return '首页封面数据格式不对';
    if (data.length > HERO_MAX) return `首页封面最多 ${HERO_MAX} 项`;
    const list = [], seen = new Set();
    for (const it of data) {
      const path = String(it?.path ?? '').trim();
      if (!path) return '首页封面列表里有空的地址';
      if (!heroUrlOk(path)) return `首页封面只能用站内上传的地址（/uploads/…）：${path}`;
      if (!heroImageOk(path)) return `首页封面只能用图片：${path}`;
      if (seen.has(path)) return `同一项重复出现：${path}`;
      seen.add(path);
      const dim = (v) => (/^\d{1,5}$/.test(String(v ?? '').trim()) ? String(v).trim() : '');
      list.push({ path, w: dim(it?.w), h: dim(it?.h) });
    }
    return list;
  }

  function saveHeroConfig(b) {

    let list;
    const raw = val(b, 'images').trim();
    if (raw) {
      const parsed = parseHeroList(raw);
      if (typeof parsed === 'string') return parsed;
      list = parsed;
    } else {
      const url = val(b, 'url').trim();
      if (url && !heroUrlOk(url)) return `首页封面只能用站内上传的地址（/uploads/…）：${url}`;
      if (url && !heroImageOk(url)) return `首页封面只能用图片：${url}`;
      const dim = (k) => (/^\d{1,5}$/.test(val(b, k).trim()) ? val(b, k).trim() : '');
      list = url ? [{ path: url, w: dim('w'), h: dim('h') }] : [];
    }

    const overlay = val(b, 'overlay').trim().slice(0, HERO_OVERLAY_MAX);
    const first = list[0];
    repo.transaction(() => {
      repo.setSetting(KEYS.heroImages, list.length ? JSON.stringify(list) : '');
      repo.setSetting(KEYS.heroOverlay, overlay);
      // 旧键镜像（单图时代的读者/脚本仍认这三个键）：存列表第一张。
      repo.setSetting(HERO_KEYS.url, first?.path ?? '');
      repo.setSetting(HERO_KEYS.w, first?.w && first?.h ? first.w : '');
      repo.setSetting(HERO_KEYS.h, first?.w && first?.h ? first.h : '');
    });
    return null;
  }

  app.post('/admin/hero', async (c) => {
    const body = await bodyOf(c);
    const err = saveHeroConfig(body);
    if (!err) return notice(c, '/admin/system', '✓ 首页封面已保存');
    // 校验失败保留本次选择（图片已经上传成功，不能因为一个路径错误就清空列表）。
    let images = [];
    try {
      const data = JSON.parse(val(body, 'images') || '[]');
      if (Array.isArray(data)) images = data.map((it) => ({
        path: String(it?.path ?? ''), w: String(it?.w ?? ''), h: String(it?.h ?? ''),
      })).filter((it) => it.path && heroImageOk(it.path));
    } catch { /* 保留空列表，至少显示错误 */ }
    if (!images.length) {
      const url = val(body, 'url').trim();
      if (url && heroImageOk(url)) images = [{ path: url, w: val(body, 'w'), h: val(body, 'h') }];
    }
    const hero = {
      images: images.map((im) => {
        const item = adminRepo.mediaByPath(im.path);
        return { ...im, thumbnail: previewSourceOf(item, 960) };
      }),
      overlay: val(body, 'overlay').trim().slice(0, HERO_OVERLAY_MAX),
    };
    return systemHtml(c, { notice: `✗ ${err}`, hero });
  });

  app.post('/admin/hero/clear', (c) => {
    repo.transaction(() => {
      for (const k of [KEYS.heroImages, KEYS.heroOverlay, ...Object.values(HERO_LEGACY_KEYS), ...HERO_RETIRED_KEYS]) repo.setSetting(k, '');
    });
    return notice(c, '/admin/system', '✓ 已移除首页展示，图片保留在媒体库');
  });

  // 清空全站修订历史与旧链接（301 映射）。只动 revisions / aliases 两张历史表，不碰 posts 里的正文与评论。
  app.post('/admin/history/clear', (c) => {
    const removed = adminRepo.clearHistory();
    return notice(c, '/admin/system', `✓ 已清空 ${removed.revisions} 条修订与 ${removed.aliases} 条旧链接`);
  });

  app.get('/admin/system', (c) => systemHtml(c, { notice: c.req.query('w') ?? '' }));

}

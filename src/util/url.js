// 友链页归并键：从评论的「网址」抽出站点 host。三条规则各有理由：只留 host（协议/路径/查询串都丢——
// a.com/some/post?utm=x 与 a.com 同站，留路径会让一次分享把一条友链拆成两条；URL.hostname 不含端口，
// a.com:8080 也自动归一）；小写（host 本大小写不敏感，但库里存原样）；剥开头 www.（www.a.com 与 a.com
// 人眼同站）。解不出来一律 null，调用方据此排除。
// ⚠️ db/migrations/023_links.sql 有一次性 SQL 回填版本，改这里必须同步改那里。
export function safeHttpUrl(raw) {
  const s = String(raw ?? '').trim();
  if (!s) return null;
  let url;
  try { url = new URL(s); } catch { return null; }
  return url.protocol === 'http:' || url.protocol === 'https:' ? url.href : null;
}

// 用户填的「网址」：允许省略协议，补 https 后交给 URL 解析；显式 javascript:/ftp: 不会被补成 https。
export function normalizeUserUrl(raw, { maxLength = 200 } = {}) {
  const s = String(raw ?? '').trim().slice(0, maxLength);
  if (!s) return null;
  return safeHttpUrl(/^https?:\/\//i.test(s) ? s : `https://${s}`);
}

export function websiteHost(raw) {
  const href = safeHttpUrl(raw);
  if (!href) return null;
  try {
    const host = new URL(href).hostname.toLowerCase().replace(/^www\./, '');
    return host || null;
  } catch { return null; }
}

/**
 * 首页封面/媒体字段只接受站内上传路径。保存与读取共用同一套规则，
 * 否则会出现「后台能存、前台过滤掉」或反过来的静默不一致。
 */
export function isSafeUploadPath(value) {
  return typeof value === 'string'
    && value.length > 0 && value.length <= 500
    && value.startsWith('/uploads/')
    // eslint-disable-next-line no-control-regex -- 这里就是要拒绝控制字符
    && !/[\s?#\\"'<>`\u0000-\u001f\u007f]/u.test(value)
    && !value.includes('..');
}

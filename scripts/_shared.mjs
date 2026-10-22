// 测试共用：后台会话 cookie 与「进度片段」解析（原先各套件各写一份，易改一处忘一处）。
export function cookieJar(name = 'blog_admin') {
  let value = '';
  return {
    get cookie() { return value; },
    set cookie(v) { value = v; },
    absorb(res) {
      const list = typeof res.headers.getSetCookie === 'function'
        ? res.headers.getSetCookie()
        : [res.headers.get('set-cookie')].filter(Boolean);
      for (const c of list) {
        const [pair] = String(c).split(';');
        const [k, v] = pair.split('=');
        if (k.trim() === name) value = v === '' ? '' : `${name}=${v}`;
      }
    },
    header() { return value ? { Cookie: value } : {}; },
  };
}

/* 带会话 cookie 的测试请求器：redirect 一律手动（要读 303 的 Location），响应 cookie 自动吸回 jar。 */
export function createClient(base, jar) {
  return async (url, opts = {}) => {
    const res = await fetch(base + url, {
      ...opts, redirect: 'manual',
      headers: { ...(opts.headers ?? {}), ...jar.header() },
    });
    jar.absorb(res);
    return res;
  };
}

/* 从后台页面 HTML 取 CSRF 令牌（隐藏域）。 */
export function csrfOf(html) {
  return /name="_csrf" value="([^"]+)"/.exec(String(html))?.[1] ?? '';
}

/* 登录后台：POST /admin/login；成功后 cookie 已由 createClient 自动吸回 jar。 */
export function loginAdmin(req, password, { to = '/admin' } = {}) {
  return req('/admin/login', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ password, to }),
  });
}

/* 从后台页面里取「进度条」那一块（空壳也照取）。cls 形如 a-feeds-progress / a-links-progress。 */
export function progressOf(page, cls) {
  const m = new RegExp(`<p class="${cls}"[^>]*>([\\s\\S]*?)</p>`).exec(page);
  if (!m) return null;
  const attrs = m[0];
  const num = (k) => Number(new RegExp(`data-${k}="(\\d+)"`).exec(attrs)?.[1]);
  const pct = /width: (\d+)%/.exec(attrs);
  return {
    running: /data-running="1"/.test(attrs),
    completed: num('completed'), total: num('total'),
    percent: pct ? Number(pct[1]) : null,
    text: m[1].replace(/<[^>]+>/g, '').trim(),
  };
}

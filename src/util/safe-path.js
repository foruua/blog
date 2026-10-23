// 站内跳转地址校验：后台登录回跳（/admin/*）与主题切换回跳（任意站内路径）共用这一份。
// 以前两处各写一遍，规则已经开始漂移（一处带长度上限、一处没有），这类「看起来一样的安全检查」
// 是最容易在改一处时漏掉另一处的地方。

const CONTROL = (text) => {
  for (const ch of text) {
    const code = ch.codePointAt(0);
    if (code < 0x20 || code === 0x7f) return true;   // CR/LF 会拼出非法 Location 头（Hono 直接抛，跳转变 500）
  }
  return false;
};

/**
 * 只接受站内路径。
 * @param {unknown} value 待校验的地址（来自查询串/表单）
 * @param {{ prefix?: string, fallback?: string, maxLength?: number }} options
 *   prefix 限定目录（如 '/admin'：只放行 /admin 与其子路径，挡住 /administrator 这类同前缀路径）
 */
export function safeInternalPath(value, { prefix = '', fallback = '/', maxLength = 500 } = {}) {
  const text = String(value ?? '').trim();
  if (!text.startsWith('/') || text.startsWith('//') || text.includes('\\')) return fallback;
  if (prefix && !(text === prefix || text.startsWith(`${prefix}/`))) return fallback;
  if (CONTROL(text)) return fallback;
  // `/foo/..//evil`、`/%2e%2e//evil` 经浏览器归一化后可能变成协议相对地址或站外路径，直接拒绝。
  const pathname = text.split(/[?#]/, 1)[0];
  if (pathname.includes('//') || /%2e|%2f|%5c/i.test(pathname)
      || pathname.split('/').some((part) => part === '.' || part === '..')) return fallback;
  return text.slice(0, maxLength);
}

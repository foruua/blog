// 分页游标的解析口径只留一份：<ISO UTC 时间>|<数字 id>。ISO 的字典序即时间序。
// 旧格式、截断、手改的游标一律回第一页，调用方不必各自处理；友圈额外要求 id 必有（defaultId=''）。
const CURSOR_RE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/;

export function parseCursorParts(before, { defaultId = '0' } = {}) {
  if (!before) return null;
  const [ts, id = defaultId] = String(before).split('|');
  if (!CURSOR_RE.test(ts) || !/^\d+$/.test(id)) return null;
  return { ts, id: Number(id) };
}

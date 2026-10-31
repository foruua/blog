// 只记错误类别与堆栈位置；错误文本可能含邮箱、密码或签名 URL。
/**
 * @param {any} error
 * @param {{ event?: string, requestId?: string, method?: string, route?: string }} [meta]
 */
export function errorRecord(error, { event = 'request.failed', requestId, method, route } = {}) {
  const safeLabel = (value, fallback) => /^[A-Za-z0-9_.-]{1,80}$/.test(String(value ?? '')) ? String(value) : fallback;
  const frames = String(error?.stack ?? '').split('\n').filter((line) => /^\s+at /.test(line))
    .slice(0, 10).map((line) => line.replace(/https?:\/\/\S+/g, '[url]').replace(/[\w.+-]+@[\w.-]+\.[A-Za-z]{2,}/g, '[email]'));
  // 路由模板（/p/:slug）不含用户数据，能定位问题又不会把 slug/查询串写进日志。
  const safeRoute = /^\/[A-Za-z0-9_\-./:]{0,120}$/.test(String(route ?? '')) ? String(route) : undefined;
  return { event, requestId, method, route: safeRoute, code: safeLabel(error?.code, 'INTERNAL'),
    name: safeLabel(error?.name, 'Error'), frames };
}

// onError 阶段 Hono 还没把路由模板写回 req.routePath，只取它会让生产日志永远缺 route 字段——
// 排查 500 时只剩 method + INTERNAL，等于没有线索。退回到实际路径（不含查询串），
// 但 /moderate/<token> 的 token 就在路径里，必须打码，与开发环境的请求日志同一口径。
function routeOf(c) {
  const routePath = c?.req?.routePath;
  if (routePath) return routePath;
  const p = c?.req?.path;
  if (!p) return undefined;
  if (p.startsWith('/moderate/')) return '/moderate/:token';
  if (p.startsWith('/unsubscribe/')) return '/unsubscribe/:token';
  return p;
}

export function logError(error, c, event) {
  console.error(JSON.stringify(errorRecord(error, {
    event, requestId: c?.get('requestId'), method: c?.req.method, route: routeOf(c),
  })));
}

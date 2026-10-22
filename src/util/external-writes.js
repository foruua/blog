// 「外部 IO / 只读 POST」在路由声明处登记，server.js 据此把它们移出全局写队列（模块级单例，登记于路由组装、读取于每请求判定）。
const externalWrites = new Map();
const patterns = [];

export function externalWrite(app, route, handler) {
  if (!externalWrites.has(route)) {
    const pattern = route.split('/').map((part) => part.startsWith(':') ? '[^/]+' : part.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('/');
    const compiled = new RegExp(`^${pattern}$`);
    externalWrites.set(route, compiled);
    patterns.push(compiled);
  }
  app.post(route, handler);
}

export const isExternalWrite = (pathname) => patterns.some((pattern) => pattern.test(pathname));

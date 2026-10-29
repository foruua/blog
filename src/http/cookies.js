// 后台会话 cookie 名的唯一来源：鉴权、页面缓存判定与测试都从这里取，
// 改名时不会出现「登录换了、缓存仍按旧名放行」的静默错位。
export const ADMIN_COOKIE = 'blog_admin';

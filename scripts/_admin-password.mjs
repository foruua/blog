export function requireAdminPassword(suite) {
  const password = process.env.ADMIN_PASSWORD;
  if (password) return password;
  throw new Error(`${suite} 需要临时测试密码。请运行 npm test（自动创建隔离数据），不要使用真实后台密码。`);
}

// 邮箱形状校验：评论侧会把地址放进 mailto: 链接，必须挡掉 URI 分隔符；SMTP 配置只做宽松形状校验，
// 保持管理员可以填带显示名/服务商特殊字符的账号。两档规则集中在这里，避免各路由各写一份。
export const EMAIL_RE = /^[^\s@"'<>,;:/?#&=]+@[^\s@"'<>,;:/?#&=]+\.[^\s@"'<>,;:/?#&=]{2,}$/u;
export const EMAIL_LOOSE_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/u;

export const hasControlChar = (value) => /\p{Cc}/u.test(String(value ?? ''));

/** 邮件头值（收件人、主题、显示名）：折叠所有控制字符，别让换行把头部劈成两行。 */
export const headerValue = (value) => String(value ?? '')
  .replace(/[\r\n\p{Cc}]+/gu, ' ')
  .trim();

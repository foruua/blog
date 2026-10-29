// 邮箱形状校验：评论侧会把地址放进 mailto: 链接，必须挡掉 URI 分隔符；SMTP 配置只做宽松形状校验，
// 保持管理员可以填带显示名/服务商特殊字符的账号。两档规则集中在这里，避免各路由各写一份。
export const EMAIL_RE = /^[^\s@"'<>,;:/?#&=]+@[^\s@"'<>,;:/?#&=]+\.[^\s@"'<>,;:/?#&=]{2,}$/u;
export const EMAIL_LOOSE_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/u;

export const hasControlChar = (value) => /\p{Cc}/u.test(String(value ?? ''));

/** 邮件头值（收件人、主题、显示名）：折叠所有控制字符，别让换行把头部劈成两行。 */
export const headerValue = (value) => String(value ?? '')
  .replace(/[\r\n\p{Cc}]+/gu, ' ')
  .trim();

// 评论回复 id 的唯一解析口径：只认 1–10 位十进制正整数，不认 0x5 / 1e1 / 5.0 / +5 / 前导零。
// 缓存键与渲染路由必须共用这一个函数：以前缓存层用 parseInt、路由用 Number()，`?reply=0x5`
// 被算成「0，不计入键」与「5，渲染回复页」两种结果，于是「回复 #5」的整页被写进裸路径缓存，
// 60 秒内所有匿名读者打开这篇文章看到的都是回复 #5 的表单，评论也挂到 #5 下面。
const REPLY_ID_RE = /^[1-9]\d{0,9}$/;

/** 解析失败一律返回 null（= 当作没有 reply），由调用方决定「不缓存」还是「不预填」。 */
export const parseReplyId = (value) => {
  const raw = typeof value === 'string' ? value : '';
  return REPLY_ID_RE.test(raw) ? Number(raw) : null;
};

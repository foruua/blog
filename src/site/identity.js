import { SITE, ENV_SITE } from '../config.js';
import { EMAIL_LOOSE_RE, hasControlChar } from '../util/validation.js';

// —— 站点身份 ——
// 站名、简介、作者、博主邮箱、印章字、备案号（ICP 与公安）、语言原本只认 .env：改一个字要登服务器改文件再重启进程。
// 这里把它们搬进 settings 表，.env 退化成「出厂值」：DB 里是空串就逐项回落，老部署不改一行配置行为不变。
//
// 地址（SITE.url / SITE.domain）**故意不开放编辑**：它决定会话 cookie 的作用域、canonical、sitemap、
// RSS 与通知邮件里的绝对链接，填错一处整站链接和登录态一起坏，属于部署参数而不是内容。

const IDENTITY_KEYS = {
  title: 'site_title',
  desc: 'site_desc',
  author: 'site_author',
  email: 'site_email',
  mark: 'site_mark',
  icp: 'site_icp',
  police: 'site_police',
  lang: 'site_lang',
};

// 上限与后台输入框的 maxlength 保持一致：两处不同就会出现「填得进去、存不进去」。
export const IDENTITY_MAX = { title: 60, desc: 200, author: 40, mark: 40, icp: 60, police: 60, email: 120, lang: 20 };

const LANG_RE = /^[A-Za-z]{2,8}(?:-[A-Za-z0-9]{1,8})*$/;

const text = (value, max) => String(value ?? '').replace(/[\r\n]+/g, ' ').trim().slice(0, max);

/** 有效值 = DB 里的值，空串回落 ENV_SITE。读侧（渲染）与表单侧共用，保证「看到的就是生效的」。 */
export function siteIdentityOf(read) {
  const pick = (key, fallback) => text(read?.(key), IDENTITY_MAX[key]) || fallback;
  return {
    title: pick(IDENTITY_KEYS.title, ENV_SITE.title),
    desc: pick(IDENTITY_KEYS.desc, ENV_SITE.desc),
    author: pick(IDENTITY_KEYS.author, ENV_SITE.author),
    email: pick(IDENTITY_KEYS.email, ENV_SITE.email),
    mark: pick(IDENTITY_KEYS.mark, ENV_SITE.mark),
    icp: pick(IDENTITY_KEYS.icp, ENV_SITE.icp),
    police: pick(IDENTITY_KEYS.police, ENV_SITE.police),
    lang: pick(IDENTITY_KEYS.lang, ENV_SITE.lang),
  };
}

/**
 * 把库里的值原地写回 SITE。SITE 是各处 import 的同一个对象引用，因此保存后下一次渲染立即生效
 * （页面缓存靠 repo.contentStamp() 失效，settings 写入会触发 042 的内容修订触发器。）
 */
export function applySiteIdentity(read) {
  const v = siteIdentityOf(read);
  SITE.title = v.title;
  SITE.desc = v.desc;
  SITE.author = v.author;
  SITE.email = v.email;
  SITE.mark = v.mark;
  SITE.icp = v.icp;
  SITE.police = v.police;
  SITE.lang = v.lang;
  // 站名留空时拿域名当身份，与出厂逻辑保持一致（后台允许清空站名——有人就想只用印章 + 域名）。
  SITE.identity = SITE.title || SITE.domain;
  return v;
}

/** 校验并保存。返回错误文案（null 表示成功）。`set(key, value)` 由调用方包在事务里。 */
export function saveSiteIdentity(body, set, val) {
  const v = {
    title: text(val(body, 'title'), IDENTITY_MAX.title),
    desc: text(val(body, 'desc'), IDENTITY_MAX.desc),
    author: text(val(body, 'author'), IDENTITY_MAX.author),
    email: text(val(body, 'email'), IDENTITY_MAX.email),
    mark: text(val(body, 'mark'), IDENTITY_MAX.mark),
    icp: text(val(body, 'icp'), IDENTITY_MAX.icp),
    police: text(val(body, 'police'), IDENTITY_MAX.police),
    lang: text(val(body, 'lang'), IDENTITY_MAX.lang) || ENV_SITE.lang,
  };

  if (v.email && !EMAIL_LOOSE_RE.test(v.email)) return `博主邮箱不像邮箱地址：${v.email}`;
  if (hasControlChar(v.icp)) return '备案号里含有控制字符';
  if (hasControlChar(v.police)) return '公安备案号里含有控制字符';
  if (!LANG_RE.test(v.lang)) return `语言标记不合法：${v.lang}（形如 zh-CN、en、ja）`;

  // 与出厂值相同的项存空串，而不是把 .env 的值抄一遍：以后改 .env 仍然会跟着变，
  // 也不会出现「库里写死了旧站名、.env 改了却没反应」这种最难查的错。
  for (const [field, key] of Object.entries(IDENTITY_KEYS)) {
    set(key, v[field] === ENV_SITE[field] ? '' : v[field]);
  }
  return null;
}

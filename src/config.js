import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
export const DATA_DIR = path.resolve(process.env.DATA_DIR ?? path.join(ROOT, 'data'));
export const UPLOADS_DIR = path.resolve(process.env.UPLOADS_DIR ?? path.join(DATA_DIR, 'uploads'));
export const DB_FILE = path.resolve(process.env.DB_FILE ?? path.join(DATA_DIR, 'blog.db'));
export const PUBLIC_DIR = path.join(ROOT, 'public');
export const OUTPUT_DIR = path.join(ROOT, 'output');
export const CONTENT_DIR = path.resolve(process.env.CONTENT_DIR ?? path.join(ROOT, 'content'));
// 所有主题都在 themes/ 下；没有「内置 / 用户安装」两套目录。部署与完整备份都按这一份处理。
export const THEMES_DIR = path.resolve(process.env.THEMES_DIR ?? path.join(ROOT, 'themes'));
const parsedPort = Number(process.env.PORT ?? 8787);
export const PORT = Number.isInteger(parsedPort) && parsedPort > 0 && parsedPort < 65536 ? parsedPort : 8787;
export const HOST = process.env.HOST ?? '127.0.0.1';

const IS_PROD = process.env.NODE_ENV === 'production';
// 占位域名故意用 .invalid：以前用作者域名，生产忘配 SITE_DOMAIN / SITE_URL 时会静默把 RSS/sitemap/canonical/通知邮件全指向别人站。
const PLACEHOLDER_DOMAIN = 'example.invalid';
const DOMAIN = process.env.SITE_DOMAIN ?? PLACEHOLDER_DOMAIN;
const SITE_URL_ENV = process.env.SITE_URL;

export const SITE = {

  title: process.env.SITE_TITLE ?? '',

  author: process.env.SITE_AUTHOR ?? '',
  desc: process.env.SITE_DESC ?? '写代码，也写字。',

  // 博主邮箱：只用于给作者回复（is_author）算 Gravatar md5，不进评论行也不参与邮件收发；留空=用字母头像。
  email: process.env.SITE_EMAIL ?? '',

  url: (SITE_URL_ENV ?? (IS_PROD
    ? `https://${DOMAIN}`
    : `http://${HOST}:${PORT}`)).replace(/\/$/, ''),
  domain: DOMAIN,
  lang: process.env.SITE_LANG ?? 'zh-CN',

  mark: process.env.SITE_MARK ?? DOMAIN,

  icp: process.env.SITE_ICP ?? '',
};

SITE.identity = SITE.title || SITE.domain;

export function configWarnings() {
  const out = [];
  if (IS_PROD && !SITE_URL_ENV && !process.env.SITE_DOMAIN) {
    out.push(`未设置 SITE_URL / SITE_DOMAIN：绝对链接（RSS、sitemap、canonical、通知邮件）会指向占位域名 ${DOMAIN}`);
  }
  if (process.env.FEED_ALLOW_PRIVATE === 'true') {
    out.push('FEED_ALLOW_PRIVATE=true：友圈允许抓取内网地址，只应在本机测试时打开');
  }
  // 反代后取不到真实客户端 IP 时，按 IP 的限流会退化成全站共用一个桶：登录失败 5 次会锁住所有人。
  if (IS_PROD && process.env.TRUST_PROXY !== 'true') {
    out.push('TRUST_PROXY 未设为 true：若站点跑在反向代理后面，真实客户端 IP 取不到，按 IP 的限流会退化成全站共用');
  }
  return out;
}

// 主题 ZIP 上限：请求体守卫、路由与安装器共用一份，避免「文档说 10MB、全局守卫 1MB」的错位。
export const MAX_THEME_ZIP = 10 * 1024 * 1024;

export const PAGE_SIZE = 20;

// 后台列表每页条数（文章/笔记/页面/评论/媒体共用）；以前单独放 src/admin/pagination.js，只为一行常量。
export const ADMIN_PAGE_SIZE = 60;

export const COMMENTS_PER_PAGE = 20;

export const FEEDS_PER_PAGE = 20;

// 友圈前台每页几位朋友：固定值，不开放后台设置。
export const FRIENDS_PER_PAGE = 20;
export const FRIENDS_PER_SOURCE = 3;

// —— 评论头像（Gravatar 协议）——
// 服务端反代 + 本地缓存，访客只连本站：CSP img-src 不用放开第三方域，访客 IP 也不外泄。上游按顺序试，
// 先成功者记住、失败后冷静 10 分钟后重试；某家回 404 不中止（镜像数据不全），全部说"没有"才记负缓存——
// 实测 secure.gravatar 连不通、Cravatar 对 a@uua.me 回 404，只有第三家拿得到，故"404 就停"在真实网络里是错的。
// 默认三家：Gravatar → Cravatar → gravatar.loli.net。留空（AVATAR_UPSTREAMS=）= 关回源，全用字母头像。
const AVATAR_DEFAULT_UPSTREAMS = 'https://secure.gravatar.com/avatar,https://cravatar.cn/avatar,https://gravatar.loli.net/avatar';
export const AVATAR_DIR = path.resolve(process.env.AVATAR_CACHE_DIR ?? path.join(DATA_DIR, 'avatars'));
export const AVATAR_UPSTREAMS = (process.env.AVATAR_UPSTREAMS ?? AVATAR_DEFAULT_UPSTREAMS)
  .split(',').map((s) => s.trim().replace(/\/+$/, '')).filter((s) => /^https?:\/\//.test(s));
// 头像最大显示 40px（友链/关于），评论里 30px；96 已覆盖 2x 屏，再大只是白传字节。
export const AVATAR_FETCH_SIZE = 96;
export const AVATAR_CACHE_MAX_FILES = 4096;

export const RECENT = 10;

export const LINKS_PER_PAGE = 24;

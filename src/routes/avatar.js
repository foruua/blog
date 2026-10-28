import { Hono } from 'hono';
import { AVATAR_MD5_RE } from '../avatar/md5.js';
import { BLANK_PNG } from '../avatar/cache.js';
import { clientKey } from '../util/http.js';
import { createAntispam } from '../comments/antispam.js';

/** /avatar/<md5>：评论头像本站出口（反代 + 本地缓存，见 src/avatar/cache.js）。只认 32 位 hex，其余一律 404——不能借它请求别处，也不会把任意路径喂给上游；响应都带 Cache-Control，别落进「页面级 no-cache」兜底。 */
export function avatarRoutes(cache, { isKnown = null } = {}) {
  const app = new Hono({ strict: false });
  const limit = createAntispam({ windowMs: 60_000, maxPerWindow: 240 });

  app.get('/avatar/:hash', async (c) => {
    const hash = String(c.req.param('hash')).toLowerCase();
    if (!AVATAR_MD5_RE.test(hash)) return c.notFound();
    // 限流放在 isKnown 之前：未知 hash 也会消耗一次哈希/集合查询，不能让它绕开预算。
    if (limit.rateLimited(clientKey(c))) {
      c.header('Retry-After', '60');
      return c.text('请求过于频繁，请稍后再试。', 429);
    }
    // 未知 hash 不回源，但也不能用 404 暴露“这个邮箱没在本站评论过”（md5 是公开可算的）。
    // 回一张与“上游确认无头像”完全相同的透明占位，并用同一档缓存头，状态码/头部都不可区分。
    // isKnown 可能是异步的（全量重建分批让出事件循环）；同步测试桩也兼容。
    if (isKnown && !(await isKnown(hash))) {
      return c.body(c.req.method === 'HEAD' ? null : BLANK_PNG, 200, {
        'Content-Type': 'image/png',
        'Content-Length': String(BLANK_PNG.length),
        'Cache-Control': 'public, max-age=3600',
      });
    }
    const { body, type, maxAge } = await cache.resolve(hash);
    return c.body(body, 200, {
      'Content-Type': type,
      'Content-Length': String(body.length),
      'Cache-Control': maxAge > 0 ? `public, max-age=${maxAge}` : 'no-store',
    });
  });

  return app;
}

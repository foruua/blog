#!/usr/bin/env node
// 匿名 HTML 页面缓存：命中、失效、304、后台不缓存、评论令牌重新签发。
import './_test-env.mjs';
import { createChecker } from './_check.mjs';
import { startServer } from './_server.mjs';
import { open, close } from '../db/driver.js';
import { createRepo } from '../db/repo.js';

const { check, report } = createChecker();
const srv = await startServer({ env: { FEED_REFRESH_MS: '0', LINK_CHECK_MS: '0' } });
const db = open(srv.dbFile);
const repo = createRepo(db);

try {
  repo.setSetting('home_recent', '10');
  const probe = `?cache-probe=${Date.now()}`;
  const first = await fetch(`${srv.base}/${probe}`);
  const firstBody = await first.text();
  check('T1 首次匿名页面正常返回', first.status === 200 && firstBody.length > 0, String(first.status));
  check('T2 首次是 MISS', first.headers.get('x-page-cache') === 'MISS', String(first.headers.get('x-page-cache')));

  const second = await fetch(`${srv.base}/${probe}`);
  const secondBody = await second.text();
  check('T3 第二次命中缓存', second.headers.get('x-page-cache') === 'HIT', String(second.headers.get('x-page-cache')));
  check('T4 命中的正文与首次一致', secondBody === firstBody, `${firstBody.length} → ${secondBody.length}`);

  const etag = second.headers.get('etag');
  const cached = await fetch(`${srv.base}/${probe}`, { headers: { 'If-None-Match': etag ?? '' } });
  check('T5 条件请求命中 304 且无正文', cached.status === 304 && (await cached.text()).length === 0, String(cached.status));

  const admin = await fetch(`${srv.base}/${probe}`, { headers: { Cookie: 'blog_admin=whatever' } });
  check('T6 后台会话不缓存、不发 ETag、private no-store',
    !admin.headers.get('x-page-cache') && !admin.headers.get('etag')
    && /private, no-store/.test(admin.headers.get('cache-control') ?? ''),
    `${admin.headers.get('x-page-cache')} / ${admin.headers.get('etag')} / ${admin.headers.get('cache-control')}`);

  const moderate = await fetch(`${srv.base}/moderate/not-a-token`);
  check('T7 审核页永不进入页面缓存，且 no-store',
    !moderate.headers.get('x-page-cache') && /no-store/.test(moderate.headers.get('cache-control') ?? ''),
    `${moderate.headers.get('x-page-cache')} / ${moderate.headers.get('cache-control')}`);

  // 直接改设置（另一个连接）必须让缓存失效，不能靠 60 秒 TTL 拖延。
  repo.setSetting('home_recent', '0');
  const changed = await fetch(`${srv.base}/${probe}`);
  const changedBody = await changed.text();
  check('T8 数据库写入后缓存立即失效（MISS）', changed.headers.get('x-page-cache') === 'MISS', String(changed.headers.get('x-page-cache')));
  check('T9 新内容生效（首页“最近更新”已关闭）', firstBody.includes('最近更新') && !changedBody.includes('最近更新'), '');

  const post = db.prepare("SELECT slug FROM posts WHERE kind = 'post' AND draft = 0 ORDER BY id LIMIT 1").get();
  if (post) {
    const url = `${srv.base}/p/${encodeURIComponent(post.slug)}/`;
    const a = await fetch(url);
    const ah = await a.text();
    const b = await fetch(url);
    const bh = await b.text();
    const ta = /name="ts" value="([^"]+)"/.exec(ah)?.[1];
    const tb = /name="ts" value="([^"]+)"/.exec(bh)?.[1];
    check('T10 文章页命中缓存后，评论时间戳令牌仍每次重新签发',
      Boolean(ta) && Boolean(tb) && ta !== tb, `${ta?.slice(0, 8)} / ${tb?.slice(0, 8)}`);
    check('T11 令牌变化不影响 ETag（令牌只做哈希归一化）',
      Boolean(a.headers.get('etag')) && a.headers.get('etag') === b.headers.get('etag'),
      `${a.headers.get('etag')} / ${b.headers.get('etag')}`);
  }
} finally {
  close(db);
  await srv.stop();
}

process.exit(report() ? 1 : 0);

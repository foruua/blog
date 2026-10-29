#!/usr/bin/env node
// 匿名 HTML 页面缓存：命中、失效、304、后台不缓存、评论令牌重新签发。
import './_test-env.mjs';
import { createChecker } from './_check.mjs';
import { startServer } from './_server.mjs';
import { open, close } from '../db/driver.js';
import { createRepo } from '../db/repo.js';

const { check, report } = createChecker();
const srv = await startServer();  // 后台轮次默认已由 _server.mjs 静默
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

  // UTM 等无关参数共享同一条缓存；q / before / n 等会改正文的参数不缓存，避免随机值冲掉整页缓存。
  const tagged = await fetch(`${srv.base}/?utm_source=newsletter`);
  check('T4b 无关查询参数复用同一条缓存', tagged.headers.get('x-page-cache') === 'HIT', String(tagged.headers.get('x-page-cache')));
  // 发信队列写入（退避/成功后 markSent）不属于页面内容：不能因此把整站 HTML 缓存冲掉。
  db.prepare(`INSERT INTO mail_outbox(to_addr, subject, text_body, status, next_attempt_at, created_at)
    VALUES(?,?,?,?,?,?)`).run('cache@example.com', 'cache', 'cache', 'pending', new Date().toISOString(), new Date().toISOString());
  const afterMail = await fetch(`${srv.base}/${probe}`);
  check('T4d1 发信队列写入不冲掉页面缓存', afterMail.headers.get('x-page-cache') === 'HIT', String(afterMail.headers.get('x-page-cache')));
  // 备份/异地状态同样属于后台数据，043 迁移后不应 bump 内容修订号。
  db.prepare(`INSERT INTO settings(key, value) VALUES(?, ?)
    ON CONFLICT(key) DO UPDATE SET value = excluded.value`).run('backup_offsite_status', '{"state":"ok"}');
  const afterBackup = await fetch(`${srv.base}/${probe}`);
  check('T4d2 备份状态写入不冲掉页面缓存', afterBackup.headers.get('x-page-cache') === 'HIT', String(afterBackup.headers.get('x-page-cache')));
  const search = await fetch(`${srv.base}/search?q=${Date.now()}`);
  check('T4c 内容相关查询参数不进共享缓存', !search.headers.get('x-page-cache'), String(search.headers.get('x-page-cache')));
  const stillCached = await fetch(`${srv.base}/${probe}`);
  check('T4d 检索请求不会把首页缓存挤掉', stillCached.headers.get('x-page-cache') === 'HIT', String(stillCached.headers.get('x-page-cache')));

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
    check('T10 文章页命中缓存后复用同一份正文（令牌不再逐次重签）',
      Boolean(ta) && ta === tb, `${ta?.slice(0, 8)} / ${tb?.slice(0, 8)}`);
    check('T11 令牌复用后 ETag 仍稳定',
      Boolean(a.headers.get('etag')) && a.headers.get('etag') === b.headers.get('etag'),
      `${a.headers.get('etag')} / ${b.headers.get('etag')}`);
  }
} finally {
  close(db);
  await srv.stop();
}

process.exit(report() ? 1 : 0);

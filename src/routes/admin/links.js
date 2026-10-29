import { externalWrite, bodyOf, val, pageNumber } from './shared.js';
import { ADMIN_PAGE_SIZE } from '../../config.js';
import { linksAdminPage, linksProgress } from '../../admin/views/links.js';
import { failureLabel } from '../../util/failure.js';
import { logError } from '../../util/errors.js';

/** 后台「友链」路由：只有催检查、藏起来、放回来三个动作，都不碰评论。名单永远是评论审核的派生物——想让人上/下，去「评论」页改评论状态。「立即检查全部」不 await（整轮耗时长，会占着全局写队列）；单条检查要等结果。 */
const RESULT = {
  ok: '✓ 探通了',
  dead: '✗ 打不开',
  unknown: '⚠ 看不清（对方在应答）',
};

export function registerLinkRoutes(app, { links, linkChecker }, { ctx }) {
  const back = (c, message) => c.redirect(`/admin/links?w=${encodeURIComponent(message)}`, 303);


  app.get('/admin/links', (c) => {
    const page = pageNumber(c);
    const rows = links.adminPage({ limit: ADMIN_PAGE_SIZE + 1, offset: (page - 1) * ADMIN_PAGE_SIZE });
    const snapshot = links.adminSnapshot();
    return c.html(linksAdminPage(ctx(c, {
      rows: rows.slice(0, ADMIN_PAGE_SIZE),
      hasMore: rows.length > ADMIN_PAGE_SIZE,
      page,
      total: snapshot.total,
      counts: snapshot.counts,
      notice: c.req.query('w') ? String(c.req.query('w')) : '',
      progress: linkChecker.progress(),
    })));
  });

  externalWrite(app, '/admin/links/check', async (c) => {
    const b = await bodyOf(c);
    const host = val(b, 'host').trim();
    if (!host) return back(c, '✗ 没认出是哪个站');
    const r = await linkChecker.checkHost(host);
    if (r.state === 'superseded') return back(c, '⚠ 站点已变更，本次旧结果已丢弃');
    if (r.state === 'missing') return back(c, '✗ 这个站已经不在名单里了（那条评论可能被删了）');

    const detail = r.state === 'ok'
      ? (r.ms ? `（${r.ms} ms）` : '')
      : (r.error ? `（${failureLabel(r.error)}）` : '');
    return back(c, `${RESULT[r.state] ?? '⚠ 结果不明'}：${host}${detail}`);
  });

  app.post('/admin/links/hide', async (c) => {
    const b = await bodyOf(c);
    const host = val(b, 'host').trim();
    const on = val(b, 'on') === '1';
    if (!host) return back(c, '✗ 没认出是哪个站');
    const site = links.getSite(host);
    if (!site) return back(c, '✗ 这个站已经不在名单里了');
    links.setHidden(host, on);
    if (!on && site.alive === 0) {
      void linkChecker.checkHost(host).catch((error) => logError(error, c, 'links.check-one-failed'));
      return back(c, `✓ 已取消 ${host} 的手动隐藏，正在复查；探通后会自动放回前台`);
    }
    return back(c, on ? `✓ 已把 ${host} 从前台撤下（评论还在，只是友链页不显示）` : `✓ 已把 ${host} 放回前台`);
  });

  app.post('/admin/links/check-all', (c) => {
    void linkChecker.checkAll({ force: true });
    // 进度条自己更新，不整页跳——整页跳会把「已完成 0 / N」定格，那正是过去「点了没反应」的原因。
    if (c.req.header('x-requested-with') === 'fetch') return c.body(null, 204);
    return back(c, '✓ 已开始检查全部站点，刷新本页可查看完成数量');
  });

  // 本轮进度片段：与首屏同一份模板（views/links.js#linksProgress）。受 /admin/* 守卫，不需 csrf。
  app.get('/admin/links/check-progress', (c) => {
    c.header('Cache-Control', 'no-store');
    return c.html(linksProgress(linkChecker.progress()));
  });
}

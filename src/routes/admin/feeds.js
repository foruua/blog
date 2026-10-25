import { subscribedSite, createLinkSubscriber } from '../../feeds/subscriptions.js';
import { externalWrite, bodyOf, val, pageNumber } from './shared.js';
import { cleanText } from '../../feeds/parse.js';
import { TIMEOUT_MS } from '../../feeds/fetch.js';
import { feedsPage, importBlock, feedsProgress } from '../../admin/views/feeds.js';
import { settings, KEYS, parseFeedsPerPage } from '../../settings.js';
import { feedState, feedStateCounts, FEED_STATES } from '../../feeds/state.js';
import { logError } from '../../util/errors.js';

/** 后台「友圈」路由：登记地址、增删改、手动刷新。添加与单条刷新等网络结果，只把配置写入放队列；刷新全部在后台。列表分页走 ?page=N，行内每个动作带 page 隐藏域，否则在第 3 页删一个源会被弹回第 1 页。 */

const MAX_FEEDS = 200;
// 等抓取结果的上限：比常规超时短，免得站主对着转圈按钮发呆。
const WAIT_MS = Math.min(TIMEOUT_MS, 6000);

// 状态筛选参数：只认 feedState 产出的那几个值，别的一律当「全部」——手改 URL 不该得到一个空列表。
const stateParam = (raw) => {
  const v = String(raw ?? '');
  return FEED_STATES.includes(v) ? v : '';
};

export function registerFeedRoutes(app, { feeds, links = null, refresher, repo, keep = 20, mutate = (fn) => fn() }, { ctx }) {
  const subscriber = links ? createLinkSubscriber({ feeds, links, refresher, mutate, repo, keep, maxFeeds: MAX_FEEDS }) : null;

  // 跳回列表带上页码、筛选态与结果文案；body 已被 CSRF 守卫读过一次，这里白拿。
  const back = async (c, message, { url = '', title = '' } = {}) => {
    const b = await bodyOf(c).catch(() => null);
    const raw = b instanceof FormData ? b.get('page') : b?.page;
    const page = Math.max(1, Number.parseInt(String(raw ?? ''), 10) || 1);
    const state = stateParam(b instanceof FormData ? b.get('state') : b?.state);
    const qs = new URLSearchParams({ w: message });
    if (page > 1) qs.set('page', String(page));
    if (state) qs.set('state', state);
    // 添加失败时把刚填的地址/站名带回表单，别让用户重新敲一遍。
    if (url) qs.set('url', url);
    if (title) qs.set('title', title);
    return c.redirect(`/admin/feeds?${qs}`, 303);
  };


  /** @returns {{url:string, error?:string}} */
  function normalizeUrl(raw) {
    let s = String(raw ?? '').trim().replace(/\s+/g, '');
    if (!s) return { url: '' };
    if (s.length > 500) return { url: '' };
    if (!/^[a-z][a-z0-9+.-]*:/i.test(s)) s = `https://${s}`;
    // 先做一次真正的 URL 解析：像 `https://` 这种“有协议但没主机”的地址不能落库，
    // 否则站主会得到一条永远失败、删起来才麻烦的订阅源。
    try {
      const parsed = new URL(s);
      // 凭据必须在落库前拒绝：抓取层虽然也会拦，但那时源已经进表，前台会多一条永远失败的记录。
      if (parsed.username || parsed.password) return { url: '', error: '地址里不要带账号密码' };
      return { url: parsed.href };
    } catch { return { url: '' }; }
  }

  // 协议必须在落库前挡：抓取层也会拒，但那时源已写进表，站主会看到一条永远失败的记录。
  const schemeOk = (url) => /^https?:\/\//i.test(url);

  const resultWord = (r) => (r.status === 'unchanged'
    ? '内容没有变化'
    : r.items ? `抓到 ${r.items} 条` : '源里暂时没有条目');

  app.get('/admin/feeds', (c) => {
    const all = feeds.list();
    const state = stateParam(c.req.query('state'));
    // 先筛再分页：页码与「第 N / M 页」都按筛选后的条数算，否则点「抓取失败」会看到一页空列表。
    const shown = state ? all.filter((f) => feedState(f) === state) : all;
    const perPage = settings.feedsPerPage(repo);

    const lastPage = Math.max(1, Math.ceil(shown.length / perPage));
    const page = Math.min(pageNumber(c), lastPage);
    const start = (page - 1) * perPage;
    const rows = shown.slice(start, start + perPage);
    return c.html(feedsPage(ctx(c, {
      rows,
      importReport: subscriber?.report(), pendingLinks: subscriber?.pendingCount() ?? null,
      addUrl: c.req.query('url') ? String(c.req.query('url')).slice(0, 500) : '',
      addTitle: c.req.query('title') ? String(c.req.query('title')).slice(0, 60) : '',

      totals: { sources: all.length },
      // 计数按全量算（不是本页）：工具行那句「3 个抓取失败」写的是总数。
      counts: feedStateCounts(all), state,
      notice: c.req.query('w') ? String(c.req.query('w')) : '',
      page,
      perPage,
      lastPage,
      progress: refresher.progress(),
    })));
  });

  app.post('/admin/feeds/subscribe-links', (c) => {
    if (!subscriber) return back(c, '✗ 友链模块未启用');
    void subscriber.start();

    if (c.req.header('x-requested-with') === 'fetch') return c.body(null, 204);
    return back(c, '✓ 已开始订阅未加入友圈的友链；进度在弹窗里更新');
  });

  // 批量订阅弹窗的内容片段：admin.js 在弹窗开着时每 1.5s 拉这里整块换掉；片段与首屏同一份模板（views/feeds.js#importBlock），无第二份真相。
  app.get('/admin/feeds/subscribe-report', (c) => {
    if (!subscriber) return c.text('', 404);
    c.header('Cache-Control', 'no-store');
    return c.html(importBlock({
      importReport: subscriber.report(),
      pendingLinks: subscriber.pendingCount(),
    }));
  });

  externalWrite(app, '/admin/feeds/add', async (c) => {
    const b = await bodyOf(c);
    const entered = { url: val(b, 'url').slice(0, 500), title: val(b, 'title').slice(0, 60) };
    const normalized = normalizeUrl(val(b, 'url'));
    if (!normalized.url) return back(c, normalized.error ? `✗ ${normalized.error}` : '✗ 请填一个地址', entered);
    const url = normalized.url;
    if (!schemeOk(url)) return back(c, '✗ 只支持 http(s) 地址', entered);
    if (feeds.count() >= MAX_FEEDS) return back(c, `✗ 最多 ${MAX_FEEDS} 个订阅源，先删掉几个`, entered);
    if (feeds.getByUrl(url)) return back(c, '✗ 这个地址已经添加过了', entered);
    // 一个站只留一个源：同站再挂第二个已不支持，想换栏目先删原条或直接改地址。
    const existing = subscribedSite(feeds, [url]);
    if (existing) return back(c, `⚠ 这个博客已订阅${existing.enabled ? '' : '（已停用）'}：${existing.title || existing.url}；一个站只能有一个源`, entered);

    const title = cleanText(val(b, 'title'), 60);
    let row;
    try { row = await mutate(() => {
      if (feeds.count() >= MAX_FEEDS) throw new Error(`最多 ${MAX_FEEDS} 个订阅源`);
      if (feeds.getByUrl(url)) throw new Error('这个地址已经添加过了');
      if (subscribedSite(feeds, [url])) throw new Error('这个博客已经订阅');
      return feeds.add({ url, title, sortOrder: feeds.count() });
    }); }
    catch (error) {
      // message 多来自我们自己的抓取/解析文案（「不是 feed」「超时」），对排障有用，保留；只补一行日志。
      console.error(JSON.stringify({ event: 'admin.feed-add-failed', code: error.code ?? 'FEED', message: String(error.message ?? '').slice(0, 300) }));
      return back(c, `✗ 添加失败：${error.message}`, entered);
    }

    const r = await refresher.refreshOne(row.id, { timeoutMs: WAIT_MS });
    if (!r.ok) return back(c, `⚠ 已添加，但抓取失败：${r.error}`);
    const name = r.title && !title ? `「${r.title}」` : '';
    const found = r.discovered ? `（自动找到订阅地址 ${r.discovered}）` : '';
    return back(c, `✓ 已添加${name}：${resultWord(r)}${found}`);
  });

  app.post('/admin/feeds/:id/save', async (c) => {
    const feed = feeds.get(c.req.param('id'));
    if (!feed) return back(c, '✗ 这个订阅源不存在');

    const b = await bodyOf(c);
    const normalized = normalizeUrl(val(b, 'url'));
    if (!normalized.url) return back(c, normalized.error ? `✗ ${normalized.error}` : '✗ 地址不能为空');
    const url = normalized.url;
    if (!schemeOk(url)) return back(c, '✗ 只支持 http(s) 地址');
    const clash = feeds.getByUrl(url);
    if (clash && clash.id !== feed.id) return back(c, '✗ 这个地址已经被另一个源用了');
    // 新增时按站去重，编辑时也要：否则改个地址就能绕过「一站一源」，前台出现同站两条源。
    const duplicate = subscribedSite(feeds, [url], feed.id);
    if (duplicate) return back(c, `⚠ 这个博客已订阅（${duplicate.title || duplicate.url}）；一个站只能有一个源`);

    const order = Number.parseInt(val(b, 'sort_order'), 10);
    feeds.update(feed.id, {
      url,
      title: cleanText(val(b, 'title'), 60),
      sortOrder: Number.isFinite(order) ? Math.min(9999, Math.max(0, order)) : feed.sort_order,
    });

    if (url === feed.url) return back(c, '✓ 已保存');
    // 换地址等于换了一个源：旧条目与条件请求缓存都必须丢掉，否则前台继续显示旧文章、下次抓取也会因 ETag 命中跳过。
    // 后台刷新不阻塞响应，但写库失败必须接住：未处理的 rejection 在 Node 22 会直接终止进程。
    void refresher.refreshOne(feed.id).catch((error) => logError(error, c, 'feeds.refresh-one-failed'));
    return back(c, '✓ 已保存，并已清掉旧条目、开始按新地址抓取');
  });

  app.post('/admin/feeds/:id/toggle', (c) => {
    const feed = feeds.get(c.req.param('id'));
    if (!feed) return back(c, '✗ 这个订阅源不存在');
    feeds.setEnabled(feed.id, !feed.enabled);
    return back(c, feed.enabled ? '✓ 已停用：前台不再显示它的文章，也不再抓取' : '✓ 已启用：稍后会自动抓取');
  });

  externalWrite(app, '/admin/feeds/:id/refresh', async (c) => {
    const feed = feeds.get(c.req.param('id'));
    if (!feed) return back(c, '✗ 这个订阅源不存在');
    const r = await refresher.refreshOne(feed.id, { timeoutMs: WAIT_MS });
    if (!r.ok) return back(c, `✗ 抓取失败：${r.error}`);
    const found = r.discovered ? `（自动找到订阅地址 ${r.discovered}）` : '';
    return back(c, `✓ ${r.title || feed.title || feed.url}：${resultWord(r)}${found}`);
  });

  app.post('/admin/feeds/refresh', (c) => {
    // 不 await：整轮抓取很久，请求会占着全局写队列。
    void refresher.refreshAll({ force: true });
    // 进度条自己更新（admin.js 每 1s 拉下面片段），不整页跳——整页跳会把「已完成 0 / N」定格，那正是过去「点了没反应」的原因；禁 JS 走 303。
    if (c.req.header('x-requested-with') === 'fetch') return c.body(null, 204);
    return back(c, '✓ 已开始刷新全部源，几秒后刷新本页看结果');
  });

  // 本轮进度片段：与首屏同一份模板（views/feeds.js#feedsProgress），无第二份真相。受 /admin/* 守卫，不需 csrf。
  app.get('/admin/feeds/refresh-progress', (c) => {
    c.header('Cache-Control', 'no-store');
    return c.html(feedsProgress(refresher.progress()));
  });


  app.post('/admin/feeds/per', async (c) => {
    const b = await bodyOf(c);
    const n = parseFeedsPerPage(val(b, 'per'));
    if (n == null) return back(c, '✗ 每页条数请填 5—100 之间的整数');
    repo.setSetting(KEYS.feedsPerPage, String(n));
    return back(c, `✓ 已设为每页 ${n} 个源`);
  });



  app.post('/admin/feeds/clear-items', (c) => {
    const n = feeds.clearItems();
    return back(c, `✓ 已清空 ${n} 条抓取结果（地址配置保留）`);
  });

  app.post('/admin/feeds/:id/delete', (c) => {
    const feed = feeds.get(c.req.param('id'));
    if (!feed) return back(c, '✗ 这个订阅源不存在');
    feeds.remove(feed.id);
    const name = feed.title || feed.url;
    return back(c, `✓ 已删除「${name}」及其抓取结果`);
  });
}

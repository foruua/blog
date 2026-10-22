import { websiteHost } from '../util/url.js';

export function subscribedSite(feeds, urls, exceptId = null, list = null) {
  const hosts = new Set(urls.map(websiteHost).filter(Boolean));
  // 批量调用方传入一次 list() 的结果，避免每个候选站各查一遍全表（后台弹窗 1.5 秒轮询会放大 N+1）。
  return (list ?? feeds.list()).find((f) => f.id !== exceptId
    && [f.url, f.site_url, f.resolved_url].some((url) => hosts.has(websiteHost(url)))) ?? null;
}

// 先验证订阅再入库；失败站点不会留下无效订阅。
export function createLinkSubscriber({ feeds, links, refresher, mutate, maxFeeds = 100, keep = 20 }) {
  let task = null;
  let report = null;
  const candidates = () => links.adminList().filter((s) => !s.hidden && s.alive !== 0);
  const subscribed = (site, list = null) => subscribedSite(feeds, [site.source_url, site.url], null, list);
  function start() {
    if (task) return task;
    const sites = candidates();
    report = { running: true, total: sites.length, completed: 0, results: [] };
    const current = report;
    const run = Promise.resolve().then(async () => {
      // 分批执行，网络额度与友圈刷新共用；每次落库前重查配置与容量。
      for (let i = 0; i < sites.length; i += 4) {
        // 每批取一次快照做预检；真正的去重仍在事务内用最新数据重查。
        const snapshot = feeds.list();
        await Promise.all(sites.slice(i, i + 4).map(async (site) => {
          let result;
          try {
            const found = subscribed(site, snapshot);
            if (found) result = { state: 'skipped', detail: found.enabled ? '已经订阅' : '已经订阅（已停用）' };
            else if (feeds.count() >= maxFeeds) result = { state: 'skipped', detail: `已达到 ${maxFeeds} 个源上限` };
            else {
              const url = new URL(site.source_url).origin + '/';
              const out = await refresher.inspectSource(url);
              result = await mutate(() => feeds.transaction(() => {
                const latest = links.getSite(site.host);
                if (!latest || latest.hidden || latest.alive === 0 || latest.source_url !== site.source_url)
                  return { state: 'skipped', detail: '友链已变更，本次跳过' };
                const duplicate = subscribedSite(feeds, [url, out.resolvedUrl, out.parsed.siteUrl].filter(Boolean));
                if (duplicate) return { state: 'skipped', detail: '已经订阅' };
                if (feeds.count() >= maxFeeds) return { state: 'skipped', detail: `已达到 ${maxFeeds} 个源上限` };
                const row = feeds.add({ url, sortOrder: feeds.count() });
                feeds.saveItems(row.id, out.parsed.items, { keep });
                feeds.markOk(row.id, { title: out.parsed.title, siteUrl: out.parsed.siteUrl,
                  etag: out.etag, lastModified: out.lastModified, resolvedUrl: out.resolvedUrl });
                return { state: 'added', detail: `已订阅 · 收录 ${out.parsed.items.length} 篇` };
              }));
            }
          } catch (error) { result = { state: 'failed', detail: String(error?.message ?? error).slice(0, 200) }; }
          current.results.push({ host: site.host, ...result });
          current.completed++;
        }));
      }
      return current;
    }).finally(() => { current.running = false; task = null; });
    task = run;
    run.catch(() => {});
    return run;
  }
  return {
    start,
    report: () => report,
    pendingCount: () => {
      const list = feeds.list();
      return candidates().filter((s) => !subscribed(s, list)).length;
    },
  };
}

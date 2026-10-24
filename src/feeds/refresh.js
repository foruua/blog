// 友圈刷新编排：决定何时抓、抓失败怎么办。失败源按 5 分 → 10 → 20 … 指数退避，上限 6 小时一次——不退避的话，
// 一个关站的友链每轮定时刷新都撞一次超时、把整轮拖到几分钟；退避后一天只花几秒。

import { createLimiter } from '../util/concurrency.js';
import { envInt } from '../util/env.js';

import { fetchDocument, discoverFeeds, FeedError, TIMEOUT_MS } from './fetch.js';
import { parseFeed, FeedParseError, PARSER_VERSION } from './parse.js';

const FAIL_BASE_MS = 5 * 60 * 1000;
const FAIL_MAX_MS = 6 * 3600 * 1000;

// 每个源保留多少条：够铺满前台一屏多，又不至于让别人的整站历史在库里越堆越大。
export const DEFAULT_KEEP = envInt(process.env.FEED_KEEP, 20, { min: 3, max: 100 });
export const DEFAULT_INTERVAL_MS = 30 * 60 * 1000;

// 解析器版本变了就作废所有条件请求缓存——否则老条目一直 304、摘要停在旧规则（真踩过：改了「取全文还是
// 导语」后，带 ETag 的源过一整轮卡片还是半行字）。
// @returns {boolean} 这次是否真的作废（据此决定要不要顺手强制刷一轮）
export function revalidateIfParserChanged({ feeds, settings, version = PARSER_VERSION, log = () => {} }) {
  const key = 'feeds_parser_version';
  const want = String(version);
  if (settings.get(key) === want) return false;
  const n = feeds.resetAllCaches();
  settings.set(key, want);
  log(JSON.stringify({ event: 'feeds.parser-changed', version: want, revalidated: n }));
  return true;
}

export function createRefresher({ feeds, keep = DEFAULT_KEEP, log = () => {}, now = () => Date.now(), fetchDoc = fetchDocument, beforeWrite = () => Promise.resolve(), commit = async (write) => { await beforeWrite(); return write(); } }) {
  let inFlight = null;
  // 排队中的「强制轮」：正在跑自动轮次时手动「刷新全部」不能被吞掉（见 refreshAll）。
  let forced = null;
  // 整轮刷新进度（后台「刷新全部」读它）。那页是静态快照，而一轮要跑几秒到几十秒——不记进度站主只会盯着
  // 不动的「0 / 41」以为卡死（友链「立即检查全部」踩过同一个坑）。
  let progress = null;
  const schedule = createLimiter(4);
  const bySource = new Map();

  const backoffMs = (failCount) => Math.min(FAIL_MAX_MS, FAIL_BASE_MS * 2 ** Math.max(0, failCount - 1));

  const isDue = (feed) => {
    if (!feed.last_fetch_at) return true;
    const at = Date.parse(feed.last_fetch_at);
    return !Number.isFinite(at) || at + backoffMs(feed.fail_count ?? 0) <= now();
  };

  // 先抓网络再写库。写库那段同步（见 db/feeds.js 顶部），不占 mutate 队列。全流程都带条件请求：对方回 304
  // 就说明库里条目仍最新，省双方带宽；「立即刷新」也不例外。
  async function load(feed, { timeoutMs = TIMEOUT_MS } = {}) {
    const signal = AbortSignal.timeout(timeoutMs);
    const maxItems = Math.min(100, Math.max(30, keep));
    // 上次自动发现过订阅地址就直接抓它：省掉「先读网页、再从网页找 feed」这一趟。
    const target = feed.resolved_url || feed.url;
    const doc = await fetchDoc(target, {
      etag: feed.etag ?? null,
      lastModified: feed.last_modified ?? null,
      timeoutMs, signal,
    });
    if (doc.notModified) return { status: 'unchanged', etag: feed.etag, lastModified: feed.last_modified };

    try {
      const parsed = parseFeed(doc.text, { baseUrl: doc.finalUrl || target, maxItems });
      return { status: 'ok', parsed, etag: doc.etag, lastModified: doc.lastModified };
    } catch (error) {
      // 站主填的多半是站点主页而非 feed 地址：HTML 里若声明了订阅地址就自己找过去，并记进 resolved_url，下次直接抓。
      if (error?.code !== 'html') throw error;
      if (feed.resolved_url) {
        throw new FeedParseError(`自动发现的订阅地址 ${feed.resolved_url} 现在返回网页，请改回站点主页`, 'html');
      }
      const [candidate] = discoverFeeds(doc.text, doc.finalUrl || target);
      if (!candidate) throw new FeedParseError('这是网页，里面也没找到订阅地址', 'html');
      const next = await fetchDoc(candidate, { timeoutMs, signal });
      const parsed = parseFeed(next.text, { baseUrl: next.finalUrl || candidate, maxItems });
      return {
        status: 'ok', parsed, etag: next.etag, lastModified: next.lastModified,
        discovered: candidate, resolvedUrl: candidate,
      };
    }
  }

  async function refreshSource(feed, { timeoutMs }) {
    const currentFeed = () => {
      const current = feeds.get(feed.id);
      return current && current.url === feed.url && current.enabled === feed.enabled
        && current.version === feed.version ? current : null;
    };

    try {
      const out = await load(feed, { timeoutMs });
      return await commit(() => {
        const current = currentFeed();
        if (!current) return { ok: false, status: 'superseded', error: '订阅源已变更，本次旧结果已丢弃' };
        if (out.status === 'unchanged') {
          feeds.markOk(feed.id, { etag: out.etag, lastModified: out.lastModified });
          log(JSON.stringify({ event: 'feeds.unchanged', id: feed.id, url: feed.url }));
          return { ok: true, status: 'unchanged', title: feed.title, items: 0 };
        }
        // 条目与 ETag/成功状态必须同一事务：markOk 失败时不能留下“条目已更新但被记成抓取失败”。
        const saved = feeds.transaction(() => {
          const result = feeds.saveItems(feed.id, out.parsed.items, { keep });
          feeds.markOk(feed.id, {
            etag: out.etag, lastModified: out.lastModified,
            title: out.parsed.title, siteUrl: out.parsed.siteUrl,
            resolvedUrl: out.resolvedUrl ?? null,
          });
          return result;
        });
        log(JSON.stringify({
          event: 'feeds.ok', id: feed.id, url: feed.url, format: out.parsed.format,
          seen: saved.seen, kept: saved.kept, discovered: out.discovered ?? '',
        }));
        return {
          ok: true, status: 'ok', items: saved.seen, kept: saved.kept,
          format: out.parsed.format, title: out.parsed.title || feed.title,
          discovered: out.discovered ?? '',
        };
      });
    } catch (error) {
      const message = (error instanceof FeedError || error instanceof FeedParseError)
        ? error.message
        : `抓取失败：${error?.message ?? error}`;
      return commit(() => {
        if (!currentFeed()) return { ok: false, status: 'superseded', error: '订阅源已变更，本次旧结果已丢弃' };
        feeds.markFail(feed.id, message);
        log(JSON.stringify({ event: 'feeds.failed', id: feed.id, url: feed.url, code: error?.code ?? 'feed', message }));
        return { ok: false, status: 'failed', error: message, code: error?.code ?? 'feed' };
      });
    }
  }

  function refreshOne(id, { timeoutMs = TIMEOUT_MS } = {}) {
    const feed = feeds.get(id);
    if (!feed) return Promise.resolve({ ok: false, status: 'missing', error: '这个订阅源不存在' });
    const existing = bySource.get(feed.id);
    if (existing?.version === feed.version && existing?.url === feed.url) return existing.promise;
    const promise = schedule(() => refreshSource(feed, { timeoutMs })).finally(() => {
      if (bySource.get(feed.id)?.promise === promise) bySource.delete(feed.id);
    });
    bySource.set(feed.id, { version: feed.version, url: feed.url, promise });
    return promise;
  }

  function refreshAll({ force = false, limit = Infinity, timeoutMs = TIMEOUT_MS } = {}) {
    if (inFlight) {
      if (!force) return inFlight;
      // 手动全量刷新不能被正在进行的自动轮次吞掉：排队等这轮结束后再跑一轮强制的。照抄 links/check.js 的写法（那里同一个坑）。
      if (!forced) forced = inFlight.then(() => refreshAll({ force, limit, timeoutMs }))
        .finally(() => { forced = null; });
      forced.catch((error) => log(JSON.stringify({ event: 'feeds.forced-round-failed', code: error.code ?? 'FEED' })));
      return forced;
    }
    const due = feeds.listEnabled().filter((f) => force || isDue(f))
      .sort((a, b) => String(a.last_fetch_at ?? '').localeCompare(String(b.last_fetch_at ?? '')) || a.id - b.id)
      .slice(0, limit);
    // 进度按这一轮的源数算，跑完冻在 completed = total（页面刷新回来还说得出"上一轮跑了几个"）。计数放 finally：
    // 源被删/停用而提前退出的那路也得算完成，否则条子永远差几格。
    progress = { running: true, total: due.length, completed: 0 };
    const run = Promise.resolve().then(async () => {
      let ok = 0, failed = 0;
      const results = await Promise.allSettled(due.map(async (feed) => {
        try {
          const current = feeds.get(feed.id);
          if (!current?.enabled) return;
          const result = await refreshOne(feed.id, { timeoutMs });
          if (result.ok) ok++; else failed++;
        } finally {
          progress.completed += 1;
        }
      }));
      const rejected = results.find((result) => result.status === 'rejected');
      if (rejected) throw rejected.reason;
      if (due.length) log(JSON.stringify({ event: 'feeds.round', total: due.length, ok, failed }));
      return { total: due.length, ok, failed };
    }).finally(() => {
      inFlight = null;
      progress = progress ? { ...progress, running: false } : null;
    });
    inFlight = run;
    run.catch((error) => log(JSON.stringify({ event: 'feeds.round-failed', code: error.code ?? 'FEED' })));
    return run;
  }

  return {
    inspectSource: (url) => schedule(() => load({ url }, { timeoutMs: TIMEOUT_MS })),
    refreshOne,
    refreshAll,
    // 整轮刷新是否在跑：测试用它断言并发调用复用同一轮；关闭流程不看它（drain 负责）。
    // 设计约束：/friends 不让匿名请求驱动对外抓取，需要刷新时由后台定时器调用 refreshAll。
    busy: () => Boolean(inFlight),
    // 关闭进程前等待所有在飞轮次/单源刷新落库，避免 close(db) 之后还有 markOk/markFail 写入。
    drain: () => Promise.allSettled([
      inFlight,
      forced,
      ...[...bySource.values()].map((item) => item.promise),
    ].filter(Boolean)),
    // 这轮跑到哪儿了（没跑过为 null）。返回副本：调用方拿到的数字不许被下一轮改掉。
    progress: () => (progress ? { ...progress } : null),
  };
}

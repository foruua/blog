// 友链健康检查：2xx 可用；404/410/451 与网络故障失败；403/429/5xx 不明。连续失败达门槛才隐藏，
// 不明结果不修改累计失败；自动与手动检查按站点合并。

import { createLimiter } from '../util/concurrency.js';

import { fetchDocument, TIMEOUT_MS, ALLOW_PRIVATE_NETWORK } from '../feeds/fetch.js';
import { decodeEntities } from '../util/entities.js';

export const FAIL_LIMIT = 3;

// 复查周期 6 小时：抓的是别人的站点，频率得克制，且"邻居关站"不紧急，晚几小时发现无损失。
export const DEFAULT_CHECK_INTERVAL_MS = 6 * 3600 * 1000;

// 一轮最多探几个站（保证每轮有界，一个卡住的站最多拖 8 秒超时）；一轮探不完不要紧——allSites 按"最久
// 没查的在前"排序，下一轮接着探剩下的。
export const MAX_PER_ROUND = 40;

const GONE_HTTP = new Set([404, 410, 451]);

// 访客填写的是任意网址：只探常见 Web 端口，别让服务器去碰 25/6379 这类服务。
// 本机测试（FEED_ALLOW_PRIVATE=true）使用随机端口，放行。
const PROBE_PORTS = new Set(['', '80', '443', '8080', '8443']);
const probeTargetOf = (raw) => {
  try {
    const url = new URL(String(raw ?? ''));
    if (!ALLOW_PRIVATE_NETWORK && !PROBE_PORTS.has(url.port)) return null;
    return url.href;
  } catch { return null; }
};

const DEAD_CODES = new Set(['dns', 'timeout', 'network', 'bad-url', 'bad-scheme', 'private-host']);

// 探活只需状态码 + <title>，不必把整页读进内存。首页超过它（2xx 才走到读体）说明对方在正常应答，仍算活，只是没标题。
const PROBE_MAX_BYTES = 256 * 1024;

// 命名与数字实体都要解：中文站名常有 &#8211; 这类破折号，不解悬停提示会露出实体源码。与友圈解析
// 共用 util/entities.js 同一张表。
// 从网页取 `<title>`，只当站名用（悬停提示）、不当身份——有的站在 JS 挑战页返回「请稍候」/
// 「Just a moment」，故不能拿来认人。只扫前 200KB：<title> 总在 <head> 里。
export function pageTitle(html) {
  const m = /<title[^>]*>([\s\S]*?)<\/title>/i.exec(String(html ?? '').slice(0, 200_000));
  if (!m) return '';
  return decodeEntities(m[1]).replace(/\s+/g, ' ').trim().slice(0, 120);
}

export async function probeSite(url, { timeoutMs = TIMEOUT_MS } = {}) {
  const t0 = Date.now();
  try {
    const doc = await fetchDocument(url, { timeoutMs, maxBytes: PROBE_MAX_BYTES });
    return {
      state: 'ok', ms: Date.now() - t0, status: doc.status ?? 200,
      title: pageTitle(doc.text), finalUrl: doc.finalUrl,
    };
  } catch (error) {
    const ms = Date.now() - t0;
    const code = error?.code ?? 'network';
    const status = error?.status ?? null;
    const message = String(error?.message ?? error);

    // 'too-large' 只在 2xx 读体时抛（非 2xx/跳转/304 都在读体前返回）：页面大不是"站点坏了"，照样算活，只是标题留空。
    if (code === 'too-large') return { state: 'ok', ms, status: status ?? 200, title: '' };
    if (code === 'http') {
      const gone = status != null ? GONE_HTTP.has(status) : /HTTP (404|410|451)/.test(message);
      return { state: gone ? 'dead' : 'unknown', ms, status, code, error: message };
    }
    return { state: DEAD_CODES.has(code) ? 'dead' : 'unknown', ms, status, code, error: message };
  }
}

const due = (site, intervalMs, at) => {
  if (!site.checked_at) return true;
  const prev = Date.parse(site.checked_at);
  return !Number.isFinite(prev) || at - prev >= intervalMs;
};

export function createLinkChecker({
  links, probe = probeSite, log = () => {},
  beforeWrite = () => Promise.resolve(), commit = async (write) => { await beforeWrite(); return write(); }, failLimit = FAIL_LIMIT, now = () => Date.now(),
}) {
  let inFlight = null;
  const schedule = createLimiter(4);
  const byHost = new Map();
  let progress = null;
  let forced = null;
  const targetOf = (site) => site.url || `https://${site.host}/`;

  async function checkOne(site) {
    const url = targetOf(site);
    if (!probeTargetOf(url)) {
      return commit(() => {
        const current = links.getSite(site.host);
        if (!current || targetOf(current) !== url || current.source_url !== site.source_url) return { state: 'superseded' };
        links.markUnknown(site.host, { url, message: '端口不在允许探测范围', sourceUrl: site.source_url });
        return { state: 'unknown', ms: 0, status: null, error: 'port-not-allowed' };
      });
    }
    let r;
    try {
      r = await probe(url);
    } catch (error) {
      // 探测函数自己炸了（不该发生，但网络栈什么都有）：按"不明"处理——绝不能因一个没预料到的异常就把邻居判死。
      r = { state: 'unknown', ms: 0, status: null, error: `探测异常：${String(error?.message ?? error)}` };
    }
    return commit(() => {
      const current = links.getSite(site.host);
      if (!current || targetOf(current) !== url || current.source_url !== site.source_url) return { state: 'superseded' };
      if (r.state === 'ok') links.markOk(site.host, { url: r.finalUrl || url, title: r.title ?? '', sourceUrl: site.source_url });
      else if (r.state === 'dead') links.markFail(site.host, { url, message: r.error, failLimit, sourceUrl: site.source_url });
      else links.markUnknown(site.host, { url, message: r.error, sourceUrl: site.source_url });
      log(JSON.stringify({ event: 'links.checked', host: site.host, state: r.state, status: r.status, ms: r.ms }));
      return r;
    });
  }

  function checkAll({ force = false, intervalMs = DEFAULT_CHECK_INTERVAL_MS, limit = Infinity } = {}) {
    if (inFlight) {
      if (!force) return inFlight;
      // 手动全量检查不能被正在进行的有限自动轮次吞掉。
      if (!forced) forced = inFlight.then(() => checkAll({ force, intervalMs, limit }))
        .finally(() => { forced = null; });
      forced.catch((error) => log(JSON.stringify({ event: 'links.forced-round-failed', code: error?.code ?? 'LINK' })));
      return forced;
    }
    const sites = links.listSites().filter((s) => force || due(s, intervalMs, now())).slice(0, limit);
    const run = (async () => {
      const tally = { total: sites.length, ok: 0, dead: 0, unknown: 0 };
      progress = { total: sites.length, completed: 0, running: true };
      const results = await Promise.allSettled(sites.map(async (site) => {
        // 直接复用本轮已经读到的站点快照，不再为每个站回表取一次。
        const r = await enqueue(site);
        if (r.state === 'ok') tally.ok++;
        else if (r.state === 'dead') tally.dead++;
        else if (r.state === 'unknown') tally.unknown++;
        progress.completed++;
      }));
      const rejected = results.find((result) => result.status === 'rejected');
      if (rejected) throw rejected.reason;
      const pruned = await commit(() => links.pruneOrphans());
      if (tally.total || pruned) log(JSON.stringify({ event: 'links.round', ...tally, pruned }));
      return { ...tally, pruned };
    })().finally(() => { inFlight = null; if (progress) progress.running = false; });
    inFlight = run;
    run.catch((error) => log(JSON.stringify({ event: 'links.round-failed', code: error?.code ?? 'LINK' })));
    return run;
  }

  function enqueue(siteOrHost) {
    const site = typeof siteOrHost === 'string' ? links.getSite(siteOrHost) : siteOrHost;
    if (!site) return Promise.resolve({ state: 'missing' });
    const host = site.host;
    const url = targetOf(site);
    const existing = byHost.get(host);
    if (existing?.url === url && existing.sourceUrl === site.source_url) return existing.promise;
    const snapshot = { ...site };
    const promise = schedule(() => checkOne(snapshot)).finally(() => {
      if (byHost.get(host)?.promise === promise) byHost.delete(host);
    });
    byHost.set(host, { url, sourceUrl: site.source_url, promise });
    return promise;
  }

  function checkHost(host) {
    return enqueue(host);
  }

  return {
    progress: () => progress ? { ...progress } : null,
    checkAll,
    checkHost,
    busy: () => Boolean(inFlight),
  };
}

import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { readBoundedStream } from '../util/stream.js';
import { sniffImageType } from '../util/image.js';

// 评论头像的服务端反代 + 本地缓存。不让浏览器直连 Gravatar：CSP 的 img-src 'self' data: 不用放开，访客
// IP/Referer 不外泄，也免一次跨境首屏；上游只被服务器问一次，之后都从本地磁盘拿。代价是上游仍看得到邮箱哈希
// （协议要求 URL 里就是 md5），能做的只是不给它 IP。缓存目录两类：`<md5>` 图片字节（按魔数嗅探、不信响应头）、
// `<md5>.none` 负缓存（上游明确无头像 d=404），免得每次渲染都去问。

// 1×1 全透明 PNG：上游无头像或挂了时顶住 <img>，底下字母头像透出来，无脚本也不出碎图标。
export const BLANK_PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==',
  'base64',
);

const POSITIVE_MAX_AGE = 86400;   // 有头像：一天
const NEGATIVE_MAX_AGE = 3600;    // 没头像：一小时后再来看
const STALE_MAX_AGE = 600;        // 上游挂了但有旧图：短缓存，别把图刷没

// 上游响应按上限边读边数：不能先 arrayBuffer() 再量大小（那已把整个响应读进内存）。共用 readBoundedStream，超限返回 null。
// 早退的响应（404/非 2xx/content-type 不符）也必须收掉 body：undici 对未消费的响应体会一直占着连接，攒多了就是 socket/FD 泄漏。
const discard = (res) => { res.body?.cancel().catch(() => {}); };

export function createAvatarCache({
  dir,
  upstreams = [],
  size = 96,
  maxFiles = 4096,
  maxBytes = 512 * 1024,
  timeoutMs = 4000,
  probeTimeoutMs = 2500,
  downMs = 10 * 60 * 1000,
  maxInflight = 8,
  maxFetchesPerMinute = 120,
  positiveTtlMs = 7 * 24 * 3600 * 1000,
  negativeTtlMs = 6 * 3600 * 1000,
  fetchImpl = globalThis.fetch,
  transform = null,               // (buf, size) => { body, type }：规范化上游拿回来的图（server.js 注入 sharp 版）
  log = () => {},
} = {}) {
  const inflight = new Map();     // hash → Promise：同一张头像并发只回源一次
  const down = new Map();         // 上游 base → 恢复时间：失败的先晾一会儿，别让每个请求都等满超时
  let lastGood = null;            // 上次成功过的上游，下次先用它
  let probing = null;             // 启动探测的 Promise：探测期间到达的请求等它一下，别各自去撞一次超时
  let budget = { at: Date.now(), n: 0 };
  let writes = 0;
  let pruning = null;             // 单飞：并发的 store 共用同一次 prune，不各自遍历一遍目录

  const statOf = async (file) => {
    try { const st = await fs.promises.stat(file); return st.isFile() ? st : null; } catch { return null; }
  };

  async function readImage(file) {
    try {
      const buf = await fs.promises.readFile(file);
      const type = sniffImageType(buf);
      return type ? { body: buf, type } : null;   // 认不出的残缺文件当成没缓存，下次重取
    } catch { return null; }
  }

  async function store(file, body) {
    await fs.promises.mkdir(dir, { recursive: true, mode: 0o700 });
    const tmp = `${file}.${process.pid}.${crypto.randomBytes(4).toString('hex')}.tmp`;
    try {
      // 文件名是邮箱 md5，别让同机其他用户读到；目录权限同理。
      await fs.promises.writeFile(tmp, body, { mode: 0o600 });
      await fs.promises.rename(tmp, file);
    } finally {
      // 写或改名中途失败会留下 .tmp 脏文件（prune 只在每 128 次写入后跑，未必删得到它）。
      await fs.promises.rm(tmp, { force: true }).catch(() => {});
    }
    if (++writes % 128 === 0) void prune().catch(() => {});   // 不 await：清理别落进用户请求路径
  }

  async function prune() {
    // 单飞：128 次写入触发的 prune 可能被多个并发 store 同时进入，各自 walk+stat 一遍。
    if (pruning) return pruning;
    pruning = doPrune().finally(() => { pruning = null; });
    return pruning;
  }

  async function doPrune() {
    let names;
    try { names = await fs.promises.readdir(dir); } catch { return 0; }
    // 隐藏文件（.DS_Store 之类）不算缓存项，不参与 maxFiles 计数，也不该被当最旧淘汰。
    names = names.filter((name) => !name.startsWith('.'));
    if (names.length <= maxFiles) return 0;
    // 分批 stat：缓存目录可能瞬间上千个文件，一次 Promise.all 会打爆 FD 并卡住事件循环。
    const stats = [];
    for (let i = 0; i < names.length; i += 64) {
      const got = await Promise.all(names.slice(i, i + 64).map(async (name) => {
        const st = await statOf(path.join(dir, name));
        return st ? { name, mtimeMs: st.mtimeMs } : null;
      }));
      for (const s of got) if (s) stats.push(s);
    }
    stats.sort((a, b) => a.mtimeMs - b.mtimeMs);
    const drop = stats.slice(0, Math.max(0, stats.length - maxFiles));
    await Promise.all(drop.map((s) => fs.promises.rm(path.join(dir, s.name), { force: true })));
    return drop.length;
  }

  // 本轮该试哪些上游：上次成功的排最前；刚失败过的先跳过（冷静期内不再为它干等超时）。
  function candidates() {
    const ordered = lastGood ? [lastGood, ...upstreams.filter((u) => u !== lastGood)] : [...upstreams];
    const now = Date.now();
    return ordered.filter((u) => (down.get(u) ?? 0) <= now);
  }

  function markDown(base) {
    down.set(base, Date.now() + downMs);
    if (lastGood === base) lastGood = null;
  }

  async function fetchUpstream(hash) {
    if (!upstreams.length) return { kind: 'disabled' };
    // 启动探测还没落地：等它（最多 probeTimeoutMs），免得这次请求自己再去撞一遍连不通的那家。
    if (probing) await probing.catch(() => {});

    // 预算按实际出站请求扣：一次 resolve 可能依次问 2–3 家上游，按 hash 只扣 1 会把上限放大成 3 倍。
    let missing = 0;
    for (const base of candidates()) {
      const now = Date.now();
      if (now - budget.at >= 60000) budget = { at: now, n: 0 };
      if (budget.n >= maxFetchesPerMinute) return { kind: 'budget' };
      budget.n++;
      try {
        const res = await fetchImpl(`${base}/${hash}?s=${size}&d=404`, {
          signal: AbortSignal.timeout(timeoutMs), redirect: 'error',
          headers: { accept: 'image/png,image/jpeg,image/*;q=0.8' },
        });
        // d=404：这家没该邮箱头像。继续问下一家别就此下结论——镜像数据不完整（实测 a@uua.me 在 Cravatar
        // 404 却在别的镜像有图）；只有所有上游都回 404 才说明确实没头像（记负缓存）。
        if (res.status === 404) { lastGood = base; missing++; discard(res); continue; }
        if (!res.ok) { markDown(base); discard(res); continue; }
        if (!String(res.headers.get('content-type') ?? '').startsWith('image/')) { markDown(base); discard(res); continue; }
        const buf = await readBoundedStream(res.body, maxBytes);
        const type = buf && sniffImageType(buf);
        if (!type) { markDown(base); continue; }
        lastGood = base; down.delete(base);
        return { kind: 'image', body: buf, type };
      } catch { markDown(base); }
    }
    // 故障或冷静期内跳过的上游没有给出结论，不能把暂时不可用缓存成“没有头像”。
    if (missing === upstreams.length) return { kind: 'none' };
    return { kind: 'failed' };
  }

  async function fetchAndStore(hash, file, negFile) {
    const got = await fetchUpstream(hash);
    try {
      if (got.kind === 'image') {
        // 规范化失败（或产物认不出）就用上游原图兜底：宁可多传几 KB，也不能因 sharp 读不了某张怪图就没头像。
        let body = got.body;
        if (transform) {
          try {
            const out = await transform(got.body, size);
            if (out?.body?.length && sniffImageType(out.body)) body = out.body;
          } catch (err) { log(`[avatar] 规范化失败，改用原图：${err.message}`); }
        }
        await store(file, body);
        await fs.promises.rm(negFile, { force: true }).catch(() => {});
        return { kind: 'image', body, type: sniffImageType(body) };
      }
      if (got.kind === 'none') await store(negFile, Buffer.alloc(0));
    } catch (err) { log(`[avatar] 缓存写入失败：${err.message}`); }
    return got;
  }

  return {
    // 启动时探一遍上游，把"连得通的那家"记下来。默认链第一家是正统 Gravatar，连不通时每个新头像都要先等满一次
    // 超时（实测首约 4.8s）；启动先探一次，之后都走可用那家。探测用全 0 假哈希：上游只回 404，只判断"连得上吗"，不写缓存。
    async probe() {
      if (probing) return probing;
      probing = (async () => {
        for (const base of upstreams) {
          try {
            const res = await fetchImpl(`${base}/${'0'.repeat(32)}?s=1&d=404`, {
              // 探测只判断"连得上吗"，用比正常回源更短的超时：把慢但可用的上游标冷静期只是暂换镜像，让每请求等满长超时更疼。
              signal: AbortSignal.timeout(probeTimeoutMs), redirect: 'error',
              headers: { accept: 'image/*' },
            });
            if (res.status === 404 || res.ok) { lastGood = base; discard(res); return base; }
            markDown(base); discard(res);
          } catch { markDown(base); }
        }
        return null;
      })().finally(() => { probing = null; });
      return probing;
    },

    /**
     * @param {string} hash 32 位小写 hex（路由层已校验）
     * @returns {Promise<{body: Buffer, type: string, maxAge: number}>} maxAge=0 表示 no-store
     */
    async resolve(hash) {
      // 模块自防护：调用方虽各自校验过，resolve 也自己挡一次路径穿越，免得新增调用方漏检时 `hash='../../x'` 就能读写缓存目录外的文件。
      if (!/^[a-f0-9]{32}$/.test(String(hash))) return { body: BLANK_PNG, type: 'image/png', maxAge: 0 };
      const file = path.join(dir, hash);
      const negFile = `${file}.none`;
      const now = Date.now();

      const pos = await statOf(file);
      if (pos && now - pos.mtimeMs < positiveTtlMs) {
        const img = await readImage(file);
        // 命中时触碰 mtime：prune 按 mtime 淘汰最旧，不触碰就成 FIFO（最早创建的热点头像先被删）而非 LRU。
        // 但每个头像请求都 utimes 太费磁盘，一小时内的重复命中跳过。
        if (img) {
          if (now - pos.mtimeMs > 3600000) void fs.promises.utimes(file, new Date(), new Date()).catch(() => {});
          return { ...img, maxAge: POSITIVE_MAX_AGE };
        }
      }
      const neg = await statOf(negFile);
      if (neg && now - neg.mtimeMs < negativeTtlMs) return { body: BLANK_PNG, type: 'image/png', maxAge: NEGATIVE_MAX_AGE };

      const blank = { body: BLANK_PNG, type: 'image/png', maxAge: 0 };
      const stale = async () => {
        if (!pos) return blank;
        const img = await readImage(file);
        return img ? { ...img, maxAge: STALE_MAX_AGE } : blank;
      };

      let pending = inflight.get(hash);
      if (!pending) {
        if (inflight.size >= maxInflight) return stale();   // 回源在飞的太多了：先给能给的，别排队
        pending = fetchAndStore(hash, file, negFile).finally(() => inflight.delete(hash));
        inflight.set(hash, pending);
      }
      const got = await pending;
      if (got.kind === 'image') return { body: got.body, type: got.type, maxAge: POSITIVE_MAX_AGE };
      if (got.kind === 'none') return { body: BLANK_PNG, type: 'image/png', maxAge: NEGATIVE_MAX_AGE };
      return stale();   // 上游挂了 / 超预算 / 没配上游
    },
    prune,
  };
}

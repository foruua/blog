import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { Readable } from 'node:stream';
import { gzip, brotliCompress, constants as zlibConstants } from 'node:zlib';
import { promisify } from 'node:util';
import { PUBLIC_DIR, UPLOADS_DIR } from '../config.js';
import { mediaRevision } from '../media/revision.js';
import { minifyAsset } from '../render/minify.js';
import { ifNoneMatch, pickEncoding } from '../util/http.js';

const gzipAsync = promisify(gzip);
const brotliAsync = promisify(brotliCompress);

// 静态资源响应：public 下的指纹资源、主题资源之外的 /uploads、以及 Range 分片。
// 从 server.js 抽出来，只保留一个出口 sendFile()；server 仍负责路由与安全头。
export const MIME = {
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.gif': 'image/gif',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.webp': 'image/webp',
  '.avif': 'image/avif',
  '.ico': 'image/x-icon',
  '.woff2': 'font/woff2',
  '.txt': 'text/plain; charset=utf-8',
  '.xml': 'application/xml; charset=utf-8',
};

export function createStaticFiles({ repo, assetVer }) {
  const realRootCache = new Map();
  // 构建期产物：scripts/build-assets.mjs 生成 .build/manifest.json + 精简/压缩文件。
  // 清单按源文件 sha256 校验，源改过而没重新构建时自动退回运行时精简，绝不发旧内容。
  const buildDir = path.join(PUBLIC_DIR, '.build');
  let precompiled = null;
  const precompiledCache = new Map();
  const compressedCache = new Map();
  const COMPRESSED_CACHE_MAX = 64;

  function loadPrecompiled() {
    if (precompiled) return precompiled;
    precompiled = new Map();
    try {
      const manifest = JSON.parse(fs.readFileSync(path.join(buildDir, 'manifest.json'), 'utf8'));
      for (const [rel, entry] of Object.entries(manifest.files ?? {})) {
        if (!entry || typeof entry.hash !== 'string') continue;
        try {
          const source = fs.readFileSync(path.join(PUBLIC_DIR, rel));
          const hash = crypto.createHash('sha256').update(source).digest('hex');
          if (hash === entry.hash) precompiled.set(rel, entry);
        } catch { /* 源文件已删除，忽略这一条 */ }
      }
    } catch { /* 没有构建产物：运行时精简即可 */ }
    return precompiled;
  }

  function precompiledFor(rel, stat) {
    const entry = loadPrecompiled().get(rel);
    if (!entry) return null;
    // 源文件在构建后被替换/编辑过：只看 size+mtime 足够；内容哈希已在加载清单时校验。
    if (Number(entry.size) !== stat.size || Math.abs(Number(entry.mtimeMs) - stat.mtimeMs) > 1) return null;
    return entry;
  }

  function readBuildFile(entry, suffix) {
    const key = `${entry.hash}:${suffix}`;
    const hit = precompiledCache.get(key);
    if (hit) return hit;
    try {
      const buf = fs.readFileSync(path.join(buildDir, entry[suffix]));
      if (precompiledCache.size >= 64) precompiledCache.delete(precompiledCache.keys().next().value);
      precompiledCache.set(key, buf);
      return buf;
    } catch { return null; }
  }

  async function compressedBuffer(real, stat, buf, encoding) {
    const key = `${real}:${stat.ino}:${stat.size}:${stat.mtimeMs}:${stat.ctimeMs}:${encoding}`;
    const hit = compressedCache.get(key);
    if (hit) return hit;
    const compressed = encoding === 'br'
      ? await brotliAsync(buf, { params: { [zlibConstants.BROTLI_PARAM_QUALITY]: 5 } })
      : await gzipAsync(buf);
    if (compressedCache.size >= COMPRESSED_CACHE_MAX) compressedCache.delete(compressedCache.keys().next().value);
    compressedCache.set(key, compressed);
    return compressed;
  }

  async function realRootOf(root) {
    const cached = realRootCache.get(root);
    if (cached) {
      // 若部署用整目录替换（mv 换 inode），旧 realpath 会把请求判成「不在受管根内」而 404，直到重启。
      // 每次顺手 stat 根目录校验 dev:ino（一次 stat 远比 realpath 便宜），换了就重算。
      try {
        const st = fs.statSync(root);
        if (st.dev === cached.dev && st.ino === cached.ino) return cached.real;
      } catch { return null; }
      realRootCache.delete(root);
    }
    try {
      const real = await fs.promises.realpath(root);
      const st = fs.statSync(root);
      realRootCache.set(root, { real, dev: st.dev, ino: st.ino });
      return real;
    } catch { return null; }
  }

  // realpath 缓存：/uploads/* 的文件名就是内容哈希、带指纹的资源也在部署时才变，一个三十张图的页面
  // 没必要每次 realpath。**不要缓存 stat**：部署时 rsync 原子替换文件会换 inode，60 秒的旧 size 配新字节
  // 会让 Content-Length 与响应体不一致（截断/连接错位）。下面统一 open + fstat，长度与字节来自同一个 fd。
  // 失效靠 media_revision 代际：删图/上传都会 bump 它，否则「刚删的图还能打开」会拖到 TTL 到期。
  const fileRealCache = new Map();
  const FILE_REAL_TTL_MS = 60_000;
  const FILE_REAL_MAX = 4000;
  let statCacheRevision = -1;

  async function realFileOf(resolved, realRoot) {
    const hit = fileRealCache.get(resolved);
    if (hit && Date.now() - hit.at < FILE_REAL_TTL_MS) return hit.real;
    let real = null;
    try {
      const found = await fs.promises.realpath(resolved);
      if (found.startsWith(realRoot + path.sep)) real = found;
    } catch { /* 文件可能刚上传还没落盘，不缓存 miss */ }
    if (!real) { fileRealCache.delete(resolved); return null; }
    if (fileRealCache.size >= FILE_REAL_MAX) fileRealCache.delete(fileRealCache.keys().next().value);
    fileRealCache.set(resolved, { at: Date.now(), real });
    return real;
  }

  // 生产环境的精简结果缓存：按真实路径 + 尺寸/mtime 失效；开发环境根本不会走到这里。
  const minifiedCache = new Map();
  async function minifiedBuffer(real, stat) {
    // 与 assetVer 的签名同源：部署若保留 mtime 且新文件同尺寸，只看 size:mtime 会命中旧精简结果。
    const key = `${stat.ino}:${stat.size}:${stat.mtimeMs}:${stat.ctimeMs}`;
    const hit = minifiedCache.get(real);
    if (hit && hit.key === key) return hit.buf;
    const source = await fs.promises.readFile(real, 'utf8');
    let text = source;
    try { text = await minifyAsset(real, source); } catch { text = source; }   // 精简失败就发原文，绝不把站点弄挂
    const buf = Buffer.from(text, 'utf8');
    minifiedCache.set(real, { key, buf });
    return buf;
  }

  async function sendFile(c, urlPath, { root = PUBLIC_DIR, prefix = '', minify = false } = {}) {
    const rel = prefix && urlPath.startsWith(prefix) ? urlPath.slice(prefix.length) : urlPath;
    const resolved = path.resolve(root, `.${path.posix.normalize(rel)}`);
    if (!resolved.startsWith(root + path.sep)) return c.notFound();
    // 附件库的增删会 bump media_revision：代际一变就整表失效（settings 已快照，这次读不落库）。
    if (root === UPLOADS_DIR) {
      const rev = mediaRevision(repo);
      if (rev !== statCacheRevision) { fileRealCache.clear(); statCacheRevision = rev; }
    }
    const realRoot = await realRootOf(root);
    if (!realRoot) return c.notFound();
    const real = await realFileOf(resolved, realRoot);
    if (!real) return c.notFound();

    // open + fstat 用同一个 fd：长度与字节必然一致，部署期间也不会出现旧 Content-Length 配新文件。
    let fh;
    try { fh = await fs.promises.open(real, 'r'); }
    catch { fileRealCache.delete(resolved); return c.notFound(); }
    let handedOff = false;
    try {
      const stat = await fh.stat();
      if (!stat.isFile()) return c.notFound();
      // 精简资源会按 Accept-Encoding 发不同字节（br/gzip/原文）。同一 ETag 跨表示容易让缓存把
      // 压缩体当成另一种编码的验证器；用弱 ETag 表示「语义相同、字节可能不同」。
      const etag = `${minify ? 'W/' : ''}"${stat.size.toString(16)}-${stat.mtimeMs.toString(16)}"`;
      // 只有带当前指纹的 ?v= 才 immutable；任意 ?v= 或裸地址都只短缓存，避免外部链接把旧内容钉一年。
      // 上传文件路径本身就是内容哈希，始终安全。
      const requestedV = c.req.query('v');
      const versioned = root === UPLOADS_DIR
        || Boolean(requestedV && requestedV === assetVer(path.basename(urlPath)));
      const headers = {
        'Content-Type': MIME[path.extname(resolved).toLowerCase()] ?? 'application/octet-stream',
        ETag: etag,
        'Cache-Control': versioned ? 'public, max-age=31536000, immutable' : 'public, max-age=300',
      };
      if (ifNoneMatch(c, etag)) {
        const extra = { ETag: etag, 'Cache-Control': headers['Cache-Control'] };
        if (minify) extra.Vary = 'Accept-Encoding';
        return c.body(null, 304, extra);
      }
      if (minify) {
        await fh.close(); fh = null;
        const relName = rel.replace(/^\/+/, '');
        const accepted = c.req.header('accept-encoding') ?? '';
        const pre = precompiledFor(relName, stat);
        let encoding = pickEncoding(accepted, ['br', 'gzip']);
        let buf = null;
        if (pre) {
          buf = encoding ? readBuildFile(pre, encoding) : null;
          if (!buf) { encoding = ''; buf = readBuildFile(pre, 'min'); }
          if (buf) {
            headers.Vary = 'Accept-Encoding';
            if (encoding) headers['Content-Encoding'] = encoding;
          }
        }
        if (!buf) {
          // 没有构建产物（或构建过期）：退回运行时精简 + 压缩缓存，绝不为每个请求重新压一遍。
          buf = await minifiedBuffer(real, stat);
          if (encoding && buf.length >= 1024) {
            try {
              buf = await compressedBuffer(real, stat, buf, encoding);
              headers['Content-Encoding'] = encoding;
              headers.Vary = 'Accept-Encoding';
            } catch { encoding = ''; /* 压缩失败就发未压缩的精简版 */ }
          }
        }
        headers['Content-Length'] = String(buf.length);
        return c.body(c.req.method === 'HEAD' ? null : buf, 200, headers);
      }
      // 大文件（原图、归档）需要分片请求：只实现单区间：
      // 多区间按 RFC 允许忽略，直接回整份 200。
      headers['Accept-Ranges'] = 'bytes';
      const range = c.req.header('range');
      const match = /^bytes=(\d*)-(\d*)$/.exec((range ?? '').trim());
      if (match && (match[1] || match[2])) {
        let start, end;
        if (match[1]) {
          start = Number(match[1]);
          end = match[2] ? Number(match[2]) : stat.size - 1;
        } else {
          start = Math.max(0, stat.size - Number(match[2]));
          end = stat.size - 1;
        }
        if (Number.isSafeInteger(start) && Number.isSafeInteger(end) && start <= end && start < stat.size) {
          end = Math.min(end, stat.size - 1);
          headers['Content-Range'] = `bytes ${start}-${end}/${stat.size}`;
          headers['Content-Length'] = String(end - start + 1);
          if (c.req.method === 'HEAD') return c.body(null, 206, headers);
          handedOff = true;
          return c.body(Readable.toWeb(fh.createReadStream({ start, end, autoClose: true })), 206, headers);
        }
        return c.body(null, 416, { 'Content-Range': `bytes */${stat.size}`, 'Accept-Ranges': 'bytes' });
      }
      headers['Content-Length'] = String(stat.size);
      if (c.req.method === 'HEAD') return c.body(null, 200, headers);
      handedOff = true;
      return c.body(Readable.toWeb(fh.createReadStream({ autoClose: true })), 200, headers);
    } finally {
      // 交出流后由 FileHandle 的 autoClose 负责；其余路径（304/HEAD/416/异常）在这里关。
      if (!handedOff && fh) await fh.close().catch(() => {});
    }
  }

  return { sendFile };
}

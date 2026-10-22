import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';

// 资源指纹缓存。命中窗口内只读一次文件元数据；内容签名变了才读盘算指纹。
// ttlMs 决定「多久重新问一次内核」：开发环境留 1 秒（改完 CSS 刷新就能看到新指纹），生产环境资源只在部署时
// 变、进程重启即重算，所以按小时计——否则每渲染一页就是十次同步 statSync，全在请求路径上。
export function createAssetVersions(root, { now = Date.now, salt = '', ttlMs = 1000 } = {}) {
  const cache = new Map();
  return (file) => {
    const at = now(), previous = cache.get(file);
    if (previous && at - previous.at < ttlMs) return previous.value;
    const location = path.join(root, file);
    let signature;
    try {
      const stat = fs.statSync(location, { bigint: true });
      signature = `${stat.ino}:${stat.size}:${stat.mtimeNs}:${stat.ctimeNs}`;
    } catch { signature = 'missing'; }
    if (previous?.signature === signature) { previous.at = at; return previous.value; }
    let content;
    try { content = fs.readFileSync(location); } catch { content = `${file}:missing`; }
    const value = crypto.createHash('sha1').update(salt).update(content).digest('hex').slice(0, 10);
    cache.set(file, { at, signature, value });
    return value;
  };
}

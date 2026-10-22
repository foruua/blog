import fs from 'node:fs';
import path from 'node:path';

export function staleOutputPlan(root, { maxAgeMs = 30 * 86400000, now = Date.now() } = {}) {
  const files = [];
  const walk = (dir) => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      if (entry.name.startsWith('.') || entry.name === 'tencent-deploy') continue;
      const file = path.join(dir, entry.name);
      if (entry.isDirectory()) walk(file);
      else if (entry.isFile() && /\.(?:png|jpe?g|webp|log)$/i.test(entry.name)) {
        const stat = fs.statSync(file);
        if (stat.mtimeMs < now - maxAgeMs) files.push({ path: path.relative(root, file), bytes: stat.size, mtimeMs: stat.mtimeMs });
      }
    }
  };
  if (fs.existsSync(root)) walk(root);
  return files;
}

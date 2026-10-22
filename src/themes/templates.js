import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';

const TEMPLATE_EXT = new Set(['.liquid', '.html']);
const MAX_DEPTH = 8;

/** 递归收集模板文件；跳过点目录与软链接（软链接可能指向主题外）。 */
export function walkTemplates(dir, out = [], depth = 0) {
  if (depth > MAX_DEPTH) return out;
  let entries = [];
  try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return out; }
  for (const entry of entries) {
    if (entry.name.startsWith('.')) continue;
    const abs = path.join(dir, entry.name);
    if (entry.isSymbolicLink()) continue;
    if (entry.isDirectory()) walkTemplates(abs, out, depth + 1);
    else if (entry.isFile() && TEMPLATE_EXT.has(path.extname(entry.name).toLowerCase())) out.push(abs);
  }
  return out;
}

/**
 * 模板名 -> 相对主题根目录的路径（`templates/home`）。
 * LiquidJS 的 root 是主题根目录，所以存 `templates/...` 而不是绝对路径。
 */
export function templateMap(theme, files = null) {
  const map = new Map();
  if (!theme?.templatesAbs) return map;
  // 同名 .liquid / .html 同时存在时固定选 .liquid，再按路径排序：结果不依赖文件系统的 readdir 顺序。
  const list = (files ?? walkTemplates(theme.templatesAbs)).slice().sort((a, b) => {
    const ext = (file) => (file.toLowerCase().endsWith('.liquid') ? 0 : 1);
    return ext(a) - ext(b) || a.localeCompare(b);
  });
  for (const abs of list) {
    const rel = path.relative(theme.templatesAbs, abs).split(path.sep).join('/');
    const name = rel.replace(/\.(?:liquid|html)$/i, '');
    const file = `${theme.templatesDir}/${rel}`;
    if (!map.has(name)) map.set(name, file);
  }
  return map;
}

/**
 * 清单 + 所有模板的 size/mtime 压成一个签名。模板解析缓存按它做 key：
 * 覆盖安装或直接改模板后，签名一变就换新引擎，不会继续发上一版。
 */
export function templateSignature(theme, files = null) {
  const hash = crypto.createHash('sha1');
  if (!theme?.dir) return '';
  try {
    const manifest = fs.statSync(path.join(theme.dir, 'theme.json'));
    // ino/ctime 与静态资源的指纹口径一致：rsync 保留了 mtime 且新旧文件同尺寸时，只看 size+mtime
    // 会继续复用旧解析树；inode/ctime 变化能识别「文件被替换」。
    hash.update(`manifest:${manifest.ino}:${manifest.size}:${manifest.mtimeMs}:${manifest.ctimeMs};`);
  } catch { /* 清单刚被删掉时仍按旧 key 走，交给上层报错 */ }
  for (const abs of (files ?? walkTemplates(theme.templatesAbs)).slice().sort()) {
    try {
      const stat = fs.statSync(abs);
      hash.update(`${path.relative(theme.dir, abs)}:${stat.ino}:${stat.size}:${stat.mtimeMs}:${stat.ctimeMs};`);
    } catch { /* 遍历与读取之间被删：忽略，下一次扫描会纠正 */ }
  }
  return hash.digest('hex');
}

/** 扫描时给主题挂上模板索引与签名，渲染路径就不必再碰文件系统。 */
export function indexTheme(theme) {
  if (!theme) return theme;
  // 目录只走一次：模板索引与签名共用同一份遍历结果（后台每次扫描要把所有主题都过一遍）。
  const files = walkTemplates(theme.templatesAbs);
  theme.templates = templateMap(theme, files);
  theme.signature = templateSignature(theme, files);
  return theme;
}

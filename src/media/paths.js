import fs from 'node:fs';
import path from 'node:path';
import { UPLOADS_DIR } from '../config.js';

// 检查现有祖先和目标，未创建的派生文件也不能经过符号链接。
export function mediaFile(urlPath, root = UPLOADS_DIR) {
  if (typeof urlPath !== 'string' || !urlPath.startsWith('/uploads/')
      || /[\\\0?#]/.test(urlPath)) throw new Error('附件路径无效');
  const parts = urlPath.slice('/uploads/'.length).split('/');
  if (parts.some((part) => !part || part === '.' || part === '..')) throw new Error('附件路径无效');
  const base = path.resolve(root);
  try {
    if (!fs.statSync(base).isDirectory()) throw new Error('附件目录无效');
  } catch (error) {
    // 允许预检缺失附件；根目录尚不存在时没有可穿越的子路径。
    if (error.code === 'ENOENT') return path.join(base, ...parts);
    throw error;
  }
  let file = base;
  for (let i = 0; i < parts.length; i++) {
    file = path.join(file, parts[i]);
    let stat;
    try { stat = fs.lstatSync(file); } catch (error) {
      if (error.code === 'ENOENT') continue;
      throw error;
    }
    if (stat.isSymbolicLink() || (i < parts.length - 1 ? !stat.isDirectory() : !stat.isFile())) {
      throw new Error('附件路径无效');
    }
  }
  return file;
}

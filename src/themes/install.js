import fs from 'node:fs';
import path from 'node:path';
import { pipeline } from 'node:stream/promises';
import { Transform } from 'node:stream';
import yauzl from 'yauzl';
import { THEMES_DIR, MAX_THEME_ZIP } from '../config.js';
import { parseThemeDir, isSafeRelative } from './registry.js';

const MAX_ZIP_BYTES = MAX_THEME_ZIP;
const MAX_FILES = 300;
const MAX_FILE_BYTES = 5 * 1024 * 1024;
const MAX_TOTAL_BYTES = 20 * 1024 * 1024;

const isSymlink = (entry) => {
  const mode = (entry.externalFileAttributes >>> 16) & 0o170000;
  return mode === 0o120000;
};

const normalizedEntryName = (name) => String(name ?? '').replace(/\\/g, '/').replace(/^\/+/, '');

function safeEntry(name) {
  const clean = normalizedEntryName(name);
  if (!clean || clean.endsWith('/')) return null;
  if (clean.startsWith('__MACOSX/')) return null;
  // 点文件（.env、.git/config、.DS_Store）不属于主题公开资源：直接跳过，避免误打包造成信息泄露。
  if (clean.split('/').some((part) => part.startsWith('.'))) return null;
  if (!isSafeRelative(clean)) throw new Error(`压缩包里有不安全的路径：${name}`);
  return clean;
}

/** 读 ZIP 并解到临时目录；只做结构与大小校验，主题清单交给 registry。 */
async function extractZip(zipFile, targetDir) {
  const zip = await new Promise((resolve, reject) => {
    // autoClose 必须关掉：先把条目收集完、再逐个 openReadStream；自动关闭会让后续流打不开。
    yauzl.open(zipFile, { lazyEntries: true, autoClose: false }, (error, handle) => error ? reject(error) : resolve(handle));
  });
  // 整个流程都包在 try/finally 里：条目校验阶段就拒绝（路径不安全、超限）时也必须关掉 zip，
  // 否则每次上传坏包都会漏一个文件句柄。
  try {
    const files = [];
    await new Promise((resolve, reject) => {
      let count = 0;
      let total = 0;
      zip.on('entry', (entry) => {
        try {
          if (isSymlink(entry)) throw new Error(`不接受软链接：${entry.fileName}`);
          const name = safeEntry(entry.fileName);
          if (!name) { zip.readEntry(); return; }
          count += 1;
          if (count > MAX_FILES) throw new Error(`主题文件太多（上限 ${MAX_FILES} 个）`);
          if (entry.uncompressedSize > MAX_FILE_BYTES) throw new Error(`文件太大：${name}`);
          total += entry.uncompressedSize;
          if (total > MAX_TOTAL_BYTES) throw new Error('主题解压后超过 20MB');
          files.push({ name, entry });
          zip.readEntry();
        } catch (error) { reject(error); }
      });
      zip.on('error', reject);
      zip.on('end', resolve);
      zip.readEntry();
    });

    const manifest = files.find((file) => file.name === 'theme.json' || /^[^/]+\/theme\.json$/.test(file.name));
    if (!manifest) throw new Error('压缩包里没有 theme.json（必须在根目录或唯一一级目录）');
    const rootPrefix = manifest.name === 'theme.json' ? '' : `${manifest.name.slice(0, -'theme.json'.length)}`;
    if (rootPrefix) {
      for (const file of files) {
        if (!file.name.startsWith(rootPrefix)) throw new Error(`主题文件必须都在 ${rootPrefix} 目录里：${file.name}`);
      }
    }

    fs.mkdirSync(targetDir, { recursive: true });
    let totalWritten = 0;
    for (const file of files) {
      const relative = rootPrefix ? file.name.slice(rootPrefix.length) : file.name;
      const dest = path.resolve(targetDir, relative);
      if (!dest.startsWith(path.resolve(targetDir) + path.sep)) throw new Error(`不安全的解压路径：${file.name}`);
      fs.mkdirSync(path.dirname(dest), { recursive: true });
      const stream = await new Promise((resolve, reject) => {
        zip.openReadStream(file.entry, (error, read) => error ? reject(error) : resolve(read));
      });
      // 中央目录里的 uncompressedSize 可以伪造；实际解压再数一遍，避免压缩炸弹。
      let written = 0;
      const guard = new Transform({
        transform(chunk, _encoding, callback) {
          written += chunk.length;
          totalWritten += chunk.length;
          if (written > MAX_FILE_BYTES) callback(new Error(`文件解压后超过 5MB：${file.name}`));
          else if (totalWritten > MAX_TOTAL_BYTES) callback(new Error('主题解压后超过 20MB'));
          else callback(null, chunk);
        },
      });
      await pipeline(stream, guard, fs.createWriteStream(dest, { mode: 0o600 }));
    }
  } finally {
    zip.close();
  }
}

/**
 * 安装一个主题 ZIP。返回 { theme }，失败抛错（错误信息可直接给后台看，不含绝对路径）。
 * 只在 THEMES_DIR 内操作；同名主题先移入 .trash 再替换。
 */
export async function installThemeZip(zipFile, { replace = false, validate = null } = {}) {
  const stat = fs.statSync(zipFile);
  if (stat.size > MAX_ZIP_BYTES) throw new Error('主题包不能超过 10MB');
  const token = `${Date.now()}-${Math.random().toString(16).slice(2, 8)}`;
  const tempDir = path.join(THEMES_DIR, `.install-${token}`);
  fs.mkdirSync(THEMES_DIR, { recursive: true });
  try {
    await extractZip(zipFile, tempDir);
    // 临时目录名不是主题 id，显式关掉目录名一致性校验；真正安装到 themes/<id>/ 后再完整校验一次。
    const parsed = parseThemeDir(tempDir, { dirName: path.basename(tempDir), enforceDirName: false, index: false });
    if (parsed.errors.length) throw new Error(parsed.errors.join('；'));
    const theme = parsed.partial;
    if (!theme?.id) throw new Error('主题 id 不合法');

    if (validate) {
      const errors = validate(theme);
      if (errors.length) throw new Error(`模板校验失败：${errors.slice(0, 3).join('；')}`);
    }

    const target = path.join(THEMES_DIR, theme.id);
    // 覆盖安装先挪到隐藏的 .replace-*（不是 .trash）：新目录校验失败时还能原子挪回来。
    let replaced = null;
    if (fs.existsSync(target)) {
      if (!replace) throw new Error(`主题「${theme.id}」已存在；勾选允许覆盖后再上传`);
      replaced = path.join(THEMES_DIR, `.replace-${token}`);
      fs.renameSync(target, replaced);
    }
    try {
      fs.renameSync(tempDir, target);
      const installed = parseThemeDir(target, { dirName: theme.id });
      if (installed.errors.length) throw new Error(installed.errors.join('；'));
      if (replaced) {
        const trash = path.join(THEMES_DIR, '.trash');
        fs.mkdirSync(trash, { recursive: true });
        fs.renameSync(replaced, path.join(trash, `${theme.id}-${token}`));
        replaced = null;
      }
      return { theme: installed.theme };
    } catch (error) {
      fs.rmSync(target, { recursive: true, force: true });
      if (replaced && fs.existsSync(replaced)) fs.renameSync(replaced, target);
      throw error;
    }
  } finally {
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
}

/** 删除主题：移入 themes/.trash，不直接销毁。使用中的最后一个主题由调用方拦截。 */
export function removeThemeDir(theme) {
  if (!theme) throw new Error('主题不存在');
  const root = path.resolve(THEMES_DIR);
  const dir = path.resolve(theme.dir);
  if (!dir.startsWith(root + path.sep)) throw new Error('主题目录不在用户主题目录内');
  const trash = path.join(root, '.trash');
  fs.mkdirSync(trash, { recursive: true });
  const dest = path.join(trash, `${theme.id}-${Date.now()}`);
  fs.renameSync(dir, dest);
  return dest;
}

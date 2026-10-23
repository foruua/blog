import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { indexTheme } from './templates.js';

// 主题 API 版本。模板引擎、上下文结构、manifest 字段有不兼容变化时 +1；
// 主题在 theme.json 的 engine 里声明自己面向哪一版，加载时只认当前版本。
export const THEME_API = 1;

const ID_RE = /^[a-z0-9][a-z0-9-]{0,47}$/;
export const isValidThemeId = (value) => typeof value === 'string' && ID_RE.test(value);
const OPTION_KEY_RE = /^[a-z][a-z0-9_]{0,31}$/;
const OPTION_TYPES = new Set(['text', 'textarea', 'color', 'boolean', 'select', 'number', 'image']);
const MAX_MANIFEST_BYTES = 256 * 1024;
const MAX_OPTIONS = 40;
const SCREENSHOT_EXT = new Set(['.png', '.jpg', '.jpeg', '.webp', '.gif', '.svg']);
// 只认合法的 CSS 十六进制颜色长度（3/4/6/8），别让 #12345 这种「像颜色」的值混进样式表。
export const COLOR_RE = /^#(?:[0-9a-f]{3}|[0-9a-f]{4}|[0-9a-f]{6}|[0-9a-f]{8})$/i;

const isSafeRelative = (value) => typeof value === 'string' && value.length > 0 && value.length <= 300
  && !value.includes('\\') && !value.includes('\0')
  && !path.posix.isAbsolute(value) && !/^[a-z]:/i.test(value)
  && value.split('/').every((part) => part !== '' && part !== '.' && part !== '..');

// 主题里的图片只认站内路径：外站图片会被 CSP 的 img-src 'self' 直接拦掉，
// 与其让它静默坏成空白，不如保存时就拒绝。
export function isSafeImagePath(value) {
  if (value === '') return true;
  if (typeof value !== 'string' || value.length > 300) return false;
  if (!value.startsWith('/') || value.startsWith('//')) return false;
  if (value.includes('..') || value.includes('\\')) return false;
  // 空白与引号/尖括号/反引号会破坏 HTML 属性；? 和 # 会被当成查询串/片段，站内路径不该带。
  if (/[\s"'<>`?#]/.test(value)) return false;
  for (const ch of value) {
    const code = ch.codePointAt(0);
    if (code < 0x20 || code === 0x7f) return false;
  }
  return true;
}

const safeJoin = (root, relative) => {
  if (!isSafeRelative(relative)) return null;
  const resolved = path.resolve(root, relative);
  return resolved.startsWith(root + path.sep) ? resolved : null;
};

/**
 * 解析软链接后仍必须落在主题目录内的普通文件。
 * 只做 safeJoin 不够：主题目录允许手工放置，assets/ 里的软链接能指到 .env；ZIP 安装虽拒绝软链接，
 * 直接拷贝进来的目录却没有这层保护。
 */
function realFileWithin(root, file, knownRealRoot = null) {
  try {
    const realRoot = knownRealRoot ?? fs.realpathSync(root);
    const real = fs.realpathSync(file);
    if (real !== realRoot && !real.startsWith(realRoot + path.sep)) return null;
    return fs.statSync(real).isFile() ? real : null;
  } catch { return null; }
}

// 模板目录本身也要确认真实路径在主题内：手工拷贝进来的 themes/<id>/templates 若是指向外部的软链接，
// walkTemplates 会顺着根目录读到主题外的 .liquid/.html 文件。
function realDirectoryWithin(root, dir, knownRealRoot = null) {
  try {
    const realRoot = knownRealRoot ?? fs.realpathSync(root);
    const real = fs.realpathSync(dir);
    if (real !== realRoot && !real.startsWith(realRoot + path.sep)) return null;
    return fs.statSync(real).isDirectory() ? real : null;
  } catch { return null; }
}

function readManifest(dir) {
  const file = path.join(dir, 'theme.json');
  let stat;
  try { stat = fs.statSync(file); } catch { return { error: '缺少 theme.json' }; }
  if (!stat.isFile()) return { error: 'theme.json 不是文件' };
  if (stat.size > MAX_MANIFEST_BYTES) return { error: 'theme.json 超过 256KB' };
  try {
    const raw = JSON.parse(fs.readFileSync(file, 'utf8'));
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return { error: 'theme.json 必须是对象' };
    return { raw };
  } catch (error) {
    return { error: `theme.json 解析失败：${error.message}` };
  }
}

function normalizeOption(raw, index) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return { error: `第 ${index + 1} 个选项不是对象` };
  const key = String(raw.key ?? '').trim();
  if (!OPTION_KEY_RE.test(key)) return { error: `选项 key 不合法：${key || '(空)'}` };
  const type = String(raw.type ?? 'text').trim();
  if (!OPTION_TYPES.has(type)) return { error: `选项 ${key} 的 type 不合法：${type}` };
  const label = String(raw.label ?? key).trim().slice(0, 60) || key;
  const option = { key, type, label, description: String(raw.description ?? '').trim().slice(0, 200) };

  if (type === 'select') {
    const list = Array.isArray(raw.options) ? raw.options : [];
    option.options = list.slice(0, 50).map((item) => {
      if (typeof item === 'string') return { value: item.slice(0, 80), label: item.slice(0, 80) };
      return { value: String(item?.value ?? '').slice(0, 80), label: String(item?.label ?? item?.value ?? '').slice(0, 80) };
    }).filter((item) => item.value);
    if (!option.options.length) return { error: `选项 ${key} 是 select，但没有可选项` };
    if (!option.options.some((item) => item.value === String(raw.default ?? ''))) option.default = option.options[0].value;
    else option.default = String(raw.default);
  } else if (type === 'boolean') {
    option.default = raw.default === true || raw.default === 'true' || raw.default === 1;
  } else if (type === 'number') {
    const min = Number.isFinite(Number(raw.min)) ? Number(raw.min) : -1e9;
    const max = Number.isFinite(Number(raw.max)) ? Number(raw.max) : 1e9;
    const step = Number.isFinite(Number(raw.step)) && Number(raw.step) > 0 ? Number(raw.step) : 1;
    if (min > max) return { error: `选项 ${key} 的 min 不能大于 max` };
    option.min = min; option.max = max; option.step = step;
    const n = Number(raw.default);
    // 没写 default 时落在 0（若区间包含 0），否则贴到最近的边界；不要落成 -1e9 这种看不见的值。
    option.default = Number.isFinite(n) ? Math.min(max, Math.max(min, n)) : Math.min(max, Math.max(min, 0));
  } else if (type === 'image') {
    const value = String(raw.default ?? '').trim().slice(0, 300);
    option.default = isSafeImagePath(value) ? value : '';
  } else {
    option.default = String(raw.default ?? '').slice(0, type === 'textarea' ? 2000 : 200);
    if (type === 'color' && option.default && !COLOR_RE.test(option.default)) option.default = '';
  }
  return { option };
}

function normalizeOptions(rawOptions) {
  if (rawOptions == null) return { options: [] };
  if (!Array.isArray(rawOptions)) return { error: 'options 必须是数组' };
  if (rawOptions.length > MAX_OPTIONS) return { error: `options 最多 ${MAX_OPTIONS} 项` };
  const options = [];
  const seen = new Set();
  for (let i = 0; i < rawOptions.length; i++) {
    const result = normalizeOption(rawOptions[i], i);
    if (result.error) return result;
    if (seen.has(result.option.key)) return { error: `选项 key 重复：${result.option.key}` };
    seen.add(result.option.key);
    options.push(result.option);
  }
  return { options };
}

/** 把一个主题目录解析成可直接使用的主题对象；失败时同时返回 errors，后台仍能把坏主题列出来。 */
export function parseThemeDir(dir, { dirName = path.basename(dir), enforceDirName = true, index = true } = {}) {
  const rootDir = path.resolve(dir);
  const errors = [];
  const manifest = readManifest(rootDir);
  if (manifest.error) return { theme: null, errors: [manifest.error] };
  const raw = manifest.raw;

  if (typeof raw.id !== 'string' || !raw.id.trim()) errors.push('缺少主题 id（theme.json 的 id 必填）');
  const id = String(raw.id ?? dirName).trim();
  if (!ID_RE.test(id)) errors.push(`主题 id 不合法：${id || '(空)'}（只能用小写字母、数字和短横线）`);
  // 安装 ZIP 时目录还是临时名，不能要求它与清单 id 一致（那时文件名不可信）。
  if (enforceDirName && id !== dirName) errors.push(`主题 id「${id}」必须与目录名「${dirName}」一致`);

  if (typeof raw.name !== 'string' || !raw.name.trim()) errors.push('缺少主题名称 name');
  const name = String(raw.name ?? id).trim().slice(0, 80);
  if (!name) errors.push('主题名称不能为空');

  const version = String(raw.version ?? '0.0.0').trim().slice(0, 40);
  if (!/^\d+(?:\.\d+){0,3}(?:[-+][0-9A-Za-z.-]+)?$/.test(version)) errors.push(`版本号不合法：${version}`);

  const engine = String(raw.engine ?? String(THEME_API)).trim();
  const engineMajor = engine.replace(/^[\^~=v]/, '').split('.')[0];
  if (engineMajor !== String(THEME_API)) errors.push(`主题面向 API ${engine}，当前只支持 API ${THEME_API}`);

  const templatesDirName = String(raw.templates ?? 'templates').trim();
  const assetsDirName = String(raw.assets ?? 'assets').trim();
  if (!isSafeRelative(templatesDirName)) errors.push(`templates 目录不合法：${templatesDirName}`);
  if (!isSafeRelative(assetsDirName)) errors.push(`assets 目录不合法：${assetsDirName}`);
  const templatesDir = safeJoin(rootDir, templatesDirName);
  const assetsDir = safeJoin(rootDir, assetsDirName);
  let templatesReal = null;
  if (!templatesDir || !fs.existsSync(templatesDir) || !fs.statSync(templatesDir).isDirectory()) {
    errors.push(`模板目录不存在：${templatesDirName}/`);
  } else {
    templatesReal = realDirectoryWithin(rootDir, templatesDir);
    if (!templatesReal) errors.push(`模板目录不能是指向主题目录外的软链接：${templatesDirName}/`);
  }
  // assets/ 是可选的：纯模板主题完全可以没有样式与图片，别把一个合法的空主题挡在门外。
  // 目录不存在时 assetPath() 会自然返回 null，无需在这里报错。

  const optionsResult = normalizeOptions(raw.options);
  if (optionsResult.error) errors.push(optionsResult.error);

  // 截图：默认为根目录 screenshot.png；给了路径就必须存在且在主题目录内。
  let screenshot = null;
  const shotRel = String(raw.screenshot ?? (fs.existsSync(path.join(rootDir, 'screenshot.png')) ? 'screenshot.png' : '')).trim();
  if (shotRel) {
    const shot = safeJoin(rootDir, shotRel);
    const realShot = shot ? realFileWithin(rootDir, shot) : null;
    if (!shot || !realShot) errors.push(`截图不存在：${shotRel}`);
    else if (!SCREENSHOT_EXT.has(path.extname(shot).toLowerCase())) errors.push('截图只支持 png / jpg / webp / gif / svg');
    else if (fs.statSync(realShot).size > 2 * 1024 * 1024) errors.push('截图不能超过 2MB');
    else screenshot = { path: shotRel, abs: realShot };
  }

  let realDir = null;
  try { realDir = fs.realpathSync(rootDir); } catch { /* 目录刚消失，交给调用方报错 */ }
  const theme = {
    id, name, version, engine,
    realDir,
    description: String(raw.description ?? '').trim().slice(0, 400),
    author: String(raw.author ?? '').trim().slice(0, 120),
    isDefault: raw.default === true,
    dir: rootDir,
    templatesDir: templatesDirName,
    assetsDir: assetsDirName,
    templatesAbs: templatesReal ?? templatesDir,
    assetsAbs: assetsDir,
    screenshot,
    options: optionsResult.options ?? [],
    raw,
  };
  // 扫描阶段只解析清单；模板索引/签名等真正用到某个主题时再算（get() 里懒加载）。
  if (index) indexTheme(theme);
  return { theme: errors.length ? null : theme, errors, partial: theme };
}

/**
 * 主题仓库：扫描唯一的 themes/ 目录。getActive/optionsOf 由调用方注入，仓库本身不依赖数据库。
 */
export function createThemeRegistry({
  themesDir, getActive = () => '', getOptions = () => '',
  now = Date.now, scanTtlMs = 2000,
  assetTtlMs = process.env.NODE_ENV === 'production' ? 60_000 : 1_000,
} = {}) {
  const root = themesDir ? path.resolve(themesDir) : null;
  let cache = { at: 0, themes: [], errors: [], map: new Map() };
  // 主题资源地址按 (id, 路径) 缓存：一个页面会问好几次 theme.css / 截图，
  // 每次都要 existsSync + statSync 才能算指纹。TTL 内直接复用，扫描时整体作废。
  const urlCache = new Map();
  const optionsCache = new Map(); // theme id → { raw, value }

  function scan(force = false) {
    const at = now();
    if (!force && at - cache.at < scanTtlMs) return cache;
    urlCache.clear();
    const found = new Map();
    const errors = [];
    let entries = [];
    try { entries = root ? fs.readdirSync(root, { withFileTypes: true }) : []; } catch { /* 首次部署时目录可能还不存在 */ }
    for (const entry of entries) {
      if (!entry.isDirectory() || entry.name.startsWith('.')) continue;
      const themeDir = path.join(root, entry.name);
      let parsed;
      try {
        parsed = parseThemeDir(themeDir, { dirName: entry.name, index: false });
      } catch (error) {
        // 扫描期间目录被删/改权限等：只把这个主题记为坏主题，绝不能让首页 500。
        errors.push({ id: entry.name, dir: themeDir, errors: [`主题扫描失败：${error?.message ?? error}`] });
        continue;
      }
      if (parsed.errors.length) {
        errors.push({ id: entry.name, dir: themeDir, errors: parsed.errors });
        continue;
      }
      found.set(parsed.theme.id, parsed.theme);
    }
    const themes = [...found.values()].sort((a, b) => a.name.localeCompare(b.name) || a.id.localeCompare(b.id));
    cache = { at, themes, errors, map: found };
    return cache;
  }

  const list = (force = false) => scan(force).themes;
  const errors = (force = false) => scan(force).errors;
  const get = (id) => {
    const key = String(id ?? '').trim();
    const theme = key ? scan().map.get(key) ?? null : null;
    // 只有真正要渲染/校验的主题才 walk 模板目录并算签名；后台列表不付出这份成本。
    if (theme && !theme.templates) indexTheme(theme);
    return theme;
  };

  function activeId() {
    const id = String(getActive() ?? '').trim();
    return id && get(id) ? id : '';
  }
  function active() {
    const id = activeId();
    return id ? get(id) : null;
  }

  /** 首次启用/激活值失效时的默认主题：优先 theme.json 的 default:true，否则列表第一个。 */
  function defaultTheme() {
    const themes = list();
    const theme = themes.find((item) => item.isDefault) ?? themes[0] ?? null;
    return theme ? get(theme.id) : null;
  }

  /** 合并默认值与已保存值；非法值一律回默认，主题升级后旧选项不会把表单弄坏。 */
  function optionsOf(theme) {
    if (!theme?.options?.length) return {};
    const raw = getOptions(theme.id) ?? '';
    // 选项定义也可能随主题覆盖安装改变（id/version 不变时），签名必须一起进 key，否则会拿旧默认值。
    const key = `${theme.id}|${raw}|${JSON.stringify(theme.options)}`;
    const hit = optionsCache.get(key);
    if (hit) return hit.value;
    const stored = (() => {
      if (!raw) return {};
      try {
        const value = JSON.parse(raw);
        return value && typeof value === 'object' && !Array.isArray(value) ? value : {};
      } catch { return {}; }
    })();
    const out = {};
    for (const option of theme?.options ?? []) {
      const value = stored[option.key];
      if (option.type === 'boolean') out[option.key] = value === undefined ? option.default : (value === true || value === 'true' || value === 1);
      else if (option.type === 'number') {
        const n = Number(value);
        out[option.key] = Number.isFinite(n) ? Math.min(option.max, Math.max(option.min, n)) : option.default;
      } else if (option.type === 'select') {
        out[option.key] = option.options.some((item) => item.value === String(value ?? '')) ? String(value) : option.default;
      } else if (option.type === 'color') {
        out[option.key] = typeof value === 'string' && COLOR_RE.test(value) ? value : option.default;
      } else if (option.type === 'image') {
        out[option.key] = typeof value === 'string' && isSafeImagePath(value) ? value : option.default;
      } else {
        out[option.key] = value === undefined ? option.default : String(value).slice(0, option.type === 'textarea' ? 2000 : 200);
      }
    }
    if (optionsCache.size >= 32 && !optionsCache.has(key)) optionsCache.delete(optionsCache.keys().next().value);
    optionsCache.set(key, { value: out });
    return out;
  }

  function assetPath(theme, relative) {
    if (!theme) return null;
    const rel = String(relative ?? '').replace(/^\/+/, '');
    // 点文件不对外：主题包误带的 .env / .git 配置不能被 /theme-assets/ 读走。
    if (rel.split('/').some((part) => part.startsWith('.'))) return null;
    if (theme.screenshot && rel === theme.screenshot.path) {
      return realFileWithin(theme.dir, theme.screenshot.abs, theme.realDir);
    }
    const underAssets = safeJoin(theme.assetsAbs, rel);
    return underAssets ? realFileWithin(theme.dir, underAssets, theme.realDir) : null;
  }

  function assetVersion(theme, relative, knownFile = null) {
    const file = knownFile ?? assetPath(theme, relative);
    if (!file) return 'missing';
    try {
      const stat = fs.statSync(file, { bigint: true });
      return crypto.createHash('sha1').update(`${stat.ino}:${stat.size}:${stat.mtimeNs}`).digest('hex').slice(0, 10);
    } catch { return 'missing'; }
  }

  function assetUrl(theme, relative) {
    if (!theme) return '';
    const rel = String(relative ?? '').replace(/^\/+/, '');
    const key = `${theme.id}:${rel}`;
    const hit = urlCache.get(key);
    if (hit && now() - hit.at < hit.ttl) return hit.url;
    // 逐段编码：文件名里的空格、?、# 不该被当成 URL 分隔符（否则资源地址会静默指向别处）。
    const encoded = rel.split('/').map(encodeURIComponent).join('/');
    const file = assetPath(theme, rel);
    const url = file
      ? `/theme-assets/${encodeURIComponent(theme.id)}/${encoded}?v=${assetVersion(theme, rel, file)}`
      : '';
    // 不存在的资源也记一下，但只记几秒：作者刚补上文件时不必等满一个 TTL。
    urlCache.set(key, { at: now(), url, ttl: url ? assetTtlMs : Math.min(assetTtlMs, 5000) });
    return url;
  }

  return { list, errors, get, active, activeId, defaultTheme, optionsOf, assetPath, assetVersion, assetUrl, scan };
}

export { isSafeRelative };

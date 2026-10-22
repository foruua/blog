import fs from 'node:fs';
import path from 'node:path';
import { getCookie, setCookie, deleteCookie } from 'hono/cookie';
import { THEMES_DIR, MAX_THEME_ZIP } from '../../config.js';
import { cookieBase } from '../../util/http.js';
import { KEYS, themeOptionsKey } from '../../settings.js';
import { THEME_PREVIEW_COOKIE } from '../../themes/request.js';
import { installThemeZip, removeThemeDir } from '../../themes/install.js';
import { isSafeImagePath, COLOR_RE, isValidThemeId } from '../../themes/registry.js';
import { listThemeErrors, clearThemeErrors } from '../../themes/errors.js';
import { themesPage } from '../../admin/views/themes.js';
import { bodyOf, val, checked, notice, externalWrite } from './shared.js';
import { createMutationQueue } from '../../util/lock.js';


const safeLocalPath = (value) => {
  const text = String(value ?? '/').trim();
  if (!text.startsWith('/') || text.startsWith('//') || text.includes('\\')) return '/';
  for (const ch of text) {
    const code = ch.codePointAt(0);
    if (code < 0x20 || code === 0x7f) return '/';
  }
  // 防 `/foo/..//evil`、`/%2e%2e//evil` 这类经浏览器归一化后变成协议相对地址的路径。
  const path = text.split(/[?#]/, 1)[0];
  if (path.includes('//') || /%2e|%2f|%5c/i.test(path)
      || path.split('/').some((part) => part === '.' || part === '..')) return '/';
  return text.slice(0, 500);
};

function optionValuesFromForm(theme, body) {
  const values = {};
  for (const option of theme.options ?? []) {
    const raw = val(body, `opt_${option.key}`);
    if (option.type === 'boolean') values[option.key] = checked(body, `opt_${option.key}`);
    else if (option.type === 'number') {
      const n = Number(raw);
      if (!Number.isFinite(n) || n < option.min || n > option.max) return { error: `「${option.label}」必须是 ${option.min}—${option.max} 之间的数字` };
      values[option.key] = n;
    } else if (option.type === 'select') {
      if (!option.options.some((item) => item.value === raw)) return { error: `「${option.label}」的取值不合法` };
      values[option.key] = raw;
    } else if (option.type === 'color') {
      if (raw && !COLOR_RE.test(raw)) return { error: `「${option.label}」必须是 #RGB / #RRGGBB / #RRGGBBAA 形式的颜色` };
      values[option.key] = raw;
    } else if (option.type === 'image') {
      const value = String(raw).trim();
      if (!isSafeImagePath(value)) return { error: `「${option.label}」必须是站内路径（以 / 开头）` };
      values[option.key] = value;
    } else {
      values[option.key] = String(raw).slice(0, option.type === 'textarea' ? 2000 : 200);
    }
  }
  return { values };
}

export function registerThemeRoutes(app, { themes, engine, repo }, { ctx }) {
  // 主题安装/删除/启用会解压、遍历模板并解析校验，耗时可能是秒级。它们不写业务表，
  // 不该占住全局写队列把评论/保存一起堵死；这里用一条独立的主题队列串行化彼此的文件操作。
  const themeQueue = createMutationQueue();
  // 视图只需要展示字段：不要把 dir / templatesAbs / raw 清单等内部结构一路传进模板层。
  const viewTheme = (theme) => ({
    id: theme.id,
    name: theme.name,
    version: theme.version,
    author: theme.author,
    description: theme.description,
    options: theme.options,
    isDefault: theme.isDefault,
    optionValues: themes.optionsOf(theme),
    screenshot_url: theme.screenshot ? themes.assetUrl(theme, theme.screenshot.path) : '',
  });

  // 使用中的主题：setting 指向的主题；若 setting 失效，展示并继续使用列表第一个可用主题。
  const currentId = () => themes.activeId() || themes.defaultTheme()?.id || '';

  const pageOf = (c, noticeText = '') => {
    // 一次全量扫描：list() / errors() / get() 在 TTL 内都吃这份缓存，不必各扫一遍。
    themes.scan(true);
    return themesPage({
      ...ctx(c),
      themes: themes.list().map(viewTheme),
      active: currentId(),
      preview: (() => {
        const id = getCookie(c, THEME_PREVIEW_COOKIE) || '';
        return id && themes.get(id) ? id : '';
      })(),
      errors: themes.errors(),
      renderErrors: listThemeErrors(),
      notice: noticeText || c.req.query('w') || '',
    });
  };

  app.get('/admin/themes', (c) => c.html(pageOf(c)));

  externalWrite(app, '/admin/themes/activate', async (c) => {
    const body = await bodyOf(c);
    const id = val(body, 'id').trim();
    if (!id) return notice(c, '/admin/themes', '✗ 请选择一个主题');
    if (!isValidThemeId(id)) return notice(c, '/admin/themes', '✗ 主题 id 不合法');
    const theme = themes.get(id);
    if (!theme) return notice(c, '/admin/themes', `✗ 主题「${id}」不存在或未通过校验`);
    return themeQueue(() => {
      const errors = engine.validate(theme);
      if (errors.length) return notice(c, '/admin/themes', `✗ 主题模板校验失败：${errors[0]}`);
      repo.setSetting(KEYS.themeActive, id);
      themes.scan(true);
      // 启用后旧的预览 cookie 可能正指向这个主题：留着会让前台一直显示「正在预览」提示条。
      deleteCookie(c, THEME_PREVIEW_COOKIE, cookieBase());
      return notice(c, '/admin/themes', `✓ 已启用「${theme.name}」`);
    });
  });

  app.post('/admin/themes/options', async (c) => {
    const body = await bodyOf(c);
    const id = val(body, 'id').trim();
    const theme = id ? themes.get(id) : null;
    if (!theme) return notice(c, '/admin/themes', '✗ 主题不存在');
    const result = optionValuesFromForm(theme, body);
    if (result.error) return notice(c, '/admin/themes', `✗ ${result.error}`);
    repo.setSetting(themeOptionsKey(id), JSON.stringify(result.values));
    return notice(c, '/admin/themes', `✓ 「${theme.name}」的主题设置已保存`);
  });

  app.post('/admin/themes/errors/clear', (c) => {
    clearThemeErrors();
    return notice(c, '/admin/themes', '✓ 已清空主题错误记录');
  });

  externalWrite(app, '/admin/themes/delete', async (c) => {
    const body = await bodyOf(c);
    const id = val(body, 'id').trim();
    const theme = id ? themes.get(id) : null;
    if (!theme) return notice(c, '/admin/themes', '✗ 主题不存在');
    if (currentId() === id) return notice(c, '/admin/themes', '✗ 使用中的主题不能删除，请先启用其它主题');
    if (themes.list(true).length <= 1) return notice(c, '/admin/themes', '✗ 至少要保留一个主题');
    return themeQueue(() => {
      try {
        // 先移目录成功，再清设置，删失败时不会先把选项弄丢。
        removeThemeDir(theme);
        repo.deleteSetting(themeOptionsKey(id));
        themes.scan(true);
        return notice(c, '/admin/themes', `✓ 已删除「${theme.name}」（文件在 themes/.trash）`);
      } catch (error) {
        return notice(c, '/admin/themes', `✗ 删除失败：${error.message}`);
      }
    });
  });

  externalWrite(app, '/admin/themes/upload', async (c) => {
    const body = await bodyOf(c);
    const file = body instanceof FormData ? body.get('theme') : null;
    if (!file || typeof file === 'string' || typeof file.arrayBuffer !== 'function') {
      return notice(c, '/admin/themes', '✗ 请选择一个 ZIP 文件');
    }
    if (file.size > MAX_THEME_ZIP) return notice(c, '/admin/themes', '✗ 主题包不能超过 10MB');
    return themeQueue(async () => {
      const token = `${Date.now()}-${Math.random().toString(16).slice(2, 8)}`;
      fs.mkdirSync(THEMES_DIR, { recursive: true });
      const zipFile = path.join(THEMES_DIR, `.upload-${token}.zip`);
      try {
        await fs.promises.writeFile(zipFile, Buffer.from(await file.arrayBuffer()), { mode: 0o600 });
        const { theme } = await installThemeZip(zipFile, {
          replace: checked(body, 'replace'),
          validate: (candidate) => engine.validate(candidate),
        });
        themes.scan(true);
        return notice(c, '/admin/themes', `✓ 已安装「${theme.name}」v${theme.version}，点「启用」后生效`);
      } catch (error) {
        return notice(c, '/admin/themes', `✗ 安装失败：${error.message}`);
      } finally {
        fs.rmSync(zipFile, { force: true });
      }
    });
  });

  // 预览：只写一个 10 分钟 httpOnly cookie，真正生效依赖 server.js 中间件里的站主会话校验。
  app.get('/admin/themes/preview', (c) => {
    const id = String(c.req.query('id') ?? '').trim();
    if (id && !themes.get(id)) return c.redirect('/admin/themes', 303);
    if (id) {
      setCookie(c, THEME_PREVIEW_COOKIE, id, { ...cookieBase(), maxAge: 600 });
    } else {
      deleteCookie(c, THEME_PREVIEW_COOKIE, cookieBase());
    }
    return c.redirect(safeLocalPath(c.req.query('to') || '/'), 303);
  });

  app.post('/admin/themes/preview/exit', (c) => {
    deleteCookie(c, THEME_PREVIEW_COOKIE, cookieBase());
    return c.redirect('/admin/themes', 303);
  });

  // 前台提示条上的「退出预览」走 GET：只是删掉自己的预览 cookie，没有副作用，不值得为它塞 CSRF。
  app.get('/admin/themes/preview/exit', (c) => {
    deleteCookie(c, THEME_PREVIEW_COOKIE, cookieBase());
    return c.redirect(safeLocalPath(c.req.query('to') || '/admin/themes'), 303);
  });
}

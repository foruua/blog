#!/usr/bin/env node
import './_test-env.mjs';

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { randomBytes } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { createChecker, sleep } from './_check.mjs';
import { cookieJar, createClient, csrfOf, loginAdmin } from './_shared.mjs';
import { isSafeRelative } from '../src/themes/registry.js';

const { check, report } = createChecker();
const themeRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'blog-themes-'));
const tempDirs = [themeRoot];
const created = [];

// 主题测试有自己的主题目录，避免把共享夹具里的主题留给后续套件。
fs.cpSync(path.resolve('scripts/fixtures/fixture'), path.join(themeRoot, 'fixture'), { recursive: true });
fs.cpSync(path.resolve('themes/classic'), path.join(themeRoot, 'classic'), { recursive: true });
{
  const second = path.join(themeRoot, 'second');
  fs.cpSync(path.resolve('scripts/fixtures/fixture'), second, { recursive: true });
  const manifest = JSON.parse(fs.readFileSync(path.join(second, 'theme.json'), 'utf8'));
  manifest.id = 'second';
  manifest.name = '第二个主题';
  fs.writeFileSync(path.join(second, 'theme.json'), JSON.stringify(manifest, null, 2));
  const layout = path.join(second, 'templates', 'layout.liquid');
  fs.writeFileSync(layout, fs.readFileSync(layout, 'utf8').replace('class="fx-main"', 'class="fx-main second-theme"'));
}

const { startServer } = await import('./_server.mjs');
const srv = await startServer({ env: { THEMES_DIR: themeRoot } });
const BASE = srv.base;
const PASSWORD = process.env.ADMIN_PASSWORD;
const jar = cookieJar();
const req = createClient(BASE, jar);
const html = async (url) => (await req(url)).text();

console.log('\n主题系统测试');
console.log('──────────────────────────────────────────────────────────');

try {
  // —— 1. 清单与路径安全 ——
  {
    check('T1a 路径校验拒绝 ../', !isSafeRelative('../etc/passwd'));
    check('T1b 路径校验拒绝绝对路径', !isSafeRelative('/etc/passwd'));
    check('T1c 路径校验拒绝反斜杠', !isSafeRelative('a\\b'));
    check('T1d 路径校验接受普通相对路径', isSafeRelative('templates/home.liquid'));

    const { createThemeRegistry } = await import('../src/themes/registry.js');
    const registry = createThemeRegistry({ themesDir: themeRoot, getActive: () => '', getOptions: () => '' });
    const themes = registry.list(true);
    check('T1e themes/ 里能发现「测试主题」「经典」与第二个主题', ['fixture', 'classic', 'second'].every((id) => themes.some((theme) => theme.id === id)));
    check('T1f 测试主题清单解析出四个设置项', registry.get('fixture')?.options.length === 4);
    check('T1g 主题截图与 CSS 都能解析到', Boolean(registry.get('fixture')?.screenshot) && Boolean(registry.assetPath(registry.get('fixture'), 'theme.css')));
    check('T1h 默认主题标记为 classic', registry.defaultTheme()?.id === 'classic');
  }

  // —— 1.5 清单与资源的边界条件（独立临时目录，不污染外观页列表）——
  {
    const unit = fs.mkdtempSync(path.join(os.tmpdir(), 'blog-theme-unit-'));
    tempDirs.push(unit);
    const makeTheme = (id, { assets = true, options = [] } = {}) => {
      const dir = path.join(unit, id);
      fs.mkdirSync(path.join(dir, 'templates'), { recursive: true });
      if (assets) fs.mkdirSync(path.join(dir, 'assets'), { recursive: true });
      fs.writeFileSync(path.join(dir, 'theme.json'), JSON.stringify({ id, name: id, engine: '1', options }));
      fs.writeFileSync(path.join(dir, 'templates', 'index.liquid'), 'ok');
      return dir;
    };
    const { createThemeRegistry } = await import('../src/themes/registry.js');
    const { createThemeEngine } = await import('../src/themes/engine.js');

    makeTheme('no-assets', { assets: false });
    makeTheme('no-layout', { options: [{ key: 'accent', type: 'color', label: '强调色', default: '#12345' }] });
    const noLayout = path.join(unit, 'no-layout');
    fs.writeFileSync(path.join(noLayout, 'templates', 'home.liquid'), '<p>theme home</p>');
    fs.writeFileSync(path.join(noLayout, 'templates', 'head.liquid'), '<meta name="fx-head" content="1">');
    fs.writeFileSync(path.join(noLayout, 'assets', 'theme.css'), '.x{}');
    const leakDir = makeTheme('leak');
    const secret = path.join(unit, 'secret.txt');
    fs.writeFileSync(secret, 'TOP-SECRET');
    fs.symlinkSync(secret, path.join(leakDir, 'assets', 'leak.txt'));

    const unitRegistry = createThemeRegistry({
      themesDir: unit, getActive: () => 'no-assets', getOptions: () => '',
    });
    const themes = unitRegistry.list(true);
    check('T1i 没有 assets/ 的主题也能加载', themes.some((theme) => theme.id === 'no-assets'));
    const leakTheme = unitRegistry.get('leak');
    check('T1j assets 里的越界软链接不会被当成主题资源', Boolean(leakTheme) && unitRegistry.assetPath(leakTheme, 'leak.txt') === null);
    const colorDefault = unitRegistry.get('no-layout')?.options.find((option) => option.key === 'accent')?.default;
    check('T1k 非法长度颜色回退为空', colorDefault === '');

    const unitEngine = createThemeEngine(unitRegistry);
    const rendered = unitEngine.render(unitRegistry.get('no-layout'), {
      page: 'home', themeType: 'home', main: '<p>builtin</p>', canonical: '/',
    });
    check('T1l 没有 layout 的主题仍自动注入 theme.css', Boolean(rendered?.head?.includes('/theme-assets/no-layout/theme.css')));
    check('T1m 没有 layout 的主题仍返回页面模板内容', rendered?.content?.includes('theme home'));
    check('T1m2 没有 layout 的主题也会带上 head.liquid', Boolean(rendered?.head?.includes('name="fx-head"')));

    // 只覆盖部分页面的主题：未覆盖的页面仍用内置正文，但主题样式应照常生效。
    const partial = makeTheme('partial');
    fs.rmSync(path.join(partial, 'templates', 'index.liquid'));
    fs.writeFileSync(path.join(partial, 'templates', 'posts.liquid'), '<p>posts</p>');
    fs.writeFileSync(path.join(partial, 'assets', 'theme.css'), '.p{}');
    unitRegistry.scan(true);
    const partialHome = unitEngine.render(unitRegistry.get('partial'), {
      page: 'home', themeType: 'home', main: '<p>builtin home</p>', canonical: '/',
    });
    check('T1n 未覆盖的页面仍注入主题 CSS', Boolean(partialHome?.head?.includes('/theme-assets/partial/theme.css')));
    check('T1o 未覆盖的页面保留内置正文', partialHome?.content === '<p>builtin home</p>');

    // 自己手写 <head>、不输出 chrome.head 的主题：CSS 也要兜底注入到 </head> 前。
    const customHead = makeTheme('custom-head');
    fs.writeFileSync(path.join(customHead, 'templates', 'layout.liquid'),
      '<html><head><title>x</title></head><body>{{ content | raw }}</body></html>');
    fs.writeFileSync(path.join(customHead, 'assets', 'theme.css'), '.c{}');
    unitRegistry.scan(true);
    const customHtml = unitEngine.render(unitRegistry.get('custom-head'), {
      page: 'home', themeType: 'home', main: '<p>x</p>', canonical: '/',
    });
    check('T1p 手写 head 的布局也会注入 theme.css', typeof customHtml === 'string'
      && customHtml.includes('/theme-assets/custom-head/theme.css') && customHtml.endsWith('</html>'));

    // 自动转义会把属性引号变成实体会让 data-palette 失效：主题的 htmlAttrs 必须输出成无需 raw 的安全片段。
    const layoutMod = await import('../src/render/layout.js');
    layoutMod.setPaletteDefault(() => 'qingci');
    try {
      const attrs = layoutMod.themeChrome({ page: 'home' }).chrome.htmlAttrs;
      check('T1q 主题 htmlAttrs 不含会被转义的引号', attrs === ' data-palette=qingci');
    } finally { layoutMod.setPaletteDefault(() => ''); }

    // 主题自己写 <head> 时，meta 的标题/OG/JSON-LD 必须来自内置 layoutContext，而不是空字段。
    const metaTheme = makeTheme('meta-probe');
    fs.writeFileSync(path.join(metaTheme, 'templates', 'layout.liquid'),
      '{{ meta.full_title }}|{{ meta.og_image }}|{{ meta.og_locale }}|{{ meta.json_ld | json | raw }}');
    unitRegistry.scan(true);
    const metaHtml = unitEngine.render(unitRegistry.get('meta-probe'), {
      page: 'page', themeType: 'page', title: '探针', canonical: '/probe', desc: '描述', main: '',
    });
    check('T1r 主题 meta 的标题/OG/locale/JSON-LD 非空', typeof metaHtml === 'string'
      && metaHtml.startsWith('探针')
      && /https?:\/\//.test(metaHtml)
      && metaHtml.includes('_')
      && metaHtml.includes('"@type":"WebSite"'));
  }

  // —— 2. 后台外观页 ——
  let csrf = '';
  {
    const r = await req('/admin/themes');
    check('T2a 未登录访问外观页被重定向', r.status === 303 && (r.headers.get('location') ?? '').includes('/admin/login'));
    await loginAdmin(req, PASSWORD);
    const page = await html('/admin/themes');
    check('T2b 外观页能打开并列出主题', page.includes('外观') && page.includes('测试主题') && page.includes('经典') && page.includes('第二个主题'));
    check('T2c 不再出现「内置主题」概念', !page.includes('内置主题'));
    check('T2d 外观页列出主题截图', page.includes('/theme-assets/fixture/screenshot.png'));
    check('T2e 外观页有主题设置表单', page.includes('主题设置') && page.includes('opt_accent'));
    csrf = csrfOf(page);
    check('T2f 外观页带 CSRF 令牌', Boolean(csrf));
    const home = await html('/');
    check('T2g 没有 theme_active 时默认启用经典主题', home.includes('class="home-main"') && home.includes('class="wrap"') && !home.includes('fx-main'));
    check('T2h 经典主题仍保留原站点页头与目录', home.includes('class="nav"') && home.includes('id="mnav"'));
  }

  // —— 3. 启用主题与模板层级 ——
  {
    const activate = await req('/admin/themes/activate', {
      method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ _csrf: csrf, id: 'fixture' }),
    });
    check('T3a 启用测试主题返回 303', activate.status === 303);

    const home = await html('/');
    check('T3b 首页使用主题布局', home.includes('fx-main') && home.includes('class="fx-intro"') && !home.includes('class="hero"'));
    check('T3c 首页加载主题 CSS', home.includes('/theme-assets/fixture/theme.css?v='));
    // 前台脚本可能被 build:assets 合成一个 site.js；开发/无构建时是五个标签。两种都算「基础脚本在位」。
    check('T3d 主题布局仍保留 #app / #main / 基础脚本', home.includes('id="app"') && home.includes('id="main"') && (home.includes('/site.js?v=') || home.includes('/app.js?v=')));
    check('T3e 主题布局仍保留 head 元信息', home.includes('<link rel="canonical"') && home.includes('og:image'));
    check('T3f 主题布局仍输出主题引导脚本', home.includes("document.documentElement.classList.add('has-js')"));

    const posts = await html('/posts/');
    check('T3g 文章列表命中 posts.liquid', posts.includes('fx-list') && posts.includes('为什么单栏是唯一正确的选择'));
    const notes = await html('/notes/');
    check('T3h 笔记列表命中 notes.liquid', notes.includes('fx-notes') && notes.includes('示例笔记') && notes.includes('<h1>笔记</h1>'));
    const post = await html('/p/why-single-column/');
    check('T3i 文章页命中 single-post.liquid', post.includes('fx-post') && post.includes('为什么单栏是唯一正确的选择'));
    const note = await html('/n/fixture-note/');
    check('T3j 笔记页命中 single-note.liquid', note.includes('fx-post-note'));
    const page = await html('/fixture-page/');
    check('T3k 固定页命中 page.liquid', page.includes('fx-page') && page.includes('这是测试固定页'));
    const archive = await html('/archive/');
    check('T3l 归档页命中 archive.liquid', archive.includes('fx-archive'));
    const search = await html('/search?q=示例');
    check('T3m 检索页命中 search.liquid', search.includes('fx-search') || search.includes('fx-page-head'));
    const missing = await req('/definitely-not-here');
    const missingHtml = await missing.text();
    check('T3n 404 命中 404.liquid 且保持 404 状态', missing.status === 404 && missingHtml.includes('fx-main'));

    // 404 自带 60s 缓存：模板改动也必须靠主题签名立刻失效，不能等 TTL。
    const template404 = path.join(themeRoot, 'fixture', 'templates', '404.liquid');
    const original404 = fs.readFileSync(template404, 'utf8');
    fs.writeFileSync(template404, `${original404}\n<!-- 404-cache-stamp -->`);
    await sleep(2200); // themes 扫描 TTL=2s
    const refreshed404 = await (await req('/definitely-not-here')).text();
    check('T3n2 404 缓存随主题模板签名失效', refreshed404.includes('404-cache-stamp'), '');
    fs.writeFileSync(template404, original404);
    await sleep(2200);
  }

  // —— 4. 主题设置 ——
  {
    const save = await req('/admin/themes/options', {
      method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ _csrf: csrf, id: 'fixture', opt_accent: '#123456', opt_show_excerpts: '1', opt_density: 'normal', opt_logo: '/uploads/theme-logo.png' }),
    });
    check('T4a 保存主题设置返回 303', save.status === 303);
    const home = await html('/');
    check('T4b 设置里的强调色写进页面', home.includes('--fx-accent: #123456'));
    check('T4b2 image 设置写进页面', home.includes('src="/uploads/theme-logo.png"'));
    const posts = await html('/posts/');
    check('T4c 列表摘要开关生效', posts.includes('fx-excerpt'));

    const badLogo = await req('/admin/themes/options', {
      method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ _csrf: csrf, id: 'fixture', opt_accent: '#123456', opt_show_excerpts: '1', opt_density: 'normal', opt_logo: 'https://evil.example/x.png' }),
    });
    check('T4e 外站图片路径被拒绝', (badLogo.headers.get('location') ?? '').includes('%E2%9C%97'));

    const bad = await req('/admin/themes/options', {
      method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ _csrf: csrf, id: 'fixture', opt_accent: 'red', opt_show_excerpts: '1', opt_density: 'normal' }),
    });
    check('T4d 非法颜色被拒绝', (bad.headers.get('location') ?? '').includes('%E2%9C%97') || (bad.headers.get('location') ?? '').includes('✗'));
  }

  // —— 5. 预览主题只影响站主 ——
  {
    const preview = await req('/admin/themes/preview?id=second&to=/');
    check('T5a 预览入口返回 303', preview.status === 303);
    const setCookie = preview.headers.getSetCookie?.().join('; ') ?? preview.headers.get('set-cookie') ?? '';
    const match = /blog_theme_preview=([^;]+)/.exec(setCookie);
    check('T5b 预览入口下发短期 cookie', Boolean(match));
    if (match) {
      const cookie = `${jar.cookie}; blog_theme_preview=${match[1]}`;
      const previewHome = await (await fetch(BASE + '/', { headers: { Cookie: cookie }, redirect: 'manual' })).text();
      check('T5c 站主带预览 cookie 能看到第二个主题', previewHome.includes('second-theme'));
      check('T5c2 预览时前台显示提示条与退出入口', previewHome.includes('class="preview-bar"') && previewHome.includes('/admin/themes/preview/exit?to='));
      const anon = await (await fetch(BASE + '/')).text();
      check('T5d 匿名访客仍看到当前主题', anon.includes('fx-main') && !anon.includes('second-theme'));
      check('T5d2 匿名访客看不到预览提示条', !anon.includes('class="preview-bar"'));
      const exitGet = await fetch(BASE + '/admin/themes/preview/exit?to=/', {
        redirect: 'manual', headers: { Cookie: cookie },
      });
      check('T5f 提示条上的 GET 退出会清掉预览 cookie', exitGet.status === 303
        && (exitGet.headers.getSetCookie?.().join('; ') ?? '').includes('blog_theme_preview='));
      const exit = await fetch(BASE + '/admin/themes/preview/exit', {
        method: 'POST', redirect: 'manual',
        headers: { Cookie: cookie, 'Content-Type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({ _csrf: csrf }),
      });
      check('T5e 退出预览返回 303', exit.status === 303);
    }
  }

  // —— 6. 使用中的主题不能删除，其它主题可以删 ——
  {
    const delActive = await req('/admin/themes/delete', {
      method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ _csrf: csrf, id: 'fixture' }),
    });
    check('T6a 使用中的主题不能删除', (delActive.headers.get('location') ?? '').includes('%E2%9C%97'));
    check('T6b 站点仍由测试主题渲染', (await html('/')).includes('fx-main'));

    const delOther = await req('/admin/themes/delete', {
      method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ _csrf: csrf, id: 'second' }),
    });
    check('T6c 其它主题可以删除', delOther.status === 303 && !(await html('/admin/themes')).includes('第二个主题'));
  }

  // —— 7. 上传 / 删除主题 ——
  {
    const work = fs.mkdtempSync(path.join(os.tmpdir(), 'blog-theme-zip-'));
    tempDirs.push(work);
    const source = path.join(work, 'upload-test');
    fs.cpSync(path.resolve('scripts/fixtures/fixture'), source, { recursive: true });
    const manifest = JSON.parse(fs.readFileSync(path.join(source, 'theme.json'), 'utf8'));
    manifest.id = 'upload-test';
    manifest.name = '上传测试主题';
    fs.writeFileSync(path.join(source, 'theme.json'), JSON.stringify(manifest, null, 2));
    // >1MB 的不可压缩资源：验证主题上传没有被普通表单的 1MB 请求体上限误伤。
    fs.writeFileSync(path.join(source, 'assets', 'large.bin'), randomBytes(1536 * 1024));
    const zip = path.join(work, 'upload-test.zip');
    const zipResult = spawnSync('zip', ['-qr', zip, 'upload-test'], { cwd: work, encoding: 'utf8' });
    if (zipResult.status === 0) {
      const form = new FormData();
      form.set('_csrf', csrf);
      form.set('theme', new File([fs.readFileSync(zip)], 'upload-test.zip', { type: 'application/zip' }));
      const upload = await req('/admin/themes/upload', { method: 'POST', body: form });
      check('T7a 主题 ZIP 上传返回 303', upload.status === 303);
      created.push(path.join(themeRoot, 'upload-test'));
      const page = await html('/admin/themes');
      check('T7b 上传后外观页列出新主题', page.includes('上传测试主题'));
      const activate = await req('/admin/themes/activate', {
        method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({ _csrf: csrf, id: 'upload-test' }),
      });
      check('T7c 上传的主题可以启用', activate.status === 303 && (await html('/')).includes('fx-main'));
      const delActive = await req('/admin/themes/delete', {
        method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({ _csrf: csrf, id: 'upload-test' }),
      });
      check('T7d 使用中的上传主题不能删除', (delActive.headers.get('location') ?? '').includes('%E2%9C%97'));
      await req('/admin/themes/activate', {
        method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({ _csrf: csrf, id: 'fixture' }),
      });
      const del = await req('/admin/themes/delete', {
        method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({ _csrf: csrf, id: 'upload-test' }),
      });
      check('T7e 切走后可以删除上传主题', del.status === 303 && !(await html('/admin/themes')).includes('上传测试主题'));
    } else {
      // 主题上传路径不能因为环境缺 zip 就静默变成“全绿”；要么在 CI 安装 zip，要么显式失败。
      check('T7 系统需要 zip 命令（主题上传测试不能静默跳过）', false);
    }
  }

  // —— 8. 坏主题不拖垮站点 ——
  {
    const badDir = path.join(themeRoot, 'broken-theme');
    fs.mkdirSync(badDir, { recursive: true });
    fs.writeFileSync(path.join(badDir, 'theme.json'), JSON.stringify({ id: 'broken-theme', name: '坏主题', version: '1.0.0', engine: '1' }));
    created.push(badDir);
    const page = await html('/admin/themes');
    check('T8a 坏主题出现在「未加载的主题」里', page.includes('未加载的主题') && page.includes('broken-theme'));
    const activate = await req('/admin/themes/activate', {
      method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ _csrf: csrf, id: 'broken-theme' }),
    });
    check('T8b 坏主题不能启用', activate.status === 303 && (activate.headers.get('location') ?? '').includes('%E2%9C%97'));
    check('T8c 站点仍然正常渲染', (await req('/')).status === 200);
  }

  // —— 8.5 渲染失败自动回退，且后台看得见 ——
  {
    const dir = path.join(themeRoot, 'render-fail');
    fs.cpSync(path.resolve('scripts/fixtures/fixture'), dir, { recursive: true });
    const manifest = JSON.parse(fs.readFileSync(path.join(dir, 'theme.json'), 'utf8'));
    manifest.id = 'render-fail';
    manifest.name = '渲染失败主题';
    fs.writeFileSync(path.join(dir, 'theme.json'), JSON.stringify(manifest, null, 2));
    // 能 parse、运行时才炸：validate 拦不住，只能靠回退 + 后台记录。
    fs.writeFileSync(path.join(dir, 'templates', 'home.liquid'), "{% render 'templates/nope' %}");
    created.push(dir);
    // 目录是刚写进去的，registry 有 2 秒扫描窗口；先开一次外观页强制重扫，否则 get() 还看不到它。
    await html('/admin/themes');

    const activate = await req('/admin/themes/activate', {
      method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ _csrf: csrf, id: 'render-fail' }),
    });
    check('T11a 运行时才失败的主题仍可启用（parse 通过）', activate.status === 303);
    const home = await html('/');
    check('T11b 渲染失败自动回退内置外壳', home.includes('class="home-main"') && !home.includes('fx-main'));
    const page = await html('/admin/themes');
    check('T11c 后台展示最近的渲染失败', page.includes('最近的主题渲染失败') && page.includes('templates/home.liquid'));

    await req('/admin/themes/activate', {
      method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ _csrf: csrf, id: 'fixture' }),
    });
  }

  // —— 9. 主题文件进入完整备份 ——
  {
    const { open, close } = await import('../db/driver.js');
    const { snapshot } = await import('../src/backup.js');
    const zlib = await import('node:zlib');
    const backupDir = fs.mkdtempSync(path.join(os.tmpdir(), 'blog-theme-bk-'));
    tempDirs.push(backupDir);
    const db = open(srv.dbFile);
    let result;
    try { result = await snapshot(db, { dir: backupDir, keep: 2, themesDir: themeRoot }); }
    finally { close(db); }
    const bundle = JSON.parse(zlib.gunzipSync(fs.readFileSync(result.assetsFile)));
    check('T9a 备份包包含 themes 分组', Array.isArray(bundle.themes));
    check('T9b themes/ 里的主题进入备份', bundle.themes.some((file) => file.path === 'fixture/theme.json'));
    check('T9c 备份清单记录了主题文件数', Number(result.themeFiles) === bundle.themes.length);
  }

  // —— 10. theme_active 失效时自动选一个可用主题 ——
  {
    const { open, close } = await import('../db/driver.js');
    const db = open(srv.dbFile);
    try {
      db.prepare("UPDATE settings SET value = 'missing-theme' WHERE key = 'theme_active'").run();
      if (!db.prepare("SELECT 1 FROM settings WHERE key = 'theme_active'").get()) {
        db.prepare("INSERT INTO settings(key, value) VALUES('theme_active', 'missing-theme')").run();
      }
    } finally { close(db); }
    const home = await html('/');
    check('T10a 激活主题失效时回落到默认经典主题', home.includes('class="home-main"') && !home.includes('fx-main'));
    const page = await html('/admin/themes');
    check('T10b 后台把可用主题显示为使用中', page.includes('使用中'));
  }
} finally {
  await srv.stop();
  for (const dir of created) fs.rmSync(dir, { recursive: true, force: true });
  for (const dir of tempDirs) fs.rmSync(dir, { recursive: true, force: true });
}

const failures = report();
process.exitCode = failures ? 1 : 0;

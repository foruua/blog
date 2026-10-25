#!/usr/bin/env node
const getVisible = (el) => { const css = el.ownerDocument.defaultView.getComputedStyle(el); return css.display !== 'none' && css.visibility !== 'hidden' && css.opacity !== '0'; };
import './_test-env.mjs';

import fs from 'node:fs';
import path from 'node:path';
import { JSDOM, VirtualConsole } from 'jsdom';

const { startServer } = await import('./_server.mjs');
const srv = await startServer();
const BASE = srv.base;

const { createChecker, sleep, waitFor } = await import('./_check.mjs');

// 令牌层（:root / 明暗 / 配色预设 / 模态锁）在 base.css，组件在 style.css；页面里两张表都加载，
// 断言按同一顺序拼起来看 —— 规则搬家不该让用例跟着搬家。
const cssAll = async () => {
  const [base, style] = await Promise.all(['base.css', 'style.css']
    .map(async (f) => (await fetch(`${BASE}/${f}`)).text()));
  return `${base}\n${style}`;
};
const { check, report } = createChecker();

async function mount(url, cookie, seed) {
  const html = await (await fetch(url, cookie ? { headers: { cookie } } : undefined)).text();

  const vc = new VirtualConsole();
  const errors = [];
  vc.on('jsdomError', (e) => errors.push(e.message));
  const dom = new JSDOM(html, { url, runScripts: 'outside-only', pretendToBeVisual: true, virtualConsole: vc });
  const w = dom.window;
  // 请求由 Node fetch 发出，AbortSignal 必须来自同一运行时。
  w.AbortController = globalThis.AbortController;
  w.AbortSignal = globalThis.AbortSignal;

  w.fetch = async (input, init) => {
    const target = typeof input === 'string' ? new URL(input, url) : input;
    const merged = Object.assign({}, init);
    if (merged.body instanceof w.FormData) {
      const body = new FormData();
      for (const [key, value] of merged.body) {
        if (typeof value === 'string') body.append(key, value);
        else {
          const bytes = await new Promise((resolve, reject) => {
            const reader = new w.FileReader();
            reader.onload = () => resolve(reader.result);
            reader.onerror = () => reject(reader.error);
            reader.readAsArrayBuffer(value);
          });
          body.append(key, new Blob([bytes], { type: value.type }), value.name);
        }
      }
      merged.body = body;
    }
    if (cookie) merged.headers = Object.assign({}, merged.headers, { cookie });
    return fetch(target, merged);
  };
  w.matchMedia = () => ({ matches: false, addEventListener() {}, removeEventListener() {}, addListener() {}, removeListener() {} });
  let sy = 0;
  Object.defineProperty(w, 'scrollY', { get: () => sy, configurable: true });
  w.scrollTo = (_x, y) => { sy = typeof y === 'number' ? y : 0; };
  // jsdom 没有 scrollIntoView（评论抽屉展开时会调）—— 补空实现，别让环境缺方法变成用例失败。
  w.Element.prototype.scrollIntoView = () => {};
  w.confirm = () => false;
  w.addEventListener('error', () => {});

  w.__vt = 0;
  w.document.startViewTransition = (cb) => {
    w.__vt += 1;
    if (typeof cb === 'function') cb();
    return { finished: Promise.resolve(), skipTransition() {}, updateCallbackDone: Promise.resolve() };
  };

  const nav = fs.readFileSync(path.join('public', 'nav.js'), 'utf8');
  const app = fs.readFileSync(path.join('public', 'app.js'), 'utf8');
  const admin = fs.readFileSync(path.join('public', 'admin.js'), 'utf8');
  const editor = fs.readFileSync(path.join('public', 'editor.js'), 'utf8');
  for (const [k, v] of Object.entries(seed ?? {})) w.localStorage.setItem(k, v);
  w.eval(fs.readFileSync('public/request.js', 'utf8'));
  w.eval(fs.readFileSync('public/ui.js', 'utf8'));
  w.eval(nav);
  w.eval(app);
  w.eval(fs.readFileSync('public/admin-editor.js', 'utf8'));
  w.eval(admin);
  w.eval(editor);
  await sleep(30);
  return { dom, w, html, errors };
}

async function login() {
  const { requireAdminPassword } = await import('./_admin-password.mjs');
  const res = await fetch(`${BASE}/admin/login`, {
    method: 'POST', redirect: 'manual',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ password: requireAdminPassword('test-pjax.mjs'), to: '/admin' }),
  });
  const list = typeof res.headers.getSetCookie === 'function' ? res.headers.getSetCookie() : [res.headers.get('set-cookie') ?? ''];
  return list.map((c) => String(c).split(';')[0]).filter(Boolean).join('; ');
}

function submit(w, form, submitter) {
  const ev = new w.SubmitEvent('submit', { bubbles: true, cancelable: true, submitter: submitter ?? undefined });
  form.dispatchEvent(ev);
  return ev;
}

function click(w, el, init = {}) {
  const ev = new w.MouseEvent('click', { bubbles: true, cancelable: true, button: 0, ...init });
  el.dispatchEvent(ev);
  return ev;
}

console.log('\n无刷新导航测试（jsdom）');
console.log('─'.repeat(58));
console.log(`  受控服务 ${BASE}\n`);

try {

  {
    const page = await mount(`${BASE}/posts/`);
    const btn = page.w.document.querySelector('.to-top');
    check('T60 回到顶部按钮在 #app 之外（无刷新换页不会把它换掉）',
      Boolean(btn) && !page.w.document.getElementById('app').contains(btn), '');
    check('T60b 顶部时按钮不显示', !btn.classList.contains('show'), btn.className);
    page.w.scrollTo(0, page.w.innerHeight * 2);
    page.w.dispatchEvent(new page.w.Event('scroll'));
    await sleep(120);
    check('T60c 滚过一屏半后浮现', btn.classList.contains('show'), btn.className);
    page.w.scrollTo(0, 0);
    page.w.dispatchEvent(new page.w.Event('scroll'));
    await sleep(120);
    check('T60d 回到顶部后收起', !btn.classList.contains('show'), btn.className);
  }

  {
    const page = await mount(`${BASE}/posts/`);
    page.w.scrollTo(0, 900);
    check('T57 已模拟"从列表中部点击"（滚动位置 900）', page.w.scrollY === 900, `y=${page.w.scrollY}`);
    const link = [...page.w.document.querySelectorAll('.list a.e-main')][2];
    click(page.w, link);
    await sleep(400);
    check('T58 点文章标题进内页后回到顶部',
      page.w.scrollY === 0 && page.w.location.pathname.startsWith('/p/'),
      `y=${page.w.scrollY} url=${page.w.location.pathname}`);

    page.w.scrollTo(0, 700);

    await page.w.__nav.navigate(new URL(`${BASE}/notes/?n=fixture-note#n-fixture-note`).href);
    await sleep(500);
    check('T59 带锚点的跳转不强行回顶部（交给锚点定位）',
      page.w.scrollY === 700 && page.w.location.hash === '#n-fixture-note'
      && Boolean(page.w.document.getElementById('n-fixture-note')),
      `y=${page.w.scrollY} hash=${page.w.location.hash}`);
  }

  {
    // 后退/前进要回到离开时的位置。jsdom 会话历史不可靠，所以验证机制本身：滚动后当前历史记录里的 scrollY 必须跟着变。
    const page = await mount(`${BASE}/posts/`);
    page.w.scrollTo(0, 640);
    page.w.dispatchEvent(new page.w.Event('scroll'));
    await sleep(620);
    check('T61 滚动位置会写进当前那条历史记录',
      Number(page.w.history.state && page.w.history.state.scrollY) === 640,
      `state=${JSON.stringify(page.w.history.state)}`);

    let writes = 0;
    const raw = page.w.history.replaceState.bind(page.w.history);
    page.w.history.replaceState = (...args) => { writes++; return raw(...args); };
    page.w.dispatchEvent(new page.w.Event('scroll'));
    await sleep(620);
    check('T62 位置没变时不重复写（Safari 对 replaceState 有频率限制）', writes === 0, `写了 ${writes} 次`);

    page.w.scrollTo(0, 1800);
    page.w.dispatchEvent(new page.w.Event('scroll'));
    await sleep(620);
    check('T63 位置变了就写新的',
      Number(page.w.history.state && page.w.history.state.scrollY) === 1800 && writes === 1,
      `y=${page.w.history.state && page.w.history.state.scrollY} writes=${writes}`);
    page.w.history.replaceState = raw;
  }

  const { w, html } = await mount(`${BASE}/posts/`);
  check('T1 容器 #app 存在', Boolean(w.document.getElementById('app')));
  check('T2 nav.js 已启用并暴露调试接口', Boolean(w.__nav && typeof w.__nav.navigate === 'function'));
  check('T3 增强层注册了换页钩子（数组，允许多个共存）',
    Array.isArray(w.__pjaxHooks) && w.__pjaxHooks.length >= 1, JSON.stringify(w.__pjaxHooks && w.__pjaxHooks.length));

  check('T3b 前台与后台增强层可以同时注册而不互相覆盖（app / admin / editor 各一个）',
    w.__pjaxHooks.length >= 2, `注册了 ${w.__pjaxHooks.length} 个`);

  {
    const mk = (attrs, href) => {
      const a = w.document.createElement('a');
      a.setAttribute('href', href);
      for (const [k, v] of Object.entries(attrs)) a.setAttribute(k, v);
      w.document.body.appendChild(a);
      return a;
    };
    const E = w.__nav.eligible;

  check('T4 站内普通链接可被拦截', E(mk({}, '/notes/'), null) === true);
    check('T5 站外链接不拦截', E(mk({}, 'https://example.com/x'), null) === false);
    check('T6 target=_blank 不拦截', E(mk({ target: '_blank' }, '/posts/'), null) === false);
    check('T7 download 不拦截', E(mk({ download: '' }, '/x.zip'), null) === false);
    check('T8 data-no-pjax 不拦截', E(mk({ 'data-no-pjax': '' }, '/posts/'), null) === false);
    check('T9 登出不拦截（必须真实请求）', E(mk({}, '/admin/logout'), null) === false);
    check('T10 同路径纯锚点不拦截', E(mk({}, '/posts/#comments'), null) === false);
  check('T10b 同路径同查询串不拦截', E(mk({}, '/posts/'), null) === false);
    check('T11 带修饰键的点击不拦截', E(mk({}, '/posts/'), { metaKey: true }) === false);
    check('T12 中键点击不拦截', E(mk({}, '/posts/'), { button: 1 }) === false);
    check('T13 静态文件不拦截', E(mk({}, '/style.css'), null) === false);
    // 前台页脚「后台」入口：新窗口打开（target 一设 pjax 就不接管），必须带 noopener。
    const adminLink = w.document.querySelector('footer.site a[href="/admin"]');
    check('T13b 页脚不再放后台入口（低频操作不占页脚）', !adminLink, adminLink?.outerHTML ?? '');
  }

  {
    const before = w.document.getElementById('app').innerHTML;
    const beforeTitle = w.document.title;
    w.__marker = 'alive';
    const link = [...w.document.querySelectorAll('.list a')][0];
    const target = link.getAttribute('href');
    click(w, link);

    check('T14b 快速换页不显示加载指示（延迟 150ms 才出现）',
      !w.document.getElementById('progress').classList.contains('is-loading'));

    await sleep(500);

    check('T14c 换页不使用 View Transition（整页快照交叉溶解会被看成"跳一下"）',
      w.__vt === 0, `被调用了 ${w.__vt} 次`);
    check('T14c2 nav.js 里不再有 startViewTransition', !/startViewTransition/.test(
      fs.readFileSync(path.join('public', 'nav.js'), 'utf8')));
    check('T14c3 换页后 #app 不留内联样式（淡入用完即归位）',
      !w.document.getElementById('app').getAttribute('style'),
      String(w.document.getElementById('app').getAttribute('style')));

    const navjsSrc = fs.readFileSync(path.join('public', 'nav.js'), 'utf8');
    const cssSrc = fs.readFileSync(path.join('public', 'style.css'), 'utf8');
    check('T14d 换页不抑制入场动画：点击与手动刷新共用同一条浮入路径',
      !/nav-swap/.test(navjsSrc) && !/nav-swap/.test(cssSrc)
      && !w.document.documentElement.classList.contains('no-entry-anim'), '');
    check('T14e 换页过程中和之后都没有残留加载态',
      !w.document.getElementById('progress').classList.contains('is-loading'));

    const reveals = [...w.document.querySelectorAll('[data-reveal]')];
    check('T14f 文章页不再有 [data-reveal]（相关区块已移除）', reveals.length === 0, `${reveals.length} 个`);
    const css = fs.readFileSync(path.join('public', 'style.css'), 'utf8');
    const appJs = fs.readFileSync(path.join('public', 'app.js'), 'utf8');

    check('T14g 压制入场动画的旧机制已彻底清除（CSS 与 nav.js 都不留）',
      !/\.no-entry-anim\s*[{,]/.test(css)
      && !/classList\.add\('no-entry-anim'\)/.test(fs.readFileSync(path.join('public', 'nav.js'), 'utf8')));
    check('T14h 换页后浮入不再走"直接显示"的短路分支', !/swapped/.test(appJs), '');

    check('T15 容器内容已替换', w.document.getElementById('app').innerHTML !== before);
    check('T16 没有发生整页刷新（window 标记仍在）', w.__marker === 'alive');
    check('T17 URL 已更新为文章地址', w.location.pathname === target, `${w.location.pathname} vs ${target}`);
    check('T18 标题已更新', w.document.title !== beforeTitle && w.document.title.length > 0, w.document.title);
    check('T19 文章正文已进入 DOM', /class="prose"/.test(w.document.getElementById('app').innerHTML));
    check('T21 加载状态已复位', !w.document.getElementById('progress').classList.contains('is-loading'));
  }

  let articlePath;
  {
    const urlBefore = w.location.pathname;
    articlePath = urlBefore;
    w.history.back();
    await sleep(400);
    w.dispatchEvent(new w.PopStateEvent('popstate', { state: w.history.state }));
    await sleep(500);
    check('T22 popstate 会重新取回该地址并渲染',
      w.document.getElementById('app').innerHTML.includes('class="list"'),
      w.location.pathname);
    check('T23 后退后 URL 不是文章页', w.location.pathname !== urlBefore, w.location.pathname);
  }

  {
    const here = w.location.pathname + w.location.search;
    const shown = w.document.getElementById('app').innerHTML;
    const spy = { n: 0 };
    const raw = w.fetch;
    w.fetch = (...args) => { spy.n++; return raw(...args); };

    w.history.replaceState({}, '', `${here}#comments`);
    w.dispatchEvent(new w.PopStateEvent('popstate', { state: w.history.state }));
    await sleep(300);
    check('T23b 只改 hash 的 popstate 不重新取页面', spy.n === 0, `请求了 ${spy.n} 次`);
    check('T23c 只改 hash 的 popstate 不动 DOM',
      w.document.getElementById('app').innerHTML === shown, '');
    check('T23c2 锚点跳转后 URL 保留 hash', w.location.hash === '#comments', w.location.hash);

    w.history.replaceState({}, '', articlePath);
    w.dispatchEvent(new w.PopStateEvent('popstate', { state: w.history.state }));
    await sleep(600);
    w.fetch = raw;
    check('T23d 换路径的 popstate 照常渲染',
      /class="prose"/.test(w.document.getElementById('app').innerHTML), w.location.pathname);
  }

  {
    const { w: wr, errors } = await mount(`${BASE}/`);
    errors.length = 0;
    wr.__nav.navigate(`${BASE}/posts/`);
    await sleep(600);
    const rs = [...wr.document.querySelectorAll('.list > li')];
    check('T30 换到列表页后，列表仍有内容', rs.length > 0, `${rs.length} 个`);
    check('T31 换页后条目已可见（没有留在隐藏态）',
      rs.length > 0 && rs.every((el) => getVisible(el)),
      `${rs.filter((el) => !getVisible(el)).length} 个未显示`);
  }

  {
    const { w: wn, errors } = await mount(`${BASE}/`);
    errors.length = 0;
    wn.__nav.navigate(`${BASE}/notes/`);
    await sleep(600);
    const cards = [...wn.document.querySelectorAll('.notes > .nf')];
    const revealed = cards.filter((el) => !el.hasAttribute('data-reveal'));
    check('T30b 换到笔记页后，笔记卡片没有入场动画标记',
      cards.length > 0 && revealed.length === cards.length, `${revealed.length}/${cards.length} 张`);
    check('T30c 换页后笔记卡片已可见（没有留在隐藏态）',
      revealed.length > 0 && revealed.every((el) => getVisible(el)),
      `${revealed.filter((el) => !getVisible(el)).length} 张未显示`);
    check('T30d 笔记卡片不再错开入场',
      !/\.notes > \.note-card:nth-child\(2\)\.is-in/.test(await cssAll()), '');
    const css = await cssAll();
    check('T30i 没有 View Transition 快照规则，也没有针对到达页的动画覆盖（统一一条路径）',
      !/::view-transition/.test(css) && !/nav-swap/.test(css) && !/#app\.arrive/.test(css), '');
  }

  {
    const { w: ws } = await mount(`${BASE}/`);
    let scrollCall = null;
    const rawScrollTo = ws.scrollTo;
    ws.scrollTo = (opts, y) => {
      scrollCall = opts && typeof opts === 'object' ? opts : { top: y, behavior: '(两参形式)' };
      rawScrollTo(opts, y);
    };
    await ws.__nav.navigate(new URL(`${BASE}/posts/`).href);
    await sleep(400);
    const items = [...ws.document.querySelectorAll('#app .list > li')];
    check('T30e 换页后列表有内容',
      items.length > 0, `${items.length} 条`);
    check('T30f 换页后条目已可见（没有留在隐藏态）',
      items.every((el) => getVisible(el)),
      `${items.filter((el) => !getVisible(el)).length} 个未显示`);
    check('T30g 换页不再给 html 挂任何动画抑制标记',
      !ws.document.documentElement.classList.contains('nav-swap')
      && !ws.document.documentElement.classList.contains('no-entry-anim'), '');
    check('T30j 换页回顶部显式传 behavior:smooth（两个内核都平滑，不靠翻转内联样式）',
      Boolean(scrollCall) && scrollCall.behavior === 'smooth' && scrollCall.top === 0,
      JSON.stringify(scrollCall));

    // 减弱动效：同一个入口必须退回瞬移（CSS 的 html{scroll-behavior:auto} 管不到显式传参）
    ws.matchMedia = () => ({ matches: true, addEventListener() {}, removeEventListener() {} });
    scrollCall = null;
    await ws.__nav.navigate(new URL(`${BASE}/archive/`).href);
    await sleep(400);
    check('T30j2 用户要求减弱动效时，换页回顶部退回 instant',
      Boolean(scrollCall) && scrollCall.behavior === 'instant', JSON.stringify(scrollCall));

    const navjs = await (await fetch(`${BASE}/nav.js`)).text();
    const cssNow = await cssAll();
    check('T30k nav.js 不再为换页做"首屏落位/错开"这类特殊处理',
      !/animationDelay/.test(navjs) && !/transitionDelay/.test(navjs) && !/getBoundingClientRect/.test(navjs), '');
    check('T30l 刷新与换页没有残留入场动画规则，默认内容不隐藏',
      !/data-reveal|\.is-in/.test(cssNow) && !/nav-swap/.test(cssNow), '');
  }

  {
    w.__beforeNavigate = () => false;
    const before = w.document.getElementById('app').innerHTML;
    const link = [...w.document.querySelectorAll('.nav a')].find((a) => a.getAttribute('href') === '/archive/');
    if (link) {
      const ev = click(w, link);
      await sleep(300);
      check('T24 __beforeNavigate 返回 false 时取消导航', ev.defaultPrevented && w.document.getElementById('app').innerHTML === before);
    } else {
      check('T24 __beforeNavigate 返回 false 时取消导航', false, '没找到 /archive/ 链接');
    }
    w.__beforeNavigate = undefined;
  }

  {
    const { w: w2, errors } = await mount(`${BASE}/`);
    errors.length = 0;
    w2.fetch = () => Promise.reject(new Error('network down'));
    const before = w2.document.getElementById('app').innerHTML;
    w2.__nav.navigate(`${BASE}/archive/`);
    await sleep(300);
    check('T25 网络失败时退回整页导航（而不是把用户卡住）',
      errors.some((m) => /Not implemented: navigation/.test(m)),
      JSON.stringify(errors.slice(0, 2)));
    check('T26 退回时没有留下半个替换过的页面',
      w2.document.getElementById('app').innerHTML === before);
  }

  {
    // 页头检索是一枚常驻搜索框（真表单，提交走 pjax 无刷新到 /search）；不再有 ⌘K 弹层。
    const { w, html } = await mount(`${BASE}/`);
    check('T46 页头检索是常驻搜索框（GET 表单落到 /search）',
      !!w.document.querySelector('nav.nav form.nav-search input[name="q"]')
      && !w.document.querySelector('nav.nav a.s-link')
      && /class="nav-search"/.test(html), '');
    check('T47 不再有 ⌘K 检索台弹层（旧记号 cmdk / q / sPal / sBox 都没有）',
      !w.document.getElementById('cmdk') && !w.document.getElementById('q')
      && !w.document.querySelector('#sPal, #sBox'), '');
    check('T48 /search 在（HTML 路由）、/api/search 不在',
      (await fetch(`${BASE}/search`)).status === 200
      && (await fetch(`${BASE}/api/search`)).status === 404, '');
  }

  {
    const { w } = await mount(`${BASE}/`);
    const seg = (m) => w.document.querySelector(`.pal-tm[data-theme-opt="${m}"]`);
    check('T50 首页 hero-meta 的「配色」浮层里有明暗三态（跟随 / 亮色 / 暗色）',
      Boolean(seg('auto')) && Boolean(seg('light')) && Boolean(seg('dark')), '');
    const before = w.document.documentElement.dataset.theme ?? '';
    seg('dark').click();
    await sleep(20);
    const after = w.document.documentElement.dataset.theme ?? '';
    check('T51 点它能切换主题并记住选择',
      after === 'dark' && w.localStorage.getItem('theme') === 'dark',
      `${before} → ${after}`);
    check('T52 选中态跟着切（暗色按下、亮色松开）',
      seg('dark').getAttribute('aria-pressed') === 'true' && seg('light').getAttribute('aria-pressed') === 'false', '');
  }

  {
    const { w } = await mount(`${BASE}/`);
    w.document.querySelector('.pal-tm[data-theme-opt="dark"]').click();
    await sleep(20);
    const afterClick = w.document.documentElement.getAttribute('data-theme');
    await w.__nav.navigate(`${BASE}/posts/`);
    await sleep(220);
    const afterNav = w.document.documentElement.getAttribute('data-theme');
    check('T55 切换主题后换页，主题保持不变',
      afterClick === 'dark' && afterNav === 'dark',
      `点击后=${afterClick} 换页后=${afterNav}`);
    check('T56 配色入口只在首页：换到文章页后不再渲染，主题仍挂在 html 上',
      !w.document.querySelector('.pal') && w.document.documentElement.getAttribute('data-theme') === 'dark', '');
  }

  {

    const css = await cssAll();
    const navjs = await (await fetch(`${BASE}/nav.js`)).text();
    const { html } = await mount(`${BASE}/`);
    check('T53 无 JS 时配色入口被 CSS 隐藏', /html:not\(\.has-js\) \.pal \{ display: none; \}/.test(css), '');
    // 「JS 可用」只允许一个标记、且必须落在 <head> 正文之前 —— 以前 CSS 认 defer 的 .js，按钮先被藏、脚本跑完才冒出，页脚会跳一下。
    check('T54 .has-js 由 <head> 里的内联主题引导设置（不等页面末尾的脚本）',
      /<script>[^<]*classList\.add\('has-js'\)[^<]*<\/script>\s*<\/head>/.test(html), '');
    check('T54b 不再有第二套「JS 可用」标记（nav.js 不加 .js）',
      !/classList\.add\('js'\)/.test(navjs), '');
  }

  {
    const page = await mount(`${BASE}/posts/`);
    const { w } = page;
    w.__marker = 'alive';
    const a = w.document.createElement('a');
    a.setAttribute('href', '/go/why-single-column');
    w.document.body.appendChild(a);
    click(w, a);
    // 条件等待：换页是异步的，固定 sleep 在慢机器上会假失败。
    await waitFor(() => w.location.pathname === '/p/why-single-column/', { timeoutMs: 5000 });
    check('T70 站内 301（/go/ 双向链接）跟着跳到底，不整页刷新',
      w.__marker === 'alive' && w.location.pathname === '/p/why-single-column/',
      `marker=${w.__marker} path=${w.location.pathname}`);
    check('T70b 301 后的地址是最终地址，不会把 /go/ 留在历史里',
      w.location.pathname === '/p/why-single-column/' && !w.location.pathname.startsWith('/go/'), w.location.pathname);
  }

  {
    const page = await mount(`${BASE}/posts/`);
    const { w } = page;
    check('T71 换页前后 #app 都是干净的（不残留内联样式）',
      !w.document.getElementById('app').getAttribute('style'), `初始 ${w.__vt}`);
    w.matchMedia = () => ({ matches: true });    await w.__nav.navigate(new URL(`${BASE}/notes/`).href);
    await waitFor(() => w.location.pathname === '/notes/', { timeoutMs: 5000 });
    check('T72 开了「减少动态效果」时照常换页（不依赖淡入，也不留内联样式）',
      w.location.pathname === '/notes/'
      && !w.document.getElementById('app').getAttribute('style')
      && w.document.getElementById('app').textContent.includes('笔记'), w.location.pathname);
  }

  {
    const cookie = await login();
    const page = await mount(`${BASE}/admin/system`, cookie);
    const { w } = page;
    check('T73 拿到了后台会话（能打开设置页）', Boolean(w.document.getElementById('app')) && w.document.body.classList.contains('admin'), '');

    w.__marker = 'alive';
    const historyBefore = w.history.length;
    const settings = [...w.document.querySelectorAll('form')].find((f) => f.getAttribute('action') === '/admin/settings');
    settings.querySelector('#s-page').value = '20';
    submit(w, settings, settings.querySelector('button[type=submit]'));
    await waitFor(() => w.document.querySelector('.a-notice'), { timeoutMs: 5000 });

    check('T74 后台表单提交后窗口标记还在（没有整页刷新）', w.__marker === 'alive', String(w.__marker));
    check('T74b 提交后地址变成服务端回跳地址', w.location.pathname === '/admin/system' && /w=/.test(w.location.search),
      `${w.location.pathname}${w.location.search.slice(0, 30)}`);
    check('T74c 同一路径的提交只替换历史记录，不新增一条', w.history.length === historyBefore,
      `${w.history.length} vs ${historyBefore}`);
    check('T74d 页面里出现服务端提示', Boolean(w.document.querySelector('.a-notice')), '');
    check('T74e 提交结果弹出轻提示', w.document.getElementById('toast')?.classList.contains('on') === true, '');
  }

  {
    const cookie = await login();
    const page = await mount(`${BASE}/admin`, cookie);
    const { w } = page;
    w.__marker = 'alive';
    const before = w.history.length;
    const search = w.document.querySelector('form.a-search');
    check('T75-0 列表页有搜索表单', Boolean(search), '');
    search.querySelector('[name=q]').value = 'fixture';
    submit(w, search);
    await waitFor(() => /q=fixture/.test(w.location.search), { timeoutMs: 5000 });
    check('T75 后台搜索（GET 表单）也不整页刷新',
      w.__marker === 'alive' && /q=fixture/.test(w.location.search) && w.history.length === before + 1,
      `marker=${w.__marker} search=${w.location.search} len=${w.history.length}/${before}`);
  }

  {
    const cookie = await login();
    const page = await mount(`${BASE}/admin/system`, cookie);
    const { w } = page;
    w.__marker = 'alive';
    const settings = [...w.document.querySelectorAll('form')].find((f) => f.getAttribute('action') === '/admin/settings');
    settings.querySelector('[name=_csrf]').value = 'forged-token';
    submit(w, settings, settings.querySelector('button[type=submit]'));
    await waitFor(() => /(安全令牌|提交失败)/.test(w.document.getElementById('toast')?.textContent ?? ''), { timeoutMs: 5000 });
    check('T76 令牌失效时不换页，只把失败原因提示出来',
      w.__marker === 'alive' && /(安全令牌|提交失败)/.test(w.document.getElementById('toast')?.textContent ?? ''),
      w.document.getElementById('toast')?.textContent ?? '（没有提示）');
  }

  {
    const page = await mount(`${BASE}/p/why-single-column/`);
    const { w } = page;
    w.__marker = 'alive';
    const form = w.document.querySelector('[data-comment-form]');
    check('T77 文章页有评论表单可提交', Boolean(form), '');
    form.querySelector('[name=author]').value = '无刷新游客';
    form.querySelector('[name=email]').value = 'pjax@example.com';    form.querySelector('[name=body]').value = '这条评论应该原地出现。';
    const pathBefore = w.location.pathname;
    await sleep(300);   // 夹具把最小填表时间压到 200ms
    submit(w, form, form.querySelector('button[type=submit]'));
    await waitFor(() => /等待站主确认/.test(w.document.querySelector('.comments')?.textContent ?? ''), { timeoutMs: 8000 });
    check('T78 评论提交后停在原页（没有整页刷新、没有跳走）',
      w.__marker === 'alive' && w.location.pathname === pathBefore && w.location.search === '',
      `${w.__marker} ${w.location.pathname}${w.location.search}`);
    check('T79 评论区就地更新，出现「等待确认」提示',
      /等待站主确认/.test(w.document.querySelector('.comments')?.textContent ?? ''),
      (w.document.querySelector('.comments')?.textContent ?? '').slice(0, 40));
    check('T79b 新表单：正文清空，昵称/邮箱被记住',
      (w.document.querySelector('[data-comment-form] [name=body]')?.value ?? 'x') === ''
      && (w.document.querySelector('[data-comment-form] [name=author]')?.value ?? '') === '无刷新游客'
      && (w.document.querySelector('[data-comment-form] [name=email]')?.value ?? '') === 'pjax@example.com',
      w.document.querySelector('[data-comment-form] [name=author]')?.value ?? '(无表单)');
    check('T79c 提交成功弹出轻提示', w.document.getElementById('toast')?.classList.contains('on') === true, '');
  }

  {
    const page = await mount(`${BASE}/p/why-single-column/`, null, {
      commenter: JSON.stringify({ author: '老读者', email: 'old@example.com', website: 'https://old.example' }),
    });
    const { w } = page;
    const f = w.document.querySelector('[data-comment-form]');
    check('T79f 记住的身份在重开页面时自动填回',
      f?.querySelector('[name=author]')?.value === '老读者'
      && f?.querySelector('[name=email]')?.value === 'old@example.com'
      && f?.querySelector('[name=website]')?.value === 'https://old.example'
      && f?.querySelector('[name=body]')?.value === '',
      f?.querySelector('[name=author]')?.value ?? '(无表单)');
    check('T79g 蜜罐字段不会被回填', f?.querySelector('[name=hp_fax]')?.value === '', f?.querySelector('[name=hp_fax]')?.value ?? '(无表单)');

    // 已经敲进去的内容不该被覆盖（服务端回显、用户手动改过都算）
    f.querySelector('[name=author]').value = '我自己改的';
    (w.__pjaxHooks || []).forEach((fn) => fn());
    check('T79h 已有输入不被回填覆盖', f.querySelector('[name=author]').value === '我自己改的',
      f.querySelector('[name=author]').value);
  }

  {
    const page = await mount(`${BASE}/notes/`);
    const { w } = page;
    w.__marker = 'alive';
    const btn = w.document.querySelector('[data-comments]');
    const slug = btn?.dataset.comments;
    const slot = w.document.getElementById(`c-${slug}`);
    // 笔记流评论是就地展开的一块（.ncp-slot）：首屏只有空壳，grid 0fr 挡不住 Tab，必须同时带 inert；
    // 评论面板首次展开时才取（列表页不再内嵌 10 份表单）。
    check('T79d 笔记列里的评论抽屉首屏是收起 + inert 的空壳，表单尚未加载',
      Boolean(slot) && slot.hasAttribute('inert') && !slot.classList.contains('is-open')
      && !slot.querySelector('[data-comment-form]')
      && btn.getAttribute('aria-expanded') === 'false', '');
    check('T79d1 抽屉的按需地址带 panel=note 与 -<slug> 后缀（多篇同时开过也不撞 id）',
      String(slot?.dataset.commentsUrl ?? '').includes('partial=comments')
      && String(slot?.dataset.commentsUrl ?? '').includes('panel=note')
      && String(slot?.dataset.commentsUrl ?? '').includes(`suffix=-${slug}`), slot?.dataset.commentsUrl ?? '');

    click(w, btn);
    check('T79d2 点「评论」就地展开：inert 摘掉、aria-expanded 翻成 true',
      slot.classList.contains('is-open') && !slot.hasAttribute('inert')
      && btn.getAttribute('aria-expanded') === 'true', `${slot.className} / ${btn.getAttribute('aria-expanded')}`);

    for (let i = 0; i < 60 && !slot.querySelector('[data-comment-form]'); i++) await sleep(50);
    const form = slot.querySelector('[data-comment-form]');
    check('T79d3 展开后取回抽屉自己那套（ncp-form），不是内页评论区那份',
      Boolean(form) && Boolean(slot.querySelector('.ncp-form')) && !slot.querySelector('.c-form'), '');
    // 列表页首屏没有评论表单，表情面板的 <template> 也得随页面下发：抽屉里的表单是后取的，
    // 那时页面已经渲染完，模板不在就再也补不出来了（表现就是点表情键没反应）。
    check('T79d4 列表页也带着表情面板模板（懒加载抽屉里的表情键能用）',
      Boolean(w.document.querySelector('template[data-emoji-tpl]')), '');
    const emojiTrigger = slot.querySelector('[data-emoji-toggle]');
    click(w, emojiTrigger);
    check('T79d5 展开的评论抽屉里，表情键能弹出面板',
      Boolean(slot.querySelector('[data-emoji-panel].is-open'))
      && emojiTrigger.getAttribute('aria-expanded') === 'true',
      `${emojiTrigger.getAttribute('aria-expanded')} / ${Boolean(slot.querySelector('[data-emoji-panel]'))}`);
    form.querySelector('[name=author]').value = '抽屉游客';
    form.querySelector('[name=email]').value = 'drawer@example.com';    form.querySelector('[name=body]').value = '抽屉里提交也应该原地更新。';
    await sleep(300);
    submit(w, form, form.querySelector('button[type=submit]'));
    await waitFor(() => /等待站主确认/.test(slot.textContent ?? ''), { timeoutMs: 8000 });
    check('T79e 抽屉里的评论提交后：不跳页、抽屉还开着、内容就地更新',
      w.__marker === 'alive' && w.location.pathname === '/notes/'
      && slot.classList.contains('is-open')
      && /等待站主确认/.test(slot.textContent ?? ''),
      `${w.location.pathname}`);
    // 回刷必须仍是抽屉那套；写成内页那套会换脸（.ncp-form 不见、换成 .c-form）—— 本机制最易漏的耦合。
    check('T79e1 回刷回来的仍是抽屉自己那份（ncp-form 还在、没被换成内页那套）',
      Boolean(slot.querySelector('.ncp-form')) && !slot.querySelector('.c-form')
      && Boolean(slot.querySelector('.ncp-flash')), '');
    // 按钮上的数字是抽屉外唯一显示条数处；它带展开箭头（::after），整块 textContent 重写会抹掉箭头 —— 断言它仍是数字。
    check('T79e2 提交后按钮仍写着「评论」或「评论 N」',
      /^评论( \d+)?$/.test((btn.textContent ?? '').trim()), JSON.stringify(btn.textContent));
  }

  {
    const cookie = await login();
    const listPage = await mount(`${BASE}/admin`, cookie);
    const href = listPage.w.document.querySelector('a.a-title')?.getAttribute('href');
    check('T80 从列表页拿到一篇文章的编辑链接', /^\/admin\/edit\/\d+$/.test(href ?? ''), String(href));

    const page = await mount(`${BASE}${href}`, cookie);
    const { w } = page;
    w.__marker = 'alive';
    const form = w.document.getElementById('editorForm');
    const body = form.querySelector('[name=body]');
    body.value = `${body.value}\n\n（无刷新保存测试标记）`;
    body.dispatchEvent(new w.Event('input', { bubbles: true }));
    const before = w.history.length;
    submit(w, form, form.querySelector('[value=save]'));
    await waitFor(() => /已保存/.test(w.document.getElementById('toast')?.textContent ?? ''), { timeoutMs: 8000 });

    check('T80b 编辑器保存不整页刷新（窗口标记还在）', w.__marker === 'alive', String(w.__marker));
    check('T80c 保存后仍停在编辑器，并给出"已保存"提示',
      w.location.pathname === href && /已保存/.test(w.document.getElementById('toast')?.textContent ?? ''),
      `${w.location.pathname}${w.location.search} toast=${w.document.getElementById('toast')?.textContent ?? '（无）'}`);
    check('T80d 同路径保存只替换历史记录', w.history.length === before, `${w.history.length}/${before}`);
    const after = await (await fetch(`${BASE}${href}`, { headers: { cookie } })).text();
    check('T80e 正文真的落库了（重新取页面能看到标记）', after.includes('无刷新保存测试标记'), '');
  }

  {
    const { w: wl } = await mount(`${BASE}/notes/`);
    const rawScroll = wl.scrollTo;
    let restoredTo = null;
    let restoreBehavior = null;
    wl.scrollTo = (opts, y) => {
      if (opts && typeof opts === 'object') { restoredTo = opts.top; restoreBehavior = opts.behavior; }
      else { restoredTo = y; }
      rawScroll(opts, y);
    };
    Object.defineProperty(wl, 'scrollY', { get: () => 1234, configurable: true });
    Object.defineProperty(wl, 'innerWidth', { get: () => 1024, configurable: true });
    const root = wl.document.documentElement;
    Object.defineProperty(root, 'clientWidth', { get: () => 1009, configurable: true });

    // 忠实模拟时序：有开着的 dialog 时 :has(dialog[open]) 已收走滚动条（clientWidth 变宽），再量只会得 0。
    Object.defineProperty(root, 'clientWidth', {
      get: () => (wl.document.querySelector('dialog[open]') ? 1024 : 1009),
      configurable: true,
    });
    wl.__measureScrollbar();
    const dlg = wl.document.createElement('dialog');
    dlg.setAttribute('open', '');
    wl.document.body.appendChild(dlg);
    wl.__syncScrollLock();     // 此刻弹窗已开：必须用缓存值，不能重测

    check('T81 浮窗打开时锁住背后的页面，并记下当前滚动量',
      root.classList.contains('modal-open') && root.style.getPropertyValue('--modal-lock-y') === '-1234px',
      `class="${root.className}" y="${root.style.getPropertyValue('--modal-lock-y')}"`);
    check('T81f 滚动条宽度取"未锁定"时的测量值并用等宽 padding 补偿（锁定时再量会得到 0）',
      root.style.getPropertyValue('--modal-lock-pad') === '15px',
      `pad="${root.style.getPropertyValue('--modal-lock-pad')}"`);
    check('T81g 锁定状态下不再重新测量（避免量到 0 把补偿抹掉）',
      wl.__measureScrollbar() === 15, `再量=${wl.__measureScrollbar()}`);

    dlg.removeAttribute('open');
    wl.__syncScrollLock();
    check('T81b 关闭后解锁，并瞬移回原来的位置（不跳回顶部、也不滑一段）',
      !root.classList.contains('modal-open') && restoredTo === 1234 && restoreBehavior === 'instant'
      && root.style.getPropertyValue('--modal-lock-pad') === '', `y=${restoredTo} behavior=${restoreBehavior} pad="${root.style.getPropertyValue('--modal-lock-pad')}"`);

    dlg.setAttribute('open', '');
    wl.__syncScrollLock();
    dlg.removeAttribute('open');
    dlg.dispatchEvent(new wl.Event('close'));   // Esc 关闭时浏览器发的是 close 事件
    check('T81c Esc 关闭（close 事件）也能解锁', !root.classList.contains('modal-open'), root.className);

    const cssLock = await cssAll();
    check('T81d 样式表里有跨端锁：桌面 overflow + 滚动条补偿，触屏 position:fixed',
      /html\.modal-open \{ overflow: hidden/.test(cssLock)
      && /html\.modal-open body \{ padding-right: var\(--modal-lock-pad/.test(cssLock)
      && /\(hover: none\) and \(pointer: coarse\)[\s\S]{0,200}position: fixed/.test(cssLock), '');
    check('T81e 灯箱掐断滚动链（笔记流的评论抽屉不在此列：它在页面里展开，锁住就滚不动了）',
      /\.lightbox[^{]*\{[^}]*overscroll-behavior: contain/.test(cssLock)
      && !/\.ncp-slot[^{]*\{[^}]*overscroll-behavior/.test(cssLock), '');
  }

  {
    const nojs = new JSDOM(html).window.document;
    const links = [...nojs.querySelectorAll('a[href]')].filter((a) => !a.getAttribute('href').startsWith('http'));
    const emptyHash = links.filter((a) => a.getAttribute('href') === '#' || a.getAttribute('href') === '');
    const main = nojs.getElementById('main');

    const mainText = main ? main.textContent.replace(/\s+/g, '') : '';
    check('T27 不执行脚本也有完整正文', Boolean(main) && mainText.length > 100 && /\/p\//.test(main.innerHTML),
      `${mainText.length} 字`);
    check('T28 导航与列表链接都是真实 href，没有 # 占位', links.length > 5 && emptyHash.length === 0,
      `${links.length} 个链接，${emptyHash.length} 个空 href`);
    check('T29 首页包含文章标题（内容在 HTML 里，不靠 JS 渲染）', nojs.body.textContent.includes('为什么单栏是唯一正确的选择'));
  }

  {
    // 文章页「回复/取消回复」：nav.js 与 app.js 同时在场的真实行为。以前取消是就地重置、地址栏仍停在 ?reply=N，再点同一个「回复」链接时 nav.js 判 URL 未变放弃接管 —— 点了没反应。
    const { DatabaseSync } = await import('node:sqlite');
    const seed = new DatabaseSync(srv.dbFile);
    let commentId;
    try {
      const post = seed.prepare("SELECT id FROM posts WHERE slug = 'why-single-column'").get();
      commentId = Number(seed.prepare(`INSERT INTO comments (post_id, parent_id, author, body_md, status, is_author, moderation_nonce)
        VALUES (?, NULL, '读者甲', '顶一下', 'approved', 0, ?)`).run(post.id, 'nonce-reply-test').lastInsertRowid);
    } finally { seed.close(); }

    const page = await mount(`${BASE}/p/why-single-column/`);
    const form = page.w.document.querySelector('.c-form');
    const link = page.w.document.querySelector('.c-list [data-reply]');
    const cancel = form.querySelector('[data-cancel-reply]');
    const state = () => [form.querySelector('input[data-parent]').value, form.querySelector('[data-reply-title]').textContent.trim(), cancel.hasAttribute('hidden')];

    check('T82 文章页评论渲染出「回复」链接与收起态的「取消回复」', Boolean(link) && Boolean(cancel) && cancel.hasAttribute('hidden'));
    check('T83 初始落款是空的（「写一条评论」已删）', JSON.stringify(state()) === JSON.stringify(['', '', true]), JSON.stringify(state()));

    click(page.w, link);
    check('T84 点「回复」就地进入回复模式，不再跳 ?reply=',
      JSON.stringify(state()) === JSON.stringify([String(commentId), '回复 读者甲', false]) && !page.w.location.search.includes('reply'),
      `${JSON.stringify(state())} url=${page.w.location.pathname}${page.w.location.search}`);
    // 表单跟随：挪进被回复那条评论下面（无子回复时就是 .c-main 最后一个孩子）；不再挂评论区底部。
    check('T84a 点「回复」后评论框跟随到该条评论下面',
      form.closest('li.comment')?.id === `c${commentId}`
      && form.previousElementSibling?.classList.contains('c-foot')
      && !form.closest('[data-comments-section]').querySelector(':scope > .c-form'),
      `parent=${form.parentElement.className} prev=${form.previousElementSibling?.className}`);

    click(page.w, cancel);
    check('T85 点「取消回复」把落款清回空', JSON.stringify(state()) === JSON.stringify(['', '', true]), JSON.stringify(state()));
    check('T85a 取消后评论框搬回评论区底部原位',
      form.parentElement.classList.contains('comments') && form.nextElementSibling === null,
      `parent=${form.parentElement.className} next=${form.nextElementSibling?.className ?? '(无)'}`);
    // 焦点送回被回复那条评论的「回复」链接（原来 focus 正文框会把页面拽到评论区底部）
    check('T85b 取消后焦点落回该条评论的「回复」链接，页面不再跳向底部',
      page.w.document.activeElement?.closest('li.comment')?.id === `c${commentId}`
      && page.w.document.activeElement?.matches('[data-reply]'),
      `activeElement=${page.w.document.activeElement?.id ?? page.w.document.activeElement?.className ?? '(body)'}`);

    click(page.w, link);
    check('T86 取消之后再次点「回复」仍然生效（原 pjax 死路）',
      JSON.stringify(state()) === JSON.stringify([String(commentId), '回复 读者甲', false]), JSON.stringify(state()));
    check('T86a 再次回复时表单再次跟随进评论里',
      form.closest('li.comment')?.id === `c${commentId}`, `parent=${form.parentElement.className}`);
  }

  {
    const loginHtml = await (await fetch(`${BASE}/admin/login`)).text();
    check('T33 登录页没有 #app（导航器自动不启用）', !/id="app"/.test(loginHtml));

    check('T34 登录页不加载 nav.js（没有容器就不必浪费字节）', !/nav\.js/.test(loginHtml));
    const adminHome = await (await fetch(`${BASE}/admin`, { redirect: 'manual' })).status;
    check('T35 未登录访问后台仍会 303 跳登录页', adminHome === 303, String(adminHome));
  }

  {
    const homeHtml = await (await fetch(`${BASE}/`)).text();
    const home = new JSDOM(homeHtml).window.document;
    const recentCount = home.querySelectorAll('.recent .entries li').length;
    check('T39 导航第一项是「首页」且指向 /', /<a href="\/" aria-current="page"><svg[\s\S]*?<span class="n-txt">首页<\/span><\/a>/.test(homeHtml),
      (homeHtml.match(/<nav class="nav"[^>]*>[\s\S]{0,120}/) ?? [''])[0].replace(/\s+/g, ' '));
    check('T40 首页列的是最近几条（账本），不是整份列表',
      homeHtml.includes('class="recent"') && homeHtml.includes('class="entries')
      && !homeHtml.includes('class="list"') && recentCount > 0 && recentCount <= 12,
      `${recentCount} 条`);
    check('T41 首页仍有首屏与栏目入口', homeHtml.includes('class="hero"') && homeHtml.includes('class="hero-meta"')
      && homeHtml.includes('href="/posts/"') && homeHtml.includes('href="/notes/"'), '');
    check('T42 首屏不再有滚动提示（下面直接接最近更新）', !homeHtml.includes('hero-cue'), '');

    check('T43 最近更新位于正文中的封面块，仍紧接统计行',
      home.querySelectorAll('main').length === 1
      && home.querySelector('main#main .hero .recent') !== null
      && home.querySelector('.hero .hero-meta + .recent') !== null
      && !homeHtml.includes('class="intro"'), '');

    const postsHtml = await (await fetch(`${BASE}/posts/`)).text();
    check('T44 文章列表搬到了 /posts/', postsHtml.includes('class="list"') && postsHtml.includes('/p/why-single-column/'), '');
    check('T45 /posts/ 上导航高亮的是「文章」而不是「首页」',
      /<a href="\/posts\/" aria-current="page"><svg[\s\S]*?<span class="n-txt">文章<\/span><\/a>/.test(postsHtml)
      && !/<a href="\/" aria-current="page"><svg[\s\S]*?<span class="n-txt">首页<\/span><\/a>/.test(postsHtml), '');
  }

  {
    const r = await fetch(`${BASE}/nav.js`);
    check('T36 /nav.js 可访问且类型正确', r.status === 200 && (r.headers.get('content-type') || '').includes('javascript'));
    const pageHead = await fetch(`${BASE}/`);
    check('T36b 页面响应要求回源校验（否则会一直引用旧指纹的资源，改动到不了用户手里）',
      (pageHead.headers.get('cache-control') || '').includes('no-cache'),
      String(pageHead.headers.get('cache-control')));
    const navV = /nav\.js\?v=([0-9a-f]+)/.exec(html)?.[1] ?? '';
    const assetHead = await fetch(`${BASE}/nav.js?v=${navV}`);
    check('T36c 静态资源仍然长期缓存（指纹未变时不该重复下载）',
      Boolean(navV) && (assetHead.headers.get('cache-control') || '').includes('immutable'),
      String(assetHead.headers.get('cache-control')));
    // 裸 /nav.js（书签、外部引用）不能 immutable：部署后内容会变，带 ?v= 的才长期缓存（T36c）。
    check('T37 裸 /nav.js 只做短缓存', !(r.headers.get('cache-control') || '').includes('immutable')
      && (r.headers.get('cache-control') || '').includes('max-age=300'), String(r.headers.get('cache-control')));
    check('T38 页面引用的资源版本号包含 nav.js 的内容', /nav\.js\?v=[0-9a-f]{10}/.test(html));
    const resourceUrls = [...html.matchAll(/(?:href|src)="(\/[^" ]+\?v=[0-9a-f]{10})"/g)].map((m) => m[1]);
    check('T39b 各资源使用自己的内容指纹', resourceUrls.length >= 4 && new Set(resourceUrls.map((url) => url.split('?v=')[1])).size > 1);
    check('T38b nav.js 会记录自己的版本号，便于确认浏览器跑的是哪一份',
      w.__navBuild === (/nav\.js\?v=([0-9a-f]+)/.exec(html) ?? [])[1],
      `__navBuild=${w.__navBuild}`);
  }

  // 按钮上的 formaction 优先于 form.action（HTML 规范）。后台「移除首页封面」「清除页面配置」靠它指向 /admin/hero/clear、/admin/mail/clear ——
  // 只看 form.action 会把移除/清除变成再保存一次（还顺带发测试邮件）。这里往真实 DOM 插两个带 formaction 的按钮。
  {
    const { w } = await mount(`${BASE}/admin/system`, await login());
    const mkForm = (action, formaction) => {
      const form = w.document.createElement('form');
      form.setAttribute('method', 'post');
      form.setAttribute('action', action);
      form.innerHTML = `<input type="hidden" name="_csrf" value="T"><button type="submit" formaction="${formaction}">go</button>`;
      w.document.getElementById('app').append(form);
      return { form, btn: form.querySelector('button') };
    };
    const hero = mkForm('/admin/hero', '/admin/hero/clear');
    const mail = mkForm('/admin/mail', '/admin/mail/clear');

    const calls = [];
    w.fetch = (input, init) => {
      calls.push({ url: String(input), method: String((init && init.method) || 'GET') });
      return Promise.resolve({
        ok: true, status: 303, headers: { get: () => 'text/html' },
        text: async () => '<!doctype html><html><body><div id="app"></div></body></html>',
      });
    };
    await w.__nav.submitForm(hero.form, hero.btn);
    await w.__nav.submitForm(mail.form, mail.btn);
    await sleep(20);
    const posts = calls.map((c) => `${c.method} ${c.url.replace(BASE, '')}`);
    check('T89a 移除首页封面打到 /admin/hero/clear（不是再存一次）',
      calls.some((c) => c.method === 'POST' && c.url.endsWith('/admin/hero/clear')), posts.join(' , '));
    check('T89b 清除邮件配置打到 /admin/mail/clear（不是再存一次）',
      calls.some((c) => c.method === 'POST' && c.url.endsWith('/admin/mail/clear')), posts.join(' , '));
  }

  // 标题 → slug 联动：新内容跟着标题走，已有内容的 slug（就是 URL）绝不能被改；手填过停联动、清空后恢复。
  {
    const cookie = await login();
    const { w } = await mount(`${BASE}/admin/new?kind=post`, cookie);
    const title = w.document.getElementById('f-title');
    const slug = w.document.getElementById('f-slug');
    const type = (el, value) => { el.value = value; el.dispatchEvent(new w.Event('input', { bubbles: true })); };
    check('T90a 编辑器里标题与 slug 字段都在（前置条件）', Boolean(title && slug), '');

    type(title, '为什么单栏是唯一正确的选择!');
    check('T90b 新文章：标题自动推导出 slug（汉字保留、标点去掉）',
      slug.value === '为什么单栏是唯一正确的选择', slug.value);

    type(title, 'Another Post: Hello, World');
    check('T90c 继续改标题，slug 跟着变（转小写、空格转连字符、去标点）',
      slug.value === 'another-post-hello-world', slug.value);

    type(title, '!!!');
    check('T90d 标题里没有可用字符时回退为 untitled（与服务端 slugify 一致）',
      slug.value === 'untitled', slug.value);

    type(slug, 'my-own-slug');
    type(title, '改标题不该覆盖手填的 slug');
    check('T90e 手填过 slug 之后，改标题不再覆盖它', slug.value === 'my-own-slug', slug.value);

    type(slug, '');
    type(title, 'Clear Again');
    check('T90f 清空 slug 后恢复联动', slug.value === 'clear-again', slug.value);

    type(title, '');
    check('T90g 标题清空时不会编造 untitled（保留上一次推导出来的 slug）',
      slug.value === 'clear-again', slug.value);

    // 前端 slugify 是服务端镜像：一旦漂移，编辑器显示的就是假 slug。空标题不参与比较。
    const { slugify: serverSlugify } = await import('../src/util/text.js');
    const samples = ['中文标题', 'Hello World', '  A__B  ', 'a--b', '-x-', '符号 !!!',
      'UPPER lower 123', '多 空格  与_下划线', 'C++ 与 Node.js'];
    const drifted = samples
      .map((s) => { type(title, s); return { s, got: slug.value, want: serverSlugify(s) }; })
      .filter((r) => r.got !== r.want);
    check('T90i 前端 slugify 与服务端逐字一致（否则编辑器展示的 slug 与落库的不是同一个）',
      drifted.length === 0, drifted.map((r) => `${JSON.stringify(r.s)}: ${r.got} ≠ ${r.want}`).join(' ~ '));

    // 这块 input 会排 3 秒后自动保存；跑一遍 pjax 钩子复用 dispose() 的 clearTimeout，免得它打到服务器上。
    w.__pjaxHooks?.forEach?.((fn) => fn());
  }

  // 已有文章的 slug 是 URL，不能因为改标题而变
  {
    const cookie = await login();
    const listHtml = await (await fetch(`${BASE}/admin?q=why-single-column`, { headers: { cookie } })).text();
    const id = /href="\/admin\/edit\/(\d+)"/.exec(listHtml)?.[1];
    const { w } = await mount(`${BASE}/admin/edit/${id}`, cookie);
    const title = w.document.getElementById('f-title');
    const slug = w.document.getElementById('f-slug');
    const before = slug?.value ?? '';
    title.value = '换了个标题但 URL 不该变';
    title.dispatchEvent(new w.Event('input', { bubbles: true }));
    check('T90h 已有文章：改标题不会悄悄改掉 slug（URL 稳定，不靠 301 兜）',
      Boolean(before) && before === 'why-single-column' && slug.value === before,
      `${before} → ${slug.value}`);
    w.__pjaxHooks?.forEach?.((fn) => fn());
  }

  {
    const cookie = await login();
    const listHtml = await (await fetch(`${BASE}/admin?q=why-single-column`, { headers: { cookie } })).text();
    const id = /href="\/admin\/edit\/(\d+)"/.exec(listHtml)?.[1];
    check('T91a 拿到文章编辑页（前置条件）', Boolean(id), `id=${id}`);
    const { w } = await mount(`${BASE}/admin/edit/${id}`, cookie);
    const body = w.document.getElementById('f-body');
    check('T91b 编辑器装好了：正文 textarea 在表单里',
      Boolean(body && w.document.getElementById('editorForm')), '');

    // 精简后不许回潮：镜像高亮层、字数胶囊、大纲、预览栏、专注/打字机/预览开关、快捷键弹窗 —— 一个都不该再出现。
    check('T91b2 写作台增强件（镜像 / 字数 / 大纲 / 预览 / 开关 / 快捷键表）已全部移除',
      ['f-body-hl', 'a-count', 'a-outline', 'a-outline-fold', 'a-preview', 'a-preview-body',
        'a-focus', 'a-typewriter', 'a-pane', 'a-keys', 'a-keys-btn', 'a-desk']
        .every((el) => !w.document.getElementById(el)), '');

    // 发布设置整块默认折叠；状态 chip 挂 summary 上，折起来也看得见；折叠只是视觉收起，字段仍在表单。
    const settings = w.document.getElementById('a-settings');
    check('T91b3 发布设置默认折叠、chip 在 summary 里、字段仍随表单提交',
      settings?.tagName === 'DETAILS' && settings.open === false
      && Boolean(settings.querySelector('summary .a-chip'))
      && Boolean(settings.querySelector('#f-slug')) && Boolean(settings.querySelector('[name="draft"]')), '');

    // Enter 列表续行 / 输入法组字期间不许抢
    body.value = '- 第一项';
    body.setSelectionRange(body.value.length, body.value.length);
    const enter = new w.KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true });
    body.dispatchEvent(enter);
    check('T91k Enter 自动续列表，并挡住默认换行',
      body.value === '- 第一项\n- ' && enter.defaultPrevented, JSON.stringify(body.value));

    body.value = '- 中文输入中';
    body.setSelectionRange(body.value.length, body.value.length);
    const ime = new w.KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true });
    Object.defineProperty(ime, 'isComposing', { value: true });
    body.dispatchEvent(ime);
    check('T91l 输入法组字中的 Enter 绝不抢（否则中文输入法会坏）',
      body.value === '- 中文输入中' && !ime.defaultPrevented, JSON.stringify(body.value));

    body.value = 'abc def';
    body.setSelectionRange(0, 3);
    const cmdK = new w.KeyboardEvent('keydown', { key: 'k', metaKey: true, bubbles: true, cancelable: true });
    body.dispatchEvent(cmdK);
    check('T91m ⌘K 把选中的文字变成链接文本',
      body.value === '[abc](url) def' && cmdK.defaultPrevented, body.value);

    body.value = 'plain';
    body.setSelectionRange(0, 5);
    const cmdB = new w.KeyboardEvent('keydown', { key: 'b', metaKey: true, bubbles: true, cancelable: true });
    body.dispatchEvent(cmdB);
    check('T91n ⌘B 加粗选区', body.value === '**plain**', body.value);

    // Tab 只该在正文里缩进：曾只要焦点在表单里就吃 Tab（标题里插两空格、⇧Tab 反删，键盘用户被关住）。
    const titleField = w.document.getElementById('f-title');
    body.value = 'abc';
    body.setSelectionRange(0, 0);
    const tabInTitle = new w.KeyboardEvent('keydown', { key: 'Tab', bubbles: true, cancelable: true });
    titleField.dispatchEvent(tabInTitle);
    check('T91o 在标题里按 Tab 不会被正文吃掉（焦点能正常前进、正文不动）',
      !tabInTitle.defaultPrevented && body.value === 'abc',
      `prevented=${tabInTitle.defaultPrevented} body=${JSON.stringify(body.value)}`);

    const tabInBody = new w.KeyboardEvent('keydown', { key: 'Tab', bubbles: true, cancelable: true });
    body.dispatchEvent(tabInBody);
    check('T91p 在正文里按 Tab 仍然缩进两格',
      tabInBody.defaultPrevented && body.value === '  abc', JSON.stringify(body.value));

    const shiftTab = new w.KeyboardEvent('keydown', { key: 'Tab', shiftKey: true, bubbles: true, cancelable: true });
    body.dispatchEvent(shiftTab);
    check('T91q 在正文里按 ⇧Tab 仍然反缩进', body.value === 'abc', JSON.stringify(body.value));

    // 这一块改过 textarea，排过自动保存的定时器 —— 跑一遍 pjax 钩子复用 dispose
    w.__pjaxHooks?.forEach?.((fn) => fn());
  }
} catch (err) {
  check(`测试过程中抛出异常：${err.message}`, false);
} finally {
  await srv.stop();
  const failures = report();
  if (!failures) {
    console.log('  换页动画相关（本次改动的重点）：');
    console.log('    · 已断言换页不使用 View Transition（避免两份文档交叉溶解看成"跳一下"）');
    console.log('    · 已断言快请求不显示加载指示（延迟 150ms）');
    console.log('    · 已断言换页后列表立刻可见，没有残留入场动画');
    console.log('');
    console.log('  无刷新提交相关：');
    console.log('    · 已断言后台 POST 表单提交后窗口标记还在（没有整页刷新）');
    console.log('    · 已断言同路径提交只替换历史记录、不新增');
    console.log('    · 已断言 GET 搜索表单、站内 301 跳转、评论提交都走无刷新');
    console.log('    · 已断言非 HTML 响应（CSRF 失效）不换页，只提示');
    console.log('');
    console.log('  jsdom 覆盖不到、需要真浏览器确认的项：');
    console.log('    · 换页是否真的"瞬时、无位移"（jsdom 没有渲染）');
    console.log('    · 后退时的滚动位置恢复');
    console.log('    · 悬停预取的"瞬间感"\n');
  }
  process.exit(failures ? 1 : 0);
}

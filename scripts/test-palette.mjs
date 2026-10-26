import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import { fileURLToPath } from 'node:url';
import { JSDOM } from 'jsdom';
import { THEME_BOOT, PALETTES, LAYOUTS, layout, setPaletteDefault, setLayoutDefault, layoutAttr, themeChrome, heroToolsHtml, PALETTE_CSS_GUARD, PALETTE_CSS_BANNED } from '../src/render/layout.js';
import { adminLayout } from '../src/admin/layout.js';
import { systemPage } from '../src/admin/views/system.js';
import { parsePaletteDefault, parseLayoutDefault, settings, saveSettings, KEYS } from '../src/settings.js';
import { createChecker } from './_check.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
// 令牌层（含配色预设块）在 base.css，前台组件在 style.css；页面里按这个顺序加载，断言也按这个顺序拼。
const css = ['base.css', 'style.css']
  .map((f) => fs.readFileSync(path.join(root, 'public', f), 'utf8'))
  .join('\n');
const appSource = fs.readFileSync(path.join(root, 'public', 'app.js'), 'utf8');
const uiSource = fs.readFileSync(path.join(root, 'public', 'ui.js'), 'utf8');
// app.js 依赖 request.js 挂上的共享工具（__csrf、__uploadRaw 等）；页面里 request.js 永远先执行，这里照搬。
const requestSource = fs.readFileSync(path.join(root, 'public', 'request.js'), 'utf8');
// 生成器是经典脚本（挂 globalThis.PaletteLib），页面里以 defer 加载在 ui.js 之前；
// 这里用 vm 跑同一份文件，不复制逻辑 —— 生成器改了，下面这套扫描断言立刻跟着变。
const paletteSource = fs.readFileSync(path.join(root, 'public', 'palette.js'), 'utf8');
const paletteCtx = vm.createContext({});
vm.runInContext(paletteSource, paletteCtx);
const lib = paletteCtx.PaletteLib;

const { test, report } = createChecker();
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

// 对比度（WCAG）：只算纯 hex，不吃 color-mix 计算值
const lum = (hex) => {
  const c = hex.replace('#', '');
  const [r, g, b] = [0, 2, 4].map((i) => parseInt(c.slice(i, i + 2), 16) / 255)
    .map((v) => (v <= .03928 ? v / 12.92 : Math.pow((v + .055) / 1.055, 2.4)));
  return .2126 * r + .7152 * g + .0722 * b;
};
const ratio = (a, b) => {
  const [x, y] = [lum(a), lum(b)].sort((m, n) => n - m);
  return (x + .05) / (y + .05);
};

function blockOf(cssText, selector) {
  const at = cssText.indexOf(selector);
  assert.notEqual(at, -1, `找不到选择器：${selector}`);
  const open = cssText.indexOf('{', at);
  const close = cssText.indexOf('\n}', open);
  return cssText.slice(open + 1, close);
}
const varOf = (block, name) => {
  const m = new RegExp(`${name}:\\s*(#[0-9a-fA-F]{6})`).exec(block);
  assert.ok(m, `块里没有 ${name}（或不是六位 hex）`);
  return m[1];
};

// 行为测试的挂载：真 layout() 渲染整页 → 塞 localStorage → 跑 <head> 内联引导 → 跑 app.js。顺序与真实页面一致。
function mount({ seed = {}, lazyPalette = false } = {}) {
  // 首页 hero-meta 那行带进真入口（#palettePickerH）：行为与访客点的那一枚完全同构。
  const html = layout({ title: '测试', main: `<div class="hero-meta">${heroToolsHtml()}</div>`, canonical: '/', active: 'home', page: 'home' });
  const dom = new JSDOM(html, { url: 'https://uua.me/', runScripts: 'outside-only', pretendToBeVisual: true });
  const w = dom.window;
  w.matchMedia = () => ({ matches: false });
  w.Element.prototype.scrollIntoView = () => {};
  for (const [k, v] of Object.entries(seed)) w.localStorage.setItem(k, v);
  // <head> 里的内联主题引导（outside-only 不会自动跑内联脚本，手动 eval 一次）
  const boot = /<script>(document\.documentElement[^<]*)<\/script>/.exec(html)?.[1];
  assert.ok(boot, '页面里找不到内联主题引导');
  assert.equal(boot, THEME_BOOT, '页面内联的引导与导出的 THEME_BOOT 不一致');
  w.eval(boot);
  // 页面里的顺序：boot（内联）→ palette.js → request.js → ui.js → app.js。ui.js 用 PaletteLib 现算自定义配色。
  // lazyPalette=true 模拟首次交互时 palette.js 还在异步加载（真实页面里它按需注入）。
  if (!lazyPalette) w.eval(paletteSource);
  w.eval(requestSource);
  w.eval(uiSource);
  w.eval(appSource);
  return { dom, w, html };
}

// 全站只有首页 hero-meta 那一枚入口（#palettePickerH），行为测试直接驱动它。
const pickerOf = (w) => w.document.getElementById('palettePickerH');
// 入口只留图标，当前是哪套写在 aria-label 的括号里（「配色（青瓷）」）—— 圆钮不随色名伸缩。
const pickedName = (w) => {
  const label = pickerOf(w)?.querySelector('summary')?.getAttribute('aria-label') || '';
  const m = /^样式（(.+)）$/.exec(label);
  return m ? m[1] : '';
};
const openPicker = (w) => {
  const picker = pickerOf(w);
  picker.setAttribute('open', '');
  // jsdom 对 details 的原生 toggle 支持不齐，这里手动补发（处理器只认事件与 open 状态）
  picker.dispatchEvent(new w.Event('toggle'));
};
const pressedOf = (w) => [...w.document.querySelectorAll('#palettePickerH .pal-opt')]
  .map((b) => `${b.dataset.palette || '∅'}=${b.getAttribute('aria-pressed')}`).join(' ');


await test('清单与 CSS 对得上：每套配色三块齐全（浅色 / 显式深色 / 系统深色）', () => {
  for (const p of PALETTES.filter((x) => x.key)) {
    assert.ok(css.includes(`html[data-palette="${p.key}"] {`), `${p.key} 缺浅色块`);
    assert.ok(css.includes(`html[data-theme="dark"][data-palette="${p.key}"] {`), `${p.key} 缺显式深色块`);
    assert.match(css, new RegExp(`@media \\(prefers-color-scheme: dark\\) \\{\\s*html:not\\(\\[data-theme="light"\\]\\):not\\(\\[data-theme="dark"\\]\\)\\[data-palette="${p.key}"\\] \\{`), `${p.key} 缺系统深色块`);
  }
  // CSS 里不许出现清单之外的 data-palette 值
  const inCss = new Set([...css.matchAll(/data-palette="([a-z]+)"/g)].map((m) => m[1]));
  const known = new Set(PALETTES.map((p) => p.key).filter(Boolean));
  for (const key of inCss) assert.ok(known.has(key), `CSS 里出现清单之外的配色：${key}`);
});

await test('深色守卫两段逐字相同（显式深色 = 系统深色，改一处必须两处一起改）', () => {
  for (const p of PALETTES.filter((x) => x.key)) {
    const explicit = blockOf(css, `html[data-theme="dark"][data-palette="${p.key}"] {`);
    const media = blockOf(css, `html:not([data-theme="light"]):not([data-theme="dark"])[data-palette="${p.key}"] {`);
    const norm = (s) => s.replace(/\s+/g, ' ').replace(/[{}]/g, ' ').trim();
    assert.equal(norm(explicit), norm(media), `${p.key} 的两段深色守卫字面不一致`);
  }
});

await test('对比度：每套配色 × 明暗，accent 对纸面 / 纸片 ≥ 4.5:1', () => {
  for (const p of PALETTES.filter((x) => x.key)) {
    for (const [label, sel] of [['浅色', `html[data-palette="${p.key}"] {`], ['深色', `html[data-theme="dark"][data-palette="${p.key}"] {`]]) {
      const block = blockOf(css, sel);
      const bg = varOf(block, '--bg');
      const elev = varOf(block, '--bg-elev');
      const accent = varOf(block, '--accent');
      const r1 = ratio(accent, bg);
      const r2 = ratio(accent, elev);
      assert.ok(r1 >= 4.5, `${p.key}·${label} accent/bg ${r1.toFixed(2)} < 4.5`);
      assert.ok(r2 >= 4.5, `${p.key}·${label} accent/bg-elev ${r2.toFixed(2)} < 4.5`);
    }
  }
});

await test('无 JS 回退与打印回退在位', () => {
  assert.match(css, /html:not\(\.has-js\) \.pal \{ display: none; \}/);
  assert.match(css, /@media print \{\s*html\[data-palette\] \{/);
});

await test('THEME_BOOT 白名单与 PALETTES 一致（含恢复语句，白名单外不认）', () => {
  const keys = PALETTES.filter((p) => p.key).map((p) => p.key);
  // THEME_BOOT 的白名单是 JSON.stringify 出来的，用的是双引号
  for (const key of keys) assert.ok(THEME_BOOT.includes(`"${key}"`), `THEME_BOOT 缺 ${key}`);
  assert.ok(THEME_BOOT.includes("localStorage.getItem('palette')"));
});

await test('「配色」入口只在首页 hero-meta 一份（页脚/抽屉/导航都没有），明暗三态在上、选项数与清单一致、色样带双点', () => {
  const html = layout({ title: '测试', main: '<p>x</p>', canonical: '/' });
  const tools = heroToolsHtml();
  const page = html + tools;
  // 唯一入口在首页 hero-meta（只有一个 .pal）；页脚、页头导航、窄屏抽屉都没有。
  assert.match(tools, /<details class="pal pal-hero" id="palettePickerH">/, '首页 hero-meta 里没有配色入口');
  assert.equal([...page.matchAll(/class="pal pal-/g)].length, 1, '配色入口应只有首页那一份');
  assert.doesNotMatch(html, /pal-foot|pal-drawer|palettePickerF|palettePickerM|mnav-foot/, '页脚与抽屉里不该再有配色入口或工具条');
  const nav = /<nav class="nav" aria-label="主导航">[\s\S]*?<\/nav>/.exec(html)?.[0] ?? '';
  assert.doesNotMatch(nav, /class="pal/, '配色入口不该回到页头导航里');
  assert.doesNotMatch(html, /id="themeToggle"/, '页脚那枚明暗按钮应该已经退休（明暗进了配色面板）');
  // 入口只剩图标（当前是哪套仍进 aria-label）。
  assert.match(tools, /<details class="pal pal-hero" id="palettePickerH">\s*<summary aria-label="样式（素笺）" title="样式"><svg class="pal-ico"/);
  assert.doesNotMatch(page, /pal-txt/, '配色入口不该再带文字');
  // 抽屉只剩目录 + 检索：RSS / 配色 / 后台都不在。
  const drawer = /<div class="mnav"[\s\S]*?<\/nav>\s*<\/div>/.exec(html)?.[0] ?? '';
  assert.doesNotMatch(drawer, /feed\.xml|\/admin|palettePicker|mnav-foot/, '抽屉里不该再有 RSS / 配色 / 后台入口');
  const drawerList = /<ul>\s*([\s\S]*?)<\/ul>/.exec(html)?.[1] ?? '';
  assert.doesNotMatch(drawerList, /class="pal/, '目录里不该有配色入口');
  // 入口不再挂当前色样：选中态只由面板里的 ✓ 表示
  assert.doesNotMatch(page, /pal-dot/);
  assert.doesNotMatch(page, /<summary>素笺<\/summary>/);
  // 明暗三态：跟随 / 亮色 / 暗色，默认没有 data-theme 时归「跟随」
  assert.equal([...page.matchAll(/class="pal-tm" data-theme-opt="([a-z]+)"/g)].map((m) => m[1]).slice(0, 3).join(','), 'auto,light,dark');
  const opts = [...page.matchAll(/<button type="button" class="pal-opt" data-palette="([^"]*)" data-hue="(\d+)" data-chroma="([0-9.]+)" aria-pressed="false"><i class="pal-sw" style="--sw-paper:(#[0-9a-f]{6});--sw-ink:(#[0-9a-f]{6})"/g)];
  assert.equal(opts.length, PALETTES.length, `选项 ${opts.length} != 面板里的 ${PALETTES.length} 项`);
  for (const [i, p] of PALETTES.entries()) {
    assert.equal(opts[i][1], p.key);
    assert.equal(opts[i][2], String(p.hue), `${p.key} 的 hue 没渲染进按钮`);
    assert.equal(opts[i][3], String(p.chroma), `${p.key} 的 chroma 没渲染进按钮`);
    assert.equal(opts[i][4], p.paper, `${p.key} 色样纸色与清单不一致`);
    assert.equal(opts[i][5], p.ink, `${p.key} 色样墨色与清单不一致`);
  }
  assert.equal([...page.matchAll(/class="pal-tm" data-theme-opt="auto"/g)].length, 1, '首页那枚该有明暗三态');
  // 自定义区只留三根滑块；三档、深浅、取色、对比度、重置与预览都已下线。
  assert.match(tools, /<div class="pal-custom" data-hue="80" data-chroma="1" data-paper="1">/);
  assert.match(tools, /<input type="range" class="pal-hue" min="0" max="359" step="1" value="80"/);
  assert.match(tools, /<input type="range" class="pal-chroma" min="0.55" max="1.45" step="0.01" value="1"/);
  assert.match(tools, /<input type="range" class="pal-paper" min="0" max="1.8" step="0.05" value="1"/);
  assert.ok(tools.includes(`class="pal-chroma" min="${lib.CHROMA_RANGE.min}" max="${lib.CHROMA_RANGE.max}"`), '浓淡滑块范围与生成器不一致');
  assert.ok(tools.includes(`class="pal-paper" min="${lib.PAPER_RANGE.min}" max="${lib.PAPER_RANGE.max}"`), '纸色滑块范围与生成器不一致');
  for (const gone of ['pal-lv', 'pal-ink', 'pal-pick', 'pal-reset', 'pal-contrast', 'pal-levels', 'pal-inks', 'pal-tools', 'pal-preview']) {
    assert.doesNotMatch(tools, new RegExp(`class="${gone}"`), `${gone} 应该已经下线`);
  }
  assert.doesNotMatch(tools, /强调色深浅|从颜色取色相与浓度|最低对比度/, '已下线的文案还在');
});

await test('入口的色名进 aria-label；后台不做选色入口，只跟随前台（<html> 挂站点默认）', () => {
  setPaletteDefault(() => 'dailan');
  try {
    assert.match(heroToolsHtml(), /<summary aria-label="样式（黛蓝）"/);
  } finally { setPaletteDefault(() => ''); }
  // 后台：不渲染选择器，但站点默认照样挂 <html> —— 前台选什么，后台跟着变
  const adminHtml = adminLayout({ title: '设置', body: '<p>x</p>', active: 'system', csrf: 'c' });
  assert.doesNotMatch(adminHtml, /id="palettePicker"/, '后台不该有选色入口');
  assert.match(adminHtml, /<html lang="[^"]+">/, '没设默认时后台 <html> 不挂属性');
  setPaletteDefault(() => 'qingci');
  try {
    const adminHtml2 = adminLayout({ title: '设置', body: '<p>x</p>', active: 'system', csrf: 'c' });
    assert.match(adminHtml2, /<html lang="[^"]+" data-palette="qingci">/);
    assert.doesNotMatch(adminHtml2, /id="palettePicker"/);
  } finally { setPaletteDefault(() => ''); }
});


await test('选中态首帧即对齐（ui.js 跑完就算，不再等面板打开）', async () => {
  const { dom, w } = mount({ seed: { palette: 'qingci' } });
  try {
    assert.equal(w.document.documentElement.dataset.palette, 'qingci', 'THEME_BOOT 没把存下的配色恢复到首帧');
    assert.equal(pressedOf(w), 'xuanzhi=false ∅=false qingci=true dailan=false qian=false ziteng=false', '首帧选中态没对齐');
    openPicker(w);
    assert.equal(pressedOf(w), 'xuanzhi=false ∅=false qingci=true dailan=false qian=false ziteng=false', '打开后选中态跑了');
  } finally { dom.window.close(); }
});

await test('点青瓷：立即生效、写 localStorage、面板保持打开、焦点不拽回入口', async () => {
  const { dom, w } = mount();
  try {
    openPicker(w);
    const opt = pickerOf(w).querySelector('.pal-opt[data-palette="qingci"]');
    opt.click();
    await sleep(0);
    assert.equal(w.document.documentElement.dataset.palette, 'qingci');
    assert.equal(w.localStorage.getItem('palette'), 'qingci');
    assert.equal(pickerOf(w).open, true, '选择后面板不该自动收起');
    assert.notEqual(w.document.activeElement, pickerOf(w).querySelector('summary'), '选择后不该把焦点拽回入口');
    assert.equal(pressedOf(w), 'xuanzhi=false ∅=false qingci=true dailan=false qian=false ziteng=false');
    assert.equal(pickedName(w), '青瓷', '选完入口的 aria-label 要跟上新色名');
  } finally { dom.window.close(); }
});

await test('入口只留图标，当前色名只进 aria-label（首帧就对齐，不用打开面板）', async () => {
  const { dom, w } = mount({ seed: { palette: 'ziteng' } });
  try {
    const summary = pickerOf(w).querySelector('summary');
    assert.equal(summary.textContent.trim(), '', '首页入口只留图标，不再带文字');
    assert.ok(summary.querySelector('.pal-ico'), '首页配色入口缺图标');
    assert.equal(pickedName(w), '紫藤', 'ui.js 首帧没把访客的色名写进 aria-label');
  } finally { dom.window.close(); }
});

await test('点素笺：撤掉 data-palette、localStorage 记下空串（不是删 key —— 站主默认设了别的也要能持久选回素笺）', async () => {
  const { dom, w } = mount({ seed: { palette: 'qingci' } });
  try {
    openPicker(w);
    pickerOf(w).querySelector('.pal-opt[data-palette=""]').click();
    await sleep(0);
    assert.equal(w.document.documentElement.dataset.palette, undefined);
    assert.equal(w.localStorage.getItem('palette'), '', '应该存空串（明确选素笺），而不是删 key（跟站点默认）');
  } finally { dom.window.close(); }
});

await test('明暗三态：点暗色写 data-theme 并落盘；点「跟随」摘掉属性与 key（首帧引导只认 light/dark）', async () => {
  const { dom, w } = mount();
  try {
    openPicker(w);
    const seg = (m) => w.document.querySelector(`#palettePickerH .pal-tm[data-theme-opt="${m}"]`);
    seg('dark').click();
    await sleep(0);
    assert.equal(w.document.documentElement.dataset.theme, 'dark');
    assert.equal(w.localStorage.getItem('theme'), 'dark', '选暗色没落盘');
    assert.equal(seg('dark').getAttribute('aria-pressed'), 'true');
    assert.equal(seg('auto').getAttribute('aria-pressed'), 'false', '选中态该只留一个');
    seg('auto').click();
    await sleep(0);
    assert.equal(w.document.documentElement.dataset.theme, undefined, '跟随系统＝不写 data-theme');
    assert.equal(w.localStorage.getItem('theme'), null, '跟随系统要连 key 一起清掉，否则首帧仍被旧值锁住');
    assert.equal(seg('auto').getAttribute('aria-pressed'), 'true');
  } finally { dom.window.close(); }
});


await test('换页（pjax 重建页头）后配色与选中态都在：data-palette 挂在 html 上不随 #app 换掉', async () => {
  const { dom, w } = mount({ seed: { palette: 'dailan' } });
  try {
    openPicker(w);
    assert.ok(pressedOf(w).includes('dailan=true'));
    const pickerHtml = pickerOf(w).outerHTML;
    const app = w.document.getElementById('app');
    app.innerHTML = `<main id="main"></main>${pickerHtml}`;
    assert.equal(w.document.documentElement.dataset.palette, 'dailan');
    openPicker(w);
    assert.ok(pressedOf(w).includes('dailan=true'), '新面板的选中态没跟上');
  } finally { dom.window.close(); }
});

await test('Esc 收面板：焦点在面板里才归还，别处按 Esc 只收不动焦点', async () => {
  const { dom, w } = mount({ seed: { palette: 'qian' } });
  try {
    const picker = pickerOf(w);
    const summary = picker.querySelector('summary');
    openPicker(w);
    const opt = picker.querySelector('.pal-opt[data-palette="dailan"]');
    opt.focus();
    opt.dispatchEvent(new w.KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
    assert.equal(picker.open, false);
    assert.equal(w.document.activeElement, summary, '面板内的 Esc 没把焦点还给入口');
    openPicker(w);
    summary.blur();
    w.document.body.dispatchEvent(new w.KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
    assert.equal(picker.open, false);
    assert.notEqual(w.document.activeElement, summary, '别处按 Esc 不该把焦点拽到首页那枚入口');
  } finally { dom.window.close(); }
});

await test('点击面板外收面板', async () => {
  const { dom, w } = mount();
  try {
    openPicker(w);
    w.document.querySelector('header.site .navbtn').click();
    await sleep(0);
    assert.equal(pickerOf(w).open, false);
  } finally { dom.window.close(); }
});

await test('白名单外的存量值被 boot 无视（localStorage 是访客可写的）', async () => {
  for (const evil of ['<script>', 'javascript:1', 'qingci ', 'undefined', 'null']) {
    const { dom, w } = mount({ seed: { palette: evil } });
    try {
      assert.equal(w.document.documentElement.dataset.palette, undefined, `非法值 ${JSON.stringify(evil)} 被当真了`);
    } finally { dom.window.close(); }
  }
});


await test('settings：默认配色白名单校验与兜底', () => {
  const repo = { store: new Map(), getSetting(k) { return this.store.get(k) ?? null; } };
  assert.equal(settings.paletteDefault(repo), '', '没设过 → 素笺');
  assert.equal(parsePaletteDefault('dailan'), 'dailan');
  assert.equal(parsePaletteDefault(' DAILAN '), 'dailan', '大小写与首尾空白应归一');
  assert.equal(parsePaletteDefault(''), '', '空串 = 素笺，合法');
  assert.equal(parsePaletteDefault('<script>'), null, '白名单外一律 null');
  assert.equal(parsePaletteDefault(undefined), '', '旧表单没这字段 → 素笺，不是篡改');
});

await test('saveSettings：默认配色随站点设置一起存，脏值整单拒绝', () => {
  const saved = new Map();
  const err = saveSettings(
    { pageSize: '20', homeRecent: '10', commentsPerPage: '20', palette: 'qingci' },
    (k, v) => saved.set(k, v),
  );
  assert.equal(err, null);
  assert.equal(saved.get(KEYS.paletteDefault), 'qingci');
  const bad = new Map();
  const err2 = saveSettings(
    { pageSize: '20', homeRecent: '10', commentsPerPage: '20', palette: 'javascript:' },
    (k, v) => bad.set(k, v),
  );
  assert.ok(err2 && err2.includes('配色'), '脏 palette 要给出人话报错');
  assert.equal(bad.size, 0, '整单拒绝，一个字都不落库');
});

await test('服务端渲染站点默认：<html data-palette> 直接挂在首帧，入口的 aria-label 跟着站点默认', () => {
  setPaletteDefault(() => 'dailan');
  try {
    const html = layout({ title: '测试', main: '<p>x</p>', canonical: '/' });
    assert.match(html, /<html lang="[^"]+" data-palette="dailan">/);
    assert.match(heroToolsHtml(), /<summary aria-label="样式（黛蓝）"/, '入口的 aria-label 该是站点默认的色名');
  } finally { setPaletteDefault(() => ''); }
  assert.doesNotMatch(layout({ title: 't', main: '', canonical: '/' }), /<html[^>]*data-palette=/, '没设默认时 <html> 不挂属性');
});

await test('boot 与站点默认的优先级：访客选择 > 素笺明选 > 站点默认；脏值回落站点默认', () => {
  setPaletteDefault(() => 'qingci');
  try {
    let { dom, w } = mount();
    assert.equal(w.document.documentElement.dataset.palette, 'qingci', '没选过 → 站点默认');
    dom.window.close();
    ({ dom, w } = mount({ seed: { palette: '' } }));
    assert.equal(w.document.documentElement.dataset.palette, undefined, '空串 = 明选素笺，盖过站点默认');
    dom.window.close();
    ({ dom, w } = mount({ seed: { palette: 'ziteng' } }));
    assert.equal(w.document.documentElement.dataset.palette, 'ziteng', '访客选择优先于站点默认');
    dom.window.close();
    ({ dom, w } = mount({ seed: { palette: '<script>' } }));
    assert.equal(w.document.documentElement.dataset.palette, 'qingci', '脏值回落站点默认');
    dom.window.close();
  } finally { setPaletteDefault(() => ''); }
});

// ———— 版式（纸面 / 素匣）——————————————
// 与配色同构：站主设默认、访客可覆盖，首帧由 THEME_BOOT 落位。区别是版式只有两态，
// 且「纸面」= 不挂属性（CSS 里用 html[data-layout="box"] 起头，少一层 :not）。

await test('版式清单与 CSS 对得上：素匣的每条规则都挂在 html[data-layout="box"] 下，且都排除首页', () => {
  assert.deepEqual(LAYOUTS.map((l) => l.key), ['paper', 'box'], '清单应恰好是纸面 + 素匣');
  // 两处主规则：匣子本体与列宽。少了任一条，要么没框、要么行长被压窄。
  assert.match(css, /html\[data-layout="box"\] body:not\(\[data-page="home"\]\) main#main \{/);
  assert.match(css, /html\[data-layout="box"\] body:not\(\[data-page="home"\]\) \.wrap \{/);
  // 刊头归零要覆盖三种 DOM 深度：列表页（main 的直接子级）、固定页（包在 .page 里）、
  // 文章页（article.post 里的 .post-mast）。只写第一种时，/about 比 /posts/ 低 54px、
  // 文章页低 40px —— 同一个匣子里三张卡片的第一行文字不在同一条水平线上。
  for (const sel of ['main#main > .mast', 'main#main > .page > .mast', 'main#main > article.post > .post-mast']) {
    assert.ok(css.includes(sel), `素匣缺少刊头归零选择器：${sel}`);
  }
  // 不变量：所有素匣规则都必须排除首页 —— 首页本来就是「标题 + 一只匣子」，再套一层就是匣中匣。
  const sels = [...css.matchAll(/html\[data-layout="box"\][^{]*\{/g)].map((m) => m[0]);
  assert.ok(sels.length >= 6, `素匣规则只有 ${sels.length} 条，像是被删过`);
  for (const sel of sels) {
    assert.ok(sel.includes('body:not([data-page="home"])'), `这条没排除首页：${sel.replace(/\s+/g, ' ')}`);
  }
  // CSS 里只认 box 这一个值；纸面是「不挂属性」，不该再出现 data-layout="paper"。
  const inCss = new Set([...css.matchAll(/data-layout="([a-z]+)"/g)].map((m) => m[1]));
  for (const key of inCss) assert.equal(key, 'box', `CSS 里出现了清单之外的版式：${key}`);
});

await test('站点默认版式：<html data-layout="box"> 直接挂在首帧；纸面不挂属性', () => {
  setLayoutDefault(() => 'box');
  try {
    assert.equal(layoutAttr(), ' data-layout="box"');
    assert.match(layout({ title: '测试', main: '<p>x</p>', canonical: '/posts/' }), /<html lang="[^"]+" data-layout="box">/);
    // 主题外壳走的是另一份（无引号写法，避免 Liquid 转义），两者必须同时挂上。
    assert.match(themeChrome({ page: 'posts' }).chrome.htmlAttrs, /data-layout=box/);
  } finally { setLayoutDefault(() => 'paper'); }
  assert.equal(layoutAttr(), '');
  assert.doesNotMatch(layout({ title: 't', main: '', canonical: '/' }), /<html[^>]*data-layout=/, '纸面时 <html> 不挂属性');
});

await test('THEME_BOOT 恢复版式：访客选过 > 站主默认；脏值不认', () => {
  assert.ok(THEME_BOOT.includes("localStorage.getItem('layout')"), 'THEME_BOOT 没读版式');
  setLayoutDefault(() => 'box');
  try {
    let { dom, w } = mount();
    assert.equal(w.document.documentElement.dataset.layout, 'box', '没选过 → 站主默认（素匣）');
    dom.window.close();
    ({ dom, w } = mount({ seed: { layout: 'paper' } }));
    assert.equal(w.document.documentElement.dataset.layout, undefined, '选过纸面 → 摘掉站主默认的素匣');
    dom.window.close();
    ({ dom, w } = mount({ seed: { layout: 'weird' } }));
    assert.equal(w.document.documentElement.dataset.layout, 'box', '脏值回落站主默认');
    dom.window.close();
  } finally { setLayoutDefault(() => 'paper'); }
  const { dom, w } = mount({ seed: { layout: 'box' } });
  try {
    assert.equal(w.document.documentElement.dataset.layout, 'box', '访客选的素匣要盖过默认纸面');
  } finally { dom.window.close(); }
});

await test('面板版式两格：首帧对齐、点素匣挂 data-layout 并落盘、点纸面摘属性但存下 paper', async () => {
  const { dom, w } = mount();
  try {
    const btn = (k) => pickerOf(w).querySelector(`.pal-ly[data-layout-opt="${k}"]`);
    assert.ok(btn('paper') && btn('box'), '面板里应有纸面 / 素匣两格');
    assert.equal(btn('paper').getAttribute('aria-pressed'), 'true', '默认选中纸面');
    assert.equal(btn('box').getAttribute('aria-pressed'), 'false');
    openPicker(w);
    btn('box').click();
    await sleep(0);
    assert.equal(w.document.documentElement.dataset.layout, 'box');
    assert.equal(w.localStorage.getItem('layout'), 'box', '要落盘，换页才不丢');
    assert.equal(btn('box').getAttribute('aria-pressed'), 'true');
    assert.equal(btn('paper').getAttribute('aria-pressed'), 'false');
    assert.equal(pickerOf(w).open, true, '换版式后面板不该自动收起');
    btn('paper').click();
    await sleep(0);
    assert.equal(w.document.documentElement.dataset.layout, undefined);
    assert.equal(w.localStorage.getItem('layout'), 'paper', '存 paper 而不是删 key —— 站主默认改成素匣后仍能选回纸面');
  } finally { dom.window.close(); }
});

await test('settings：默认版式只认 paper / box，脏值回落纸面，空值按纸面', () => {
  const repo = { store: new Map(), getSetting(k) { return this.store.get(k) ?? null; } };
  assert.equal(settings.layoutDefault(repo), 'paper', '没设过 → 纸面');
  assert.equal(parseLayoutDefault('box'), 'box');
  assert.equal(parseLayoutDefault(' BOX '), 'box', '大小写与首尾空白应归一');
  assert.equal(parseLayoutDefault(''), 'paper', '旧表单没这字段 → 纸面，不是篡改');
  assert.equal(parseLayoutDefault(undefined), 'paper');
  assert.equal(parseLayoutDefault('wide'), null, '白名单外一律 null');
  repo.store.set(KEYS.layoutDefault, 'wide');
  assert.equal(settings.layoutDefault(repo), 'paper', '库里脏值回落纸面');
});

await test('saveSettings：默认版式随站点设置一起存，脏值整单拒绝', () => {
  const saved = new Map();
  const err = saveSettings(
    { pageSize: '20', homeRecent: '10', commentsPerPage: '20', palette: '', layout: 'box' },
    (k, v) => saved.set(k, v),
  );
  assert.equal(err, null);
  assert.equal(saved.get(KEYS.layoutDefault), 'box');
  const bad = new Map();
  const err2 = saveSettings(
    { pageSize: '20', homeRecent: '10', commentsPerPage: '20', palette: '', layout: 'wide' },
    (k, v) => bad.set(k, v),
  );
  assert.ok(err2 && err2.includes('版式'), '脏 layout 要给出人话报错');
  assert.equal(bad.size, 0, '整单拒绝，一个字都不落库');
});

await test('后台「站点与阅读」有默认版式下拉，选项与清单一致且回填当前值', () => {
  const html = systemPage({
    site: { pageSize: 20, homeRecent: 10, commentsPerPage: 20, palette: '', layout: 'box' },
    hero: { images: [] }, mail: {}, history: {}, csrf: 'c',
  });
  const sel = /<select class="a-select" id="s-layout" name="layoutDefault">([\s\S]*?)<\/select>/.exec(html)?.[1] ?? '';
  assert.ok(sel, '后台没有默认版式下拉');
  assert.equal([...sel.matchAll(/value="(paper|box)"/g)].map((m) => m[1]).join(','), 'paper,box');
  assert.match(sel, /value="box" selected/, '当前值没回填');
  // 站主要求删掉那行说明（「只影响首页之外的页面…」），别再长回来
  assert.doesNotMatch(html, /只影响首页之外的页面/);
  assert.doesNotMatch(html, /a-field-note/);
});

// ———— 自定义配色（色相滑块）——————————————

await test('生成器：360 色相 × 三档浓度 × 明暗，五类对比度全部 ≥ 4.5:1', () => {
  const worst = {};
  const pairs = (t) => [
    ['accent/bg', t.accent, t.bg],
    ['accent/bg-elev', t.accent, t['bg-elev']],
    ['code-fg/code-bg', t['code-fg'], t['code-bg']],
    ...lib.TOKENS.filter((n) => n.startsWith('hl-')).map((n) => [`${n}/code-bg`, t[n], t['code-bg']]),
  ];
  for (const lv of lib.LEVEL_KEYS) {
    for (let hue = 0; hue < 360; hue++) {
      for (const dark of [false, true]) {
        const t = lib.tokensOf(hue, lv, dark);
        for (const [name, a, b] of pairs(t)) {
          const r = lib.contrast(a, b);
          if (!worst[name] || r < worst[name].r) worst[name] = { r, where: `${lv} H${hue} ${dark ? 'dark' : 'light'}` };
        }
      }
    }
  }
  assert.deepEqual(Object.keys(worst).length, 11, '扫描项数不对');
  for (const [name, v] of Object.entries(worst)) {
    assert.ok(v.r >= 4.5, `${name} 最低 ${v.r.toFixed(2)}:1 @ ${v.where}`);
  }
});

await test('生成器：三段结构与 css 预设那套同形（浅色 / 显式深色 / 系统深色，后两段逐字相同）', () => {
  const built = lib.customCss(210, 'mid');
  const blockOfBuilt = (sel) => {
    const at = built.indexOf(sel);
    assert.notEqual(at, -1, `生成的 CSS 缺 ${sel}`);
    const open = built.indexOf('{', at);
    return built.slice(open + 1, built.indexOf('}', open));
  };
  assert.match(built, /^html\[data-palette="custom"\]\{/);
  const explicit = blockOfBuilt('html[data-theme="dark"][data-palette="custom"]{');
  const media = blockOfBuilt('html:not([data-theme="light"]):not([data-theme="dark"])[data-palette="custom"]{');
  const norm = (s) => s.replace(/\s+/g, ' ').replace(/[{}]/g, ' ').trim();
  assert.equal(norm(explicit), norm(media), '两段深色守卫字面不一致');
  for (const name of lib.TOKENS) assert.ok(built.includes(`--${name}:`), `缺令牌 ${name}`);
  assert.ok(built.includes('--seed-h:210') && built.includes('--seed-lv:mid'), '种子没写进 CSS');
  assert.ok(built.includes('--seed-c:1.00') && built.includes('--seed-p:1.00') && built.includes('--seed-k:0.00'), '新种子没写进 CSS');
});

await test('生成器：浓度 / 纸色 / 深浅的边界组合仍守住 11 组对比度', () => {
  const chromas = [lib.CHROMA_RANGE.min, 0.85, 1, 1.15, lib.CHROMA_RANGE.max];
  const papers = [lib.PAPER_RANGE.min, 0.5, 1, lib.PAPER_RANGE.max];
  const worst = {};
  for (const chroma of chromas) {
    for (const paper of papers) {
      for (const ink of lib.INK_KEYS) {
        for (let hue = 0; hue < 360; hue += 5) {
          for (const dark of [false, true]) {
            const t = lib.tokensOf(hue, { chroma, paper, ink }, dark);
            const pairs = [
              ['accent/bg', t.accent, t.bg],
              ['accent/bg-elev', t.accent, t['bg-elev']],
              ['code-fg/code-bg', t['code-fg'], t['code-bg']],
              ...lib.TOKENS.filter((n) => n.startsWith('hl-')).map((n) => [`${n}/code-bg`, t[n], t['code-bg']]),
            ];
            for (const [name, a, b] of pairs) {
              const r = lib.contrast(a, b);
              if (!worst[name] || r < worst[name].r) {
                worst[name] = { r, where: `c${chroma} p${paper} k${ink} H${hue} ${dark ? 'dark' : 'light'}` };
              }
            }
          }
        }
      }
    }
  }
  assert.deepEqual(Object.keys(worst).length, 11, '扫描项数不对');
  for (const [name, v] of Object.entries(worst)) {
    assert.ok(v.r >= 4.5, `${name} 最低 ${v.r.toFixed(2)}:1 @ ${v.where}`);
  }
});

await test('生成器：新参数钳制与种子格式', () => {
  const clamped = lib.customCss(210, { chroma: 9, paper: -1, ink: 9 });
  assert.ok(clamped.includes('--seed-c:1.45'), '浓度上限没钳住');
  assert.ok(clamped.includes('--seed-p:0.00'), '纸色下限没钳住');
  assert.ok(clamped.includes('--seed-k:1.00'), '深浅上限没钳住');
  const fine = lib.customCss(210, { chroma: 1.2, paper: 0.5, ink: -1 });
  assert.ok(fine.includes('--seed-c:1.20') && fine.includes('--seed-p:0.50') && fine.includes('--seed-k:-1.00'), '合法种子没原样写入');
  assert.equal(lib.levelOfChroma(1.2), 'bold', '1.2 应归到最近的一档');
  const near = lib.hexToOklch('#2f5a86');
  assert.ok(near && Math.abs(near.H - 251) < 2 && near.C > 0.08, 'hex → OKLCH 取色结果不对');
});

await test('生成器输出全部通过 boot 的校验闸（放宽闸或改格式都会在这里炸）', () => {
  let longest = 0;
  for (const lv of lib.LEVEL_KEYS) {
    for (let hue = 0; hue < 360; hue += 7) {
      const built = lib.customCss(hue, lv);
      longest = Math.max(longest, built.length);
      assert.ok(PALETTE_CSS_GUARD.test(built), `boot 的闸拒绝了 H${hue}/${lv} 的产物`);
      assert.ok(!PALETTE_CSS_BANNED.test(built), `boot 的禁词撞上了 H${hue}/${lv} 的产物`);
      assert.equal(lib.sanitize(built), built, `sanitize() 与闸不一致：H${hue}/${lv}`);
    }
  }
  // 新种子含小数与负号：两条边界各扫一遍，确认闸没把它们当外挂。
  for (const opts of [
    { chroma: lib.CHROMA_RANGE.min, paper: lib.PAPER_RANGE.min, ink: -1 },
    { chroma: lib.CHROMA_RANGE.max, paper: lib.PAPER_RANGE.max, ink: 1 },
  ]) {
    for (let hue = 0; hue < 360; hue += 13) {
      const built = lib.customCss(hue, opts);
      longest = Math.max(longest, built.length);
      assert.ok(PALETTE_CSS_GUARD.test(built), `boot 的闸拒绝了自定义边界 H${hue}`);
      assert.ok(!PALETTE_CSS_BANNED.test(built), `boot 的禁词撞上了自定义边界 H${hue}`);
      assert.equal(lib.sanitize(built), built, `sanitize() 与闸不一致：自定义边界 H${hue}`);
    }
  }
  assert.ok(longest < 8000, `单段 CSS ${longest} 字节，超出闸的上限`);
});

await test('生成器：色相归一与非法档位兜底', () => {
  assert.equal(lib.customCss(360, 'mid'), lib.customCss(0, 'mid'), '360 应归一到 0');
  assert.equal(lib.customCss(-30, 'mid'), lib.customCss(330, 'mid'), '-30 应归一到 330');
  assert.ok(lib.customCss(721.6, 'mid').includes('--seed-h:2'), '721.6 应四舍五入归一到 2');
  assert.ok(lib.customCss(210, 'nope').includes('--seed-lv:mid'), '非法档位应回落 mid');
});

await test('清单里每套预设都带合法的 OKLCH 角度、档位与 chroma（滑块要从这里接上）', () => {
  for (const p of PALETTES) {
    assert.ok(Number.isInteger(p.hue) && p.hue >= 0 && p.hue < 360, `${p.key} 的 hue 不合法`);
    assert.ok(lib.LEVEL_KEYS.includes(p.level), `${p.key} 的 level 不合法`);
    assert.equal(p.chroma, lib.LEVELS[p.level], `${p.key} 的 chroma 与该档不一致`);
  }
});

await test('自定义：首帧注入那段 CSS，种子挂到 dataset 上，summary 显示「角度·浓度」', () => {
  const built = lib.customCss(210, 'mid');
  const { dom, w } = mount({ seed: { palette: 'custom', palCustom: built } });
  try {
    const el = w.document.documentElement;
    assert.equal(el.dataset.palette, 'custom', '自定义没生效');
    assert.equal(el.dataset.seedH, '210');
    assert.equal(el.dataset.seedLv, 'mid');
    assert.equal(Number(el.dataset.seedC), 1);
    assert.equal(Number(el.dataset.seedP), 1);
    const style = w.document.getElementById('palCustom');
    assert.ok(style, 'CSS 没注入');
    assert.equal(style.textContent, built);
    assert.equal(pressedOf(w), 'xuanzhi=false ∅=false qingci=false dailan=false qian=false ziteng=false', '自定义时预设都不该是选中态');
    assert.equal(pickedName(w), '210°·100%', '自定义没有色名，入口该显示「角度·浓度」');
  } finally { dom.window.close(); }
});

await test('自定义：浓淡 / 纸色能从首帧 CSS 回读到面板', () => {
  const built = lib.customCss(210, { chroma: 1.2, paper: 0.5 });
  const { dom, w } = mount({ seed: { palette: 'custom', palCustom: built } });
  try {
    const el = w.document.documentElement;
    const picker = pickerOf(w);
    assert.equal(Number(el.dataset.seedC), 1.2);
    assert.equal(Number(el.dataset.seedP), 0.5);
    assert.equal(pickedName(w), '210°·120%', 'summary 该用连续浓度');
    assert.equal(picker.querySelector('.pal-chroma').value, '1.2');
    assert.equal(picker.querySelector('.pal-paper').value, '0.5');
  } finally { dom.window.close(); }
});

await test('首次拖滑块时生成器还在加载：静默期到货后也要补同步', async () => {
  const { dom, w } = mount({ lazyPalette: true });
  try {
    const picker = pickerOf(w);
    openPicker(w);
    const input = picker.querySelector('.pal-hue');
    input.value = '300';
    input.dispatchEvent(new w.Event('input', { bubbles: true }));
    // 等 rAF 与 250ms 静默期都过去：两次 applyCustom 都只能排队，等生成器到货。
    await sleep(320);
    const loader = w.document.querySelector('script[src*="palette.js"]');
    assert.ok(loader, '没按需注入 palette.js');
    w.eval(paletteSource);
    loader.onload?.();
    await sleep(0);
    const el = w.document.documentElement;
    assert.equal(el.dataset.seedH, '300');
    assert.equal(pickedName(w), '300°·100%', '生成器到货后 summary 没跟上拖动的角度');
  } finally { dom.window.close(); }
});

await test('自定义：存的是脏 CSS 就整条丢掉，退化为站点默认（localStorage 访客可写）', () => {
  for (const evil of ['html{background:url(http://evil/x)}', '@import "x.css"', '</style><script>alert(1)</script>', 'a{color:red\\7b}', 'x'.repeat(9000)]) {
    const { dom, w } = mount({ seed: { palette: 'custom', palCustom: evil } });
    try {
      assert.equal(w.document.documentElement.dataset.palette, undefined, `脏值 ${evil.slice(0, 24)} 被当真了`);
      assert.equal(w.document.getElementById('palCustom'), null, '脏值也被注进了 <style>');
    } finally { dom.window.close(); }
  }
});

await test('拖滑块：立即换成自定义、实时改令牌、静默后落盘', async () => {
  const { dom, w } = mount({ seed: { palette: 'qingci' } });
  try {
    openPicker(w);
    const input = pickerOf(w).querySelector('.pal-hue');
    assert.equal(input.value, '168', '打开面板时滑块该停在青瓷的角度上');
    input.value = '300';
    input.dispatchEvent(new w.Event('input', { bubbles: true }));
    await sleep(60);
    const el = w.document.documentElement;
    assert.equal(el.dataset.palette, 'custom', '拖滑块没切到自定义');
    assert.equal(el.dataset.seedH, '300');
    assert.equal(Number(el.dataset.seedC), 1, '从预设进入自定义时浓淡该接住预设那一档');
    assert.equal(Number(el.dataset.seedP), 1);
    assert.equal(pickerOf(w).querySelector('.pal-hue-out').textContent, '300°');
    const style = w.document.getElementById('palCustom');
    assert.ok(style && style.textContent.includes('--seed-h:300'), 'CSS 没按新角度重算');
    assert.ok(style.textContent.includes('--seed-c:1.00'), 'CSS 没带上浓淡种子');
    // 落盘走 250ms 静默期（拖一次滑块不该往 localStorage 写几十遍），所以先等静默期过去。
    await sleep(300);
    assert.equal(w.localStorage.getItem('palette'), 'custom', '没记住选了自定义');
    assert.ok(w.localStorage.getItem('palCustom')?.includes('--seed-h:300'), '静默期过后没落盘');
  } finally { dom.window.close(); }
});

await test('拖浓淡滑块：连续值生效、落盘后回读', async () => {
  const { dom, w } = mount({ seed: { palette: 'custom', palCustom: lib.customCss(200, 'mid') } });
  try {
    openPicker(w);
    const input = pickerOf(w).querySelector('.pal-chroma');
    input.value = '1.42';
    input.dispatchEvent(new w.Event('input', { bubbles: true }));
    await sleep(60);
    const el = w.document.documentElement;
    assert.equal(Number(el.dataset.seedC), 1.42);
    assert.ok(w.document.getElementById('palCustom').textContent.includes('--seed-c:1.42'));
    assert.equal(pickerOf(w).querySelector('.pal-chroma-out').textContent, '142%');
    await sleep(300);
    assert.ok(w.localStorage.getItem('palCustom')?.includes('--seed-c:1.42'), '浓淡没落盘');
  } finally { dom.window.close(); }
});

await test('拖纸色滑块：0 = 中性纸，令牌与种子一起变', async () => {
  const { dom, w } = mount({ seed: { palette: 'custom', palCustom: lib.customCss(200, 'mid') } });
  try {
    openPicker(w);
    const input = pickerOf(w).querySelector('.pal-paper');
    input.value = '0';
    input.dispatchEvent(new w.Event('input', { bubbles: true }));
    await sleep(60);
    const el = w.document.documentElement;
    assert.equal(Number(el.dataset.seedP), 0);
    assert.ok(w.document.getElementById('palCustom').textContent.includes('--seed-p:0.00'));
    assert.equal(pickerOf(w).querySelector('.pal-paper-out').textContent, '无');
  } finally { dom.window.close(); }
});

await test('点预设：退出自定义（注入的 style 留着也不再生效），滑块回到那套的角度', async () => {
  const { dom, w } = mount({ seed: { palette: 'custom', palCustom: lib.customCss(200, 'bold') } });
  try {
    openPicker(w);
    pickerOf(w).querySelector('.pal-opt[data-palette="dailan"]').click();
    await sleep(0);
    const el = w.document.documentElement;
    assert.equal(el.dataset.palette, 'dailan');
    assert.equal(w.localStorage.getItem('palette'), 'dailan');
    assert.equal(el.dataset.seedH, undefined, 'dataset 上的种子该随自定义一起失效');
    assert.equal(el.dataset.seedLv, undefined);
    assert.equal(el.dataset.seedC, undefined);
    assert.equal(el.dataset.seedP, undefined);
    assert.equal(pickerOf(w).querySelector('.pal-hue').value, '252', '滑块该停在黛蓝的 OKLCH 角度上');
    assert.equal(pickedName(w), '黛蓝');
  } finally { dom.window.close(); }
});

await test('自定义与站点默认的优先级：没选过 → 站点默认；选了 custom → custom', () => {
  setPaletteDefault(() => 'qingci');
  try {
    let { dom, w } = mount();
    assert.equal(w.document.documentElement.dataset.palette, 'qingci', '没选过该用站点默认');
    dom.window.close();
    ({ dom, w } = mount({ seed: { palette: 'custom', palCustom: lib.customCss(30, 'mid') } }));
    assert.equal(w.document.documentElement.dataset.palette, 'custom', '访客自定义该盖过站点默认');
    dom.window.close();
  } finally { setPaletteDefault(() => ''); }
});

await test('站主不能把「自定义」设成站点默认（那份 CSS 只在每个访客自己的浏览器里）', () => {
  assert.equal(parsePaletteDefault('custom'), null, 'custom 不该进站主白名单');
  assert.equal(parsePaletteDefault(''), '', '空串仍是合法的素笺');
});

await test('打印：配色回退压得住注入的自定义（同权重靠源码顺序，必须 !important）', () => {
  const printBlock = /@media print \{\s*html\[data-palette\] \{([\s\S]*?)\n\s{2}\}/.exec(css);
  assert.ok(printBlock, '打印回退块不见了');
  for (const name of ['--bg', '--accent', '--gold', '--grain']) {
    assert.match(printBlock[1], new RegExp(`${name}: [^;]+ !important`), `${name} 没加 !important，自定义配色会被原样印出来`);
  }
});

process.exitCode = report();

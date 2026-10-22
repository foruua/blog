#!/usr/bin/env node
// UI 细节审计：对比度/横向溢出/点击目标/字号/图片尺寸。`npm run test:ui` 自建隔离实例（含后台），也是 `npm test` 最后一个套件。
// 隔离模式不碰真实数据（VACUUM INTO 快照 → 临时目录 → 临时口令 → 独立端口 → 用完删除）；缺 playwright/浏览器必须明确跳过，绝不假装通过。
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

export class AuditUnavailable extends Error {
  constructor(message, code) {
    super(message);
    this.name = 'AuditUnavailable';
    this.code = code;
  }
}

// 豁免清单：WCAG 不适用/豁免项，否则审计永远红。
const CONTRAST_EXEMPT = [
  ['.sep', '装饰性分隔符（不是正文）'],
  ['.is-off', '失效控件（WCAG 1.4.3 明确豁免）'],
];

const VIEWPORTS = [
  ['desktop', { width: 1280, height: 900 }],
  ['mobile', { width: 390, height: 844 }],
];

// 检索词取 sitemap 首篇标题头两字：结果/无结果是两套标记，只审空态等于没审。
async function searchWord(base) {
  try {
    const xml = await (await fetch(base + '/sitemap.xml')).text();
    const loc = (/<loc>([^<]*\/p\/[^<]+)<\/loc>/.exec(xml) ?? [])[1];
    if (!loc) return '';
    const html = await (await fetch(loc)).text();
    const title = (/<title>([^<]*)<\/title>/.exec(html) ?? [])[1] ?? '';
    const cjk = [...title].filter((c) => /[\u4e00-\u9fff]/.test(c)).slice(0, 2).join('');
    if (cjk) return cjk;
    return (/([A-Za-z]{4,})/.exec(title) ?? [])[1] ?? '';
  } catch { return ''; }
}

async function discoverPaths(base, only = null) {
  const front = ['/', '/posts/', '/notes/', '/archive/', '/friends/', '/links/', '/__audit-404'];
  try {
    const xml = await (await fetch(base + '/sitemap.xml')).text();
    const urls = [...xml.matchAll(/<loc>([^<]+)<\/loc>/g)].map((m) => new URL(m[1]).pathname);
    const post = urls.find((u) => u.startsWith('/p/'));
    const note = urls.find((u) => u.startsWith('/n/'));
    if (post) front.push(post);
    if (note) front.push(note);
    for (const url of urls) if (/^\/[^/]+\/?$/.test(url) && !front.includes(url)) front.push(url);
  } catch { }
  front.push('/search');
  const word = await searchWord(base);
  if (word) front.push(`/search?q=${encodeURIComponent(word)}`);
  const admin = ['/admin', '/admin/notes', '/admin/pages', '/admin/new', '/admin/comments', '/admin/media', '/admin/feeds', '/admin/links', '/admin/system'];
  const paths = [...front, ...admin];
  if (!only) return paths;
  return paths.filter((p) => (only === 'admin' ? p.startsWith('/admin') : !p.startsWith('/admin')));
}

export const PROBE = (options = {}) => {
  const { root = 'body', doc = true } = options ?? {};
  const scope = document.querySelector(root) ?? document.body;
  const cv = document.createElement('canvas').getContext('2d');
  const P = (raw) => {
    let c = String(raw);
    if (c.startsWith('color-mix')) { cv.fillStyle = 'rgba(0,0,0,0)'; cv.fillStyle = c; c = cv.fillStyle; }
    let m = /rgba?\(([\d.]+),\s*([\d.]+),\s*([\d.]+)(?:,\s*([\d.]+))?\)/.exec(c);
    if (m) return { r: +m[1], g: +m[2], b: +m[3], a: m[4] === undefined ? 1 : +m[4] };
    m = /^#([0-9a-f]{6})$/i.exec(c);
    if (m) { const n = parseInt(m[1], 16); return { r: (n >> 16) & 255, g: (n >> 8) & 255, b: n & 255, a: 1 }; }
    m = /color\(srgb\s+([\d.]+)\s+([\d.]+)\s+([\d.]+)(?:\s*\/\s*([\d.]+))?\)/.exec(c);
    if (m) return { r: +m[1] * 255, g: +m[2] * 255, b: +m[3] * 255, a: m[4] === undefined ? 1 : +m[4] };
    return null;
  };
  // 底色合成不能简写成 f*f.a+b*(1-f.a) 再硬写 a:1：祖先链上 b 常也半透明，会让 acc.a>=1 提前 break。
  const over = (f, b) => {
    const a = f.a + b.a * (1 - f.a);
    if (a <= 0) return { r: 0, g: 0, b: 0, a: 0 };
    return {
      r: (f.r * f.a + b.r * b.a * (1 - f.a)) / a,
      g: (f.g * f.a + b.g * b.a * (1 - f.a)) / a,
      b: (f.b * f.a + b.b * b.a * (1 - f.a)) / a,
      a,
    };
  };
  const topSplit = (str) => {
    const out = []; let depth = 0, cur = '';
    for (const ch of str) {
      if (ch === '(') depth++;
      else if (ch === ')') depth--;
      if (ch === ',' && depth === 0) { out.push(cur); cur = ''; continue; }
      cur += ch;
    }
    if (cur.trim()) out.push(cur);
    return out;
  };
  // 解析 linear-gradient 色标逐个算对比度取最差：文字色 vs 单一底色测不出渐变。
  const linearStops = (image) => {
    if (!image.startsWith('linear-gradient(')) return null;    const parts = topSplit(image.slice('linear-gradient('.length, -1));
    const stops = [];
    for (const raw of parts) {
      const part = raw.trim();
      if (!part) continue;
      if (/^to\s/.test(part) || /^[-+]?[\d.]+(deg|grad|rad|turn)$/.test(part)) continue;      const colorPart = part.replace(/\s+[-+]?[\d.]+%?$/, '').trim();      if (!colorPart) continue;
      cv.fillStyle = 'rgba(0,0,0,0)'; cv.fillStyle = colorPart;
      const c = P(cv.fillStyle) ?? P(colorPart);
      if (c && c.a > 0) stops.push(c);
    }
    return stops.length ? stops : null;
  };
  const bgCandidates = (el) => {
    const fallback = P(getComputedStyle(document.documentElement).backgroundColor) ?? { r: 255, g: 255, b: 255, a: 1 };
    let cur = el, acc = null, grad = null, unmeasurable = false, guard = 0;
    while (cur && guard++ < 40) {
      const cs = getComputedStyle(cur);
      const img = cs.backgroundImage;
      if (img && img !== 'none' && !grad && !unmeasurable) {
        const stops = linearStops(img);
        if (stops) grad = stops;
        else unmeasurable = true;      }
      const c = P(cs.backgroundColor);
      if (c && c.a > 0) acc = acc ? over(acc, c) : c;
      if (acc && acc.a >= 1) break;
      cur = cur.parentElement;
    }
    const base = acc && acc.a >= 1 ? acc : over(acc ?? { ...fallback, a: 0 }, fallback);
    if (grad) return { list: grad.map((s) => over(s, base)), gradient: true, unmeasurable: false };
    return { list: [base], gradient: unmeasurable, unmeasurable };
  };
  const lum = ({ r, g, b }) => { const f = (v) => { v /= 255; return v <= .03928 ? v / 12.92 : ((v + .055) / 1.055) ** 2.4; }; return .2126 * f(r) + .7152 * f(g) + .0722 * f(b); };
  const ratio = (a, b) => { const [x, y] = [lum(a), lum(b)].sort((p, q) => q - p); return (x + .05) / (y + .05); };
  // 收起的 <details> 仍有盒子（content-visibility:hidden 只挡绘制），比高度/命中区会误报；除自己的 <summary> 外都当不可见。
  const inClosedDetails = (el) => {
    const det = el.closest('details');
    if (!det || det.open) return false;
    const sum = [...det.children].find((c) => c.tagName === 'SUMMARY');
    return !(sum && sum.contains(el));
  };
  const visible = (el) => { const cs = getComputedStyle(el); if (cs.display === 'none' || cs.visibility === 'hidden' || +cs.opacity === 0) return false; if (inClosedDetails(el)) return false; const r = el.getBoundingClientRect(); return r.width > 0 && r.height > 0; };
  const ownText = (el) => [...el.childNodes].some((n) => n.nodeType === 3 && n.textContent.trim() !== '');
  const skippedBaseline = (el) => Boolean(el.closest('[data-audit-skip-align]'));
  const label = (el) => {
    const cls = typeof el.className === 'string' && el.className.trim() ? '.' + el.className.trim().split(/\s+/).slice(0, 2).join('.') : '';
    return el.tagName.toLowerCase() + cls;
  };
  // 句内内联链接：WCAG 2.5.8 豁免尺寸要求，只看有无非空文本。
  const isInlineLink = (el) => {
    const p = el.parentElement;
    return Boolean(p) && [...p.childNodes].some((n) => n.nodeType === 3 && n.textContent.trim() !== '');
  };

  const out = { contrast: [], small: [], tiny: [], noDim: [], noAlt: [], baseline: [], rows: [], overflow: null };
  // 小字混不同字体时容器 center/stretch 会让基线差 1px 像没对齐；真实基线用零尺寸 inline-block 探针量。
  const baselineOf = (el) => {
    const probe = document.createElement('span');
    probe.style.cssText = 'display:inline-block;width:0;height:0';
    el.prepend(probe);
    const y = probe.getBoundingClientRect().bottom;
    probe.remove();
    return +y.toFixed(2);
  };
  for (const el of scope.querySelectorAll('*')) {
    if (!visible(el) || skippedBaseline(el)) continue;
    const cs = getComputedStyle(el);
    if (!/^(inline-)?flex$/.test(cs.display)) continue;
    const kids = [...el.children].filter((k) => visible(k) && k.textContent.trim() !== '');
    if (kids.length < 2 || kids.length > 8) continue;
    if (kids.some((k) => k.querySelector('img,svg,canvas,video,input,select,textarea'))) continue;
    if (kids.some((k) => k.matches('button,[role="button"],[class*="btn"]') || k.querySelector('button,[class*="btn"]'))) continue;
    let maxFs = 0;
    for (const k of kids) {
      maxFs = Math.max(maxFs, parseFloat(getComputedStyle(k).fontSize),
        ...[...k.querySelectorAll('*')].map((d) => parseFloat(getComputedStyle(d).fontSize)));
    }
    if (maxFs > 15) continue;
    const lines = [];
    for (const kid of kids) {
      const rect = kid.getBoundingClientRect();
      const line = lines.find((row) => Math.min(row.bottom, rect.bottom) - Math.max(row.top, rect.top) > .5);
      if (line) {
        line.top = Math.max(line.top, rect.top); line.bottom = Math.min(line.bottom, rect.bottom);
        line.kids.push(kid);
      } else lines.push({ top: rect.top, bottom: rect.bottom, kids: [kid] });
    }
    for (const line of lines) {
      if (line.kids.length < 2) continue;
      const ys = line.kids.map(baselineOf);
      const skew = Math.max(...ys) - Math.min(...ys);
      if (skew > 0.75) out.baseline.push({ sel: label(el), align: cs.alignItems, skew: +skew.toFixed(2), fs: +maxFs.toFixed(1), text: line.kids.map((k) => k.textContent.trim().slice(0, 14)).join(' | ') });
    }
  }
  for (const el of scope.querySelectorAll('*')) {
    if (!visible(el)) continue;
    const cs = getComputedStyle(el);
    if (ownText(el)) {
      const fs = parseFloat(cs.fontSize);
      const need = (fs >= 24 || (fs >= 18.66 && +cs.fontWeight >= 700)) ? 3 : 4.5;
      const fg = P(cs.color), cand = bgCandidates(el);
      if (fg && cand.list.length) {
        const ratios = cand.list.map((b) => ratio(fg, b));
        const worst = Math.min(...ratios);
        const wb = cand.list[ratios.indexOf(worst)];
        if (worst < need) out.contrast.push({ sel: label(el), r: +worst.toFixed(2), need, fs: +fs.toFixed(1), text: el.textContent.trim().slice(0, 24), color: cs.color, bg: `rgb(${Math.round(wb.r)}, ${Math.round(wb.g)}, ${Math.round(wb.b)})`, gradient: cand.gradient, unmeasurable: cand.unmeasurable });
      }
      if (fs < 10) out.tiny.push({ sel: label(el), fs: +fs.toFixed(1), text: el.textContent.trim().slice(0, 18) });
    }
    if (el.tagName === 'IMG') {
      // CLS 只看 aspect-ratio（getComputedStyle().width 对图片返回已用宽度），有就不缺属性。
      const hasAttrs = el.getAttribute('width') && el.getAttribute('height');
      if (!hasAttrs && cs.aspectRatio === 'auto') out.noDim.push({ sel: label(el), src: (el.getAttribute('src') ?? '').slice(0, 44) });
      if (!el.hasAttribute('alt')) out.noAlt.push({ sel: label(el), src: (el.getAttribute('src') ?? '').slice(0, 44) });
    }
    if (['A', 'BUTTON', 'SELECT', 'INPUT', 'SUMMARY'].includes(el.tagName) && el.type !== 'hidden' && !el.closest('.c-hp')) {
      // 复选框/单选框的命中区是整个 label，不该量控件本身
      const box = (el.type === 'checkbox' || el.type === 'radio') && el.closest('label') ? el.closest('label') : el;
      const r = box.getBoundingClientRect();
      if (r.height < 24 && !isInlineLink(el)) {
        out.small.push({ sel: label(el), w: Math.round(r.width), h: +r.height.toFixed(1), text: (el.textContent || el.value || '').trim().slice(0, 16) });
      }
    }
  }
  // 同行盒子控件必须等高（只比真控件与 .a-btn 系列）。
  {
    const boxy = '.a-btn, .a-btn-ghost, .a-btn-danger, .a-pager-btn';
    const controls = [...scope.querySelectorAll(`button, input:not([type="hidden"]), select, textarea, ${boxy}`)]
      .filter((el) => visible(el) && el.getBoundingClientRect().height > 0)
      .filter((el) => !/a-hero-x|lb-close|lb-nav|a-modal/.test(String(el.className)))
      // 蜜罐：.c-hp 靠 left:-9999px 挪出屏幕，abspos+top:auto 的顶边会随机落进某行误报。
      .filter((el) => !el.closest('.c-hp'));
    // 已知盲区：align-items:center 时高度不同的两控件顶边被推开而量不到；先不动。
    // 先在层内分组：打开的 <dialog> 是浮层，混着比会拿弹窗关闭键投诉页面输入框不等高。
    const layers = new Map();
    for (const el of controls) {
      const key = el.closest('dialog[open]') ?? document.body;
      if (!layers.has(key)) layers.set(key, []);
      layers.get(key).push(el);
    }
    // 同一水平带≠同一行：后台两栏时侧栏 margin-top:auto 的按钮会与主区末行顶边撞上（差 0.6px 却横隔 800px）；按水平空隙 > RUN_GAP 切段。
    const RUN_GAP = 64;
    for (const group of layers.values()) {
      const lines = [];
      for (const el of group.sort((a, b) => a.getBoundingClientRect().top - b.getBoundingClientRect().top)) {
        const r = el.getBoundingClientRect();
        const line = lines.find((l) => Math.abs(l.top - r.top) <= 3);
        if (line) line.items.push(el); else lines.push({ top: r.top, items: [el] });
      }
      for (const line of lines) {
        const runs = [];
        const byLeft = line.items.map((el) => ({ el, r: el.getBoundingClientRect() }))
          .sort((a, b) => a.r.left - b.r.left);
        for (const { el, r } of byLeft) {
          const run = runs[runs.length - 1];
          if (run && r.left - run.right <= RUN_GAP) { run.items.push(el); run.right = Math.max(run.right, r.right); }
          else runs.push({ items: [el], right: r.right });
        }
        for (const run of runs) {
          if (run.items.length < 2) continue;
          const hs = run.items.map((el) => +el.getBoundingClientRect().height.toFixed(1));
          const spread = Math.max(...hs) - Math.min(...hs);
          if (spread > 2) {
            out.rows.push({
              sel: run.items.map((el) => label(el)).join(' + '),
              detail: `高度 ${hs.join(' / ')}（差 ${spread.toFixed(1)}px）`,
              text: run.items.map((el) => (el.textContent || el.value || el.getAttribute('placeholder') || '').trim().slice(0, 12)).join(' | '),
            });
          }
        }
      }
    }
  }

  out.overflow = doc && document.documentElement.scrollWidth > window.innerWidth + 1
    ? { scrollW: document.documentElement.scrollWidth, inner: window.innerWidth } : null;

  // 关着的弹窗必须连盒子都不占：作者写 display:flex 会压掉 UA 的 dialog:not([open]){display:none}，只查 open 属性抓不到。
  out.strayDialogs = !doc ? [] : [...document.querySelectorAll('dialog:not([open])')]
    .filter(visible)
    .map((el) => ({ sel: label(el), text: (el.textContent || '').trim().slice(0, 16) }));
  // 同一个坑的 <details> 版：浮层面板（页头二级菜单、配色面板）是 position:absolute，包含块在 details 之外，
  // 于是 UA 那条「收起的 <details> 跳过内容」只管住绘制、没管住布局 —— 关着的面板照旧被排一遍，还会把文档撑出滚动溢出。
  out.strayOverlays = !doc ? [] : [...document.querySelectorAll('details:not([open]) .nsub-panel, details:not([open]) .pal-panel')]
    .filter(visible)
    .map((el) => ({ sel: label(el), text: (el.textContent || '').trim().slice(0, 16) }));
  return out;
};

const exempted = (sel, rule) => rule.find(([s]) => sel.includes(s))?.[1] ?? null;

// 抽屉互斥展开，逐个打开立即采样，不能先点完再只量最后一个。
async function inspectNoteDrawers(page) {
  const samples = [await page.evaluate(PROBE)];
  const buttons = page.locator('[data-comments]');
  for (let i = 0; i < await buttons.count(); i++) {
    const btn = buttons.nth(i);
    // 每行折叠行也挂评论抽屉，按钮收在面板里看不见 —— 先展开所在行再点。
    if (!(await btn.isVisible())) {
      await btn.evaluate((el) => { el.closest('details')?.setAttribute('open', ''); });
      await page.waitForTimeout(140);
    }
    await btn.click();
    await page.waitForTimeout(80);
    samples.push(await page.evaluate(PROBE));
  }
  return samples;
}

// 窄屏导航抽屉关着时 .mnav{display:none}，不掀开就等于没审；宽屏无此按钮（.navbtn 只在 ≤620px）→ 返回 null。
async function inspectMobileDrawer(page) {
  const button = page.locator('header.site .navbtn');
  if (!(await button.isVisible().catch(() => false))) return null;
  await button.click();
  await page.waitForTimeout(340);  // 只量面板：底下页面刚量过，再量一遍会重复记问题。
  const sample = await page.evaluate(PROBE, { root: '.mnav-panel', doc: false });
  await page.keyboard.press('Escape');
  await page.waitForTimeout(60);
  return sample;
}

// 悬停/键盘聚焦态是看不清字高发处，默认态采样看不到：用 CDP forcePseudoState 强制一批 :hover 再跑同一探针。测完必须逐节点清掉（伪类残留会量到假悬停态）；只取对比度。
const HOVER_SELECTOR = 'a[href], button, summary, [role="button"], input, select, textarea';
async function inspectHover(page) {
  const cdp = await page.context().newCDPSession(page).catch(() => null);
  if (!cdp) return [];
  try {
    await cdp.send('DOM.enable'); await cdp.send('CSS.enable');
    const { root } = await cdp.send('DOM.getDocument', { depth: -1 });
    const { nodeIds } = await cdp.send('DOM.querySelectorAll', { nodeId: root.nodeId, selector: HOVER_SELECTOR });
    for (const nodeId of nodeIds) await cdp.send('CSS.forcePseudoState', { nodeId, forcedPseudoClasses: ['hover'] });
    const sample = await page.evaluate(PROBE);
    for (const nodeId of nodeIds) await cdp.send('CSS.forcePseudoState', { nodeId, forcedPseudoClasses: [] });
    return sample.contrast;
  } catch { return []; } finally { await cdp.detach().catch(() => {}); }
}

// 正文目录 <details> 默认收着，注意收起的内容照样量得到（::details-content 挂 content-visibility:hidden，不绘制但布局在）；掀开是为展开态，两态都得站得住。
async function inspectPostPage(page) {
  const samples = [await page.evaluate(PROBE)];
  const opened = await page.evaluate(() => {
    const tocs = [...document.querySelectorAll('details.toc')];
    tocs.forEach((d) => { d.open = true; });
    return tocs.length;
  });
  if (!opened) return samples;
  await page.waitForTimeout(60);
  samples.push(await page.evaluate(PROBE));
  return samples;
}

async function inspectMediaDialog(page) {
  const samples = [await page.evaluate(PROBE)];
  const link = page.locator('.a-media-reference[data-media-details]').first();
  if (await link.count()) {
    await link.click();
    await page.locator('.a-media-dialog[open] .a-media-detail').waitFor();
    samples.push(await page.evaluate(PROBE));
    await page.locator('[data-media-close]').click();
  }
  return samples;
}

// 弹窗：没打开的 <dialog> 不渲染，关着就等于没审；造最长片段拦住片段端点喂进去走 admin.js 真正替换路径（片段用站里同一模板渲染）。
let importBlockFn = null;
async function loadImportBlock() {
  if (!importBlockFn) ({ importBlock: importBlockFn } = await import(new URL('../src/admin/views/feeds.js', import.meta.url)));
  return importBlockFn;
}

async function inspectImportDialog(page, importBlock) {
  const samples = [await page.evaluate(PROBE)];
  const dialog = page.locator('#a-import-dialog');
  if (!(await dialog.count())) return samples;
  const fake = importBlock({
    pendingLinks: 4,
    importReport: {
      running: false, total: 9, completed: 9,
      results: [
        { host: 'moyu.blog', state: 'failed', detail: '这是一个网页，页面里也没有找到 RSS/Atom 订阅地址' },
        { host: 'bufanz.com', state: 'failed', detail: '抓取超时（8 秒没有响应）' },
        { host: 'xiang.dev', state: 'added', detail: '已订阅 · 收录 12 篇' },
        { host: 'pwsz.com', state: 'skipped', detail: '已经订阅' },
      ],
    },
  });
  await page.route('**/admin/feeds/subscribe-report', (route) => route.fulfill({
    status: 200, contentType: 'text/html; charset=utf-8', headers: { 'Cache-Control': 'no-store' }, body: fake,
  }));
  await page.evaluate(() => document.getElementById('a-import-dialog').showModal());
  await dialog.locator('.a-import-row').first().waitFor();
  samples.push(await page.evaluate(PROBE));
  await page.locator('[data-import-close]').first().click();
  await page.unroute('**/admin/feeds/subscribe-report');
  return samples;
}

async function collectOne(browser, base, password, { group, tag = '', scheme, vpName, viewport, urls }) {
  const findings = [];
  let pagesAudited = 0;
  const failed = new Set();
  const ctx = await browser.newContext({ viewport, colorScheme: scheme });
  try {
    const page = await ctx.newPage();
    if (group === '后台') {
      await page.goto(base + '/admin/login', { waitUntil: 'networkidle' });
      await page.fill('input[name=password]', password);
      await Promise.all([page.waitForNavigation({ waitUntil: 'networkidle' }), page.click('button[type=submit]')]);
    }
    const targets = [...urls];
    for (const p of targets) {
      const where = `${group}${tag ? `·${tag}` : ''}/${scheme}/${vpName} ${p}`;
      let res;
      try { res = await page.goto(base + p, { waitUntil: 'networkidle' }); }
      catch (e) {
        // 打不开的页面必须算失败：以前直接 continue，审计会报全部通过，而那一页一次都没量过。
        findings.push({ where, kind: '页面无法加载', fail: true, detail: String((e && e.message) || e) });
        failed.add(where);
        continue;
      }
      const expected = p === '/__audit-404' ? 404 : 200;
      if (res.status() !== expected) {
        findings.push({ where, kind: '页面状态错误', fail: true, detail: `HTTP ${res.status()}，预期 ${expected}` });
        failed.add(where);
        continue;
      }
      if (p === '/admin/media') {
        const detail = await page.locator('a[href^="/admin/media/"]').evaluateAll((links) =>
          links.map((a) => a.getAttribute('href')).find((href) => /^\/admin\/media\/\d+$/.test(href)));
        if (detail) for (const url of [detail, detail.replace('/media/', '/media/delete/')]) {
          if (!targets.includes(url)) targets.push(url);
        }
      }
      await page.addStyleTag({ content: 'html{scroll-behavior:auto!important}*,*::before,*::after{transition:none!important;animation:none!important}[data-reveal]{opacity:1!important;transform:none!important}' });
      const samples = p === '/notes/' ? await inspectNoteDrawers(page)
        : p === '/admin/media' ? await inspectMediaDialog(page)
        : p === '/admin/feeds' ? await inspectImportDialog(page, await loadImportBlock())
        : p.startsWith('/p/') || p.startsWith('/n/') ? await inspectPostPage(page) : [await page.evaluate(PROBE)];
      const drawerSample = await inspectMobileDrawer(page);
      if (drawerSample) samples.push(drawerSample);
      const r = Object.fromEntries(['contrast', 'small', 'tiny', 'noDim', 'noAlt', 'baseline', 'rows', 'strayDialogs', 'strayOverlays']
        .map((key) => [key, samples.flatMap((sample) => sample[key])]));
      r.overflow = samples.find((sample) => sample.overflow)?.overflow;
      r.hoverContrast = await inspectHover(page);
      pagesAudited++;
      const push = (f) => { findings.push({ where, ...f }); if (f.fail) failed.add(where); };
      for (const c of r.contrast) {
        if (exempted(c.sel, CONTRAST_EXEMPT)) continue;
        // 渐变已按最差色标真实测量，照常判定；只有径向/锥形/多层才降级为需人工确认。
        push({ kind: '对比度', fail: !c.unmeasurable, ...c });
      }
      for (const c of r.hoverContrast) {
        if (exempted(c.sel, CONTRAST_EXEMPT)) continue;
        push({ kind: '对比度', fail: !c.unmeasurable, ...c, where: `${where}·hover` });
      }
      for (const t of r.small) push({ kind: '点击目标', fail: true, ...t });
      for (const t of r.tiny) push({ kind: '字号', fail: false, ...t });
      for (const d of r.noDim) push({ kind: '图片缺尺寸', fail: false, ...d });
      for (const a of r.noAlt) push({ kind: '图片缺 alt', fail: true, ...a });
      for (const b of r.baseline) push({ kind: '基线不齐', fail: true, ...b });
      for (const row of r.rows) push({ kind: '控件高度不齐', fail: true, ...row });
      for (const d of r.strayDialogs) push({ kind: '弹窗未打开却可见', fail: true, ...d });
      for (const o of r.strayOverlays) push({ kind: '浮层未打开却占盒子', fail: true, ...o });
      if (r.overflow) push({ kind: '横向溢出', fail: true, ...r.overflow });
    }
  } finally { await ctx.close(); }
  return { findings, pagesAudited, pagesWithFailures: failed.size };
}

async function collect(browser, base, paths, password, viewports) {
  const tasks = [];
  for (const [group, scheme] of [['前台', 'light'], ['前台', 'dark'], ['后台', 'light'], ['后台', 'dark']]) {
    const urls = paths.filter((p) => (group === '后台') === p.startsWith('/admin'));
    if (!urls.length) continue;
    if (group === '后台' && !password) continue;
    for (const [vpName, viewport] of viewports) tasks.push({ group, scheme, vpName, viewport, urls });
  }
  const all = await Promise.all(tasks.map((t) => collectOne(browser, base, password, t)));
  return {
    findings: all.flatMap((p) => p.findings),
    pagesAudited: all.reduce((n, p) => n + p.pagesAudited, 0),
    pagesWithFailures: all.reduce((n, p) => n + p.pagesWithFailures, 0),
  };
}

function dedupe(findings) {
  const uniq = new Map();
  for (const f of findings) {
    const key = [f.kind, f.sel, f.r ?? `${f.w}×${f.h}`, f.text ?? f.src ?? ''].join('|');
    if (!uniq.has(key)) uniq.set(key, { ...f, pages: 1 });
    else uniq.get(key).pages++;
  }
  const order = { 对比度: 0, 横向溢出: 1, 点击目标: 2, '控件高度不齐': 3, '弹窗未打开却可见': 4, '浮层未打开却占盒子': 4, '图片缺 alt': 5, '图片缺尺寸': 6, 字号: 7 };
  return [...uniq.values()].sort((a, b) => (order[a.kind] - order[b.kind]) || ((a.r ?? 0) - (b.r ?? 0)));
}

export function formatFinding(f) {
  const tag = f.fail ? '✗' : '·';
  if (f.kind === '对比度') {
    return `${tag} 对比度 ${String(f.r).padStart(5)}（需 ${f.need}） ${String(f.fs)}px  ${f.sel}  “${f.text}”  ${f.color} on ${f.bg}   ${f.where}  ×${f.pages}${f.gradient && f.unmeasurable ? '  [渐变背景，需人工确认]' : ''}`;
  }
  if (f.kind === '横向溢出') return `${tag} 横向溢出 ${f.scrollW} > ${f.inner}  ${f.where}`;
  if (f.kind === '点击目标') return `${tag} 点击目标 ${f.w}×${f.h}（需 ≥24 高） ${f.sel} “${f.text}”  ${f.where}  ×${f.pages}`;
  if (f.kind === '控件高度不齐') return `${tag} 同行控件不等高 ${f.sel} ${f.detail} “${f.text}”  ${f.where}  ×${f.pages}`;
  if (f.kind === '弹窗未打开却可见') return `${tag} 弹窗未打开却可见 ${f.sel} “${f.text}” —— 作者样式压过了 dialog:not([open]) 的 display:none  ${f.where}  ×${f.pages}`;
  if (f.kind === '浮层未打开却占盒子') return `${tag} 浮层未打开却占盒子 ${f.sel} “${f.text}” —— 收起的 <details> 里那层绝对定位面板仍在被布局，补 \`details:not([open]) <panel> { display: none }\`  ${f.where}  ×${f.pages}`;
  return `${tag} ${f.kind} ${f.sel} ${f.text ?? f.src}  ${f.where}  ×${f.pages}`;
}

async function loadChromium(injected) {
  if (injected) return injected;
  try { return (await import('playwright')).chromium; }
  catch {
    throw new AuditUnavailable('未安装 playwright。装上即可纳入：npm i -D playwright && npx playwright install chromium', 'NO_PLAYWRIGHT');
  }
}

export async function auditUi({ base, password = '', chromium, quiet = false, only = null, json = null, report = false } = {}) {
  const browserType = await loadChromium(chromium);
  const paths = await discoverPaths(base, only);
  let browser;
  try { browser = await browserType.launch(); }
  catch (e) {
    throw new AuditUnavailable(`浏览器不可用（${String(e.message).split('\n')[0]}）。装一次：npx playwright install chromium`, 'NO_BROWSER');
  }
  let raw;
  try { raw = await collect(browser, base, paths, password, VIEWPORTS); }
  finally { await browser.close(); }

  const findings = dedupe(raw.findings);
  const failures = findings.filter((f) => f.fail).length;
  const hints = findings.length - failures;
  if (json) fs.writeFileSync(json, JSON.stringify({ base, paths, findings }, null, 1));

  if (report && !quiet) {
    console.log(`审计范围：${paths.length} 个路径 × 明暗 × 桌面/移动${password ? '（含后台）' : '（未提供后台口令，已跳过后台）'}`);
    if (!password) console.log('  要看后台：npm run test:ui（自建隔离实例，不需要你的密码）');
    console.log('');
    if (!findings.length) console.log('✓ 没有发现问题');
    for (const f of findings) console.log(formatFinding(f));
    console.log(`\n合计：${failures} 类问题需处理，${hints} 类提示`);
  }
  return { base, paths, findings, failures, hints, pagesAudited: raw.pagesAudited, pagesWithFailures: raw.pagesWithFailures };
}

export async function startIsolated() {
  const work = fs.mkdtempSync(path.join(os.tmpdir(), 'ui-audit-'));
  const dirs = { data: path.join(work, 'data'), content: path.join(work, 'content'), uploads: path.join(work, 'uploads'), themes: path.join(work, 'themes') };
  for (const d of Object.values(dirs)) fs.mkdirSync(d, { recursive: true });

  const srcDb = process.env.DB_FILE ?? path.join(ROOT, 'data', 'blog.db');
  const { DatabaseSync } = await import('node:sqlite');
  const snap = new DatabaseSync(srcDb, { readOnly: true });
  try { snap.exec(`VACUUM INTO '${path.join(dirs.data, 'blog.db').replace(/'/g, "''")}'`); } finally { snap.close(); }

  // 复制内容与附件：子进程会拿维护锁，指向真实目录会和正在跑的服务抢锁。
  // 同一文件系统优先硬链接（不复制几百 MB 字节），跨设备/权限不允许时退回 copyFile。
  const copy = (from, to) => {
    if (!fs.existsSync(from)) return;
    const walk = (src, dest) => {
      const stat = fs.lstatSync(src);
      if (stat.isSymbolicLink()) { fs.symlinkSync(fs.readlinkSync(src), dest); return; }
      if (stat.isDirectory()) {
        fs.mkdirSync(dest, { recursive: true });
        for (const name of fs.readdirSync(src)) walk(path.join(src, name), path.join(dest, name));
        return;
      }
      try { fs.linkSync(src, dest); }
      catch { fs.copyFileSync(src, dest); }
    };
    walk(from, to);
  };
  copy(process.env.CONTENT_DIR ?? path.join(ROOT, 'content'), dirs.content);
  copy(process.env.UPLOADS_DIR ?? path.join(ROOT, 'data', 'uploads'), dirs.uploads);
  // 主题也要隔离：否则会读/清理真实 themes/，自定义主题还会让审计结果随本机安装漂移。
  copy(process.env.THEMES_DIR ?? path.join(ROOT, 'themes'), dirs.themes);

  const password = `ui-audit-${crypto.randomBytes(9).toString('base64url')}`;
  const dbFile = path.join(dirs.data, 'blog.db');

  // 防呆：绝不往临时目录之外写。坑：曾用 srv.dbFile（isolateDb:false 时即真实库）把临时口令写进真实库、覆盖使用者后台密码。
  const guard = (target) => {
    const abs = path.resolve(target);
    if (abs !== path.resolve(dbFile) || !abs.startsWith(path.resolve(work) + path.sep)) {
      throw new Error(`拒绝写入：${abs} 不在临时目录内`);
    }
    return abs;
  };

  const { startServer } = await import('./_server.mjs');
  const srv = await startServer({
    isolateDb: false,    env: {
      DATA_DIR: dirs.data, DB_FILE: dbFile,
      CONTENT_DIR: dirs.content, UPLOADS_DIR: dirs.uploads, THEMES_DIR: dirs.themes,
      SITE_DOMAIN: process.env.SITE_DOMAIN ?? 'example.invalid', NODE_ENV: 'production',
      // 快照含真实站点友链/订阅记录；审计只量 UI，关掉抓取、探活、头像回源与自动备份。
      LINK_CHECK_MS: '0', FEED_REFRESH_MS: '0', AVATAR_UPSTREAMS: '',
      BACKUP_ON_PUBLISH: 'false', BACKUP_REMOTE: '', BACKUP_HOOK: '', WATCHDOG_INTERVAL_MS: '0',
    },
  });
  const { hashPassword } = await import('../src/admin/auth.js');
  const db = new DatabaseSync(guard(dbFile));
  try {
    db.prepare(`INSERT INTO settings(key,value) VALUES('admin_password_hash',?)
      ON CONFLICT(key) DO UPDATE SET value=excluded.value`).run(hashPassword(password));
  } finally { db.close(); }

  return {
    base: srv.base,
    password,
    // 快照库绝对路径只在临时目录里（stop() 连目录一起删）
    dbFile,
    async stop() { await srv.stop(); fs.rmSync(work, { recursive: true, force: true }); },
  };
}

const isCli = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isCli) {
  const argv = process.argv.slice(2);
  const opt = (flag, fallback = null) => {
    const i = argv.indexOf(flag);
    return i >= 0 && argv[i + 1] && !argv[i + 1].startsWith('--') ? argv[i + 1] : fallback;
  };
  const has = (flag) => argv.includes(flag);
  const ISOLATE = has('--isolate');
  // `--only bogus` 以前会静默落进只审前台分支：拼错参数反而审得更少、还报通过。
  const ONLY = opt('--only');
  if (ONLY !== null && !['front', 'admin'].includes(ONLY)) {
    console.error(`✗ --only 只接受 front 或 admin，收到：${ONLY}`);
    process.exit(2);
  }

  let instance = null;
  try {
    let base = (opt('--base') ?? '').replace(/\/$/, '');
    let password = opt('--admin-password') ?? process.env.UI_AUDIT_PASSWORD ?? '';
    if (ISOLATE) {
      instance = await startIsolated();
      base = instance.base;
      password = instance.password;
      if (!has('--quiet')) console.log(`隔离实例已启动：${base}（快照自 ${process.env.DB_FILE ?? 'data/blog.db'}，临时口令，用完即删）\n`);
    } else if (!base) {
      base = `http://127.0.0.1:${process.env.PORT ?? 8787}`;
    }
    const res = await auditUi({
      base, password,
      quiet: has('--quiet'), only: ONLY,
      json: opt('--json'), report: true,
    });
    process.exitCode = res.failures ? 1 : 0;
  } catch (e) {
    if (e instanceof AuditUnavailable) {
      console.error(`${e.message}\n`);
      process.exitCode = 2;
    } else { throw e; }
  } finally {
    if (instance) await instance.stop();
  }
}

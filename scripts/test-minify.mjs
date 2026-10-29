#!/usr/bin/env node
// 生产环境（SERVE_MINIFIED 打开）静态资源应被精简：CSS 语义等价、JS 只去注释且仍可解析。
// 开发/测试默认 SERVE_MINIFIED=0（见 _server.mjs），那批按可读格式断言线上资源的用例不受影响。
import fs from 'node:fs';
import * as csstree from 'css-tree';
import * as acorn from 'acorn';
import { createFixtures } from './_fixtures.mjs';
import { createChecker } from './_check.mjs';
import { startServer } from './_server.mjs';

const { check, report } = createChecker();
const fixtures = await createFixtures();
let server;
try {
  server = await startServer({ env: { ...fixtures.env, SERVE_MINIFIED: '1' } });
  const get = async (path, headers) => {
    const res = await fetch(server.base + path, { headers });
    return { status: res.status, type: res.headers.get('content-type'), etag: res.headers.get('etag'), lastModified: res.headers.get('last-modified'), text: await res.text() };
  };

  const ruleCount = (css) => {
    let rules = 0, decls = 0;
    csstree.walk(csstree.parse(css), { enter(n) { if (n.type === 'Rule') rules++; if (n.type === 'Declaration') decls++; } });
    return { rules, decls };
  };

  const cssSrc = fs.readFileSync('public/style.css', 'utf8');
  const css = await get('/style.css');
  check('M1 CSS 返回 200 且类型正确', css.status === 200 && /text\/css/.test(css.type), `${css.status} ${css.type}`);
  check('M2 CSS 精简幅度明显（<85%）', css.text.length < cssSrc.length * 0.85, `${cssSrc.length} → ${css.text.length}`);
  check('M3 CSS 不再含注释', !css.text.includes('/*'));
  check('M4 源码注释不出现在精简后的 CSS 里', !css.text.includes('账本（首页最近更新'));
  check('M5 关键选择器保留', css.text.includes('.c-head'));
  check('M6 calc 里的运算符空格保留', css.text.includes('calc(100vw - 2rem)'));
  check('M7 现代语法保留（:has / color-mix）', css.text.includes(':has(') && css.text.includes('color-mix('));
  check('M8 精简前后规则/声明数一致（语义等价）',
    JSON.stringify(ruleCount(css.text)) === JSON.stringify(ruleCount(cssSrc)),
    `${JSON.stringify(ruleCount(cssSrc))} → ${JSON.stringify(ruleCount(css.text))}`);

  const jsSrc = fs.readFileSync('public/app.js', 'utf8');
  const js = await get('/app.js');
  check('M9 JS 被精简', js.status === 200 && js.text.length < jsSrc.length, `${jsSrc.length} → ${js.text.length}`);
  check('M10 源码注释不出现在精简后的 JS 里', !js.text.includes('正文插图的「点开大图」是 JS 能力'));
  check('M11 关键函数名保留', js.text.includes('setupHeroCarousel'));
  let jsParses = true;
  try { acorn.parse(js.text, { ecmaVersion: 'latest', sourceType: 'script' }); } catch { jsParses = false; }
  check('M12 精简后仍是合法脚本', jsParses);

  const derived = fs.readFileSync('public/palette.js', 'utf8');
  const served = await get('/palette.js');
  let paletteParses = true;
  try { acorn.parse(served.text, { ecmaVersion: 'latest', sourceType: 'script' }); } catch { paletteParses = false; }
  check('M13 palette.js 也精简且仍合法', paletteParses && served.text.length < derived.length);

  const notModified = await fetch(server.base + '/style.css', { headers: { 'if-none-match': css.etag } });
  check('M14 ETag 协商仍工作（304）', notModified.status === 304, String(notModified.status));
  const since = await fetch(server.base + '/style.css', { headers: { 'if-modified-since': css.lastModified ?? '' } });
  check('M14b Last-Modified / If-Modified-Since 协商', Boolean(css.lastModified) && since.status === 304, `${css.lastModified} → ${since.status}`);
  // 精简 CSS 走的是 minify 分支（不支持 Range），Range 用同一出口的图片资源验证。
  const image = await fetch(server.base + '/og-default.jpg');
  const imageLM = image.headers.get('last-modified') ?? '';
  const staleRange = await fetch(server.base + '/og-default.jpg', { headers: { range: 'bytes=0-10', 'if-range': '"stale"' } });
  check('M14c If-Range 不匹配时回完整 200', staleRange.status === 200 && !staleRange.headers.get('content-range'), String(staleRange.status));
  const freshRange = await fetch(server.base + '/og-default.jpg', { headers: { range: 'bytes=0-10', 'if-range': imageLM } });
  check('M14d If-Range 匹配时回 206', freshRange.status === 206 && /^bytes 0-10\//.test(freshRange.headers.get('content-range') ?? ''), `${freshRange.status} ${freshRange.headers.get('content-range')}`);

  // 构建期预压缩：Brotli 与 gzip 都不应再让 Hono 每请求现压；identity 仍回未压缩的精简版。
  const br = await fetch(server.base + '/style.css', { headers: { 'accept-encoding': 'br' } });
  check('M15 接受 br 时直接发预压缩文件',
    br.headers.get('content-encoding') === 'br' && /accept-encoding/i.test(br.headers.get('vary') ?? '')
    && (await br.text()).length > 0,
    String(br.headers.get('content-encoding')));
  const gz = await fetch(server.base + '/style.css', { headers: { 'accept-encoding': 'gzip' } });
  check('M16 接受 gzip 时直接发预压缩文件', gz.headers.get('content-encoding') === 'gzip', String(gz.headers.get('content-encoding')));
  const identity = await fetch(server.base + '/style.css', { headers: { 'accept-encoding': 'identity' } });
  check('M17 identity 不被压缩', identity.headers.get('content-encoding') === null, String(identity.headers.get('content-encoding')));

  // 去注释必须保留 token 边界：直接拼接会把 token 粘连，改变语义（ASI）或直接产生语法错误。
  const { minifyJs } = await import('../src/render/minify.js');
  for (const [source, fused] of [
    ['function f(){ return/*c*/x; }', 'returnx'],
    ['function g(){ var x = a/*\n*/b }', 'x = ab'],
    ['function h(){ throw/*c*/new Error(); }', 'thrownew'],
  ]) {
    const out = await minifyJs(source);
    let ok = !out.includes(fused);
    try { acorn.parse(out, { ecmaVersion: 'latest' }); } catch { ok = false; }   // 不粘连则一定仍是合法脚本
    check(`M18 去注释不粘连 token：${source}`, ok, out);
  }

  const svg = await get('/favicon.svg');
  check('M19 svg 不被当成 css/js 处理', svg.status === 200 && svg.text.includes('<svg'), String(svg.status));

  console.log(`  生产精简幅度：CSS ${cssSrc.length}→${css.text.length} 字符，JS ${jsSrc.length}→${js.text.length} 字符`);
} finally {
  if (server) await server.stop();
  fixtures.cleanup();
}

process.exit(report() ? 1 : 0);

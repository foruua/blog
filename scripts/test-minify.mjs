import assert from 'node:assert/strict';
import fs from 'node:fs';
import * as csstree from 'css-tree';
import * as acorn from 'acorn';
import { createFixtures } from './_fixtures.mjs';
import { startServer } from './_server.mjs';

// 生产环境（SERVE_MINIFIED 打开）静态资源应被精简：CSS 语义等价、JS 只去注释且仍可解析。
// 开发/测试默认 SERVE_MINIFIED=0（见 _server.mjs），那批按可读格式断言线上资源的用例不受影响。
const fixtures = await createFixtures();
let server;
try {
  server = await startServer({ env: { ...fixtures.env, SERVE_MINIFIED: '1' } });
  const get = async (path, headers) => {
    const res = await fetch(server.base + path, { headers });
    return { status: res.status, type: res.headers.get('content-type'), etag: res.headers.get('etag'), text: await res.text() };
  };

  const ruleCount = (css) => {
    let rules = 0, decls = 0;
    csstree.walk(csstree.parse(css), { enter(n) { if (n.type === 'Rule') rules++; if (n.type === 'Declaration') decls++; } });
    return { rules, decls };
  };

  const cssSrc = fs.readFileSync('public/style.css', 'utf8');
  const css = await get('/style.css');
  assert.equal(css.status, 200);
  assert.match(css.type, /text\/css/);
  assert.ok(css.text.length < cssSrc.length * 0.85, `CSS 精简幅度应明显：${cssSrc.length} → ${css.text.length}`);
  assert.ok(!css.text.includes('/*'), 'CSS 不应再有注释');
  assert.ok(!css.text.includes('账本（首页最近更新'), '源码注释不应出现在精简后的 CSS 里');
  assert.ok(css.text.includes('.c-head'), '关键选择器应保留');
  assert.ok(css.text.includes('calc(100vw - 2rem)'), 'calc 里的运算符空格必须保留');
  assert.ok(css.text.includes(':has(') && css.text.includes('color-mix('), '现代语法应保留');
  assert.deepEqual(ruleCount(css.text), ruleCount(cssSrc), '精简前后规则/声明数应一致（语义等价）');

  const jsSrc = fs.readFileSync('public/app.js', 'utf8');
  const js = await get('/app.js');
  assert.equal(js.status, 200);
  assert.ok(js.text.length < jsSrc.length, `JS 应被精简：${jsSrc.length} → ${js.text.length}`);
  assert.ok(!js.text.includes('正文插图的「点开大图」是 JS 能力'), '源码注释不应出现在精简后的 JS 里');
  assert.ok(js.text.includes('setupHeroCarousel'), '关键函数名应保留');
  acorn.parse(js.text, { ecmaVersion: 'latest', sourceType: 'script' });   // 精简后仍是合法脚本

  const derived = fs.readFileSync('public/palette.js', 'utf8');
  const served = await get('/palette.js');
  acorn.parse(served.text, { ecmaVersion: 'latest', sourceType: 'script' });
  assert.ok(served.text.length < derived.length, 'palette.js 也应精简');

  const notModified = await fetch(server.base + '/style.css', { headers: { 'if-none-match': css.etag } });
  assert.equal(notModified.status, 304, 'ETag 协商仍应工作');

  // 构建期预压缩：Brotli 与 gzip 都不应再让 Hono 每请求现压；identity 仍回未压缩的精简版。
  const br = await fetch(server.base + '/style.css', { headers: { 'accept-encoding': 'br' } });
  assert.equal(br.headers.get('content-encoding'), 'br', '接受 br 时应直接发预压缩文件');
  assert.match(br.headers.get('vary') ?? '', /accept-encoding/i);
  assert.ok((await br.text()).length > 0);
  const gz = await fetch(server.base + '/style.css', { headers: { 'accept-encoding': 'gzip' } });
  assert.equal(gz.headers.get('content-encoding'), 'gzip', '接受 gzip 时应直接发预压缩文件');
  const identity = await fetch(server.base + '/style.css', { headers: { 'accept-encoding': 'identity' } });
  assert.equal(identity.headers.get('content-encoding'), null, 'identity 不应被压缩');

  // 去注释必须保留 token 边界：直接拼接会把 token 粘连，改变语义（ASI）或直接产生语法错误。
  const { minifyJs } = await import('../src/render/minify.js');
  for (const [source, fused] of [
    ['function f(){ return/*c*/x; }', 'returnx'],
    ['function g(){ var x = a/*\n*/b }', 'x = ab'],
    ['function h(){ throw/*c*/new Error(); }', 'thrownew'],
  ]) {
    const out = await minifyJs(source);
    assert.ok(!out.includes(fused), `去注释不应粘连 token：${source} → ${out}`);
    acorn.parse(out, { ecmaVersion: 'latest' });   // 不粘连则一定仍是合法脚本
  }

  const svg = await get('/favicon.svg');
  assert.equal(svg.status, 200);
  assert.ok(svg.text.includes('<svg'), 'svg 不该被当成 css/js 处理');

  console.log(`✓ 生产精简：CSS ${cssSrc.length}→${css.text.length} 字符（结构等价），JS ${jsSrc.length}→${js.text.length} 字符（去注释后仍合法）`);
} finally {
  if (server) await server.stop();
  fixtures.cleanup();
}

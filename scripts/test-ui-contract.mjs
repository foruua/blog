import http from 'node:http';
import assert from 'node:assert/strict';
import { auditUi } from './ui-audit.mjs';

// 真浏览器验证审计器自身：必需页面 500 必须失败，专用 404 按预期接受。
// 页面组里放两处「要有 inspector 才审得到」的东西：① 笔记流的互斥抽屉（非当前的靠 hidden 收起 —— 真看不见，探针会跳过）；② 文章内页的正文目录（<details class="toc"> 默认没有 open）。
// 目录那处有个反直觉的前提：关着的 <details> 内容**不是**看不见的 —— Chromium 给 ::details-content 挂 content-visibility:hidden，不绘制但布局在，矩形照样非零，
// 所以收起态本来就在审计范围内。于是反证不能只靠「里面有块低对比文字」（那样摘掉探针也会红），得让**只有展开态**才出问题：抬头在 [open] 时换色。
const server = http.createServer((req, res) => {
  const status = req.url === '/posts/' ? 500 : req.url === '/__audit-404' ? 404 : 200;
  res.writeHead(status, { 'content-type': req.url === '/sitemap.xml' ? 'application/xml' : 'text/html' });
  const drawers = `<!doctype html><html lang="zh"><body style="background:white;color:black">
    <button data-comments="one">第一条</button><button data-comments="two">第二条</button>
    <div id="one" hidden><span style="color:#aaa">first drawer marker</span></div><div id="two" hidden>第二个抽屉</div>
    <script>document.querySelectorAll('[data-comments]').forEach(button=>button.addEventListener('click',()=>{
      ['one','two'].forEach(id=>document.getElementById(id).hidden=id!==button.dataset.comments);
    }));</script></body></html>`;
  const post = `<!doctype html><html lang="zh"><head><style>
      details.toc > summary { color: #000; }                 /* 收起态：够黑，过 */
      details.toc[open] > summary { color: #bbb; }           /* 展开态：掉到线下 —— 不掀开就永远测不到 */
    </style></head><body style="background:white;color:black">
    <details class="toc"><summary>toc open marker</summary>
      <ol><li class="lvl-2"><a href="#a"><span style="color:#bbb">toc entry marker</span></a></li>
      <li class="lvl-3"><a href="#b">子节</a></li></ol>
    </details></body></html>`;
  res.end(req.url === '/sitemap.xml'
    ? '<urlset><url><loc>http://x/p/toc-sample/</loc></url></urlset>'
    : req.url === '/notes/' ? drawers : req.url === '/p/toc-sample/' ? post
      : '<!doctype html><html lang="zh"><body>测试页面</body></html>');
});
await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
try {
  const result = await auditUi({ base: `http://127.0.0.1:${server.address().port}`, only: 'front', quiet: true });
  assert.ok(result.findings.some((f) => f.fail && f.kind === '页面状态错误' && f.where.includes('/posts/')));
  assert.ok(!result.findings.some((f) => f.kind === '页面状态错误' && f.where.includes('/__audit-404')));
  assert.ok(result.findings.some((f) => f.fail && f.kind === '对比度' && f.text === 'first drawer marker'));
  // 收起态：关着的 <details> 内容照样量得到（content-visibility 挡住的是绘制，不是布局）
  assert.ok(result.findings.some((f) => f.fail && f.kind === '对比度' && f.text === 'toc entry marker'),
    '关着的正文目录没被量到');
  // 展开态：只有真的掀开过 <details>，[open] 那条规则才会生效（见 ui-audit.mjs#inspectPostPage）
  assert.ok(result.findings.some((f) => f.fail && f.kind === '对比度' && f.text === 'toc open marker'),
    '正文目录停在收起态 —— 展开态（抬头转金）等于没审');
  console.log('✓ 互斥抽屉逐个测量、目录收起/展开两态都量到；必需页面 HTTP 500 被报为失败；专用 404 页面按预期接受');
} finally { await new Promise((resolve) => server.close(resolve)); }

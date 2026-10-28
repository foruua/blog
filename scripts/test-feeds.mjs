#!/usr/bin/env node
import './_test-env.mjs';
import { cookieJar, createClient, csrfOf, loginAdmin, progressOf as progressFragment } from './_shared.mjs';

// 友圈（RSS + 前台聚合页）测试：A 层进程内直测解析与 SSRF，B 层端到端起假「朋友站点」让真 server.js 抓。
// FEED_ALLOW_PRIVATE 只加在**子进程**（假友站只能跑 127.0.0.1，测试进程保持默认以验证拦截）。

import http from 'node:http';
import { open, close } from '../db/driver.js';

const { startServer } = await import('./_server.mjs');
const { createChecker, waitFor } = await import('./_check.mjs');
const { check, report } = createChecker();
const { requireAdminPassword } = await import('./_admin-password.mjs');

const PASSWORD = requireAdminPassword('test-feeds.mjs');

console.log('\n友圈测试（抓取 / 解析 / 后台 / 前台）');
console.log('────────────────────────────────────────────');


const hits = new Map();
const bump = (key) => hits.set(key, (hits.get(key) ?? 0) + 1);

const xml = (res, body, type = 'application/rss+xml; charset=utf-8') => {
  res.writeHead(200, { 'Content-Type': type });
  res.end(body);
};

const rssFixture = (base) => `<?xml version="1.0" encoding="UTF-8"?>
<rss version="2.0" xmlns:content="http://purl.org/rss/1.0/modules/content/" xmlns:dc="http://purl.org/dc/elements/1.1/">
  <channel>
    <title>朋友的博客</title>
    <link>${base}/</link>
    <description>一个用来测试的源</description>
    <item>
      <title>用 CDATA 写的 &amp; 与 &lt;标签&gt;</title>
      <link>${base}/post/1</link>
      <guid isPermaLink="false">tag:friend,2026:1</guid>
      <pubDate>Mon, 05 Jan 2026 03:04:05 GMT</pubDate>
      <description><![CDATA[<p>正文里有 <b>标签</b>，还有 <script>alert('xss')</script> 与 <a href="https://evil.test/">外链</a>。</p>]]></description>
      <dc:creator>张三</dc:creator>
    </item>
    <item>
      <title>标题里有 &#39; 引号 &amp; 与号</title>
      <link>/post/2</link>
      <guid>tag:friend,2026:2</guid>
      <pubDate>2026-01-04T10:00:00Z</pubDate>
      <description>&lt;p&gt;被转义过的 &amp;amp; HTML&lt;/p&gt;</description>
    </item>
    <item>
      <title>&lt;script&gt;alert(1)&lt;/script&gt;标题注入测试</title>
      <link>${base}/post/3</link>
      <guid>tag:friend,2026:3</guid>
      <pubDate>这不是一个日期</pubDate>
    </item>
  </channel>
</rss>`;

const atomFixture = (base) => `<?xml version="1.0" encoding="utf-8"?>
<feed xmlns="http://www.w3.org/2005/Atom">
  <title>Atom 朋友</title>
  <link rel="alternate" type="text/html" href="${base}/"/>
  <link rel="self" href="${base}/atom.xml"/>
  <entry>
    <title>Atom 的条目</title>
    <link rel="alternate" href="/atom-post/1"/>
    <id>urn:uuid:atom-1</id>
    <published>2026-02-01T08:00:00Z</published>
    <updated>2026-02-02T08:00:00Z</updated>
    <author><name>李四</name></author>
    <summary type="html">&lt;p&gt;Atom 摘要 &amp; 更多&lt;/p&gt;</summary>
  </entry>
</feed>`;

const rdfFixture = (base) => `<?xml version="1.0" encoding="UTF-8"?>
<rdf:RDF xmlns:rdf="http://www.w3.org/1999/02/22-rdf-syntax-ns#" xmlns="http://purl.org/rss/1.0/" xmlns:dc="http://purl.org/dc/elements/1.1/">
  <channel rdf:about="${base}/rdf.xml"><title>RDF 朋友</title><link>${base}/</link></channel>
  <item rdf:about="${base}/rdf/1">
    <title>RDF 条目</title>
    <link>${base}/rdf/1</link>
    <dc:date>2026-03-01T00:00:00Z</dc:date>
    <description>RDF 摘要</description>
  </item>
</rdf:RDF>`;

const listFixture = (base, n) => {
  const items = Array.from({ length: n }, (_, i) => {
    const at = new Date(Date.UTC(2026, 0, 1, 0, 0, i + 1)).toUTCString();
    return `    <item><title>批量文章 ${i + 1}</title><link>${base}/list/${i + 1}</link><guid>list-${i + 1}</guid><pubDate>${at}</pubDate><description>第 ${i + 1} 篇的摘要</description></item>`;
  }).join('\n');
  return `<?xml version="1.0" encoding="UTF-8"?>
<rss version="2.0"><channel><title>批量源</title><link>${base}/</link>
${items}
</channel></rss>`;
};

// 中文用 GBK（老中文博客的坑，解码层必须认 charset 才不乱码）：「中文标题」=d6d0 cec4 b1ea cce2。
const seriesFixture = (base, tag, n, from = '2026-06-01T00:00:00Z') => {
  const start = Number.isFinite(Date.parse(from)) ? Date.parse(from) : Date.UTC(2026, 5, 1);
  const items = Array.from({ length: n }, (_, i) => {
    const at = new Date(start + i * 60000).toUTCString();
    return `<item><title>${tag}-${i + 1}</title><link>${base}/series/${tag}/${i + 1}</link><guid>${tag}-${i + 1}</guid><pubDate>${at}</pubDate><description>${tag} 第 ${i + 1} 篇</description></item>`;
  }).join('');
  return `<?xml version="1.0" encoding="UTF-8"?><rss version="2.0"><channel><title>${tag} 的源</title><link>${base}/series/${tag}</link>${items}</channel></rss>`;
};

const gbkFixture = (base) => Buffer.concat([
  Buffer.from(`<?xml version="1.0" encoding="gb2312"?><rss version="2.0"><channel><title>`, 'latin1'),
  Buffer.from('d6d0cec4b1eaccE2', 'hex'),
  Buffer.from(`</title><link>${base}/</link><item><title>`, 'latin1'),
  Buffer.from('b2e2cad4', 'hex'),
  Buffer.from(`</title><link>${base}/gbk/1</link><pubDate>2026-04-01T00:00:00Z</pubDate></item></channel></rss>`, 'latin1'),
]);

// 带内部 DTD/外部实体的输入：解析器应完全忽略 DTD，绝不读本地文件。
const xxeFixture = `<?xml version="1.0"?>
<!DOCTYPE rss [<!ENTITY xxe SYSTEM "file:///etc/passwd">]>
<rss version="2.0"><channel><title>&xxe;</title><link>http://example.test/</link>
<item><title>&xxe;</title><link>http://example.test/1</link><guid>xxe-1</guid></item>
</channel></rss>`;

let fixture;
let base;

// 一个源 = 一个站，所以每源用自己的主机名，否则入库地址相同会被同站检查拦下；`*.localhost` 回环，同一 fixture 服务所有名字。
const site = (name, path = '/') => `http://${name}.localhost:${fixture.address().port}${path}`;

async function startFixture() {
  fixture = http.createServer((req, res) => {
    // 客户端超时/中断是常态，别让断开的 socket 把测试进程炸掉
    req.on('error', () => {});
    res.on('error', () => {});
    const url = new URL(req.url, 'http://127.0.0.1');
    // 跟随请求 Host：写死 127.0.0.1 会让批量订阅造的邻居被判「同站已订阅」。
    const here = `http://${req.headers.host ?? `127.0.0.1:${fixture.address().port}`}`;
    bump(url.pathname + (url.search || ''));

    if (url.pathname === '/') {
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
      return res.end('<!DOCTYPE html><html><head><link rel="alternate" type="application/rss+xml" href="/rss.xml"></head><body>邻居主页</body></html>');
    }
    if (url.pathname === '/rss.xml') return xml(res, rssFixture(here));
    if (url.pathname === '/atom.xml') return xml(res, atomFixture(here), 'application/atom+xml; charset=utf-8');
    if (url.pathname === '/rdf.xml') return xml(res, rdfFixture(here), 'application/xml; charset=utf-8');
    if (url.pathname === '/list.xml') return xml(res, listFixture(here, Number(url.searchParams.get('n') ?? 10)));
    if (url.pathname === '/gbk.xml') return xml(res, gbkFixture(here), 'application/rss+xml; charset=gb2312');
    if (url.pathname === '/series.xml') {
      return xml(res, seriesFixture(
        here,
        url.searchParams.get('tag') ?? 'S',
        Number(url.searchParams.get('n') ?? 3),
        url.searchParams.get('from') ?? undefined,
      ));
    }
    if (url.pathname === '/xxe.xml') return xml(res, xxeFixture);
    if (url.pathname === '/page.html') {
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
      return res.end(`<!DOCTYPE html><html><head>
<link rel="alternate" type="application/rss+xml" title="RSS" href="/rss.xml">
<link rel="alternate" type="application/atom+xml" href="/atom.xml">
</head><body>我是一个网页</body></html>`);
    }
    if (url.pathname === '/redirect.xml') {
      res.writeHead(302, { Location: '/rss.xml' });
      return res.end();
    }
    if (url.pathname === '/json') {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      return res.end('{"version":"https://jsonfeed.org/version/1","items":[]}');
    }
    if (url.pathname === '/etag.xml') {
      if (req.headers['if-none-match'] === '"friend-v1"') { res.writeHead(304); return res.end(); }
      res.writeHead(200, { 'Content-Type': 'application/rss+xml; charset=utf-8', ETag: '"friend-v1"' });
      return res.end(`<?xml version="1.0"?><rss version="2.0"><channel><title>会 304 的源</title><link>${here}/</link>
        <item><title>只此一篇</title><link>${here}/etag/1</link><guid>etag-1</guid><pubDate>2026-05-01T00:00:00Z</pubDate></item>
      </channel></rss>`);
    }
    if (url.pathname === '/huge.xml') {
      res.writeHead(200, { 'Content-Type': 'application/rss+xml; charset=utf-8' });
      return res.end(`<?xml version="1.0"?><rss version="2.0"><channel><title>大文件</title>${'<!-- padding -->'.repeat(300000)}</channel></rss>`);
    }
    if (url.pathname === '/slow.xml') {
      // 只发响应头、永不结束：客户端必须自己超时（否则测试挂在这里）
      res.writeHead(200, { 'Content-Type': 'application/rss+xml; charset=utf-8' });
      return res.write('<?xml version="1.0"?><rss version="2.0"><channel>');
    }
    res.writeHead(404, { 'Content-Type': 'text/plain' });
    return res.end('nope');
  });
  await new Promise((resolve) => fixture.listen(0, '127.0.0.1', resolve));
  base = `http://127.0.0.1:${fixture.address().port}`;
}

await startFixture();


{
  const { parseFeed, htmlToText, FeedParseError } = await import('../src/feeds/parse.js');
  const { assertPublicUrl, fetchDocument, discoverFeeds, isPrivateAddress, expandV6, lookupPublicDns } = await import('../src/feeds/fetch.js');
  const { failureLabel } = await import('../src/util/failure.js');

  const rss = parseFeed(rssFixture('https://friend.example'), { baseUrl: 'https://friend.example/rss.xml' });
  check('A1 认出 RSS 2.0 并取到标题与站点', rss.format === 'rss' && rss.title === '朋友的博客' && rss.siteUrl === 'https://friend.example/', `${rss.format}/${rss.title}/${rss.siteUrl}`);
  check('A2 RSS 条目数正确', rss.items.length === 3, `${rss.items.length}`);
  check('A3 CDATA 里的 HTML 被剥成纯文本', rss.items[0].summary.includes('正文里有') && !/[<>]/.test(rss.items[0].summary), rss.items[0].summary);
  check('A4 script 里的内容不会被带出来', !/alert\(/.test(rss.items[0].summary), rss.items[0].summary);
  check('A5 实体解码正确（&#39; / &amp;）', rss.items[1].title === "标题里有 ' 引号 & 与号", rss.items[1].title);
  check('A6 转义过的 HTML 也还原成纯文本', rss.items[1].summary === '被转义过的 & HTML', rss.items[1].summary);
  check('A7 相对链接按 feed 地址补全', rss.items[1].link === 'https://friend.example/post/2', rss.items[1].link);
  check('A8 dc:creator 作为作者', rss.items[0].author === '张三', rss.items[0].author);
  check('A9 认得 RFC822 与 ISO8601 两种时间', rss.items[0].publishedAt === '2026-01-05T03:04:05Z' && rss.items[1].publishedAt === '2026-01-04T10:00:00Z', `${rss.items[0].publishedAt} / ${rss.items[1].publishedAt}`);
  check('A10 解析不了的时间宁可留空（不猜成今天）', rss.items[2].publishedAt === null, String(rss.items[2].publishedAt));
  check('A11 标题里的脚本标签原样保留、由渲染层转义', rss.items[2].title.includes('<script>'), rss.items[2].title);

  const atom = parseFeed(atomFixture('https://friend.example'), { baseUrl: 'https://friend.example/atom.xml' });
  check('A12 认出 Atom，rel=alternate 作为条目链接', atom.format === 'atom' && atom.items[0].link === 'https://friend.example/atom-post/1', `${atom.format}/${atom.items[0].link}`);
  check('A13 Atom 站名 / 作者 / 时间', atom.title === 'Atom 朋友' && atom.siteUrl === 'https://friend.example/' && atom.items[0].author === '李四' && atom.items[0].publishedAt === '2026-02-01T08:00:00Z', `${atom.title}/${atom.items[0].author}/${atom.items[0].publishedAt}`);
  check('A14 Atom 摘要是纯文本', atom.items[0].summary === 'Atom 摘要 & 更多', atom.items[0].summary);

  const rdf = parseFeed(rdfFixture('https://friend.example'), { baseUrl: 'https://friend.example/rdf.xml' });
  check('A15 认得 RSS 1.0（RDF）', rdf.format === 'rdf' && rdf.items.length === 1 && rdf.items[0].publishedAt === '2026-03-01T00:00:00Z', `${rdf.format}/${rdf.items[0]?.publishedAt}`);

  const xxe = parseFeed(xxeFixture, { baseUrl: 'https://friend.example/xxe.xml' });
  check('A16 DTD 里的外部实体被忽略（没有读到本地文件，也没有展开）',
    xxe.title === '&xxe;' && !/root:/.test(JSON.stringify(xxe)), xxe.title);

  const deep = `${'<a>'.repeat(60)}x${'</a>'.repeat(60)}`;
  let deepCode = '';
  try { parseFeed(`<rss version="2.0"><channel><title>${deep}</title></channel></rss>`); }
  catch (error) { deepCode = error.code; }
  check('A17 嵌套过深直接拒绝（不当成死循环）', deepCode === 'too-complex', deepCode);

  let htmlCode = '';
  try { parseFeed('<!DOCTYPE html><html><body>hi</body></html>'); } catch (error) { htmlCode = error.code; }
  check('A18 网页会被认出来，并给出可照做的提示', htmlCode === 'html');

  let junkCode = '';
  try { parseFeed('hello world'); } catch (error) { junkCode = error.code; }
  check('A19 完全不是 XML 的内容报错而不是静默成功', junkCode === 'parse' && FeedParseError.name === 'FeedParseError');

  check('A20 摘要截断并且不留标签', htmlToText(`<p>${'字'.repeat(400)}</p>`, 220).length === 220);

  const found = discoverFeeds(`<link rel="alternate" type="application/rss+xml" href="/rss.xml"><link rel="icon" href="/f.ico">`, 'https://friend.example/page');
  check('A21 从网页里发现订阅地址（只认 alternate）', found.length === 1 && found[0] === 'https://friend.example/rss.xml', JSON.stringify(found));

  // SSRF：逐个形态都要拦住
  const rejects = async (url) => {
    try { await assertPublicUrl(url); return 'allowed'; }
    catch (error) { return error.code; }
  };
  check('A22 拦环回地址 127.0.0.1', await rejects('http://127.0.0.1:8080/feed') === 'private-host');
  check('A23 拦 localhost 域名', await rejects('http://localhost/feed') === 'private-host');
  check('A24 拦云元数据地址 169.254.169.254', await rejects('http://169.254.169.254/latest/meta-data/') === 'private-host');
  check('A25 拦内网 10.x / 192.168.x', await rejects('http://10.1.2.3/feed') === 'private-host' && await rejects('http://192.168.1.1/feed') === 'private-host');
  check('A26 拦 IPv6 环回 [::1]', await rejects('http://[::1]:8080/feed') === 'private-host');
  check('A27 拦十进制 / 十六进制伪装的 IP', await rejects('http://2130706433/feed') === 'private-host' && await rejects('http://0x7f000001/feed') === 'private-host');
  check('A28 拦非 http(s) 协议', await rejects('ftp://friend.example/feed') === 'bad-scheme' && await rejects('file:///etc/passwd') === 'bad-scheme');
  check('A29 拦带账号密码的地址（防钓鱼/凭据外带）', await rejects('http://user:pass@friend.example/feed') === 'bad-url');

  check('A30 IPv6 判定：映射 v4 与 NAT64 都按内网处理，公网地址放行',
    isPrivateAddress('::ffff:192.168.0.1') && isPrivateAddress('::ffff:127.0.0.1')
    && isPrivateAddress('64:ff9b::7f00:1') && !isPrivateAddress('2001:4860:4860::8888')
    && expandV6('::1').length === 32);

  let fetchCode = '';
  try { await fetchDocument(`${base}/rss.xml`); } catch (error) { fetchCode = error.code; }
  check('A31 默认配置下抓取层本身就拒绝环回地址', fetchCode === 'private-host', fetchCode);

  process.env.FEED_ALLOW_PRIVATE = 'true';
  const openMod = await import('../src/feeds/fetch.js?allow-private=1');
  const doc = await openMod.fetchDocument(`${base}/rss.xml`);
  check('A32 测试开关打开后能抓到本机假友站', doc.text.includes('朋友的博客'), String(doc.text.length));
  let bigCode = '';
  try { await openMod.fetchDocument(`${base}/huge.xml`); } catch (error) { bigCode = error.code; }
  check('A33 超过体积上限的内容会被拒绝', bigCode === 'too-large', bigCode);
  let jsonCode = '';
  try { await openMod.fetchDocument(`${base}/json`); } catch (error) { jsonCode = error.code; }
  check('A34 JSON Feed 给出明确提示而不是解析错误', jsonCode === 'content-type', jsonCode);
  let notFoundCode = '';
  try { await openMod.fetchDocument(`${base}/nope.xml`); } catch (error) { notFoundCode = error.code; }
  check('A35 404 报成「地址不存在」', notFoundCode === 'http', notFoundCode);
  const redirected = await openMod.fetchDocument(`${base}/redirect.xml`);
  check('A36 跟随跳转，并用最终地址作为相对链接的基准', redirected.finalUrl.endsWith('/rss.xml'), redirected.finalUrl);
  delete process.env.FEED_ALLOW_PRIVATE;

  const gbk = await openMod.fetchDocument(`${base}/gbk.xml`);
  check('A37 GB2312 的源按声明解码，不乱码', gbk.text.includes('中文标题') && gbk.text.includes('测试'), gbk.text.slice(0, 60));

  const twoSources = `<?xml version="1.0"?><rss version="2.0" xmlns:content="http://purl.org/rss/1.0/modules/content/"><channel><title>全文源</title><link>https://x.test/</link>
    <item><title>有全文的条目</title><link>https://x.test/1</link><guid>long-1</guid>
      <description>只有一句导语。</description>
      <content:encoded><![CDATA[<p>${'正文'.repeat(400)}</p>]]></content:encoded></item></channel></rss>`;
  const longer = parseFeed(twoSources, { baseUrl: 'https://x.test/feed.xml' });
  check('A38 摘要取「导语」与「全文」里更长的那个，并截到上限',
    longer.items[0].summary.startsWith('正文') && longer.items[0].summary.length === 300, `${longer.items[0].summary.length} 字`);

  const onlyDesc = `<?xml version="1.0"?><rss version="2.0"><channel><title>只有导语</title><link>https://x.test/</link>
    <item><title>只有导语</title><link>https://x.test/2</link><guid>d-1</guid><description>就这一句。</description></item></channel></rss>`;
  const short = parseFeed(onlyDesc, { baseUrl: 'https://x.test/feed.xml' });
  check('A39 源只给了导语时照旧用它（不会因为取"更长"而变空）', short.items[0].summary === '就这一句。', short.items[0].summary);

  // 花括号短代码入库前剥掉；但代码块与模板占位符必须原样保留。
  const shortcoded = `<?xml version="1.0"?><rss version="2.0" xmlns:content="http://purl.org/rss/1.0/modules/content/"><channel><title>短代码源</title><link>https://x.test/</link>
    <item><title>带短代码</title><link>https://x.test/3</link><guid>sc-1</guid>
      <content:encoded><![CDATA[<p>开头 {mx_post_card type="local" cid="178"} 中间 {mx_photo} 结尾</p><p>代码 { console.log('ok'); } 与占位符 {name} 必须留下</p>]]></content:encoded></item>
    <item><title>被截断的</title><link>https://x.test/4</link><guid>sc-2</guid>
      <content:encoded><![CDATA[<p>正文 {mx_post_card type="local]]></content:encoded></item></channel></rss>`;
  const sc = parseFeed(shortcoded, { baseUrl: 'https://x.test/feed.xml' });
  check('A40 花括号短代码被剥掉，代码与占位符原样保留',
    !/mx_post_card|mx_photo/.test(sc.items[0].summary)
    && sc.items[0].summary.includes('开头') && sc.items[0].summary.includes('结尾')
    && sc.items[0].summary.includes("{ console.log('ok'); }") && sc.items[0].summary.includes('{name}'),
    sc.items[0].summary);
  check('A41 源自己截断、到结尾都没闭合的短代码也一并去掉',
    !sc.items[1].summary.includes('mx_post_card') && sc.items[1].summary.startsWith('正文'), sc.items[1].summary);

  // DoH：国内优先、海外兜底（拿海外解析器问国内站点会拿到边缘 IP，对方回 403/522）；本机假 DoH 走一遍。
  const dohHits = [];
  let dohMode = 'ok';
  const dohSrv = http.createServer((q, res) => {
    const u = new URL(q.url, 'http://doh.test');
    const type = Number(u.searchParams.get('type'));
    dohHits.push(`${u.pathname.replace('/', '')}:${type}`);
    const down = dohMode === 'all-down' || (dohMode === 'first-down' && u.pathname === '/first');
    res.writeHead(200, { 'Content-Type': 'application/dns-json' });
    if (down) { res.end(JSON.stringify({ Status: 3, Answer: [] })); return; }
    const answer = u.pathname === '/first'
      ? (type === 1 ? [{ type: 1, data: '111.62.183.5' }] : [{ type: 28, data: '2409:8c04:1007:a00b:3::7' }])
      : (type === 1 ? [{ type: 1, data: '163.181.214.1' }] : []);
    res.end(JSON.stringify({ Status: 0, Answer: answer }));
  });
  await new Promise((r) => dohSrv.listen(0, '127.0.0.1', r));
  const dohEndpoints = [`http://127.0.0.1:${dohSrv.address().port}/first`, `http://127.0.0.1:${dohSrv.address().port}/second`];

  const dohAsk = async () => {
    try { return await lookupPublicDns('friend.example', { endpoints: dohEndpoints }); }
    catch { return []; }   // 断言里自己报错，别让整个套件在这里断掉
  };
  const dohFirst = await dohAsk();
  check('A42 先问国内那家：拿到答案就不再问下一家',
    dohHits.join(',') === 'first:1,first:28' && dohFirst.map((a) => a.address).join(',') === '111.62.183.5,2409:8c04:1007:a00b:3::7',
    dohHits.join(','));
  check('A43 A 与 AAAA 一起收，各自带上 family（后续 SSRF 校验要用）',
    dohFirst.length === 2 && dohFirst.every((a) => a.family === (a.address.includes(':') ? 6 : 4)), JSON.stringify(dohFirst));

  dohHits.length = 0;
  dohMode = 'first-down';
  const dohSecond = await dohAsk();
  check('A44 首选给不出答案时自动退回下一家，用的是退回来的那份地址',
    dohSecond.map((a) => a.address).join(',') === '163.181.214.1' && dohHits.includes('second:1'), dohHits.join(','));

  dohHits.length = 0;
  dohMode = 'all-down';
  let dohCode = '';
  try { await lookupPublicDns('friend.example', { endpoints: dohEndpoints }); } catch { dohCode = 'threw'; }
  check('A45 两家都问不到就抛错（调用方翻成 dns 失败，而不是拿空地址表去建连）', dohCode === 'threw', dohCode);
  dohSrv.close();

  // 失败报文 → 行里那句人话。表里是**库里存量的原文**：早前落下的长报文必须当场变短，不能等下一轮抓取刷掉。
  const labels = [
    ['对方返回 HTTP 403（对方拒绝访问，可能需要浏览器 UA 或已被 Cloudflare 拦）', '403 拒绝访问'],
    ['对方返回 HTTP 404（这个地址不存在）', '404 地址不存在'],
    ['对方返回 HTTP 429', '429 请求过多'],
    ['对方返回 HTTP 503', '503 对方服务异常'],
    ['抓取超时（8 秒）', '超时'],
    ['抓取超时（8 秒没有响应）', '超时'],
    ['域名解析不了：friend.example', '域名解析不了'],
    ['指向内网或保留地址，已拒绝（localhost）', '指向内网地址'],
    ['连不上对方站点（ECONNREFUSED）', '连不上对方'],
    ['连不上对方站点：connect ECONNREFUSED 1.2.3.4:443', '连不上对方'],
    ['读不到对方内容（ECONNRESET）', '读不到内容'],
    ['这是网页，不是订阅源（可以改填站点主页）', '不是订阅源'],
    ['对方返回的是 JSON Feed，目前只支持 RSS / Atom', '不是订阅源'],
    ['不是 RSS / Atom 源（根元素是 <foo>）', '不是订阅源'],
    ['对方内容超过 256KB', '内容过大'],
    ['跳转超过 5 次', '跳转过多'],
    ['XML 太复杂，已放弃', 'XML 太复杂'],
    ['源里没有条目', '源里没有条目'],
  ];
  const wrong = labels.filter(([raw, want]) => failureLabel(raw) !== want);
  check('A46 失败报文都压成一句人话（含库里存量的长报文）', wrong.length === 0,
    wrong.map(([raw, want]) => `${raw} → ${failureLabel(raw)}（期望 ${want}）`).join('；'));
  check('A47 满行也不许超过 14 字（行里那半行说明要真的短）',
    labels.map(([raw]) => failureLabel(raw)).every((s) => [...s].length <= 14),
    labels.map(([raw]) => failureLabel(raw)).filter((s) => [...s].length > 14).join('；'));
  check('A48 空报文回空串（没失败就不该有半行说明）', failureLabel('') === '' && failureLabel(null) === '');
  check('A49 认不出来的报文照原样截短，宁可难看也不炸',
    failureLabel('某种没见过的错误').includes('某种没见过的错误')
    && [...failureLabel('x'.repeat(80))].length <= 17, failureLabel('x'.repeat(80)));
}


const srv = await startServer({
  isolateDb: true,
  env: {
    FEED_ALLOW_PRIVATE: 'true',    FEED_REFRESH_MS: '0',    FEED_TIMEOUT_MS: '1000',
    FEED_MAX_BYTES: String(256 * 1024),
    FEED_KEEP: '20',
    BACKUP_ON_PUBLISH: 'false',
  },
});
const API = srv.base;
const db = open(srv.dbFile);

const jar = cookieJar();
const req = createClient(API, jar);
const html = async (url) => (await req(url)).text();
// 跟着「更早的更新」抓全所有页（上限 50 页兜底，防游标坏了死循环）。
const friendsPages = async () => {
  const pages = [];
  let url = '/friends/';
  for (let i = 0; i < 50; i++) {
    const h = await html(url);
    pages.push(h);
    const more = /<p class="pager-more"><a href="([^"]+)">更早的更新 →<\/a><\/p>/.exec(h)?.[1];
    if (!more) break;
    url = more;
  }
  return pages;
};
const friendsText = async () => (await friendsPages()).join('');
const form = (body) => ({
  method: 'POST',
  headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
  body: new URLSearchParams(body),
});
const noticeOf = (res) => {
  const location = res.headers.get('location') ?? '';
  return decodeURIComponent(new URL(location, 'http://x').searchParams.get('w') ?? '');
};
// 结果行域名与说明是两列，逐条对，别拿「两个词挨在一起」当证据。
const importRows = (page) => [...page.matchAll(/<li class="a-import-row" data-state="([^"]+)"><span class="a-import-mk"[^>]*>[^<]*<\/span><code>([^<]*)<\/code><span class="a-import-txt">([^<]*)<\/span><\/li>/g)]
  .map((m) => ({ state: m[1], host: m[2], detail: m[3] }));
const feedIdOf = (url) => db.prepare('SELECT id FROM feeds WHERE url = ?').get(url)?.id ?? 0;
const itemCountOf = (id) => db.prepare('SELECT COUNT(*) AS n FROM feed_items WHERE feed_id = ?').get(id).n;
const feedRowOf = (page, id) => page.split('<li class="a-feed"').find((chunk) => chunk.includes(`feed-editor-${id}-title`)) ?? '';
const feedMetaOf = (row) => /<button[^>]*class="a-feed-meta[^"]*"[^>]*>([\s\S]*?)<\/button>/.exec(row)?.[1] ?? '';
// 那一小段是编辑入口，title 里挂着订阅地址 —— 比字符串记得转义（`&` 是 `&amp;`）。
const feedMetaTipOf = (row) => /<button[^>]*class="a-feed-meta[^"]*"[^>]*title="([^"]*)"/.exec(row)?.[1] ?? '';
const escAttr = (s) => String(s).replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

const added = [];
async function addFeed(url, extra = {}) {
  const csrf = csrfOf(await html('/admin/feeds'));
  const res = await req('/admin/feeds/add', form({ _csrf: csrf, url, ...extra }));
  added.push(url);
  return { status: res.status, msg: noticeOf(res) };
}

{
  const anon = await req('/admin/feeds');
  check('B1 未登录打不开友圈后台', anon.status === 303 && (anon.headers.get('location') ?? '').includes('/admin/login'), `status=${anon.status}`);
}

{
  const login = await loginAdmin(req, PASSWORD);
  check('B2 后台登录成功', login.status === 303 && jar.cookie.startsWith('blog_admin='), `status=${login.status}`);
}

{
  const empty = await html('/friends/');
  check('B3 一个地址都没有时，前台给一句人话而不是空页面',
    empty.includes('这里还没有内容') && empty.includes('后台'), empty.slice(empty.indexOf('fc-empty'), empty.indexOf('fc-empty') + 60));
  check('B4 主导航里有「友圈」', /<nav class="nav"[^>]*>[\s\S]*?href="\/friends\/"[^>]*><svg[\s\S]*?<span class="n-txt">友圈<\/span></.test(empty), '');
  const gone = await req('/friends.opml');
  check('B5 友站列表与 OPML 入口已经移除（那个地址不再存在）',
    gone.status === 404 && !empty.includes('fc-sources') && !empty.includes('/friends.opml'), `status=${gone.status}`);
  const sitemap = await (await req('/sitemap.xml')).text();
  check('B6 sitemap 收录了 /friends', sitemap.includes(`${API}/friends/`), '');
}

{
  const page = await html('/admin/feeds');
  check('B7 后台友圈页能打开', page.includes('添加订阅源') && page.includes('还没有添加任何地址'), '');
}

{
  const r = await addFeed(site('rss', '/rss.xml'));
  check('B8 添加 RSS 源：立即抓到并在提示里说明条数', r.status === 303 && r.msg.startsWith('✓') && r.msg.includes('抓到 3 条'), r.msg);
}
{
  const r = await addFeed(site('rss', '/rss.xml'));
  check('B9 同一个地址不能重复添加', r.msg.includes('已经添加过'), r.msg);
}
{
  const r = await addFeed(site('page', '/page.html'));
  check('B10 填站点主页也能用：自动找到订阅地址', r.msg.includes('自动找到订阅地址') && r.msg.includes('/rss.xml'), r.msg);

  // 发现出来的地址要记住：下次刷新直接抓 feed 本身，不再读那个网页。
  const id = feedIdOf(site('page', '/page.html'));
  const stored = db.prepare('SELECT resolved_url FROM feeds WHERE id = ?').get(id)?.resolved_url;
  const pageHits = hits.get('/page.html') ?? 0;
  const rssHits = hits.get('/rss.xml') ?? 0;
  const csrf = csrfOf(await html('/admin/feeds'));
  await req(`/admin/feeds/${id}/refresh`, form({ _csrf: csrf }));
  check('B10b 自动发现的订阅地址被记住，下次直接抓它（不再读网页）',
    stored === site('page', '/rss.xml') && (hits.get('/page.html') ?? 0) === pageHits && (hits.get('/rss.xml') ?? 0) > rssHits,
    `resolved=${stored} page=${hits.get('/page.html')} rss=${hits.get('/rss.xml')}`);
  const metaRow = feedRowOf(await html('/admin/feeds'), id);
  const tip = feedMetaTipOf(metaRow);
  check('B10c 后台那一行挂的是实际订阅地址（不是配置里填的那个主页）',
    tip.includes(escAttr(site('page', '/rss.xml'))) && !tip.includes(escAttr(site('page', '/page.html'))), tip);
}
{
  const r = await addFeed(site('atom', '/atom.xml'));
  check('B11 添加 Atom 源成功', r.msg.startsWith('✓'), r.msg);
}
{
  const r = await addFeed(site('rdf', '/rdf.xml'));
  check('B12 添加 RSS 1.0（RDF）源成功', r.msg.startsWith('✓') && r.msg.includes('抓到 1 条'), r.msg);
}
{
  const r = await addFeed(site('gbk', '/gbk.xml'));
  check('B13 GB2312 源入库不乱码', r.msg.startsWith('✓'), r.msg);
}
{
  const r = await addFeed(site('json', '/json'));
  check('B14 不是订阅源的地址：添加保留、但明确报出失败原因', r.msg.startsWith('⚠') && r.msg.includes('JSON Feed'), r.msg);
  const page = await html('/admin/feeds');
  check('B15 后台把失败原因显示在那一行上', page.includes('抓取失败') && page.includes('不是订阅源'), '');
  // 行里只留一句人话；完整报文一字不丢收进 title（悬停可见）。
  const line = /<p class="a-warn a-feed-err"([^>]*)>([^<]*)<\/p>/.exec(page);
  check('B15b 行里只写标签，完整报文进 title（可见文字里不再出现报文）',
    line?.[2] === '不是订阅源'
    && /title="对方返回的是 JSON Feed，目前只支持 RSS \/ Atom"/.test(line?.[1] ?? '')
    && !page.replace(/title="[^"]*"/g, '').includes('JSON Feed'),
    JSON.stringify(line));
}
{
  const r = await addFeed(site('slow', '/slow.xml'));
  check('B16 对方不响应时按超时处理，不会把请求挂死', r.msg.startsWith('⚠') && r.msg.includes('超时'), r.msg);
}
{
  const r = await addFeed(site('huge', '/huge.xml'));
  check('B17 超大响应被拒绝', r.msg.startsWith('⚠') && r.msg.includes('KB'), r.msg);
}
{
  const r = await addFeed('ftp://friend.example/feed');
  check('B18 非 http(s) 地址在落库之前就被拒绝', r.msg.startsWith('✗') && r.msg.includes('只支持 http'), r.msg);
  const malformed = await addFeed('https://');
  check('B18b 缺主机的地址在落库之前就被拒绝', malformed.msg.startsWith('✗'), malformed.msg);
}

{
  const page = await friendsText();
  const sources = db.prepare("SELECT COUNT(*) AS n FROM feeds WHERE enabled = 1 AND fail_count = 0").get().n;
  check('B19 前台列出所有成功的源', sources >= 5 && page.includes('朋友的博客') && page.includes('Atom 朋友') && page.includes('RDF 朋友'), `sources=${sources}`);
  check('B20 标题、链接、时间都渲染出来', page.includes('用 CDATA 写的 &amp; 与 &lt;标签&gt;') && page.includes(site('rss', '/post/1')) && page.includes('<time datetime="2026-01-05T03:04:05Z"'), '');
  check('B21 抓不到时间的条目写成「时间未知」而不是编一个时间', page.includes('时间未知'), '');
  // 前台不再渲染摘要：条目里既不该有 .fc-sum，也不该出现那段文本。
  check('B22 摘要不上前台：条目里没有 .fc-sum，也没有摘要文本',
    !page.includes('fc-sum') && !page.includes('正文里有'), '');
  check('B23 页面里没有远程图片（CSP 是 img-src self，也不该把读者 IP 送出去）',
    !/<img[^>]+src="https?:\/\//i.test(page), '');
  check('B24 标题里的脚本被转义，不能变成真标签',
    page.includes('&lt;script&gt;alert(1)&lt;/script&gt;') && !page.includes('<script>alert(1)</script>'), '');
  // 摘要只是不上前台，解析与入库照旧（别顺手把抓取也删了）。
  check('B25 摘要仍然入库，只是前台不展示',
    (db.prepare('SELECT summary FROM feed_items WHERE link = ?').get(site('rss', '/post/1'))?.summary ?? '').includes('正文里有'), '');
  check('B26 外链带 noopener/nofollow', /<a href="[^"]+" target="_blank" rel="noopener nofollow"/.test(page), '');
  check('B27 GBK 源的站名/文章不乱码', page.includes('中文标题'), '');
  check('B28 页面上不再有友站列表区块与 OPML 入口',
    !page.includes('fc-sources') && !page.includes('友站 <') && !page.includes('/friends.opml'), '');
  // 注意：数字外面包着 <b>，要先剥标签再断言，否则永远匹配不上。
  const stats = (/<p class="mast-stat">([\s\S]*?)<\/p>/.exec(page)?.[1] ?? '')
    .replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim();
  check('B28b 刊头只写「N 个订阅」和「最近 N 天 N 篇」，不再有「最新一篇」',
    /\d+ 个订阅/.test(stats) && /当前收录近 30 天 \d+ 篇/.test(stats) && !stats.includes('最新一篇'), stats);
  // 「一位朋友一节」小节标题就是站名；不能断言区块里没有 <h1-6> —— 站名就是 <h2>。
  const stream = /<section class="fc-stream">([\s\S]*?)<\/section>/.exec(page)?.[1] ?? '';
  check('B28c 友圈按朋友分组：每一节都有站名当小节标题',
    stream.length > 0 && /<h2 class="fcg-name">/.test(stream) && !stream.includes('最新文章'), stream.slice(0, 60).trim());
  const srcLinks = [...page.matchAll(/<h2 class="fcg-name"><a href="([^"]+)"/g)].map((m) => m[1]);
  check('B29 每节的站名指向对方站点',
    srcLinks.length > 0 && srcLinks.every((href) => /^http:\/\/[a-z0-9-]+\.localhost:\d+\//.test(href)), `${srcLinks.length} 个`);
}

{
  const r = await addFeed(site('list', '/list.xml?n=25'));
  const id = feedIdOf(site('list', '/list.xml?n=25'));
  const kept = itemCountOf(id);
  const oldest = db.prepare('SELECT COUNT(*) AS n FROM feed_items WHERE feed_id = ? AND title = ?').get(id, '批量文章 1').n;
  check('B30 每个源只保留最近 20 条', r.msg.startsWith('✓') && kept === 20, `kept=${kept} msg=${r.msg}`);
  check('B31 超出的部分丢的是最旧的几条', oldest === 0, `oldest=${oldest}`);
}

{
  const id = feedIdOf(site('rss', '/rss.xml'));
  const before = itemCountOf(id);
  const page = await html('/admin/feeds');
  const csrf = csrfOf(page);
  const again = await req(`/admin/feeds/${id}/refresh`, form({ _csrf: csrf }));
  check('B32 再次刷新不会产生重复条目', itemCountOf(id) === before, `${before} → ${itemCountOf(id)}`);
  check('B33 手动刷新给出结果提示', noticeOf(again).startsWith('✓'), noticeOf(again));
}

{
  const r = await addFeed(site('etag', '/etag.xml'));
  const id = feedIdOf(site('etag', '/etag.xml'));
  const csrf = csrfOf(await html('/admin/feeds'));
  const second = await req(`/admin/feeds/${id}/refresh`, form({ _csrf: csrf }));
  const etagHits = hits.get('/etag.xml') ?? 0;
  check('B34 支持 ETag 条件请求：第二次刷新命中 304', r.msg.startsWith('✓') && noticeOf(second).includes('没有变化'), `${noticeOf(second)} · hits=${etagHits}`);
  check('B35 304 之后条目仍在（没有被清掉）', itemCountOf(id) === 1, String(itemCountOf(id)));
}

{
  const r = await addFeed(site('listb', '/list.xml?n=20&tag=b'));
  const id = feedIdOf(site('listb', '/list.xml?n=20&tag=b'));
  check('B36 第二个批量源入库', r.msg.startsWith('✓') && itemCountOf(id) === 20, `${r.msg} / ${itemCountOf(id)}`);

  // 每页固定 20 位朋友；按现有源数补到 21 个，让「下一页」真的出现。
  const baseWithItems = db.prepare('SELECT COUNT(DISTINCT i.feed_id) AS n FROM feed_items i JOIN feeds f ON f.id = i.feed_id WHERE f.enabled = 1').get().n;
  const extraTags = Array.from({ length: Math.max(0, 20 - baseWithItems + 1) }, (_, i) => `P${i + 1}`);
  for (const tag of extraTags) await addFeed(site(`p${tag}`, `/series.xml?tag=${tag}&n=1`));
  const withItems = db.prepare('SELECT COUNT(DISTINCT i.feed_id) AS n FROM feed_items i JOIN feeds f ON f.id = i.feed_id WHERE f.enabled = 1').get().n;
  const firstPage = Math.min(20, withItems);
  const first = await html('/friends/');
  const secs = [...first.matchAll(/<article class="fcg-sec"[\s\S]*?<\/article>/g)].map((m) => m[0]);
  const counts = secs.map((s) => (s.match(/class="fcg-row"/g) ?? []).length);
  check('B37 一页最多放 20 位朋友，每节仍是 1—3 条（20 条的那两个源也只占 3 条）',
    secs.length === firstPage && counts.every((n) => n >= 1 && n <= 3), `节数=${secs.length} 源=${withItems} 每节=${counts.join(',')}`);
  const feedsAdmin = await html('/admin/feeds');
  const gone = await req('/admin/feeds/front-per', form({ _csrf: csrfOf(feedsAdmin), per: '2' }));
  check('B37b 后台不再提供「前台一页」设置，旧提交地址已关闭',
    !feedsAdmin.includes('f-friends-per') && !feedsAdmin.includes('位朋友') && gone.status === 404, `status=${gone.status}`);
  const more = /<p class="pager-more"><a href="([^"]+)">更早的更新 →<\/a><\/p>/.exec(first)?.[1] ?? '';
  check('B38 页尾有「更早的更新」，链到 ?before= 游标（不是老的「更早的文章」）',
    /^\/friends\/\?before=\d{4}-\d{2}-\d{2}T\d{2}%3A\d{2}%3A\d{2}Z%7C\d+$/.test(more) && !first.includes('更早的文章'), more);
  const bad = await html('/friends/?before=oops');
  check('B38b 坏游标回第一页', (bad.match(/class="fcg-sec"/g) ?? []).length === firstPage && bad.includes('pager-more'), '');
  const pages = await friendsPages();
  const joined = pages.join('');
  const secTotal = pages.reduce((n, h) => n + (h.match(/<article class="fcg-sec"/g) ?? []).length, 0);
  check('B38c 分页拼起来恰好覆盖每一位有文章的朋友，页数 = ⌈源数 / 20⌉',
    secTotal === withItems && pages.length === Math.ceil(withItems / 20), `节=${secTotal} 源=${withItems} 页=${pages.length}`);
  check('B38d 最后一页没有「更早的更新」（游标链有终点，不是死循环）',
    !pages[pages.length - 1].includes('pager-more'), `页数=${pages.length}`);
  // 被上限截掉的是最旧几条且只是不显示；用 href="…" 连引号匹配 —— /list/1 是 /list/17 前缀。
  check('B38e 超出的条目只是不上前台，库里仍然留着',
    itemCountOf(id) === 20 && joined.includes(`href="${site('listb', '/list/20')}"`) && !joined.includes(`href="${site('listb', '/list/1')}"`)
    && !joined.includes(`href="${site('listb', '/list/17')}"`), `库里=${itemCountOf(id)}`);
  // 只为分页造出来的源，断言完就清掉，别影响后面的列表/清理测试。
  for (const tag of extraTags) {
    const fid = feedIdOf(site(`p${tag}`, `/series.xml?tag=${tag}&n=1`));
    db.prepare('DELETE FROM feed_items WHERE feed_id = ?').run(fid);
    db.prepare('DELETE FROM feeds WHERE id = ?').run(fid);
  }
}

{
  const id = feedIdOf(site('rss', '/rss.xml'));
  const countOf = async () => ((await friendsText()).match(/href="[^"]*\/post\/1"/g) ?? []).length;
  const csrf = csrfOf(await html('/admin/feeds'));
  const before = await countOf();
  await req(`/admin/feeds/${id}/toggle`, form({ _csrf: csrf }));
  const off = await countOf();
  check('B39 停用后前台不再显示它的文章', before === 2 && off === 1, `${before} → ${off}`);
  await req(`/admin/feeds/${id}/toggle`, form({ _csrf: csrf }));
  const on = await countOf();
  check('B40 重新启用后文章回来', on === 2, String(on));
}

{
  const id = feedIdOf(site('atom', '/atom.xml'));
  db.prepare('UPDATE feeds SET last_fetch_at = ?, etag = NULL WHERE id = ?').run('2020-01-01T00:00:00Z', id);
  const before = hits.get('/atom.xml') ?? 0;
  await fetch(`${API}/friends/`);
  await new Promise((resolve) => setTimeout(resolve, 150));
  const after = hits.get('/atom.xml') ?? 0;
  check('B41 FEED_REFRESH_MS=0 时前台访问不触发自动刷新', before === after, `${before} → ${after}`);
}

{
  const id = feedIdOf(site('rss', '/rss.xml'));
  const csrf = csrfOf(await html('/admin/feeds'));
  const before = itemCountOf(id);
  const del = await req(`/admin/feeds/${id}/delete`, form({ _csrf: csrf }));
  check('B42 删除源会连它的条目一起删掉', noticeOf(del).startsWith('✓') && itemCountOf(id) === 0, `${before} → ${itemCountOf(id)}`);
  // 用行内表单 action 认人（源 id 唯一）：别拿 URL 字符串找 —— 别的源可能把同地址记成实际订阅。
  check('B43 删除后后台列表里不再有它',
    !(await html('/admin/feeds')).includes(`/admin/feeds/${id}/save`), '');
}

{
  const csrf = csrfOf(await html('/admin/feeds'));
  const before = db.prepare('SELECT COUNT(*) AS n FROM feed_items').get().n;
  const clear = await req('/admin/feeds/clear-items', form({ _csrf: csrf }));
  check('B44 清空抓取结果保留地址配置',
    noticeOf(clear).includes(`已清空 ${before} 条`) && db.prepare('SELECT COUNT(*) AS n FROM feed_items').get().n === 0
    && db.prepare('SELECT COUNT(*) AS n FROM feeds').get().n > 0, `${before}`);
  const noItems = await html('/friends/');
  check('B45 没有条目时前台仍然是 200 并给出解释', noItems.includes('还没有抓到文章'), '');
}

{
  // 地址改掉之后旧条目要清掉（否则前台会一直显示上一个源的文章）
  const id = feedIdOf(site('rdf', '/rdf.xml'));
  const csrf = csrfOf(await html('/admin/feeds'));
  await req(`/admin/feeds/${id}/refresh`, form({ _csrf: csrf }));
  check('B46 刷新后重新有内容', itemCountOf(id) === 1, String(itemCountOf(id)));

  const save = await req(`/admin/feeds/${id}/save`, form({
    _csrf: csrf, url: site('rdf', '/redirect.xml'), title: '改名后的站', sort_order: '1',
  }));
  check('B47 改地址会清掉旧条目并按新地址重抓', noticeOf(save).includes('开始按新地址抓取'), noticeOf(save));
  const after = await waitFor(() => (itemCountOf(id) === 3 ? 3 : null), { timeoutMs: 8000 });
  check('B48 新地址的内容已经替换进来', after === 3, `items=${itemCountOf(id)}`);

  const row = db.prepare('SELECT title, sort_order, site_url FROM feeds WHERE id = ?').get(id);
  check('B49 站名与排序保存生效', row.title === '改名后的站' && row.sort_order === 1, JSON.stringify(row));
}

{
  const csrf = csrfOf(await html('/admin/feeds'));
  const before = db.prepare('SELECT COUNT(*) AS n FROM feeds').get().n;
  const r = await req('/admin/feeds/add', form({ _csrf: csrf, url: 'ftp://friend.example/feed' }));
  check('B50 被拒绝的地址不会在表里留下记录', db.prepare('SELECT COUNT(*) AS n FROM feeds').get().n === before, noticeOf(r));
}


{
  const csrf = csrfOf(await html('/admin/feeds'));
  await req('/admin/feeds/clear-items', form({ _csrf: csrf }));
  await addFeed(site('t1', '/series.xml?tag=T1&n=4'));
  await addFeed(site('t2', '/series.xml?tag=T2&n=3'));

  const id1 = feedIdOf(site('t1', '/series.xml?tag=T1&n=4'));
  const id2 = feedIdOf(site('t2', '/series.xml?tag=T2&n=3'));
  const shown = async (tag) => ((await friendsText()).match(new RegExp(`>${tag}-\\d+<`, 'g')) ?? []).length;

  check('C1 固定 3 篇：4 条的那个源也只铺 3 条',
    (await shown('T1')) === 3 && (await shown('T2')) === 3, `T1=${await shown('T1')} T2=${await shown('T2')}`);
  check('C1b 超出上限时丢的是最旧的一条，且只是不上前台',
    !(await friendsText()).includes('T1-1') && (await friendsText()).includes('T1-4')
    && itemCountOf(id1) === 4, `库里=${itemCountOf(id1)}`);

  const page = await html('/admin/feeds');
  const gone = await req('/admin/feeds/display', form({ _csrf: csrf, limit: '1' }));
  check('C2 后台不再提供显示条数设置，旧的统一设置地址已关闭',
    !page.includes('name="display_limit"') && !page.includes('f-limit-all') && gone.status === 404, `status=${gone.status}`);

  const save = await req(`/admin/feeds/${id1}/save`, form({
    _csrf: csrf, url: site('t1', '/series.xml?tag=T1&n=4'), title: 'T1 的源', sort_order: '0', display_limit: '2',
  }));
  check('C2b 单源旧字段被忽略，仍固定显示 3 条',
    noticeOf(save).startsWith('✓') && (await shown('T1')) === 3, `${noticeOf(save)}`);
  check('C2c display_limit 列已被迁移删除',
    !db.prepare('PRAGMA table_info(feeds)').all().some((c) => c.name === 'display_limit'), '');

  check('C4 只是不显示，库里并没有被删', itemCountOf(id1) === 4 && itemCountOf(id2) === 3, `${itemCountOf(id1)}/${itemCountOf(id2)}`);
  const metaRow = feedRowOf(await html('/admin/feeds'), id1);
  const meta = feedMetaOf(metaRow);
  check('C5 那一行只剩「最近成功时间」：地址、条目数、前台显示几篇都不再摆出来',
    meta.includes('最近成功') && !meta.includes('<code>') && !meta.includes(' 条')
    && !meta.includes('前台显示') && !meta.includes('实际订阅'), meta);
  const metaTip = feedMetaTipOf(metaRow);
  const feedAddress = (db.prepare('SELECT resolved_url, url FROM feeds WHERE id = ?').get(id1) ?? {});
  check('C5b 订阅地址挪进了那一小段的悬停提示（没丢，只是不再占版面）',
    metaTip.includes(escAttr(feedAddress.resolved_url || feedAddress.url)) && metaTip.includes('编辑'),
    metaTip);

}


{
  // 抓取失败散在几十个源里时，一页页翻着找最费劲：?state= 只留坏的那几个。界面不做一排筛选按钮，
  // 只在工具行右端写一句状态（全部正常是陈述，有坏源时那几个字可点），所以断言都对着这句话。
  const stateOfRow = (r) => (!r.enabled ? 'off' : r.fail_count > 0 ? 'failed' : r.last_ok_at ? 'ok' : 'never');
  const all = db.prepare('SELECT id, enabled, fail_count, last_ok_at FROM feeds').all();
  const expect = all.reduce((acc, r) => { const k = stateOfRow(r); acc[k] = (acc[k] ?? 0) + 1; return acc; }, {});
  const rowsOf = (page) => [...page.matchAll(/<li class="a-feed" data-state="([^"]+)"/g)].map((m) => m[1]);
  // 那句状态是 flex 排的，分隔点靠 gap 而不是空格——取文本时先把点换成「 · 」，断言的字符串才读得懂。
  const statusOf = (page) => (/<p class="a-feeds-status[^"]*"[^>]*>([\s\S]*?)<\/p>/.exec(page)?.[1] ?? '')
    .replace(/<span class="a-feeds-status-dot"[^>]*>·<\/span>/g, ' · ')
    .replace(/<[^>]+>/g, '').replace(/\s+/g, ' ').trim();

  const page = await html('/admin/feeds?state=failed');
  const states = rowsOf(page);
  check('D1 ?state=failed 只列抓取失败的源',
    expect.failed >= 1 && states.length === expect.failed && states.every((s) => s === 'failed'),
    `期望 ${expect.failed} 行，实际 ${states.length} 行（${states.join(',')}）`);
  check('D2 筛选时状态行写「只看抓取失败（N 个） · 看全部 M 个」，N 是全量不是本页数',
    statusOf(page) === `只看抓取失败（${expect.failed} 个） · 看全部 ${all.length} 个`, statusOf(page));
  check('D3 行内动作与翻页都把 state 带回去（刷一个源不会把人弹回全部）',
    page.includes('<input type="hidden" name="state" value="failed">'), '');

  const bogus = await html('/admin/feeds?state=bogus');
  check('D4 不认识的 state 退回全部，不会给一页空白',
    rowsOf(bogus).length > 0 && !statusOf(bogus).startsWith('只看') && bogus.includes('href="/admin/feeds?state=failed"'),
    statusOf(bogus));

  // 停用优先：停用的源不再抓，也就从「抓取失败」里退出——两个筛选互斥，计数才不会重复。
  const target = all.find((r) => stateOfRow(r) === 'failed');
  const csrf = csrfOf(await html('/admin/feeds'));
  await req(`/admin/feeds/${target.id}/toggle`, form({ _csrf: csrf, state: 'failed' }));
  const offPage = await html('/admin/feeds?state=off');
  check('D5 停用一个失败源后，它从「抓取失败」移到「已停用」',
    rowsOf(offPage).every((s) => s === 'off') && Boolean(feedRowOf(offPage, target.id))
    && !feedRowOf(await html('/admin/feeds?state=failed'), target.id), '');
  await req(`/admin/feeds/${target.id}/toggle`, form({ _csrf: csrf, state: 'failed' }));

  const res = await req(`/admin/feeds/${target.id}/refresh`, form({ _csrf: csrf, state: 'failed' }));
  check('D6 动作之后的跳转保留筛选态', (res.headers.get('location') ?? '').includes('state=failed'),
    res.headers.get('location') ?? '');

  // 一个坏源都没有时，这句话退成陈述句：不挂一排 0，也不给筛选入口（没东西可筛）。
  const snapshot = db.prepare('SELECT id, enabled, fail_count, last_ok_at FROM feeds').all();
  db.prepare("UPDATE feeds SET fail_count = 0, last_ok_at = COALESCE(last_ok_at, '2026-01-01T00:00:00Z')").run();
  const calm = await html('/admin/feeds');
  check('D7 全部正常时只写「N 个源 · 全部正常」，不挂 0 也不给筛选入口',
    statusOf(calm) === `${all.length} 个源 · 全部正常` && !calm.includes('state=failed'), statusOf(calm));
  const restore = db.prepare('UPDATE feeds SET enabled = ?, fail_count = ?, last_ok_at = ? WHERE id = ?');
  for (const r of snapshot) restore.run(r.enabled, r.fail_count, r.last_ok_at, r.id);
}

{
  const csrf = csrfOf(await html('/admin/feeds'));
  await req('/admin/feeds/clear-items', form({ _csrf: csrf }));

  const ago = (days) => new Date(Date.now() - days * 86400000).toISOString().replace(/\.\d{3}Z$/, 'Z');
  await addFeed(site('in', `/series.xml?tag=IN&n=2&from=${encodeURIComponent(ago(0))}`));
  await addFeed(site('prev', `/series.xml?tag=PREV&n=1&from=${encodeURIComponent(ago(10))}`));
  await addFeed(site('out', `/series.xml?tag=OUT&n=3&from=${encodeURIComponent(ago(40))}`));

  const mastStat = async () => ((/<p class="mast-stat">([\s\S]*?)<\/p>/.exec(await html('/friends/'))?.[1] ?? '')
    .replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim());

  const stats = await mastStat();
  check('D1 刊头写「当前收录近 30 天 N 篇」', /当前收录近 30 天 3 篇/.test(stats), stats);
  check('D2 是滚动窗口而不是自然月：10 天前那条（可能已跨月）照样算进去',
    /当前收录近 30 天 3 篇/.test(stats) && !/当前收录近 30 天 2 篇/.test(stats), stats);
  check('D3 40 天前的条目不计入，但仍在列表里',
    !/当前收录近 30 天 6 篇/.test(stats) && (await friendsText()).includes('OUT-1'), stats);

  await req('/admin/feeds/clear-items', form({ _csrf: csrf }));
  const zero = await mastStat();
  check('D4 窗口内一条都没有时也照常显示「当前收录近 30 天 0 篇」', /当前收录近 30 天 0 篇/.test(zero), zero);
}


{
  const { createFeedRepo } = await import('../db/feeds.js');
  const { revalidateIfParserChanged } = await import('../src/feeds/refresh.js');
  const local = createFeedRepo(db);
  const settings = {
    get: (k) => db.prepare('SELECT value FROM settings WHERE key = ?').get(k)?.value ?? null,
    set: (k, v) => db.prepare('INSERT INTO settings(key, value) VALUES(?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value').run(k, String(v)),
  };
  const target = local.list()[0];
  db.prepare('UPDATE feeds SET etag = ?, last_modified = ? WHERE id = ?')
    .run('"v-old"', 'Mon, 01 Jan 2026 00:00:00 GMT', target.id);
  db.prepare("DELETE FROM settings WHERE key = 'feeds_parser_version'").run();

  const logged = [];
  const first = revalidateIfParserChanged({ feeds: local, settings, version: 99, log: (line) => logged.push(line) });
  const cleared = db.prepare('SELECT etag, last_modified FROM feeds WHERE id = ?').get(target.id);
  check('E1 解析器版本变了：作废所有条件请求缓存（否则摘要永远停在旧规则算出来的样子）',
    first === true && cleared.etag === null && cleared.last_modified === null, JSON.stringify(cleared));
  check('E1b 这次作废会记一条日志（升级后能看出数据为什么被重算）',
    logged.some((line) => line.includes('feeds.parser-changed')), logged.join(' | '));

  db.prepare('UPDATE feeds SET etag = ? WHERE id = ?').run('"v-new"', target.id);
  const second = revalidateIfParserChanged({ feeds: local, settings, version: 99, log: () => {} });
  const kept = db.prepare('SELECT etag FROM feeds WHERE id = ?').get(target.id);
  check('E2 版本没变时一个字节都不动（不会每次启动都白抓一遍）',
    second === false && kept.etag === '"v-new"', String(kept.etag));
}


{
  const perOf = () => db.prepare("SELECT value FROM settings WHERE key = 'feeds_per_page'").get()?.value;
  const idsOf = (page) => [...page.matchAll(/action="\/admin\/feeds\/(\d+)\/refresh"/g)].map((m) => Number(m[1]));
  const rowsOf = (page) => (page.match(/class="a-feed"/g) ?? []).length;

  const total = db.prepare('SELECT COUNT(*) AS n FROM feeds').get().n;
  check('F1 这一段有足够多的源来验证翻页（否则下面的断言没有意义）', total > 5, `total=${total}`);

  const csrf = csrfOf(await html('/admin/feeds'));
  const set = await req('/admin/feeds/per', form({ _csrf: csrf, per: '5' }));
  check('F2 每页几个源可以设置并落库', noticeOf(set).startsWith('✓') && perOf() === '5', `${noticeOf(set)} / ${perOf()}`);

  const last = Math.ceil(total / 5);
  const p1 = await html('/admin/feeds');
  const p2 = await html('/admin/feeds?page=2');
  const same = idsOf(p1).filter((id) => idsOf(p2).includes(id));
  check('F3 第 1 页只渲染「每页」那么多行', rowsOf(p1) === 5 && idsOf(p1).length === 5, `rows=${rowsOf(p1)}`);
  check('F4 第 2 页是另一批源，不是把第 1 页又画了一遍',
    rowsOf(p2) === Math.min(5, total - 5) && same.length === 0, `重叠 ${same.length} 个`);
  const feedHead = /<h2 class="a-h2">(已订阅[^<]*)<\/h2>/.exec(p1)?.[1] ?? '';
  check('F5 页脚报出总页数，订阅标题只报源数量',
    p1.includes(`第 1 / ${last} 页`) && p1.includes(`共 ${total} 个源`) && feedHead === `已订阅 ${total} 个源`,
    `head=${feedHead} last=${last}`);

  const over = await html('/admin/feeds?page=999');
  check('F6 越界页码收敛到最后一页（删光某页之后重定向回来不会是空页）',
    over.includes(`第 ${last} / ${last} 页`) && rowsOf(over) > 0, '');

  // 行内动作必须把当前页码带回服务端，否则在第 2 页停用源会被弹回第 1 页
  const idOnP2 = idsOf(p2)[0];
  check('F7 第 2 页的行内表单带着页码隐藏域',
    p2.includes('<input type="hidden" name="page" value="2">'), '');
  const toggled = await req(`/admin/feeds/${idOnP2}/toggle`, form({ _csrf: csrf, page: '2' }));
  check('F8 在第 2 页停用/启用之后仍然回到第 2 页',
    (toggled.headers.get('location') ?? '').includes('page=2'), toggled.headers.get('location') ?? '');
  await req(`/admin/feeds/${idOnP2}/toggle`, form({ _csrf: csrf, page: '2' }));

  const bad = await req('/admin/feeds/per', form({ _csrf: csrf, per: 'abc' }));
  check('F9 非法的每页条数被拒绝，且不改动已存的值',
    noticeOf(bad).startsWith('✗') && perOf() === '5', `${noticeOf(bad)} / ${perOf()}`);
  const tooBig = await req('/admin/feeds/per', form({ _csrf: csrf, per: '999' }));
  check('F10 超出 5—100 的每页条数同样被拒绝',
    noticeOf(tooBig).startsWith('✗') && perOf() === '5', noticeOf(tooBig));

  // 收尾：把每页恢复成默认值，别把设置留给后面的套件
  await req('/admin/feeds/per', form({ _csrf: csrf, per: '20' }));
  check('F11 可以改回默认的每页 20 个源', perOf() === '20' && rowsOf(await html('/admin/feeds')) === Math.min(20, total), perOf());
}


{
  // 一个站只能有一个源：同一主机再挂第二个一律拦下，没有勾一下放行的余地。
  const count = () => db.prepare('SELECT COUNT(*) AS n FROM feeds').get().n;
  const before = count();
  const csrf = csrfOf(await html('/admin/feeds'));
  const first = await addFeed(site('dup', '/rss.xml'));
  check('G1 同站的第一个源照常添加', first.msg.startsWith('✓') && count() === before + 1, first.msg);

  const dup = await req('/admin/feeds/add', form({ _csrf: csrf, url: site('dup', '/atom.xml') }));
  check('G2 同站再挂第二个源被拦下，并说清是这个博客已经订阅过',
    noticeOf(dup).includes('这个博客已订阅') && count() === before + 1, noticeOf(dup));

  // 反证：换个主机名就照旧能加 —— 挡的是「同一个站」，不是「同一个本机 fixture」。
  const other = await addFeed(site('dup-other', '/rss.xml'));
  check('G2b 换个站名就能加（挡的是同站，不是同一台本机假友站）',
    other.msg.startsWith('✓') && count() === before + 2, other.msg);
}

{
  // 用不带子域的 localhost —— 上面那批源都在 `<名字>.localhost` 上，这个名字还空着。
  const post = db.prepare('SELECT id FROM posts ORDER BY id LIMIT 1').get()?.id;
  const add = db.prepare(`INSERT INTO comments(post_id, author, website, website_host, body_md, status, is_author)
                          VALUES(?, ?, ?, ?, ?, 'approved', 0)`);
  add.run(post, '邻居甲', `http://localhost:${fixture.address().port}/`, 'localhost', '你好');
  add.run(post, '邻居乙', 'http://127.0.0.3:1/', '127.0.0.3', '你好');

  const page = await html('/admin/feeds');
  check('G3 后台出现批量入口，并报出待订阅的站数',
    page.includes('订阅未加入友圈的友链') && page.includes('（2 个）'), '');

  const started = await req('/admin/feeds/subscribe-links', form({ _csrf: csrfOf(page) }));
  check('G4 点一下就开始了，不用等它整轮跑完',
    started.status === 303 && noticeOf(started).includes('已开始订阅'), noticeOf(started));

  let after = '';
  for (let i = 0; i < 80; i++) {
    after = await html('/admin/feeds');
    if (after.includes('本轮已结束')) break;
    await new Promise((r) => setTimeout(r, 200));
  }
  check('G5 结束后给出这一轮的进度与逐站结果',
    /本轮已结束 · 2 \/ 2 个站/.test(after) && after.includes('data-running="0"'), '');
  const rows = importRows(after);
  check('G6 能从主页发现订阅源的邻居被订阅了',
    rows.some((r) => r.state === 'added' && r.host === 'localhost'),
    JSON.stringify(rows));
  check('G7 连不上的邻居报出原因，且没有留下无效订阅',
    rows.some((r) => r.state === 'failed' && r.host === '127.0.0.3' && r.detail)
    && db.prepare("SELECT COUNT(*) AS n FROM feeds WHERE url LIKE '%127.0.0.3%'").get().n === 0, '');
  check('G8 失败的那个仍算待订阅，下次可以再试一次',
    (await html('/admin/feeds')).includes('（1 个）'), '');
}


{
  // admin.js 每 1.5s 换整张卡：必须只回那一张卡（不是整页），且不许被缓存（否则每次都拿回第一次快照）。
  const frag = await req('/admin/feeds/subscribe-report');
  const body = await frag.text();
  check('H1 进度片段只回那一张卡，不是整页',
    frag.status === 200 && body.includes('data-import=') && !body.includes('<html'),
    `status=${frag.status} len=${body.length}`);
  check('H2 片段不许被缓存（否则轮询永远拿到同一份快照）',
    (frag.headers.get('cache-control') ?? '').includes('no-store'), frag.headers.get('cache-control') ?? '');
  check('H3 片段与首次渲染同源：页面里的卡片也带同一个 data-import',
    (await html('/admin/feeds')).includes('data-import="/admin/feeds/subscribe-report"'), '');

  const saved = jar.cookie; jar.cookie = '';
  let denied;
  try { denied = await req('/admin/feeds/subscribe-report'); } finally { jar.cookie = saved; }
  check('H4 未登录拿不到进度片段（邻居名单与抓取结果不对外）',
    denied.status === 303 && (denied.headers.get('location') ?? '').includes('/admin/login'),
    `status=${denied.status}`);
}

{
  // 「跑着」必须在 HTML 里看得出来；两个站几毫秒跑完抓不到稳定快照，所以直接把状态喂给同一模板函数测契约。
  const { importBlock } = await import('../src/admin/views/feeds.js');
  const mid = importBlock({
    pendingLinks: 2,
    importReport: {
      running: true, total: 9, completed: 7,
      results: [
        { host: 'ok.example', state: 'added', detail: '已订阅 · 收录 3 篇' },
        { host: 'bad.example', state: 'failed', detail: '连不上对方站点' },
        { host: 'skip.example', state: 'skipped', detail: '已经订阅' },
      ],
    },
  });
  check('H5 跑着的时候片段标 data-running=1，进度条与计数都在',
    mid.includes('data-running="1"') && mid.includes('正在订阅 · 7 / 9 个站')
    && mid.includes('a-import-meter'), '');
  const rows = importRows(mid);
  check('H6 结果按「失败 → 新增 → 跳过」排，要人搭理的排在最前',
    rows.map((r) => r.state).join(',') === 'failed,added,skipped', rows.map((r) => r.state).join(','));
  check('H7 域名与说明分列，说明跟着自己那一行走',
    rows[0].host === 'bad.example' && rows[0].detail === '连不上对方站点', JSON.stringify(rows[0]));
  check('H8 片段里没有动作按钮、也没有那段说明（弹窗只回答「这一轮跑到哪儿了」）',
    !mid.includes('<button') && !mid.includes('subscribe-links') && !mid.includes('自动寻找'), '');
  check('H9 片段里带着入口按钮该有的样子，admin.js 照它同步禁用态与文案',
    mid.includes('data-pending="2"')
    && mid.includes('data-entry-label="订阅未加入友圈的友链（2 个）"'), '');

  const idle = importBlock({ pendingLinks: 2, importReport: null });
  check('H10 没跑过的时候不渲染进度与结果，只留一句「正在读取进度」',
    idle.includes('data-running="0"') && !idle.includes('a-import-list')
    && !idle.includes('本轮已结束') && idle.includes('正在读取进度'), '');
  check('H11 一个待订阅的站都没有时，片段里的入口文案就是「友链都订阅过了」',
    importBlock({ pendingLinks: 0, importReport: null }).includes('data-entry-label="友链都订阅过了"'), '');
}

{
  // 进度与结果收进弹窗：页面上只留入口、别渲染第二份 —— 两份各自刷新会各说各话。
  const page = await html('/admin/feeds');
  check('H12 页面上只有一份进度容器，而且在弹窗里',
    (page.split('data-import="').length - 1) === 1
    && page.includes('<dialog class="a-modal a-import-dialog" id="a-import-dialog"')
    && page.indexOf('data-import=') > page.indexOf('id="a-import-dialog"'), '');
  check('H13 开一轮的那个表单只剩页面入口这一处（弹窗里不再放第二个按钮）',
    (page.match(/data-import-start/g) ?? []).length === 1
    && (page.match(/action="\/admin\/feeds\/subscribe-links"/g) ?? []).length === 1,
    String((page.match(/data-import-start/g) ?? []).length));
  check('H14 弹窗有标题关联、关闭键，并且点外侧能关掉',
    page.includes('aria-labelledby="a-import-dialog-title"') && page.includes('data-import-close')
    && page.includes('data-dismiss-outside'), '');
}

{
  const { importEntry, importDialog } = await import('../src/admin/views/feeds.js');
  const report = { running: false, total: 2, completed: 2, results: [] };
  const done = importEntry({ csrf: 'x', importReport: report, pendingLinks: 1 });
  check('H15 跑完之后页面上留一个「查看上一次结果」的入口（否则关掉弹窗就再也翻不回来）',
    done.includes('data-import-view') && done.includes('查看上一次结果')
    && !done.includes('a-import-row') && !done.includes('a-import-count'), '');
  const live = importEntry({ csrf: 'x', importReport: { ...report, running: true }, pendingLinks: 1 });
  check('H16 一轮还在跑的时候入口写成「查看进度」，并且「订阅」是禁用的',
    live.includes('查看进度') && /<button[^>]*disabled/.test(live), '');
  check('H17 没跑过的时候不留「查看」入口（点开是空的，不如不给）',
    !importEntry({ csrf: 'x', importReport: null, pendingLinks: 3 }).includes('data-import-view'), '');

  const none = importEntry({ csrf: 'x', importReport: null, pendingLinks: 0 });
  check('H18 没有待订阅的站时按钮直接禁用并改口，那段说明也收掉（动作都停了，说明就是噪音）',
    /<button[^>]*disabled[^>]*>友链都订阅过了<\/button>/.test(none)
    && !none.includes('自动寻找'), '');
  const some = importEntry({ csrf: 'x', importReport: null, pendingLinks: 3 });
  check('H19 有待订阅的站时按钮可点、写着数目，说明还在',
    !/<button[^>]*disabled/.test(some) && some.includes('订阅未加入友圈的友链（3 个）')
    && some.includes('自动寻找'), '');

  const dlg = importDialog({ importReport: report, pendingLinks: 1 });
  check('H20 弹窗首屏就带着完整内容（不靠 JS 也能读到上一轮结果）',
    dlg.includes('data-import=') && dlg.includes('本轮已结束 · 2 / 2 个站')
    && dlg.includes('a-import-dialog-body'), '');
  check('H21 弹窗里没有提交按钮、没有说明文字（留一个关闭键就够）',
    !dlg.includes('type="submit"') && !dlg.includes('subscribe-links')
    && !dlg.includes('自动寻找') && dlg.includes('data-import-close'), '');
}

{
  const page = await html('/admin/feeds');
  const plain = await req('/admin/feeds/subscribe-links', form({ _csrf: csrfOf(page) }));
  check('H22 没 JS 时照旧整页跳一次，提示语说清进度去哪儿看',
    plain.status === 303 && noticeOf(plain).includes('弹窗'), `${plain.status} ${noticeOf(plain)}`);
  const xhr = await req('/admin/feeds/subscribe-links', {
    ...form({ _csrf: csrfOf(page) }), headers: { 'X-Requested-With': 'fetch' },
  });
  check('H23 弹窗那条路回 204（没有 location），省掉一次整页 HTML 的传输',
    xhr.status === 204 && !xhr.headers.get('location'), `status=${xhr.status}`);
  // 把这一轮跑完，别把后台任务留给收尾
  for (let i = 0; i < 80; i++) {
    if ((await html('/admin/feeds')).includes('本轮已结束')) break;
    await new Promise((r) => setTimeout(r, 200));
  }
}

// I. 「刷新全部」的进度条：一轮几十个源要跑几秒到几十秒，页面是静态快照，不自己更新站主会以为卡死。
// POST 带 x-requested-with: fetch 换 204，客户端每 1s 拉片段换进度条，跑完 pjax 刷整页；这里测服务端那半。

{
  const { feedsProgress } = await import('../src/admin/views/feeds.js');

  const shell = (p) => {
    const out = feedsProgress(p);
    return !out.includes('<span>') && !out.includes('a-feeds-meter') && out.includes('data-feeds-progress=');
  };
  check('I1 没跑过 / 一轮没活儿可干（0 个源）都不留话 —— 常驻一句「0 / 0 个源」纯是噪音',
    shell(null) && shell({ running: false, total: 0, completed: 0 }), feedsProgress({ running: false, total: 0, completed: 0 }));
  check('I2 只有"正在跑"才留话与条子（跑完两条一起收，页头不留满格的账）',
    feedsProgress({ running: true, total: 4, completed: 1 }).includes('width: 25%')
    && shell({ running: false, total: 4, completed: 4 }));
  check('I3 比例取整且夹在 0–100（completed 超过 total 也不画出格）',
    feedsProgress({ running: true, total: 3, completed: 1 }).includes('width: 33%')
    && feedsProgress({ running: true, total: 3, completed: 9 }).includes('completed="3"')
    && feedsProgress({ running: true, total: 3, completed: 9 }).includes('width: 100%'));
  check('I4 data-running 是客户端唯一的判据（跑完那枚属性还在，只是不再带话）',
    /data-running="1"[\s\S]*已完成 1 \/ 4 个源/.test(feedsProgress({ running: true, total: 4, completed: 1 }))
    && /data-running="0"/.test(feedsProgress({ running: false, total: 4, completed: 4 }))
    && shell({ running: false, total: 4, completed: 4 }));
}

{
  const progressOf = (page) => progressFragment(page, 'a-feeds-progress');
  const fragment = () => req('/admin/feeds/refresh-progress').then((r) => r.text());
  const disabledRefresh = (page) => /data-feeds-refresh[\s\S]*?<button[^>]*disabled/.test(page);

  const idle = progressOf(await html('/admin/feeds'));
  check('I5 没跑过时也留着进度锚点（空壳），客户端不必自己造节点',
    idle !== null && idle.total === 0 && idle.text === '' && idle.percent === null, JSON.stringify(idle));
  check('I6 片段端点回的就是那一块（空壳也照回，不是 404 也不是整页）',
    progressOf(await fragment()) !== null);

  const anon = await fetch(`${API}/admin/feeds/refresh-progress`, { redirect: 'manual' });
  check('I7 没登录时片段不放行（回登录页 —— 客户端据此停轮，而不是把登录页塞进进度条）',
    anon.status === 303 && (anon.headers.get('location') ?? '').startsWith('/admin/login'),
    `status=${anon.status} location=${anon.headers.get('location')}`);
  check('I8 片段不许被缓存（每 1s 拉一次，缓存住就等于进度不动了）',
    (await req('/admin/feeds/refresh-progress')).headers.get('cache-control') === 'no-store');

  const page = await html('/admin/feeds');
  const csrf = csrfOf(page);
  check('I9 不带 fetch 头时仍旧整页跳（禁用 JS 的老路照走）',
    noticeOf(await req('/admin/feeds/refresh', form({ _csrf: csrf }))).includes('已开始刷新全部源'));

  // 一个永不回话的源（/slow.xml 吊着，FEED_TIMEOUT_MS=1000 会 1s 后超时）才有稳定可观察的还在跑；用独立主机名。
  const slow = site('slowpoke', '/slow.xml');
  check('I10 前置：先把那个慢源挂上（这一轮才有 1s 的可观察窗口）',
    (await addFeed(slow)).msg.startsWith('⚠ 已添加'), slow);

  const started = await req('/admin/feeds/refresh', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded', 'x-requested-with': 'fetch' },
    body: new URLSearchParams({ _csrf: csrf }),
  });
  check('I11 带 fetch 头提交只回 204（进度条自己会更新，不必整页跳一次）',
    started.status === 204 && !started.headers.get('location'), `status=${started.status}`);

  const running = progressOf(await fragment());
  check('I12 跑着时片段说清楚了：data-running=1 + 总数 + 一句「刷新中」',
    running?.running === true && running.total > 0 && running.text.startsWith('刷新中')
    && running.completed < running.total, JSON.stringify(running));
  check('I13 跑着时进度条按完成比例画（宽度 = completed / total，不是写死的）',
    running?.percent !== null
    && running.percent === Math.round((running.completed / running.total) * 100), JSON.stringify(running));
  check('I14 跑着的时候「刷新全部」是禁用的（一轮只跑一次，别让站主白等第二轮）',
    disabledRefresh(await html('/admin/feeds')));

  let done = progressOf(await fragment());
  for (let i = 0; i < 100 && done?.running; i += 1) {
    await new Promise((r) => setTimeout(r, 200));
    done = progressOf(await fragment());
  }
  check('I15 跑完之后进度归位：running=0 且 completed 追平 total',
    done?.running === false && done.total > 0 && done.completed === done.total, JSON.stringify(done));
  check('I16 跑完之后整块收起（条子与那句话一起收，页头不留「最近一轮刷新已结束：已完成 N / N 个源」）',
    done?.percent === null && done.text === '', JSON.stringify(done));
  check('I17 首屏与片段逐字对得上（同一份模板，否则每 1s 换出来的东西会跟首屏打架）',
    JSON.stringify(progressOf(await html('/admin/feeds'))) === JSON.stringify(done));
  check('I18 跑完之后按钮不再禁用', !disabledRefresh(await html('/admin/feeds')));
}


{
  // Feed 是匿名高成本端点：30 秒内重复请求不应再扫库，ETag 仍要能走 304，且每 IP 有硬上限。
  const { feedRoutes } = await import('../src/routes/feed.js');
  let calls = 0;
  const app = feedRoutes({
    feed: () => { calls++; return []; },
    getSetting: () => null,
    allPublished: () => [],
    pages: () => [],
  });
  const first = await app.request('/feed.xml');
  const second = await app.request('/feed.xml');
  check('J1 30 秒内重复请求 Feed 命中响应缓存', first.status === 200 && calls === 1, `status=${first.status} db calls=${calls}`);
  check('J2 缓存响应保留 Content-Type 与 ETag',
    second.headers.get('content-type')?.includes('application/rss+xml') && Boolean(second.headers.get('etag')), '');
  const etag = second.headers.get('etag');
  const notModified = await app.request('/feed.xml', { headers: { 'If-None-Match': etag } });
  check('J3 缓存命中的条件请求仍返回 304', notModified.status === 304, `status=${notModified.status}`);
  let limited = 0;
  for (let i = 0; i < 130; i++) {
    if ((await app.request('/feed.xml')).status === 429) limited++;
  }
  check('J4 Feed 超过每 IP 120 次/分钟后返回 429', limited === 13, `429=${limited}`);

  // 原始 query 不能把缓存 key 撑成无限集合：limit=020 / 20 必须命中同一条归一化后的缓存。
  let normalizedCalls = 0;
  const normalizedApp = feedRoutes({
    feed: () => { normalizedCalls++; return []; },
    getSetting: () => null,
    allPublished: () => [],
    pages: () => [],
  });
  await normalizedApp.request('/feed.xml?limit=020');
  await normalizedApp.request('/feed.xml?limit=20');
  await normalizedApp.request('/feed.xml?limit=+20');
  check('J5 limit 的不同写法共用同一条缓存', normalizedCalls === 1, `db calls=${normalizedCalls}`);

  // 后台改站名/描述后，文章时间戳没变但 Feed 正文变了：ETag 必须跟着变，否则客户端一直 304。
  const { SITE } = await import('../src/config.js');
  const originalIdentity = SITE.identity;
  const etagWith = async (identity) => {
    SITE.identity = identity;
    const feedApp = feedRoutes({
      feed: () => [],
      getSetting: () => null,
      allPublished: () => [],
      pages: () => [],
    });
    return (await feedApp.request('/feed.xml')).headers.get('etag');
  };
  let before, after;
  try {
    before = await etagWith(originalIdentity);
    after = await etagWith(`${originalIdentity}·改名`);
  } finally { SITE.identity = originalIdentity; }
  check('J6 站名变化会让 Feed ETag 失效', Boolean(before) && Boolean(after) && before !== after, `${before} / ${after}`);

  // 重启后缓存是空的：带旧 ETag 的请求必须先生成并缓存一份 200，而不是直接回 304 让缓存永远冷着。
  let coldFills = 0;
  const coldRepo = () => {
    coldFills++;
    return [{
      id: 1, slug: 'cold', kind: 'post', title: '冷缓存', description: '',
      body_html: '<p>冷缓存</p>', published_at: '2026-01-01T00:00:00Z', updated_at: '2026-01-01T00:00:00Z',
    }];
  };
  const warmApp = feedRoutes({ feed: coldRepo, getSetting: () => null, allPublished: () => [], pages: () => [] });
  const warm = await warmApp.request('/feed.xml');
  const warmEtag = warm.headers.get('etag');
  const coldApp = feedRoutes({ feed: coldRepo, getSetting: () => null, allPublished: () => [], pages: () => [] });
  const refill = await coldApp.request('/feed.xml', { headers: { 'If-None-Match': warmEtag } });
  const refilled = await refill.text();
  const conditional = await coldApp.request('/feed.xml', { headers: { 'If-None-Match': warmEtag } });
  check('J7 冷缓存遇到旧 ETag 先回 200 并填充缓存，随后才 304',
    refill.status === 200 && refilled.includes('冷缓存') && conditional.status === 304 && coldFills === 2,
    `${refill.status} → ${conditional.status}, fills=${coldFills}`);
}

close(db);
await srv.stop();
await new Promise((resolve) => { fixture.closeAllConnections?.(); fixture.close(resolve); });

process.exit(report() ? 1 : 0);

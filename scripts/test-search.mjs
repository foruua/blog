#!/usr/bin/env node
// 全站检索：核心逻辑 + 接线。现在是「查询时现读现匹配」——不建索引、不切词。
// 重点仍是每条判断配反证：草稿/未发布/页面/评论都不该出现在结果里。
import './_test-env.mjs';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { JSDOM } from 'jsdom';
import { open, close } from '../db/driver.js';
import { migrate } from '../db/migrate.js';
import { createRepo } from '../db/repo.js';
import { createSearch, plainText, parseQuery, SEARCH_LIMIT } from '../src/search/index.js';
import { wordCount, snippetAround, highlightTerms } from '../src/util/text.js';
import { createChecker } from './_check.mjs';

const { check, report } = createChecker();
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'blog-search-'));
const db = open(path.join(tmp, 'blog.db'));
migrate(db, { log: () => {} });

const repo = createRepo(db);
const search = createSearch(db);

const make = (slug, kind, title, text, publishedAt = '2026-01-01T00:00:00Z', extra = {}) => repo.upsertFromFile({
  slug, kind, title, bodyMd: text, bodyHtml: `<p>${text}</p>`, toc: [], lang: 'zh',
  commentsOn: true, draft: false, source: 'file', filePath: `${slug}.md`,
  fileHash: `${slug}-h1`, wordCount: wordCount(text), publishedAt, ...extra,
});

make('a-cut-words', 'post', '中文全文检索为什么要先切词', '子串匹配本来就不受分词影响。');
make('a-node-sqlite', 'post', 'node:sqlite 用了半年，够用', '内置驱动零原生依赖，FTS5 与 JSON 函数都在。');
make('a-backup', 'post', '没演练过的备份不算备份', '备份的意义在于恢复，没有恢复演练的备份只是心理安慰。');
make('a-note-market', 'note', '周日去菜市场', '早上去菜市场买了青菜和番茄，摊主送了一把葱。');
make('a-page-about', 'page', '关于', '这里是关于页面，也会提到中文排版与备份。');
// 正文里两个词被块级标签隔开：plainText 应把它们拼成空格分隔，于是「中文 排版」能 AND 命中。
repo.upsertFromFile({ slug: 'a-typo', kind: 'post', title: '块级标签之间', bodyMd: '中文排版', bodyHtml: '<p>中文</p><p>排版</p>', toc: [], lang: 'zh', commentsOn: true, draft: false, source: 'file', filePath: 'a-typo.md', fileHash: 'a-typo-h1', wordCount: 4, publishedAt: '2026-01-05T00:00:00Z' });
make('z-draft', 'post', '这是一篇切词草稿', '草稿里也有中文切词四个字。', '2026-01-01T00:00:00Z', { draft: true });
make('z-future', 'post', '明天才发的切词文章', '还没到时间。', '2099-01-01T00:00:00Z');

const find = (q, opts = {}) => search.query({ q, ...opts });
const slugs = (r) => r.hits.map((h) => h.slug);

// —— 引擎 ——

check('中文子串搜得到', find('切词').total > 0 && slugs(find('切词')).includes('a-cut-words'));
check('单字也能召回', find('词').total > 0);
check('跨块级标签的两词（拼成空格）能 AND 命中', slugs(find('中文 排版')).includes('a-typo'));
check('拉丁大小写不敏感', find('SQLITE').total === find('sqlite').total && find('sqlite').total > 0);
check('多个词是 AND：都要命中才算', find('备份 演练').total > 0 && find('中文 番茄').total === 0,
  `备份+演练=${find('备份 演练').total} 中文+番茄=${find('中文 番茄').total}`);
check('标题命中', slugs(find('菜市场')).includes('a-note-market'));

check('草稿搜不到', find('切词草稿').total === 0);
check('未到发布时间搜不到', find('明天才发').total === 0);
check('固定页搜不到', find('关于页面').total === 0 && !slugs(find('中文')).includes('a-page-about'));
check('笔记在检索范围内', find('菜市场').hits.every((h) => h.type === 'note') && find('菜市场').total === 1);
check('结果项带 url / ts / type', (() => {
  const h = find('备份').hits[0];
  return h && h.url.startsWith('/') && h.ts && (h.type === 'post' || h.type === 'note');
})());

check('按发布时间从新到旧', (() => {
  const rows = find('中文').hits;
  return rows.every((h, i) => i === 0 || String(rows[i - 1].ts) >= String(h.ts));
})());

check(`超过 ${SEARCH_LIMIT} 条时截断并置 truncated`, (() => {
  for (let i = 0; i < SEARCH_LIMIT + 5; i++) make(`bulk-${i}`, 'post', `批量词条 ${i}`, '同一个关键词在这里。', `2026-03-${String((i % 28) + 1).padStart(2, '0')}T00:00:00Z`);
  const r = find('关键词');
  return r.hits.length === SEARCH_LIMIT && r.total === SEARCH_LIMIT + 5 && r.truncated === true;
})(), `hits=${find('关键词').hits.length} total=${find('关键词').total}`);

check('自定义 limit 生效', find('关键词', { limit: 3 }).hits.length === 3);

check('空查询直接返回空（且不抛）', find('').total === 0 && find('   ').total === 0 && find('').parsed.empty);
check('纯引号/连字符这种死词不返回全库也不抛错', find('"').total === 0 && find('-').total === 0);
check('超长查询被截断但不出错', (() => { try { find('中'.repeat(500)); return true; } catch { return false; } })());
check('特殊字符不抛错', (() => { try { find('中文" OR "a'); return true; } catch { return false; } })());

check('parseQuery 按空白切词、去引号、去重、小写', (() => {
  const p = parseQuery('  Node "SQLite" node ');
  return p.terms.join('|') === 'node|sqlite' && p.empty === false;
})());
check('plainText 把块级标签变成空格而不是删掉', plainText('<p>中文</p><p>切词</p>') === '中文 切词', plainText('<p>中文</p><p>切词</p>'));
check('plainText 丢掉脚本/样式内容', plainText('<p>可见</p><script>不可见</script>') === '可见');

// —— 命中摘要（snippetAround + highlightTerms）——
// 摘要窗口按空格边界截：拉丁词不许被拦腰砍断，中文没有空格就照切。左右各钉一个精确结果，
// 不然这条断言很容易写成"看起来差不多"。
const WORDS = 'alpha bravo charlie delta echo foxtrot golf hotel india juliet';
check('snippetAround：以命中词为中心，两端补省略号', (() => {
  const s = snippetAround(WORDS, ['golf'], { radius: 10, max: 40 });
  return s === '…foxtrot golf hotel india juliet';
})(), snippetAround(WORDS, ['golf'], { radius: 10, max: 40 }));
check('snippetAround：窗口末尾落在半截词上时退到空格（不切出 de…）', (() => {
  const s = snippetAround(WORDS, ['alpha'], { radius: 0, max: 22 });
  return s === 'alpha bravo charlie…';
})(), snippetAround(WORDS, ['alpha'], { radius: 0, max: 22 }));
check('snippetAround：正文里找不到词（只标题命中）时退回开头，不高亮也不抛', (() => {
  const s = snippetAround('一段很长的正文。'.repeat(40), ['标题里才有的词']);
  return s.startsWith('一段很长的正文') && s.endsWith('…') && !s.includes('标题里才有的词');
})());
check('snippetAround：多词时取最靠前的那个命中', (() => {
  const s = snippetAround(`${'前'.repeat(60)}乙词${'中'.repeat(60)}甲词`, ['甲词', '乙词'], { radius: 4, max: 20 });
  return s.includes('乙词') && !s.includes('甲词');
})(), snippetAround(`${'前'.repeat(60)}乙词${'中'.repeat(60)}甲词`, ['甲词', '乙词'], { radius: 4, max: 20 }));
check('snippetAround：空正文/空词表不抛', snippetAround('', ['词']) === '' && snippetAround('正文', []) === '正文');

check('highlightTerms：只包命中段，其余转义（返回的是 HTML）',
  highlightTerms('a<b> 命中 切词', ['命中']) === 'a&lt;b&gt; <mark>命中</mark> 切词',
  highlightTerms('a<b> 命中 切词', ['命中']));
check('highlightTerms：用户输入的元字符当字面量，不拼正则',
  (() => { const h = highlightTerms('价格 3.5 元，(a) 与 *', ['.', '(', '*']); return h.includes('<mark>.</mark>') && h.includes('<mark>(</mark>') && h.includes('<mark>*</mark>'); })());
check('highlightTerms：注入型输入被转义，不会印出标签',
  highlightTerms('正文里没有那个词', ['<script>alert(1)</script>']) === '正文里没有那个词');
check('highlightTerms：同一位置多词取最长（「切」与「切词」都命中时整词高亮）',
  highlightTerms('先切词再说', ['切', '切词']) === '先<mark>切词</mark>再说',
  highlightTerms('先切词再说', ['切', '切词']));
check('highlightTerms：大小写不敏感，但保留原文大小写',
  highlightTerms('Node 与 SQLITE', ['node', 'sqlite']) === '<mark>Node</mark> 与 <mark>SQLITE</mark>',
  highlightTerms('Node 与 SQLITE', ['node', 'sqlite']));
check('highlightTerms：词表为空时只转义', highlightTerms('<b>x</b>', []) === '&lt;b&gt;x&lt;/b&gt;');

close(db);
fs.rmSync(tmp, { recursive: true, force: true });

// —— 接线 ——

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const { startServer } = await import('./_server.mjs');
const { VERSIONED_ASSETS } = await import('../src/render/layout.js');
const srv = await startServer();
const BASE = srv.base;

// 克隆库会把 comments 整表清掉（_server.mjs 的 clearTables），所以这里自己造两条：
// 一条已通过、一条待审 —— 结果行右下角那枚「N 条评论」得是真数，且只算已通过的那条。
// 挑 why-single-column：它的正文里就有「示例」（能被检索命中），又因为最新而稳定出现在 /posts/ 第一页。
const COMMENTED_SLUG = 'why-single-column';
{
  const { DatabaseSync } = await import('node:sqlite');
  const t = new DatabaseSync(srv.dbFile);
  try {
    const postId = t.prepare('SELECT id FROM posts WHERE slug = ?').get(COMMENTED_SLUG).id;
    const ins = t.prepare(`INSERT INTO comments (post_id, author, body_md, status) VALUES (?, ?, ?, ?)`);
    ins.run(postId, '测试读者', '这条该被算上', 'approved');
    ins.run(postId, '测试读者', '这条还在待审，不该被算上', 'pending');
  } finally { t.close(); }
}

try {
  const pageOf = async (u) => {
    const res = await fetch(BASE + u);
    return { status: res.status, html: await res.text() };
  };
  const domOf = (html) => new JSDOM(html).window.document;

  const bare = await pageOf('/search');
  check('M1 /search 走的是检索路由，不是固定页通配（200 且 body[data-page=search]）',
    bare.status === 200 && /<body data-page="search"/.test(bare.html), `status=${bare.status}`);
  check('M1b /search 不进搜索引擎索引',
    /<meta name="robots" content="noindex,follow">/.test(bare.html));
  check('M2 空查询是"输入一个词开始"，不摆零结果列表',
    /输入一个词开始/.test(bare.html) && !/命中 <b>0<\/b>/.test(bare.html)
    && domOf(bare.html).querySelectorAll('ul.list > li').length === 0);
  check('M2b 已删除「空格分隔多个词…」说明文案', !/空格分隔/.test(bare.html));

  const hit = await pageOf('/search?q=%E7%A4%BA%E4%BE%8B');   // 示例
  const doc = domOf(hit.html);
  const rows = [...doc.querySelectorAll('ul.list > li')];
  // 行的骨架：li 与其直接子节点、.e-main 的直接子节点、.e-meta 的直接子节点 —— 逐元素标签+类名。
  // 搜索列表与文章列表共用 listBlock/listItem，这条断言就是"别再分叉"的看门人。
  const shapeOf = (li) => {
    const kid = (el) => el.tagName.toLowerCase() + (typeof el.className === 'string' && el.className.trim()
      ? '.' + el.className.trim().split(/\s+/).join('.') : '');
    const main = li.querySelector('.e-main');
    const meta = li.querySelector('.e-meta');
    return [kid(li), ...[...main.children].map(kid), kid(meta), ...[...meta.children].map(kid)].join(' | ');
  };
  check('M3 结果页有结果行，且每行都是文章列表那一套（编年轨 / 标题 / 摘要 / 元信息行）', rows.length > 0
    && rows.every((li) => li.querySelector('.e-main > time') && li.querySelector('.e-main > h2')
      && li.querySelector('.e-main > p.excerpt') && li.querySelector('.e-meta > time.e-rel')
      && li.querySelector('.e-meta > a.e-comments')),
    `${rows.length} 条`);
  check('M3b 结果页不再显示「命中 N 项」统计栏', !doc.querySelector('.mast-stat') && !/命中 <b>/.test(hit.html));
  check('M3c 每条结果都带命中摘要，命中词包在 <mark> 里', rows.length > 0
    && rows.every((li) => li.querySelector('p.excerpt'))
    && rows.some((li) => /<mark>示例<\/mark>/.test(li.querySelector('p.excerpt').innerHTML)),
    rows[0]?.querySelector('p.excerpt')?.outerHTML.slice(0, 100));
  check('M3d 摘要是正文里的上下文（不是标题复读），并按窗口补了省略号', (() => {
    const ex = rows[0]?.querySelector('p.excerpt')?.textContent ?? '';
    return ex.includes('示例正文') && ex.includes('…');
  })(), rows[0]?.querySelector('p.excerpt')?.textContent.slice(0, 50));
  check('M3e 摘要里 <mark> 的个数与命中次数一致（不漏包、不重复包）', (() => {
    const ex = rows[0]?.querySelector('p.excerpt');
    if (!ex) return false;
    const marks = [...ex.querySelectorAll('mark')].map((m) => m.textContent);
    return marks.length > 0 && marks.every((m) => m === '示例')
      && ex.textContent.split('示例').length - 1 === marks.length;
  })(), `${[...(rows[0]?.querySelectorAll('p.excerpt mark') ?? [])].length} 个 mark`);
  check('M3f 摘要里没有裸标签（转义到位）', rows.every((li) => !/<(?!\/?mark\b)/i.test(li.querySelector('p.excerpt').innerHTML)));
  // 只在标题里命中的词，正文摘要里不会出现 mark；标题必须自己高亮，否则整条结果看起来与搜索词无关。
  const titleHit = domOf((await pageOf('/search?q=' + encodeURIComponent('单栏'))).html);
  const titleRow = [...titleHit.querySelectorAll('ul.list > li')].find((li) => li.querySelector('h2')?.textContent.includes('单栏'));
  check('M3f2 只在标题命中的词也高亮在标题上',
    !!titleRow && /<mark>单栏<\/mark>/.test(titleRow.querySelector('h2').innerHTML),
    titleRow?.querySelector('h2')?.innerHTML.slice(0, 80));
  // 与文章列表逐元素同构：拿 /posts/ 的一行做基准，比骨架（标签 + 类名 + 层级），不比文字。
  // 基准先取好再比 —— check() 是同步的，传 Promise 进去会永远判真。
  const postsHtml = (await pageOf('/posts/')).html;
  const postRow = domOf(postsHtml).querySelector('ul.list > li:not(.note)');
  const postShape = postRow ? shapeOf(postRow) : '(文章列表没有可比的行)';
  const searchPostRow = rows.find((li) => !li.classList.contains('note'));
  check('M3g 结果行与文章列表行逐元素同构（同一份 listItem，没有第二套标记）',
    !!searchPostRow && shapeOf(searchPostRow) === postShape,
    `搜索行：${searchPostRow ? shapeOf(searchPostRow) : '(无)'}\n     文章行：${postShape}`);
  const countOf = (li) => li.querySelector('.e-comments')?.textContent;
  check('M3h 结果行的评论数字是真数，且只算已通过（待审那条不算）', (() => {
    const row = rows.find((li) => li.querySelector('.e-comments')?.getAttribute('href')?.includes(`/p/${COMMENTED_SLUG}/`));
    return countOf(row) === '1';
  })(), rows.map(countOf).join(' / '));
  check('M3h2 同一篇的评论数在 /posts/ 与 /search 上口径一致', (() => {
    const postsRow = domOf(postsHtml).querySelector(`ul.list > li a[href="/p/${COMMENTED_SLUG}/"]`)?.closest('li');
    const searchRow = rows.find((li) => li.querySelector('.e-comments')?.getAttribute('href')?.includes(`/p/${COMMENTED_SLUG}/`));
    return !!postsRow && !!searchRow && countOf(postsRow) === countOf(searchRow) && countOf(postsRow) === '1';
  })());
  check('M3i 笔记结果带类型方章（与归档那种混合列表同一规矩：文章不挂章）', (() => {
    const notes = rows.filter((li) => li.classList.contains('note'));
    return notes.length > 0 && notes.every((li) => li.querySelector('h2 .kind')?.textContent === '笔记')
      && rows.filter((li) => !li.classList.contains('note')).every((li) => !li.querySelector('.kind'));
  })(), `${rows.filter((li) => li.classList.contains('note')).length} 条笔记`);
  check('M4 页头检索是常驻搜索框（不是链接、不是弹层），脚本仍在',
    /class="nav-search"/.test(hit.html) && (/\/site\.js\?v=/.test(hit.html) || /\/search\.js\?v=/.test(hit.html))
    && !/id="sBox"/.test(hit.html) && !/id="sPal"/.test(hit.html));
  check('M5 结果里没有固定页（页面不在检索范围）',
    rows.every((li) => !/\/fixture-page/.test(li.querySelector('a')?.getAttribute('href') ?? '')),
    rows.map((li) => li.querySelector('a')?.getAttribute('href')).join(' '));

  const none = await pageOf('/search?q=zzz%E6%B2%A1%E6%9C%89%E8%BF%99%E4%B8%AA%E8%AF%8D');
  check('M6 零结果给的是空状态页，不是空列表',
    none.status === 200 && domOf(none.html).querySelectorAll('ul.list > li').length === 0
    && domOf(none.html).querySelector('.post-empty'), `status=${none.status}`);

  // 参数健壮性：脏输入一律退回默认，不许 500
  for (const [label, url] of [
    ['M7 kind 参数已被忽略（写脏值也不出错）', '/search?q=%E7%A4%BA%E4%BE%8B&kind=%E4%B9%B1%E5%86%99'],
    ['M7b 旧 page 参数被忽略', '/search?q=%E7%A4%BA%E4%BE%8B&page=99'],
    ['M7c q 是超长串', `/search?q=${'%E4%B8%AD'.repeat(300)}`],
  ]) {
    const r = await pageOf(url.replace(/ /g, '%20'));
    check(`${label} 不报错（200）`, r.status === 200, `status=${r.status}`);
  }

  const home = await pageOf('/');
  const homeDoc = domOf(home.html);
  const css = fs.readFileSync(path.join(ROOT, 'public', 'style.css'), 'utf8');
  const navSearch = () => homeDoc.querySelector('nav.nav form.nav-search');
  check('M8 页头检索是「图标 + 展开输入」（GET 表单落到 /search）', (() => {
    const f = navSearch();
    return !!f && f.getAttribute('action') === '/search' && f.getAttribute('method') === 'get'
      && !!f.querySelector('button.nav-search-btn[aria-expanded="false"]')
      && f.getAttribute('data-open') !== 'true'
      && !!f.querySelector('input[name="q"]');
  })());
  check('M8b 抽屉里也有一枚常驻搜索框（GET 表单落到 /search）', (() => {
    const f = homeDoc.querySelector('.mnav form.s-drawer-form');
    return !!f && f.getAttribute('action') === '/search' && f.getAttribute('method') === 'get'
      && !!f.querySelector('input[name="q"]');
  })());
  check('M8b2 抽屉搜索框的文字左右留白，不贴着焦点框/按钮',
    /\.s-drawer-input\s*\{[^}]*padding:\s*0\s+\.5rem/.test(css), '缺 .s-drawer-input { padding: 0 .5rem }');
  check('M8b3 桌面展开的搜索框与搜索按钮留出间距',
    /\.nav-search-input\s*\{[^}]*right:\s*calc\(100%\s*\+\s*\.5rem\)/.test(css), '缺 .nav-search-input 与按钮的 .5rem 间距');
  check('M8c 旧入口已清：没有检索链接、没有弹层', !homeDoc.querySelector('a.s-link') && !homeDoc.querySelector('#sBox, #sPal'));
  check('M8d 快捷键不进可见文案（首页无 ⌘K 字样）', !home.html.includes('⌘K'));
  check('M8e 无 JS 兜底链接在（去 /search），由 html.has-js 决定露哪一枚',
    !!homeDoc.querySelector('a.nav-search-fallback[href="/search"]')
    && /html:not\(\.has-js\)\s*\.nav-search\s*\{\s*display:\s*none/.test(css)
    && /html\.has-js\s*\.nav-search-fallback\s*\{\s*display:\s*none/.test(css));
  check('M8f 配色已移出导航、进首页 hero-meta（页头无 .pal，hero-meta 有 #palettePickerH）',
    !homeDoc.querySelector('nav.nav .pal') && !!homeDoc.querySelector('.hero-meta #palettePickerH'));

  check('M9 search.js 已登记进 VERSIONED_ASSETS（长期缓存正则用的就是这一份）', VERSIONED_ASSETS.includes('search.js'));

  // 空检索页没有统计栏，标题下第一条横线仍要与其它页同距（.mast-stat 上沿的 1.1rem）。
  check('M9b 空检索页的标题下横线与其它页同距（1.1rem）',
    /\.mast:not\(:has\(\.mast-stat\)\)\s*\+\s*\.s-form\s*\{\s*margin-top:\s*1\.1rem/.test(css),
    '缺 .mast:not(:has(.mast-stat)) + .s-form { margin-top: 1.1rem }');
  check('M9c 页头工具区不再用竖线「与目录分开」', !/\.nav-tools\s*\{[^}]*border-left/.test(css));

  // 客户端那半：点图标展开输入框；⌘K / Ctrl+K 与 / 也展开并聚焦。search.js 是 IIFE，只能进 DOM 跑。
  {
    const dom = new JSDOM(`<!doctype html><body>${homeDoc.querySelector('nav.nav').outerHTML}</body>`, { runScripts: 'outside-only' });
    dom.window.eval(fs.readFileSync(path.join(ROOT, 'public', 'search.js'), 'utf8'));
    const d = dom.window.document;
    const form = d.querySelector('.nav-search');
    const btn = d.querySelector('.nav-search-btn');
    const input = d.querySelector('.nav-search-input');

    btn.dispatchEvent(new dom.window.MouseEvent('click', { bubbles: true, cancelable: true }));
    check('M10 点图标就地展开搜索框并聚焦',
      form.getAttribute('data-open') === 'true' && btn.getAttribute('aria-expanded') === 'true' && d.activeElement === input,
      `open=${form.getAttribute('data-open')} focus=${d.activeElement?.className}`);

    d.body.dispatchEvent(new dom.window.KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true }));
    check('M10b Esc 收起并清空', form.getAttribute('data-open') === 'false' && input.value === '', `open=${form.getAttribute('data-open')}`);

    d.body.dispatchEvent(new dom.window.KeyboardEvent('keydown', { key: 'k', metaKey: true, bubbles: true, cancelable: true }));
    check('M10c ⌘K 也展开并聚焦', form.getAttribute('data-open') === 'true' && d.activeElement === input, `focus=${d.activeElement?.className}`);

    // 在输入框里打「/」不能被快捷键抢走
    const typed = new dom.window.KeyboardEvent('keydown', { key: '/', bubbles: true, cancelable: true });
    input.dispatchEvent(typed);
    check('M10d 输入框里按「/」不被抢（不 preventDefault）', typed.defaultPrevented === false);

    // pjax 换页会把整条页头换掉：事件委托在 document 上，新节点上的点击仍要生效（曾因闭包缓存旧节点而点不动）。
    d.querySelector('nav.nav').innerHTML = homeDoc.querySelector('nav.nav').innerHTML;
    const btn2 = d.querySelector('.nav-search-btn');
    btn2.dispatchEvent(new dom.window.MouseEvent('click', { bubbles: true, cancelable: true }));
    check('M10e 换页（页头重建）后搜索框仍能展开',
      d.querySelector('.nav-search').getAttribute('data-open') === 'true',
      `open=${d.querySelector('.nav-search')?.getAttribute('data-open')}`);
  }
} finally {
  await srv.stop();
}

process.exit(report() ? 1 : 0);

#!/usr/bin/env node
import './_test-env.mjs';

import { open, close } from '../db/driver.js';
import { SITE } from '../src/config.js';

const { startServer } = await import('./_server.mjs');
const srv = await startServer();
const BASE = srv.base;
const db = open(srv.dbFile);

const { createChecker } = await import('./_check.mjs');
const { check, report } = createChecker();

const SLUG = 'why-single-column';
const page = await (await fetch(`${BASE}/p/${SLUG}/`)).text();

{
  const listPage = await (await fetch(`${BASE}/posts/`)).text();

  check('T4b 刊头统计的字数写成「约 N 字」或「约 N.N 万字」而不是「约 N字」',
    /约 (?:\d[\d,]* 字|\d+(?:\.\d+)? 万字)/.test(listPage)
    && !/约 \d[\d,]*字/.test(listPage)
    && !/约 \d+(?:\.\d+)?万 字/.test(listPage),
    (/约 [^<]*/.exec(listPage) ?? [''])[0]);

  const items = [...listPage.matchAll(/<a[^>]*href="(\/p\/[^"]+)"[\s\S]*?<p class="excerpt">([^<]*)<\/p>/g)]
    .map((m) => ({ href: m[1], text: m[2] }));
  check('T4c 列表页每条都露一段正文开头', items.length > 0 && items.every((x) => x.text.length > 8),
    `${items.length} 条`);
  const first = items[0];
  const article = await (await fetch(BASE + first.href)).text();
  check('T4d 这一段确实来自正文（不是作者存的摘要）',
    Boolean(first) && article.includes(first.text.slice(0, 12)),
    `${first?.href} 摘要=${first?.text.slice(0, 16)}`);
}

{

  const longBody = `<p>${'这段用来把三行填满。'.repeat(12)}</p><p><img src="/uploads/x.png" alt="图"></p>`
    + '<p><a href="https://example.com/"><img src="/uploads/y.png" alt="外链图"></a></p>';
  db.prepare(`INSERT INTO posts(slug,kind,title,body_md,body_html,draft,source,word_count,published_at)
    VALUES('zz-thumb','post','带图测试','x',?,0,'admin',1,'2026-01-01T00:00:00Z')`).run(longBody);
  const listed = await (await fetch(`${BASE}/posts/`)).text();
  check('T4e 文章列表是编年轨：日期列（日号 + 月/年两组）+ 标题 + 摘要',
    /<a class="e-main" href="\/p\/zz-thumb\/">\s*<time [^>]*><b>\d+<\/b><small><span>[^<]+<\/span><span>\d{4}<\/span><\/small><\/time>/.test(listed)
    && /<h2>带图测试<\/h2>/.test(listed), '');
  check('T4f 列表里不再有缩略图（编年轨上只留文字）',
    !/class="thumb"/.test(listed) && !/has-thumb/.test(listed), '');
  check('T4h 0 条评论的条目右端不再挂计数（有评论时才输出，见 T54 的正例）',
    !/<a class="e-comments"[^>]*href="\/p\/zz-thumb\/#comments"/.test(listed)
    && !/class="e-comments"[^>]*>\s*<svg[^>]*e-comments-ico[^>]*><\/svg>0</.test(listed), '');
  const rowExcerpt = /<a class="e-main" href="\/p\/zz-thumb\/">[\s\S]*?<p class="excerpt">([^<]*)<\/p>/.exec(listed)?.[1] ?? '';
  check('T4g 条目带两行预算的摘要', rowExcerpt.length > 60, `${rowExcerpt.length} 字`);
  {
    const article = await (await fetch(`${BASE}/p/zz-thumb/`)).text();
    check('T4i 正文插图挂上灯箱属性，并且同组（data-lightbox = p-<slug>）',
      article.includes('data-lightbox="p-zz-thumb"')
      // 媒体表没有这行时退回原图（站内路径）；只有外站/data 地址才用占位图。
      && /<img src="\/uploads\/x\.png" alt="图"[^>]*data-full="\/uploads\/x\.png"[^>]*data-alt="图"/.test(article), '');
    // 可交互语义由 public/app.js 补，不写死正文里 —— 否则禁 JS 的读者拿到按不动的按钮。
    check('T4i2 正文标记里不带 role="button" / tabindex（那是 JS 补的，禁 JS 时是假按钮）',
      !/role="button"/.test(article) && !/<img[^>]*data-lightbox[^>]*\stabindex=/.test(article), '');
    check('T4j 文章页带上了灯箱弹窗',
      article.includes('id="lightbox"') && article.includes('class="lb-img"'), '');
    check('T4k 包在站外链接里的图片不被灯箱抢走点击（那个链接是作者刻意写的）',
      /<a href="https:\/\/example\.com\/"><img src="\/uploads\/y\.png"[^>]*>/.test(article)
      && !/y\.png"[^>]*data-lightbox/.test(article), '');
  }

  db.prepare("DELETE FROM posts WHERE slug = 'zz-thumb'").run();
}

{
  const long = '这一条用来测试笔记列：正文应当整篇铺开，而不是截成八十八字的摘要。'.repeat(5);
  db.prepare(`INSERT INTO posts(slug,kind,title,body_md,body_html,draft,source,word_count,published_at,comments_on)
    VALUES('zz-note','note','笔记列测试','x',?,0,'admin',1,'2026-02-02T00:00:00Z',1)`)
    .run(`<p>${long}</p><p><img src="/uploads/pic.png" alt="示例图"></p>`);

  const zzid = db.prepare("SELECT id FROM posts WHERE slug = 'zz-note'").get().id;
  db.prepare(`INSERT INTO comments(post_id,parent_id,author,body_md,status,is_author,created_at)
    VALUES(?, NULL, '随手读者', '抽屉里的第一条。', 'approved', 0, '2031-01-01T00:00:00.000Z')`).run(zzid);
  const zzRoot = db.prepare('SELECT id FROM comments WHERE post_id = ? ORDER BY id').get(zzid).id;
  db.prepare(`INSERT INTO comments(post_id,parent_id,author,body_md,status,is_author,created_at)
    VALUES(?, ?, '沉沦', '收到。', 'approved', 1, '2031-01-01T00:00:00.000Z')`).run(zzid, zzRoot);

  const page = await (await fetch(`${BASE}/notes/`)).text();
  const at = page.indexOf('href="/n/zz-note/"');
  const itemStart = at >= 0 ? page.lastIndexOf('<li', at) : -1;
  const slice = itemStart >= 0 ? page.slice(itemStart, page.indexOf('</li>', at) + 5) : '';

  check('T52 笔记列表与文章列表同一套条目（标题 + 摘要 + 评论链接）',
    slice.includes('class="note"') && slice.includes('href="/n/zz-note/"')
    && slice.includes('<h2>笔记列测试') && slice.includes('class="excerpt"'), `长度 ${slice.length}`);
  check('T53 笔记列表不再有折叠行、图集与就地评论抽屉',
    !page.includes('nf-fold') && !page.includes('ncp-slot') && !page.includes('class="gallery"'), '');
  check('T54 评论数（气泡 + 数字）直达笔记详情页的评论区',
    slice.includes('href="/n/zz-note/#comments"') && slice.includes('aria-label="2 条评论"')
    && slice.includes('e-comments-ico'), slice.slice(-200));

  // 评论回刷只保留标准评论区这一套（c-*）；笔记列表不再有抽屉那套（ncp-*）。
  const panel = await (await fetch(`${BASE}/n/zz-note/?partial=comments`)).text();
  check('T54b 笔记详情页的评论回刷仍是标准评论区',
    panel.includes('class="c-list"') && panel.includes('class="c-form"') && !panel.includes('class="ncp'),
    panel.slice(0, 120));

  const css = await (await fetch(`${BASE}/style.css`)).text();
  check('T54c 笔记列表/抽屉的样式已从全量样式表移除',
    !/\.nf-/.test(css) && !/\.ncp-/.test(css), '');

  const notePage = await (await fetch(`${BASE}/n/zz-note/`)).text();
  const noteBodyTag = /<textarea[^>]*name="body"[^>]*>/.exec(notePage)?.[0] ?? '';
  check('T54f 笔记详情页评论区走可见 label（与文章页同一套）',
    /<label for="c-body">内容<\/label>/.test(notePage)
    && !/placeholder=/.test(noteBodyTag), `内页正文框：${noteBodyTag.slice(0, 80)}`);

  check('T55 页面里有灯箱（点正文插图进灯箱看大图）', page.includes('id="lightbox"') && page.includes('class="lb-img"'));

  const homeHtml = await (await fetch(`${BASE}/`)).text();
  check('T56 首页的笔记条目仍是账本行（没被笔记流样式撑高）',
    /<li class="note"><a[^>]*href="\/n\//.test(homeHtml), '');

  db.prepare("DELETE FROM posts WHERE slug = 'zz-note'").run();
}

{
  const css = await (await fetch(`${BASE}/style.css`)).text();
  const js = await (await fetch(`${BASE}/app.js`)).text();
  const body = await (await fetch(`${BASE}/posts/`)).text();
  check('T63 页脚界栏断口里的金星印钮是回顶入口（圆环 + 题签，aria-label 指向保留片段 #top）',
    /<a class="foot-seal" href="#top" aria-label="回到顶部"><span class="foot-seal-star" aria-hidden="true"><\/span><span class="foot-seal-tip" aria-hidden="true">回到顶部<\/span><\/a>/.test(body), '');
  check('T64 右下悬浮回顶钮整体撤掉（全站只留页脚这一处回顶）',
    !/class="to-top"/.test(body) && !/\.to-top/.test(css) && !/to-top/.test(js)
    && /footer\.site \.foot-seal/.test(css), '');
}

{
  // 正文目录：刊物开篇那页「细目」—— 金色两位序号 + 发丝线行 + 末端金线收束。
  // 令牌（:root / 明暗 / 配色预设）在 base.css，组件在 style.css；下面 T66f 要同时读到两层，按加载顺序拼。
  const css = (await Promise.all(['base.css', 'style.css'].map(async (f) => (await fetch(`${BASE}/${f}`)).text()))).join('\n');

  check('T66 文章页的目录仍是「一行抬头 + 两级条目」这套标记（序号不写进 HTML，抬头带一枚展开箭头）',
    /<details class="toc"><summary>目录（\d+ 节）<span class="toc-cue" aria-hidden="true"><\/span><\/summary>/.test(page)
    && /<li class="lvl-2"><a href="#[^"]+">[^<]+<\/a><\/li>/.test(page)
    && !/<li class="lvl-2"><a href="#[^"]+">\s*\d\d/.test(page), '');

  check('T66b 序号由 CSS 计数器算出来（01 / 02 …，两位补零，金色）',
    /details\.toc li\.lvl-2 \{ counter-increment: sec; \}/.test(css)
    && /details\.toc li\.lvl-2 > a::before \{[\s\S]{0,220}content: counter\(sec, decimal-leading-zero\);/.test(css)
    && /details\.toc ol \{[\s\S]{0,80}counter-reset: sec;/.test(css), '');

  check('T66c 目录不再是"带边框的方框"：ol 清掉边框与项目符号，抬头那条线一路延到列宽右缘',
    /details\.toc ol \{\s*list-style: none; margin: 0; padding: 0;\s*border: 0; counter-reset: sec;/.test(css)
    && /details\.toc summary::after \{[\s\S]{0,120}flex: 1 1 auto/.test(css), '');

  check('T66d 原来的小箭头退场（它跟新的发丝线是两套语言）',
    /details\.toc summary::before \{ display: none; \}/.test(css), '');

  check('T66e 分隔线与收束金线都走伪元素，不当底色（否则文字会被审计判成压在渐变上）',
    /details\.toc ol::after \{[\s\S]{0,120}background: var\(--gold\);/.test(css)
    && !/details\.toc (ol|li|summary) \{[^}]*background(-image)?:/.test(css), '');

  {
    // 承载信息的三种色（序号 --accent、一级 --fg-soft、二级 --muted）逐套配色 × 明暗都要过 4.5:1；两层令牌必须分开取，直接当唯一来源会取到 undefined。
    const { PALETTES } = await import('../src/settings.js');
    const lum = (hex) => {
      const c = hex.replace('#', '');
      const [r, g, b] = [0, 2, 4].map((i) => parseInt(c.slice(i, i + 2), 16) / 255)
        .map((v) => (v <= .03928 ? v / 12.92 : ((v + .055) / 1.055) ** 2.4));
      return .2126 * r + .7152 * g + .0722 * b;
    };
    const ratio = (a, b) => { const [x, y] = [lum(a), lum(b)].sort((m, n) => n - m); return (x + .05) / (y + .05); };
    // 用块首那两行锚定，别用裸 `:root {` —— 文件里 `:root` 有三处，第一个不一定是色彩那块。
    const block = (marker) => {
      const at = css.indexOf(marker);
      if (at < 0) return '';
      const open = css.indexOf('{', at), close = css.indexOf('\n}', open);
      return css.slice(open + 1, close);
    };
    const tok = (blocks, name) => {
      for (const b of blocks) { const m = new RegExp(`${name}:\\s*(#[0-9a-fA-F]{6})`).exec(b); if (m) return m[1]; }
      return null;
    };
    const light = block(':root {\n  --bg: #f8f8f8;');
    const dark = block('html[data-theme="dark"] {\n  --bg: #1a1a1a;');
    const cases = [['素笺·浅色', light, ''], ['素笺·深色', dark, '']];
    for (const p of PALETTES.filter((x) => x.key)) {
      cases.push([`${p.name}·浅色`, light, block(`\nhtml[data-palette="${p.key}"] {`)]);
      cases.push([`${p.name}·深色`, dark, block(`\nhtml[data-theme="dark"][data-palette="${p.key}"] {`)]);
    }
    const bad = [];
    for (const [label, themeBlk, paletteBlk] of cases) {
      const bg = tok([paletteBlk, themeBlk], '--bg');
      for (const [what, name] of [['序号', '--accent'], ['一级', '--fg-soft'], ['二级', '--muted']]) {
        const c = tok([paletteBlk, themeBlk], name);
        const r = c && bg ? ratio(c, bg) : 0;
        if (!(r >= 4.5)) bad.push(`${label}·${what} ${r.toFixed(2)}`);
      }
    }
    check('T66f 目录三种文字色在每套配色 × 明暗下都 ≥ 4.5:1', bad.length === 0, bad.slice(0, 4).join(' / '));
  }
}

{
  const html = await (await fetch(`${BASE}/p/fixture-24/`)).text();
  const pager = /<nav class="pager"[\s\S]*?<\/nav>/.exec(html)?.[0] ?? '';
  const kinds = [...pager.matchAll(/href="\/([pn])\//g)].map((m) => m[1]);
  check('T61 文章页的上一篇/下一篇只在文章之间（不跳到笔记）',
    pager.length > 0 && kinds.length > 0 && kinds.every((k) => k === 'p'),
    `链接 ${kinds.join(',') || '无'}`);

  const note = await (await fetch(`${BASE}/n/fixture-note/`)).text();
  const npager = /<nav class="pager"[\s\S]*?<\/nav>/.exec(note)?.[0] ?? '';
  const nkinds = [...npager.matchAll(/href="\/([pn])\//g)].map((m) => m[1]);
  check('T62 笔记页的上一篇/下一篇也只在笔记之间',
    nkinds.every((k) => k === 'n'), `链接 ${nkinds.join(',') || '无'}`);
  // 夹具里这条围栏是 UI 审计的对比度样本：它没了，明暗两套 --hl-* 就再也量不到。
  check('T63 夹具笔记里的围栏代码被服务端高亮（UI 审计靠它量 hljs 配色）',
    /<code class="hljs language-js">/.test(note) && /hljs-keyword/.test(note), '');
}

{
  const row = db.prepare("SELECT id, file_path FROM posts WHERE source = 'file' AND file_path IS NOT NULL ORDER BY id LIMIT 1").get();
  const original = row.file_path;
  db.prepare('UPDATE posts SET file_path = ? WHERE id = ?').run('/nowhere/moved-away.md', row.id);
  const { syncContent } = await import('../src/content/sync.js');
  const { createRepo } = await import('../db/repo.js');
  const result = syncContent(createRepo(db), { quiet: true });
  const after = db.prepare('SELECT file_path FROM posts WHERE id = ?').get(row.id);
  check('T60 文件换了位置时刷新 file_path，而不是被 prune 删掉',
    after && after.file_path === original && result.removed === 0,
    after ? `path=${after.file_path} removed=${result.removed}` : '行被删了');
}

{
  const pages = ['/', '/archive/', '/t/设计/'];
  let bad = [];
  let linked = 0;
  for (const url of pages) {
    const html = await (await fetch(BASE + url)).text();
    bad = bad.concat([...html.matchAll(/href="(\/notes\/\?n=[^"]*)"/g)].map((m) => `${url} → ${m[1]}`));
    linked += (html.match(/href="\/n\//g) ?? []).length;
  }
  const notesHtml = await (await fetch(`${BASE}/notes/`)).text();
  check('T57b 笔记列表的评论链接直达详情页评论区',
    /<a class="e-comments"[^>]*href="\/n\/fixture-note\/#comments"[^>]*>/.test(notesHtml), '');
  check('T57 首页/归档/标签页里的笔记链接都指向正文页',
    bad.length === 0 && linked > 0, `旧列表链接 ${bad.length} 条：${bad.slice(0, 2).join(' ')}；正文链接 ${linked} 条`);

  // /notes/ 与 /posts/ 共用 ?before= 游标；?n=<slug> 不再是笔记列表的入口。
  for (let i = 1; i <= 6; i++) {
    const day = `2024-0${i}-01T00:00:00Z`;
    db.prepare(`INSERT INTO posts(slug,kind,title,body_md,body_html,draft,source,word_count,published_at,comments_on)
      VALUES(?,'note',?,'x','<p>旧笔记。</p>',0,'admin',1,?,1)`).run(`zz-note-old-${i}`, `旧笔记 ${i}`, day);
  }
  db.prepare("INSERT INTO settings(key,value) VALUES('page_size','5') ON CONFLICT(key) DO UPDATE SET value='5'").run();
  const oldest = db.prepare("SELECT slug FROM posts WHERE kind='note' AND draft=0 ORDER BY published_at LIMIT 1").get().slug;
  const firstPage = await (await fetch(`${BASE}/notes/`)).text();
  const beforeHref = /href="(\/notes\/\?before=[^"]+)"/.exec(firstPage)?.[1] ?? '';
  check('T58 笔记列表用 ?before= 翻页（不再有 ?n= 游标）',
    /<p class="pager-more"><a href="\/notes\/\?before=/.test(firstPage) && !/\/notes\/\?n=/.test(firstPage),
    beforeHref);
  const legacy = await fetch(`${BASE}/notes/?n=fixture-note`, { redirect: 'manual' });
  check('T58b 旧 /notes/?n=<slug> 301 到笔记正文页',
    legacy.status === 301 && (legacy.headers.get('location') ?? '').endsWith('/n/fixture-note/'),
    `${legacy.status} ${legacy.headers.get('location')}`);
  const legacyMissing = await fetch(`${BASE}/notes/?n=no-such-note`, { redirect: 'manual' });
  check('T58c 指向不存在笔记的 ?n= 按普通列表展示（不 404、不 301）',
    legacyMissing.status === 200, String(legacyMissing.status));
  const multi = await fetch(`${BASE}${beforeHref}`, { redirect: 'manual' });
  const multiHtml = await multi.text();

  check('T59 更早的笔记在第二页仍可访问',
    multi.status === 200 && multiHtml.includes(`href="/n/${oldest}/"`), `status=${multi.status}`);
  db.prepare("DELETE FROM settings WHERE key = 'page_size'").run();
  db.prepare("DELETE FROM posts WHERE slug LIKE 'zz-note-old-%'").run();
}

{
  check('T1 文章页不再有「相关」区块', !page.includes('class="related"'));
  check('T2 文章页不再有「引用本文」反链区', !page.includes('id="backlinks"') && !page.includes('篇内容引用了本文'));
  check('T3 文章页不再有「永久链接」', !page.includes('永久链接'));
  {

    const go = await fetch(`${BASE}/go/${encodeURIComponent(SLUG)}`, { redirect: 'manual' });
    check('T3b wikilink 跳转仍在（链接数据没被一起删掉）',
      go.status === 301 && (go.headers.get('location') ?? '').endsWith(`/p/${SLUG}/`),
      `status=${go.status} location=${go.headers.get('location') ?? '—'}`);
  }
}

{
  // 分享图取图与正文/灯箱共用 IMG_TAG_RE：alt 里带 `>` 时不能被截成半个标签。
  db.prepare(`INSERT INTO posts(slug,kind,title,body_md,body_html,draft,source,word_count,published_at,comments_on)
    VALUES('zz-og-alt','post','OG 探针','x','<p><img src="/uploads/zz-og.png" alt="a > b"></p>',0,'admin',1,'2026-01-01T00:00:00Z',0)`).run();
  const ogPage = await (await fetch(`${BASE}/p/zz-og-alt/`)).text();
  check('T9c 分享图取 <img> 时不被 alt 里的 > 截断',
    /<meta property="og:image" content="[^"]*\/uploads\/zz-og\.png"/.test(ogPage)
    && /<meta property="og:image:alt" content="a &gt; b"/.test(ogPage), '');
  db.prepare("DELETE FROM posts WHERE slug = 'zz-og-alt'").run();
}

{
  const now = new Date().toISOString().replace(/\.\d{3}Z$/, 'Z');
  const future = new Date(Date.now() + 86400000).toISOString().replace(/\.\d{3}Z$/, 'Z');
  const mk = (slug, draft, published) => {
    const r = db.prepare(`INSERT INTO posts(slug,kind,title,body_md,draft,source,word_count,published_at)
      VALUES(?, 'post', ?, 'x', ?, 'admin', 1, ?)`).run(slug, `ZZ 测试 ${slug}`, draft, published);
    return Number(r.lastInsertRowid);
  };
  const draftId = mk('zz-p2-draft', 1, now);
  const futureId = mk('zz-p2-future', 0, future);

  const after = await (await fetch(`${BASE}/p/${SLUG}/`)).text();
  check('T6 草稿不出现在文章页上', !after.includes('zz-p2-draft') && !after.includes('ZZ 测试 zz-p2-draft'));
  check('T7 定时（未到时间）文章不出现在文章页上', !after.includes('zz-p2-future'));

  db.prepare('DELETE FROM posts WHERE id IN (?, ?)').run(draftId, futureId);
}

{
  const r = await fetch(`${BASE}/missing-fixed-page/`);
  const body = await r.text();
  check('T8 没写内容的固定页返回 404', r.status === 404 && body.includes('404'), `status=${r.status}`);
}

{
  const fs = await import('node:fs');
  const path = await import('node:path');
  const { CONTENT_DIR } = await import('../src/config.js');
  const { createRepo } = await import('../db/repo.js');
  const { syncContent } = await import('../src/content/sync.js');
  const dir = path.join(CONTENT_DIR, 'pages');
  const file = path.join(dir, 'about.md');
  const file2 = path.join(dir, 'colophon.md');
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(file, '---\ntitle: 关于我\nslug: about\ndate: 2026-10-06 12:00\n---\n\n# 你好\n\n固定页正文标记 zz-about-body，还有**加粗**。');
  fs.writeFileSync(file2, '---\ntitle: 版本说明\nslug: colophon\ndate: 2026-10-07 12:00\ncomments: false\n---\n\n本站都是手写的。');
  const file3 = path.join(dir, 'zz-esc.md');
  fs.writeFileSync(file3, '---\ntitle: A <b>B</b>\nslug: zz-esc\ndate: 2026-10-07 13:00\n---\n\n标题里有标签。');
  syncContent(createRepo(db), { quiet: true });
  try {
    const html = await (await fetch(`${BASE}/about/`)).text();
    check('T8c 固定页由内容管线索引并渲染到 /about/（标题 + 渲染后的正文）',
      html.includes('关于我') && html.includes('<strong>加粗</strong>') && html.includes('class="page"'), '');
    check('T8c2 刊头线索词用 slug（不再是写死的 About/Page）',
      html.includes('class="mast-mark">about<') && !html.includes('mast-mark">Page<'), '');
    const posts = await (await fetch(`${BASE}/posts/`)).text();
    const notes = await (await fetch(`${BASE}/notes/`)).text();
    const feed = await (await fetch(`${BASE}/feed.xml`)).text();
    // 固定页会出现在**导航**里（标题），而导航每页都有 —— 所以用正文片段判断它有没有混进列表/Feed，不能拿标题当判据（踩过的坑）。
    const leak = ['posts', 'notes', 'feed'].filter((k) => ({ posts, notes, feed })[k].includes('zz-about-body'));
    check('T8d 固定页不进文章/笔记列表与 Feed（正文不会混进去）', leak.length === 0, `命中 ${leak.join(',') || '无'}`);

    const two = await fetch(`${BASE}/colophon/`);
    const twoHtml = await two.text();
    check('T8f 固定页走通用路由 /<slug>（第二份固定页也能打开）',
      two.status === 200 && twoHtml.includes('版本说明') && twoHtml.includes('class="page"')
      && twoHtml.includes('class="mast-mark">colophon<'), `status=${two.status}`);
    check('T8g 不带结尾斜杠的 /colophon 同样是这一页',
      (await (await fetch(`${BASE}/colophon`)).text()).includes('版本说明'), '');
    check('T8h 通用路由不会凭空造页：不存在的 slug 仍是 404',
      (await fetch(`${BASE}/zz-not-a-page/`)).status === 404, '');
    // 404 有 60s 进程内缓存：命中路径曾用 c.body 返回（默认 text/plain），第二个 404 会变成裸 <pre>。
    // 连打两次、第二次（命中缓存）必须仍是 text/html。
    {
      await fetch(`${BASE}/zz-not-a-page-2/`);
      const again = await fetch(`${BASE}/zz-not-a-page-2/`);
      const ctype = again.headers.get('content-type') ?? '';
      check('T8h2 缓存命中的 404 仍是 text/html（不是裸文本 <pre>）',
        again.status === 404 && ctype.includes('text/html'),
        `status=${again.status} type=${ctype}`);
    }
    check('T8i 导航高亮当前这一页（固定页各自高亮自己）',
      html.includes('href="/about" aria-current="page"')
      && twoHtml.includes('href="/colophon" aria-current="page"'), '');

    const navNow = (await (await fetch(`${BASE}/`)).text()).match(/<nav class="nav"[\s\S]*?<\/nav>/)?.[0] ?? '';
    check('T8j 新发布的固定页自动进导航（标签 = 页面标题，按发布时间排在内容入口之后）',
      navNow.includes('href="/colophon"') && navNow.includes('>版本说明</span></a>')
      && navNow.indexOf('href="/archive/"') < navNow.indexOf('href="/about"')
      && navNow.indexOf('href="/about"') < navNow.indexOf('href="/colophon"'),
      navNow.replace(/\s+/g, ' ').slice(0, 200));
    // 页面标题是用户内容：进导航前必须转义（标题里塞 <b> 只能是文字）
    check('T8k 导航里的页面标题被转义',
      navNow.includes('A &lt;b&gt;B&lt;/b&gt;') && !navNow.includes('A <b>B</b>'), '');
    check('T8e 固定页逐条进了 sitemap',
      (await (await fetch(`${BASE}/sitemap.xml`)).text()).includes('/about')
      && (await (await fetch(`${BASE}/sitemap.xml`)).text()).includes('/colophon'), '');
  } finally {
    fs.rmSync(file, { force: true });
    fs.rmSync(file2, { force: true });
    fs.rmSync(file3, { force: true });
    db.prepare("DELETE FROM posts WHERE slug IN ('about', 'colophon', 'zz-esc') AND kind = 'page'").run();
  }
}

{
  // 中文 slug 的笔记抽屉：suffix 不能只认 ASCII，否则两篇抽屉会撞 c-author/c-body 这些 id。
  const fs = await import('node:fs');
  const path = await import('node:path');
  const { CONTENT_DIR } = await import('../src/config.js');
  const { createRepo } = await import('../db/repo.js');
  const { syncContent } = await import('../src/content/sync.js');
  const slug = '中文笔记';
  const file = path.join(CONTENT_DIR, 'notes', `${slug}.md`);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, '---\ntitle: 中文笔记\ndate: 2026-10-08\n---\n中文 slug 的正文。');
  try {
    syncContent(createRepo(db), { quiet: true });
    const url = `${BASE}/n/${encodeURIComponent(slug)}/?partial=comments`;
    const html = await (await fetch(url)).text();
    check('T8m 中文 slug 的笔记详情页评论区正常',
      html.includes('id="comments"') && html.includes('id="c-body"') && html.includes('class="c-form"'), html.slice(0, 120));
  } finally {
    fs.rmSync(file, { force: true });
    db.prepare('DELETE FROM posts WHERE slug = ? AND kind = ?').run(slug, 'note');
    syncContent(createRepo(db), { quiet: true });
  }
}

{
  const { validateSlug } = await import('../src/util/text.js');
  check('T8n 固定页 slug 不允许占用 /search 与 /links 路由',
    Boolean(validateSlug('search', 'page')) && Boolean(validateSlug('links', 'page'))
    && validateSlug('search', 'post') === null, '');
}

{
  // 路径参数已由 Hono 解码（`%zz` 坏转义原样返回）；路由里再 decodeURIComponent 会抛 URIError 变成 500 —— 应干净 404。
  const codes = [];
  for (const path of ['/p/100%25/', '/p/%zz/', '/n/100%25/', '/go/100%25']) {
    codes.push((await fetch(BASE + path, { redirect: 'manual' })).status);
  }
  check('T8b 路径里的坏转义/百分号返回 404，而不是 500',
    codes.every((c) => c === 404), codes.join(','));
}

{
  const js = await (await fetch(`${BASE}/app.js`)).text();

  check('T9 增强层不再含浮层面板，也没有打开它的快捷键',
    !js.includes('cmdk') && !(/metaKey|ctrlKey/.test(js) && js.includes("'k'")));
  const uiJs = await (await fetch(`${BASE}/ui.js`)).text();
  check('T10 明暗切换已并入「配色」浮层（ui.js 出三态按钮，app.js 不再碰页脚那枚）',
    uiJs.includes('pal-tm') && uiJs.includes('__theme') && !js.includes('themeToggle'));
  const homeFoot = await (await fetch(`${BASE}/`)).text();
  const postFoot = await (await fetch(`${BASE}/p/${SLUG}/`)).text();
  check('T10b 页脚不再放后台入口（低频操作不占页脚）',
    !/<footer class="site">[\s\S]*?href="\/admin"[\s\S]*?<\/footer>/.test(homeFoot)
    && !/<footer class="site">[\s\S]*?href="\/admin"[\s\S]*?<\/footer>/.test(postFoot), '');
  check('T11 增强层不再拉搜索结果', !js.includes('/api/search'));
}

{
  const home = await (await fetch(`${BASE}/`)).text();

  check('T17 首页是封面 + 最近几条（不是整份列表）',
    home.includes('class="hero"') && home.includes('class="recent"')
    && home.includes('class="entries') && !home.includes('class="list"'), '');
  check('T18 导航第一项是「首页」并高亮', /<a href="\/" aria-current="page"><svg class="n-ico"[\s\S]*?<span class="n-txt">首页<\/span><\/a>/.test(home), '');
  check('T19 首页仍有栏目入口（无 JS 也能走）',
    home.includes('href="/posts/"') && home.includes('href="/notes/"') && home.includes('class="hero-meta"'), '');

  // 首页轮播从第 2 张起 lazy：缺 width/height 换图时会顶动正文（CLS）。夹具默认无首页图，这里塞两张假路径（只看标记）。
  {
    const { createRepo } = await import('../db/repo.js');
    createRepo(db).setSetting('hero_images', JSON.stringify([
      { path: '/uploads/2026/01/hero-a.png', w: 1200, h: 800 },
      { path: '/uploads/2026/01/hero-b.png', w: 1200, h: 800 },
    ]));
    const homeWithHero = await (await fetch(`${BASE}/`)).text();
    const lazy = [...homeWithHero.matchAll(/<img\b[^>]*>/gi)].map((m) => m[0]).filter((t) => /loading="lazy"/.test(t));
    check('T19b 首页轮播的懒加载图都带 width/height（避免 CLS）',
      lazy.length >= 1 && lazy.every((t) => /\bwidth="/.test(t) && /\bheight="/.test(t)), `${lazy.length} 张`);
    // 只写 width/height 时算出的 aspect-ratio 带 `auto` 前缀，懒加载审计会判没设比例；行内 aspect-ratio 才被都认。
    check('T19c 首页轮播的懒加载图带行内 aspect-ratio（与正文插图同一套标记）',
      lazy.length >= 1 && lazy.every((t) => /style="aspect-ratio:\d+\/\d+"/.test(t)), `${lazy.length} 张`);
    // Chrome 的 LazyLoadImageIssue 会盯上网格里的轮播图：只写 width:auto 时首帧先算成极小尺寸；给 slide 确定宽度后首帧即稳。
    const css = await (await fetch(`${BASE}/style.css`)).text();
    check('T19d 轮播 slide 有确定宽度（消除首帧 0 尺寸导致的 Chrome 懒加载告警）',
      /\.hero-figure\s+\.hero-slide\s*\{[^}]*width:\s*100%/.test(css), '');
  }

  const newest = db.prepare(`SELECT slug, published_at FROM posts
    WHERE kind = 'post' AND draft = 0 ORDER BY published_at DESC LIMIT 1`).get();
  const p1 = await (await fetch(`${BASE}/posts/`)).text();
  const p2 = await (await fetch(`${BASE}/posts/?before=${encodeURIComponent(newest.published_at)}`)).text();
  check('T20 /posts/ 第一页含最新文章', p1.includes(`/p/${newest.slug}/`), newest.slug);
  check('T21 分页游标 ?before= 真的翻页了（第二页不含最新那篇）',
    p2.includes('class="list"') && !p2.includes(`/p/${newest.slug}/`), '');
  check('T22 /posts/ 的导航高亮是「文章」而不是「首页」',
    /aria-current="page"><svg[\s\S]*?<span class="n-txt">文章<\/span>/.test(p1)
    && !/aria-current="page"><svg[\s\S]*?<span class="n-txt">首页<\/span>/.test(p1), '');

  check('T23 /posts/ 不再有导语', !p1.includes('class="intro"'), '');
  const notesHtml = await (await fetch(`${BASE}/notes/`)).text();
  check('T24 /notes/ 不再有导语', !notesHtml.includes('class="intro"'), '');
  check('T25 /posts/ 的 meta description 仍在（导语转成了描述）',
    /<meta name="description" content="长文。偶尔写，写就写透。">/.test(p1), '');
  check('T26 /notes/ 的 meta description 仍在',
    /<meta name="description" content="还没长成文章的碎片/.test(notesHtml), '');
  check('T27 首页不再包含辅助导语',
    !home.includes('class="intro"'), '');

  check('T28 首页不再有那句引文与出处（HTML 里也没有）',
    !home.includes('hero-lede') && !home.includes('hero-source') && !home.includes('class="tagline"'), '');

  {

    const recentItems = [...home.matchAll(/<li(?: class="note")?><a /g)].length;
    const archiveItems = [...(await (await fetch(`${BASE}/archive/`)).text()).matchAll(/data-reveal/g)].length;

    // 首页账本只挂 entries-rel（相对时间），列宽按相对时间算就够；顺手挂 dated 会把日期列撑到完整日期宽。
    check('T41 首页"最近更新"的条目直接显示，且只挂 entries-rel',
      home.includes('class="entries entries-rel"') && !home.includes('entries-dated') && recentItems > 0,
      `${recentItems} 条`);
    check('T42 归档页的账本不挂浮入（保持可扫读）', archiveItems === 0, `${archiveItems} 条`);

    const relTimes = [...home.matchAll(/<time datetime="(\d{4}-\d{2}-\d{2})" title="(\d{4}-\d{2}-\d{2})"[^>]*>([^<]+)<\/time>/g)];
    const relOk = relTimes.length > 0
      && relTimes.every((m) => m[1] === m[2])
      && relTimes.some((m) => /前$|昨天|前天|刚刚/.test(m[3]));
    check('T49 首页"最近更新"用相对日期，精确日期仍在 datetime/title 上',
      relOk, `相对日期 ${relTimes.length} 条 / 共 ${recentItems} 条`);
    check('T43 刊头里没有站名，导航独占整条（row-solo）',
      !home.includes('class="brand"') && home.includes('class="row row-solo"'), '');
    check('T44 页脚两行：第一行版权（sr-only © + 矢量符号 + 年份[· 署名]），第二行备案号',
      /<span class="foot-copy"><span class="sr-only">©<\/span><svg [\s\S]{0,300}?> \d{4}(?:<span class="sep">·<\/span>[^<]+)?<\/span>/.test(home) && home.includes('class="foot-beian"'), '');

    check('T45 无站名时 <title> 与 og:site_name 退回域名，不是空的',
      SITE.identity.length > 0
      && home.includes(`<title>${SITE.identity}</title>`)
      && home.includes(`og:site_name" content="${SITE.identity}"`), SITE.identity);
    check('T46 内页 <title> 就是页面标题，不再拖一串"· 站名"',
      /<title>文章<\/title>/.test(p1), '');
  }

  const navBlock = (home.match(/<nav class="nav"[\s\S]*?<\/nav>/) ?? [''])[0];
  const navLinks = [...navBlock.matchAll(/href="([^"]+)"/g)].map((m) => m[1]);
  let dead = [];
  for (const href of navLinks) {
    const r = await fetch(BASE + href);
    if (r.status !== 200) dead.push(`${href}→${r.status}`);
  }
  check('T32 导航里每个链接都能打开（不留死链）', navLinks.length >= 4 && dead.length === 0, dead.join(' '));
  // 导航是固定集合：六项内容入口 + 已发布固定页，末位永远是「关于」。新增一项时这条会红 ——
  // 那是它的用途：逼人确认真的要多一个入口。这里只钉前六项顺序与「友圈、友链都在归档之前」。
  check('T33 导航前六项顺序固定，「友圈」「友链」都在归档之前',
    navLinks.length >= 6
    && navLinks.slice(0, 6).join(' ') === '/ /posts/ /notes/ /friends/ /links/ /archive/'
    && ['首页', '文章', '笔记', '友圈', '友链', '归档'].every((t) => navBlock.includes(t)),
    navLinks.join(' '));

  check('T34 搜索按钮不再显示 ⌘K 提示', !home.includes('⌘K'), '');
  const nf = await (await fetch(`${BASE}/no-such-page-xyz`)).text();
  // 404 不再放「首页 / 归档」按钮（导航里本来就有），去处改成检索框与最近更新。
  check('T35 404 页面不提 ⌘K，且给出去处（检索框 + 最近更新）',
    !nf.includes('⌘K') && nf.includes('post-404-search') && nf.includes('recent-404'), '');
  // 404 的「最近更新」没有月份上下文，日期必须走相对时间；只印一个「16」看不出是哪天。
  check('T35b 404 的最近更新用相对日期', nf.includes('class="entries entries-rel"'), '');

  const archiveHtml = await (await fetch(`${BASE}/archive/`)).text();

  check('T30 /archive/ 也没有导语（导航高亮已说明位置）',
    !archiveHtml.includes('class="intro"') && archiveHtml.includes('class="mast"'), '');

  check('T31b 归档页只剩页首与年谱（索引段已随标签一起删除）',
    !archiveHtml.includes('class="dex"') && !archiveHtml.includes('id="tags"')
    && archiveHtml.includes('class="chron"'), '');

  check('T31 /archive/ 的 meta description 仍在（只是不再渲染成文字）',
    /<meta name="description" content="全部文章与笔记/.test(archiveHtml), '');

  {
    const listItems = (html) => [...html.matchAll(/<li([^>]*)>/g)].map((m) => m[1]);
    const notesHtml = await (await fetch(`${BASE}/notes/`)).text();
    const postsHtml = await (await fetch(`${BASE}/posts/`)).text();
    const postItems = listItems(postsHtml);

    const noteItems = [...notesHtml.matchAll(/<li class="note">/g)].length;
    const noteReveals = [...notesHtml.matchAll(/data-reveal/g)].length;
    check('T36 /notes/ 与 /posts/ 使用同一套列表标记（.list ul + .e-main 条目）',
      notesHtml.includes('<ul class="list" data-kind="note">') && noteItems > 0
      && notesHtml.includes('class="e-main"') && !/nf-fold|ncp-slot/.test(notesHtml), `${noteItems} 条`);
    check('T36b /notes/ 的条目没有入场动画标记',
      noteItems > 0 && noteReveals === 0, `${noteReveals}/${noteItems} 条`);
    check('T37 /posts/ 的列表标了 data-kind="post"，条目都不带 .note',
      postsHtml.includes('<ul class="list" data-kind="post">')
      && postItems.length > 0 && postItems.every((a) => !a.includes('class="note"')),
      `${postItems.length} 条`);
    check('T38 /archive/ 混排页里两种文体各自带标记',
      /<li class="note"><a[^>]*href="\/n\//.test(archiveHtml) && /<li><a[^>]*href="\/p\//.test(archiveHtml), '');

    const noteSlug = /href="\/n\/([^"/]+)\//.exec(notesHtml)?.[1];
    const postSlug = /href="\/p\/([^"/]+)\//.exec(postsHtml)?.[1];
    const notePage = noteSlug ? await (await fetch(`${BASE}/n/${noteSlug}/`)).text() : '';
    const postPage = postSlug ? await (await fetch(`${BASE}/p/${postSlug}/`)).text() : '';
    check('T39 两种详情页版式一致：都带 data-kind，都显示阅读时长',
      notePage.includes('data-kind="note"') && postPage.includes('data-kind="post"')
      && /约 \d+ 分钟/.test(notePage) && /约 \d+ 分钟/.test(postPage),
      `${noteSlug} / ${postSlug}`);

    // 令牌层（:root / 明暗 / 配色预设 / 模态锁）在 base.css，组件在 style.css；页面里按这个顺序加载。
    const css = (await Promise.all(['base.css', 'style.css'].map(async (f) => (await fetch(`${BASE}/${f}`)).text()))).join('\n');

    check('T51 首屏直接显示，不再有淡入动画',
      !/animation:\s*rise|@keyframes\s+rise/.test(css), '');

    {
      const entriesA = /^\.entries a \{([^}]*)\}/m.exec(css)?.[1] ?? '';
      const listMain = /\.list li > \.e-main \{([^}]*)\}/.exec(css)?.[1] ?? '';
      {
      // 配色可用性：正文/次要色对背景必须达到 WCAG AA（防止看着高级把文字调得过浅）
      const lum = (hex) => {
        const ch = [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16) / 255)
          .map((v) => (v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4));
        return 0.2126 * ch[0] + 0.7152 * ch[1] + 0.0722 * ch[2];
      };
      const ratio = (a, b) => {
        const [hi, lo] = [lum(a), lum(b)].sort((x, y) => y - x);
        return (hi + 0.05) / (lo + 0.05);
      };
      const tok = (name) => (new RegExp(`--${name}:\\s*(#[0-9a-fA-F]{6})`).exec(css) || [])[1];
      const bg = tok('bg');
      check('T50e 浅色主题的文字色对背景均达 WCAG AA 4.5:1（正文/次要/金色）',
        ratio(tok('muted'), bg) >= 4.5 && ratio(tok('accent'), bg) >= 4.5 && ratio(tok('fg-soft'), bg) >= 4.5,
        `muted=${ratio(tok('muted'), bg).toFixed(2)} accent=${ratio(tok('accent'), bg).toFixed(2)} fg-soft=${ratio(tok('fg-soft'), bg).toFixed(2)}`);
      check('T50f 次要标签色不低于 3:1（仅用于分隔符等装饰）',
        ratio(tok('muted-soft'), bg) >= 3,
        `muted-soft=${ratio(tok('muted-soft'), bg).toFixed(2)}`);
    }

    check('T50d 文章列表悬停不铺底色（那条浅金渐变已删），行文字仍内收、上下细线仍通栏',
        entriesA && !/margin:\s*0\s+-/.test(entriesA)
        && /padding:\s*[^;]*[\d.]+rem\s+[\d.]+rem/.test(entriesA)
        && listMain && /padding-inline:\s*\.6rem/.test(listMain)
        // 悬停底色已去掉（`li:hover::before` 不该再有，想加回来这条先拦）；`li::before` 现在是 1px 编年竖线。
        && !/\.list li:hover::before/.test(css)
        && /\.list li::before \{[^}]*width: 1px/.test(css)
        && /\.list li::after \{[^}]*left: 0; right: 0/.test(css),
        `entries=${entriesA.trim().slice(0, 50)} | list=${listMain.trim().slice(0, 50)}`);
    }

    // 账本分隔线必须是通栏实色；首页行悬停改成左缘金线（不铺底色），其它页仍保留整行悬停底色。
    check('T50d2 账本分隔线不做渐变；首页悬停走左缘金线、不铺底色',
      /\.entries li::after \{[^}]*background: var\(--rule\)/.test(css)
      && /\.entries a:hover \{ background: var\(--accent-soft\); \}/.test(css)
      && /body\[data-page="home"\] \.recent \.entries a:hover \{ background: transparent; \}/.test(css)
      && /body\[data-page="home"\] \.recent \.entries a:hover::before/.test(css),
      '账本分隔线应为实色；首页悬停应走左缘金线');

    // 归档每个年份都靠 .chron 的 1.5rem 上内距拉开与分割线的距离；首年不能单独换成 --section-inset。
    check('T50h 归档首年与后续年份距上分割线一致',
      /\.chron \{[^}]*padding-top:\s*1\.5rem/.test(css)
      && !/\.mast \+ \.chron[^{]*\{[^}]*padding-top/.test(css),
      '首年不应单独覆盖 .chron 的 padding-top');
    check('T50i 审核页手机端：源文可换行、操作按钮整列',
      /\.prose pre\.mod-source \{[^}]*white-space:\s*pre-wrap/.test(css)
      && /\.mod-form \.c-actions \{[^}]*flex-direction:\s*column/.test(css),
      '审核页窄屏操作按钮与源文换行规则缺失');

    check('T50b 浮窗打开时锁住背后的页面；笔记列表已无评论抽屉，全量样式里也没有它的规则',
      /html:has\(dialog\[open\]\)/.test(css) && /html\.modal-open \{ overflow: hidden/.test(css)
      && !/\.ncp-(?:slot|mask|form|list)/.test(css)
      && !/\.nf-(?:fold|sum|panel|meta)/.test(css), '');
    check('T50c 灯箱同样掐断滚动链', /\.lightbox\s*\{[^}]*overscroll-behavior:\s*contain/.test(css), '');
    // 笔记列表与文章列表共用同一套行几何，不再有折叠层的 0fr/常驻内距那套。
    check('T50g 笔记列表与文章列表共用行几何（.list .e-meta / .list h2::before 仍在）',
      /\.list \.e-meta \{/.test(css) && /\.list h2::before \{/.test(css)
      && !/\.nf-/.test(css), '');

    check('T47 页头不吸顶，也没有靠 JS 记滚动状态的 .stuck（页头随正文滚走，不需要滚动监听）',
      !/header\.site \{[^}]*position:\s*sticky/.test(css)
      && !/html\.is-scrolled header\.site/.test(css)
      && !/\.stuck\s*[{,]/.test(css)
      && !/classList\.toggle\('stuck'/.test(await (await fetch(`${BASE}/app.js`)).text()),
      '页头仍在吸顶，或残留了滚动状态类');
    check('T47e 导航按钮不画下划线：悬浮与当前项靠字色、字重和金图标区分',
      !/\.nav a::after/.test(css)
      && !/\.nav \.nsub > summary::after/.test(css)
      && !/\.nav a\[aria-current="page"\]::after/.test(css)
      && /\.nav a\[aria-current="page"\] \{[^}]*color:\s*var\(--fg\)/.test(css)
      && /\.nav a\[aria-current="page"\] \.n-ico \{[^}]*color:\s*var\(--accent\)/.test(css), '');
    check('T47b 各页 header 等高：首页不再单独改 padding，行高有下限兜住被隐藏的站名',
      !/body\[data-page="home"\] header\.site \{[^}]*padding/.test(css)
      && /header\.site \.row \{[\s\S]{0,240}min-height/.test(css), '');

    check('T47c 首页封面收紧留白，内页刊头保留阅读节奏',
      /--page-top:\s*clamp/.test(css)
      && /\.hero \{[^}]*padding:\s*clamp\(1\.5rem, 3vw, 2\.2rem\)/.test(css)
      && /\.mast \{[^}]*padding:\s*var\(--page-top\)/.test(css), '');

    check('T47d 首页不再单独改导航间距：四项间距与内页一致',
      !/body\[data-page="home"\] header\.site \.nav \{[^}]*gap/.test(css)
      && /\.nav \{[^}]*gap:\s*clamp/.test(css), '');

    check('T40 样式里没有按文体分叉的规则',
      !/\[data-kind="note"\]/.test(css)
      && !/\.list li\.note[\s{,]/.test(css)
      && !/\.entries li\.note[\s{,]/.test(css),
      'CSS 里仍有按文体分叉的选择器');
  }
}

{
  const home = await (await fetch(`${BASE}/`)).text();
  check('T57 首页有 WebSite JSON-LD、manifest、apple-touch-icon 与 JSON Feed 发现',
    /<script type="application\/ld\+json">\{"@context":"https:\/\/schema\.org","@type":"WebSite"/.test(home)
    && home.includes('<link rel="manifest" href="/site.webmanifest">')
    && /<link rel="apple-touch-icon" href="\/apple-touch-icon\.png\?v=/.test(home)
    && /<link rel="alternate" type="application\/feed\+json"/.test(home), '');

  // zz-note 在 T55 之后已被删掉；取当前库里真实存在的一篇已发布笔记。
  const noteSlug = db.prepare("SELECT slug FROM posts WHERE kind='note' AND draft=0 ORDER BY published_at DESC LIMIT 1").get()?.slug;
  const noteHtml = await (await fetch(`${BASE}/n/${encodeURIComponent(noteSlug)}/`)).text();
  check('T57b 内容页叠 BlogPosting + BreadcrumbList，article:modified_time 是 ISO 8601',
    /"@type":"BlogPosting"/.test(noteHtml) && /"@type":"BreadcrumbList"/.test(noteHtml)
    && /<meta property="article:published_time" content="\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?Z">/.test(noteHtml)
    && /<meta property="article:modified_time" content="\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?Z">/.test(noteHtml)
    && !/article:modified_time" content="\d{4}-\d{2}-\d{2} /.test(noteHtml), '');

  const manifest = await (await fetch(`${BASE}/site.webmanifest`)).json();
  check('T57c manifest 是合法 JSON，三个图标都带内容指纹',
    manifest.name && manifest.start_url === '/' && manifest.icons.length === 3
    && manifest.icons.every((i) => /\.png\?v=[0-9a-f]{10}$/.test(i.src))
    && manifest.icons.some((i) => i.purpose === 'maskable'), '');
  check('T57c2 manifest 背景/主题色跟随默认配色的纸色',
    manifest.background_color === '#f8f8f8' && manifest.theme_color === '#f8f8f8', JSON.stringify({ bg: manifest.background_color, theme: manifest.theme_color }));

  const robots = await (await fetch(`${BASE}/robots.txt`)).text();
  check('T57d robots 挡掉后台、审核与检索入口',
    /Disallow: \/admin\b/.test(robots) && /Disallow: \/moderate\//.test(robots) && /Disallow: \/search\b/.test(robots), '');

  const sitemap = await (await fetch(`${BASE}/sitemap.xml`)).text();
  check('T57e sitemap 收录年归档页，并给列表页 lastmod',
    /<loc>[^<]*\/a\/20\d\d<\/loc><lastmod>/.test(sitemap)
    && /<loc>[^<]*\/posts\/<\/loc><lastmod>/.test(sitemap)
    && /<loc>[^<]*\/notes\/<\/loc><lastmod>/.test(sitemap), '');

  const sectionRedirect = await fetch(`${BASE}/posts?x=1`, { redirect: 'manual' });
  check('T57f 目录页统一带尾斜杠：旧地址 301 且保留查询串',
    sectionRedirect.status === 301 && sectionRedirect.headers.get('location') === '/posts/?x=1',
    `${sectionRedirect.status} ${sectionRedirect.headers.get('location')}`);
  const postsPage = await (await fetch(`${BASE}/posts/`)).text();
  check('T57g 列表页 canonical 与站内链接同形（带尾斜杠）',
    /<link rel="canonical" href="[^"]*\/posts\/"/.test(postsPage), '');
}

{
  const home = await fetch(`${BASE}/`, { headers: { 'Accept-Encoding': 'gzip' } });
  const etag = home.headers.get('etag');
  check('T58 匿名 HTML 发弱 ETag，并自带 gzip（Cloudflare 认 no-transform 才肯透传校验值）',
    /^W\/"[^"]+"$/.test(etag || '') && home.headers.get('content-encoding') === 'gzip'
    && /no-transform/.test(home.headers.get('cache-control') || '') && /accept-encoding/i.test(home.headers.get('vary') || ''),
    `${etag} / ${home.headers.get('content-encoding')} / ${home.headers.get('cache-control')}`);
  const cached = await fetch(`${BASE}/`, { headers: { 'If-None-Match': etag } });
  check('T58b 命中 If-None-Match 回 304 且无响应体', cached.status === 304 && (await cached.text()).length === 0, String(cached.status));
  const brotli = await fetch(`${BASE}/`, { headers: { 'Accept-Encoding': 'br' } });
  check('T58c 浏览器接受 Brotli 时 HTML 走 br，仍保留弱 ETag',
    brotli.headers.get('content-encoding') === 'br' && /^W\/"[^"]+"$/.test(brotli.headers.get('etag') || ''),
    `${brotli.headers.get('content-encoding')} / ${brotli.headers.get('etag')}`);

  // 取一篇老文章（相对日期按天走，不在分钟边界上抖）。缓存命中时正文（含令牌）原样复用，
  // ETag 仍把令牌归一化到小时档，连续两次请求应一致、第二次能 304。
  const oldSlug = db.prepare("SELECT slug FROM posts WHERE kind='post' AND draft=0 ORDER BY published_at ASC LIMIT 1").get()?.slug;
  const first = await fetch(`${BASE}/p/${encodeURIComponent(oldSlug)}/`);
  const firstBody = await first.text();
  const second = await fetch(`${BASE}/p/${encodeURIComponent(oldSlug)}/`);
  const secondBody = await second.text();
  check('T58c 缓存命中复用同一份正文与令牌，ETag 相同',
    /name="ts" value="([^"]+)"/.exec(firstBody)?.[1] === /name="ts" value="([^"]+)"/.exec(secondBody)?.[1]
    && Boolean(first.headers.get('etag')) && first.headers.get('etag') === second.headers.get('etag'),
    `${first.headers.get('etag')} / ${second.headers.get('etag')}`);
  const cachedArticle = await fetch(`${BASE}/p/${encodeURIComponent(oldSlug)}/`, { headers: { 'If-None-Match': first.headers.get('etag') ?? '' } });
  check('T58d 文章页连续访问同样能 304', cachedArticle.status === 304, `${first.status} → ${cachedArticle.status}`);

  const admin = await fetch(`${BASE}/`, { headers: { Cookie: 'blog_admin=whatever' } });
  check('T58e 带后台 cookie 的 HTML 不发 ETag，且 Cache-Control 为 private, no-store',
    !admin.headers.get('etag') && /no-store/.test(admin.headers.get('cache-control') || ''),
    `${admin.headers.get('etag')} / ${admin.headers.get('cache-control')}`);
}

close(db);
await srv.stop();
process.exit(report() ? 1 : 0);

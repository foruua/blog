import './_test-env.mjs';
import fs from 'node:fs';
import path from 'node:path';
import { cookieJar, createClient, csrfOf, loginAdmin } from './_shared.mjs';
import { open } from '../db/driver.js';
import { CONTENT_DIR, UPLOADS_DIR, DATA_DIR } from '../src/config.js';
import { toLocalInput } from '../src/util/text.js';

const { startServer } = await import('./_server.mjs');
const srv = await startServer();
const BASE = srv.base;
const DB_FILE = srv.dbFile;
import { requireAdminPassword } from './_admin-password.mjs';

const PASSWORD = requireAdminPassword('test-admin.mjs');
const PREFIX = 'zz-test-';

const db = open(DB_FILE);

const { createChecker, sleep, waitFor } = await import('./_check.mjs');
const { check, report, out } = createChecker();

const jar = cookieJar();
const client = createClient(BASE, jar);
const req = async (url, opts = {}) => {
  if (url === '/admin/save' || url === '/admin/api/autosave') {
    if (opts.body instanceof URLSearchParams && opts.body.get('id') && !opts.body.has('version')) {
      opts.body.set('version', String(db.prepare('SELECT version FROM posts WHERE id=?').get(Number(opts.body.get('id')))?.version ?? 0));
    } else if (typeof opts.body === 'string' && opts.headers?.['Content-Type'] === 'application/json') {
      const data = JSON.parse(opts.body); if (data.id && !Object.hasOwn(data,'version')) { data.version = db.prepare('SELECT version FROM posts WHERE id=?').get(Number(data.id))?.version; opts.body = JSON.stringify(data); }
    }
  }
  return client(url, opts);
};
const html = async (url) => (await req(url)).text();


const sharp = (await import('sharp')).default;
const PNG_1x1 = await sharp({ create: { width: 1, height: 1, channels: 4, background: '#ff3300' } }).png().toBuffer();
const PNG_RAW = await sharp({ create: { width: 2, height: 2, channels: 4, background: '#33aaff' } }).png().toBuffer();
// 最小的 MP4 头：ftyp + moov/trak/tkhd（1920×1080）。只用于确认视频上传会被拒，不要求能解码播放。
const mp4Box = (type, payload) => {
  const b = Buffer.alloc(8 + payload.length);
  b.writeUInt32BE(8 + payload.length, 0); b.write(type, 4, 'latin1'); payload.copy(b, 8);
  return b;
};
const tkhdPayload = Buffer.alloc(84);
tkhdPayload.writeUInt32BE(1920 * 65536, 76);
tkhdPayload.writeUInt32BE(1080 * 65536, 80);
const FAKE_MP4 = Buffer.concat([
  mp4Box('ftyp', Buffer.concat([Buffer.from('isom'), Buffer.from('isom')])),
  mp4Box('moov', mp4Box('trak', mp4Box('tkhd', tkhdPayload))),
]);

const created = [];
const createdFiles = [];

console.log('\n后台端到端测试');
console.log('────────────────────────────────────────────');

{
  jar.cookie = '';
  const r = await req('/admin');
  check('T1a 未登录访问 /admin 被重定向到登录页', r.status === 303 && (r.headers.get('location') ?? '').includes('/admin/login'), `status=${r.status}`);
  const r2 = await req('/admin/api/autosave', { method: 'POST', body: '{}' });
  check('T1b 未登录调 API 返回 401 而不是重定向', r2.status === 401, `status=${r2.status}`);
  const r3 = await req('/admin/hero', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ url: 'https://evil.test/x.jpg', _csrf: 'x' }),
  });
  check('T1c 未登录改不了首页封面', r3.status === 303 && (r3.headers.get('location') ?? '').includes('/admin/login'), `status=${r3.status}`);
}

{
  const r = await loginAdmin(req, 'definitely-wrong');
  check('T2a 错误密码被拒', (r.headers.get('location') ?? '').includes('e=bad'), r.headers.get('location') ?? '');

  const r2 = await loginAdmin(req, PASSWORD);
  check('T2b 正确密码登录成功', r2.status === 303 && jar.cookie.startsWith('blog_admin='), `status=${r2.status}`);
  const r3 = await req('/admin');
  check('T2c 登录后后台可访问', r3.status === 200, `status=${r3.status}`);

  if (!jar.cookie.startsWith('blog_admin=')) {
    console.error(out.join('\n'));
    console.error(`
  ✗ 后台登录失败，测试无法继续。

  按 Location 看是哪一种失败：
    curl -s -i -X POST -d "password=<ADMIN_PASSWORD>&to=/admin" \\
      http://127.0.0.1:8787/admin/login | grep -i ^location
      → /admin                     成功
      → /admin/login?e=bad         密码与数据库不一致
      → /admin/login?e=limited     登录尝试过于频繁，等 15 分钟再试

  口令来自环境变量 ADMIN_PASSWORD：npm test 会为每个套件生成临时口令与临时库，
  正常情况下不需要手填。单独跑本脚本时自己给一个，别用真实后台密码：
    ADMIN_PASSWORD=临时口令 node scripts/test-admin.mjs

  若临时库已经和口令脱节（手工改过 data/blog.db），用隔离数据重跑：
    npm test -- --only test-admin
`);
    process.exit(2);
  }
}

{
  const r = await req('/admin/save', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ title: 'x', body: 'y' }),
  });
  check('T3a 缺少 CSRF 令牌的写操作被拒', r.status === 403, `status=${r.status}`);

  const r2 = await req('/admin/save', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ _csrf: 'forged-token-aaaaaaaaaaaa', title: 'x', body: 'y' }),
  });
  check('T3b 伪造 CSRF 令牌被拒', r2.status === 403, `status=${r2.status}`);
}

let postId = 0;
let slug = `${PREFIX}hello`;
{
  const page = await html(`/admin/new?kind=post`);
  const csrf = csrfOf(page);
  const r = await req('/admin/save', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      _csrf: csrf, action: 'publish', id: '', kind: 'post',
      title: '测试文章：后台写入', slug,
      date: toLocalInput(new Date().toISOString()),
      body: '第一段。\n\n## 小标题\n\n正文里有 [[为什么单栏是唯一正确的选择]] 这样的链接。',
      draft: '', comments: '1',
    }),
  });
  const loc = r.headers.get('location') ?? '';
  postId = Number(/\/admin\/edit\/(\d+)/.exec(loc)?.[1] ?? 0);
  check('T4a 保存后跳回编辑器', r.status === 303 && postId > 0, `status=${r.status} loc=${loc}`);
  created.push({ id: postId, slug });

  const file = path.join(CONTENT_DIR, 'posts', `${slug}.md`);
  createdFiles.push(file);
  check('T4b Markdown 文件真的写到了磁盘', fs.existsSync(file), file);
  const raw = fs.existsSync(file) ? fs.readFileSync(file, 'utf8') : '';
  check('T4c 文件里带 front-matter', raw.startsWith('---') && raw.includes('title:'));
  check('T4d front-matter 不含标签（功能已删除）', !raw.includes('tags:'));
  check('T4e 正文里是原始 Markdown（不是渲染后的 HTML）', raw.includes('[[为什么单栏是唯一正确的选择]]'));

  const dbRow = db.prepare('SELECT * FROM posts WHERE id = ?').get(postId) ?? {};
  check('T4f 数据库已索引该文章', Boolean(dbRow) && dbRow.source === 'file' && dbRow.draft === 0, JSON.stringify(dbRow?.source));

  const siteRes = await fetch(`${BASE}/p/${slug}/`);
  const siteHtml = await siteRes.text();
  check('T4h 前台立即可见（无需重启）', siteRes.status === 200 && siteHtml.includes('第一段'), `status=${siteRes.status}`);
  check('T4i [[双向链接]] 被渲染成 /go/ 链接', siteHtml.includes('class="wikilink"'));

  const byTitle = await html(`/admin?q=${encodeURIComponent('后台写入')}`);
  const byShort = await html(`/admin?q=${encodeURIComponent('测试')}`);
  check('T4j0 后台标题子串搜索命中（FTS 长词与短词回退一致）',
    byTitle.includes(slug) && byShort.includes(slug), `long=${byTitle.includes(slug)} short=${byShort.includes(slug)}`);
}

{
  const page = await html(`/admin/edit/${postId}`);
  check('T4j 编辑页 body 挂 page-is-editor（手机端让开自己的吸顶保存条）',
    /<body class="admin page-is-editor">/.test(page), '');
  const csrf = csrfOf(page);
  const r = await req('/admin/api/autosave', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'x-csrf-token': csrf },
    body: JSON.stringify({
      id: String(postId), title: '测试文章：自动保存后的标题', slug, kind: 'post',
      date: toLocalInput(new Date().toISOString()), body: '被自动保存改过的正文。',
      draft: '', comments: '1', action: 'autosave',
    }),
  });
  const j = await r.json();
  check('T5a 自动保存返回成功', r.status === 200 && j.ok === true, JSON.stringify(j));
  const dbRow = db.prepare('SELECT title, body_md FROM posts WHERE id = ?').get(postId) ?? {};
  check('T5b 自动保存已落库', dbRow.title.includes('自动保存'), dbRow.title);
  check('T5c 自动保存也写回了文件', fs.readFileSync(path.join(CONTENT_DIR, 'posts', `${slug}.md`), 'utf8').includes('自动保存后的标题'));
  const revs = db.prepare('SELECT note FROM revisions WHERE post_id = ?').all(postId);
  check('T5d 产生了修订记录', revs.length > 0, `${revs.length} 条`);
}

{
  const page = await html(`/admin/edit/${postId}`);
  const newSlug = `${PREFIX}renamed`;
  const r = await req('/admin/save', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      _csrf: csrfOf(page), action: 'save', id: String(postId), kind: 'post',
      title: '测试文章：改名了', slug: newSlug,
      date: toLocalInput(new Date().toISOString()), body: '改名后的正文。',
      draft: '', comments: '1',
    }),
  });
  check('T6a 改 slug 保存成功', r.status === 303, `status=${r.status}`);

  const oldRes = await fetch(`${BASE}/p/${slug}/`, { redirect: 'manual' });
  const loc = oldRes.headers.get('location') ?? '';
  check('T6b 旧 slug 返回 301 而不是 404', oldRes.status === 301, `status=${oldRes.status}`);
  check('T6c 301 指向新地址', loc.includes(newSlug), loc);
  const dbAlias = db.prepare('SELECT * FROM aliases WHERE post_id = ?').all(postId);
  check('T6d aliases 表留有映射', dbAlias.length > 0, JSON.stringify(dbAlias));
  slug = newSlug;
}

{
  const page = await html(`/admin/edit/${postId}`);
  const future = new Date(Date.now() + 4000).toISOString();
  const r = await req('/admin/save', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      _csrf: csrfOf(page), action: 'save', id: String(postId), kind: 'post',
      title: '测试文章：定时发布', slug, date: toLocalInput(future),
      body: '定时发布的正文。', draft: '', comments: '1',
    }),
  });
  check('T7a 定时发布保存成功', r.status === 303, `status=${r.status}`);

  await fetch(`${BASE}/p/${slug}/`);
  const before = (await fetch(`${BASE}/p/${slug}/`)).status;
  check('T7b 未到时间时前台不可见（404）', before === 404, `status=${before}`);

  const inList = await (await fetch(`${BASE}/`)).text();
  check('T7c 未到时间时也不出现在列表', !inList.includes('定时发布'));

  const t0 = Date.now();
  // 轮询到真的可见（上限 15s），不死等 4500ms：机器一忙固定等待就假失败。
  const after = await waitFor(async () => {
    const code = (await fetch(`${BASE}/p/${slug}/`, { redirect: 'manual' })).status;
    return code === 200 ? code : 0;
  }, { timeoutMs: 15000, stepMs: 150 });
  const row = db.prepare('SELECT slug, draft, published_at FROM posts WHERE id = ?').get(postId) ?? {};
  const now = db.prepare("SELECT strftime('%Y-%m-%dT%H:%M:%SZ','now') AS n").get().n;
  check('T7d 到点后自动可见（无需任何定时任务）', after === 200,
    `status=${after} 等待=${Date.now() - t0}ms 行=${JSON.stringify(row)} sqlite_now=${now}`);
}

let uploadedUrl = '';
let uploadedRawUrl = '';
{
  const page = await html(`/admin/edit/${postId}`);
  const csrf = csrfOf(page);

  const fd = new FormData();
  fd.append('_csrf', csrf);
  fd.append('file', new Blob([PNG_1x1], { type: 'image/png' }), 'dot.png');
  const r = await req('/admin/api/upload', { method: 'POST', headers: { 'x-csrf-token': csrf }, body: fd });
  const j = await r.json();
  uploadedUrl = j.url ?? '';
  check('T8a PNG 上传成功', r.status === 200 && j.ok === true, JSON.stringify(j));
  check('T8b 解析出宽高', j.width === 1 && j.height === 1, `${j.width}x${j.height}`);
  check('T8c 文件名是内容哈希（不含原始名，避免路径注入）', /^\/uploads\/\d{4}\/\d{2}\/[0-9a-f]{16}\.png$/.test(uploadedUrl), uploadedUrl);
  check('T8d 上传的文件确实存在', fs.existsSync(path.join(UPLOADS_DIR, uploadedUrl.replace(/^\/uploads\//, ''))));
  const served = await fetch(BASE + uploadedUrl);
  check('T8e 上传的文件可被访问且类型正确', served.status === 200 && served.headers.get('content-type') === 'image/png');

  const fd2 = new FormData();
  fd2.append('_csrf', csrf);
  fd2.append('file', new Blob([PNG_1x1], { type: 'image/png' }), 'another-name.png');
  const j2 = await (await req('/admin/api/upload', { method: 'POST', headers: { 'x-csrf-token': csrf }, body: fd2 })).json();
  check('T8f 相同内容去重，复用已有路径', j2.deduped === true && j2.url === uploadedUrl, JSON.stringify(j2));

  const rawName = '原始 图.png';
  const raw = await req('/admin/api/upload', {
    method: 'POST',
    headers: { 'x-csrf-token': csrf, 'content-type': 'image/png', 'x-file-name': encodeURIComponent(rawName) },
    body: PNG_RAW,
  });
  const rawJson = await raw.json();
  uploadedRawUrl = rawJson.url ?? '';
  check('T8f1 原始二进制流式上传成功', raw.status === 200 && rawJson.ok === true, JSON.stringify(rawJson));
  check('T8f1b 流式上传保留文件名并正确落盘',
    fs.existsSync(path.join(UPLOADS_DIR, rawJson.url.replace(/^\/uploads\//, '')))
    && db.prepare('SELECT filename FROM media WHERE path=?').get(rawJson.url)?.filename === rawName,
    `${rawJson.url} / ${db.prepare('SELECT filename FROM media WHERE path=?').get(rawJson.url)?.filename}`);
  const mediaSearch = await (await req(`/admin/api/media?q=${encodeURIComponent('原始 图')}`)).json();
  check('T8f1c 媒体库按文件名搜索命中', mediaSearch.ok === true
    && mediaSearch.items.some((x) => x.path === rawJson.url), JSON.stringify(mediaSearch.items?.map((x) => x.filename)));

  const mediaApi = await (await req('/admin/api/media')).json();
  check('T8f2 媒体库接口列出已有文件（带文件名，供选择器显示）',
    mediaApi.ok === true && mediaApi.items.some((x) => x.path === uploadedUrl && x.filename),
    JSON.stringify(mediaApi.items?.slice(0, 2) ?? mediaApi).slice(0, 120));
  const edPicker = await html(`/admin/edit/${postId}`);
  check('T8f3 编辑页带媒体库选择器（弹窗 + 上传新文件 + 取消）',
    edPicker.includes('id="a-picker"') && edPicker.includes('id="a-picker-upload"')
    && edPicker.includes('data-picker-cancel'), '');

  // 视频支持已下线：上传接口只收图片，multipart 与 raw 两条路径都把视频挡在门外。
  const fdV = new FormData();
  fdV.append('_csrf', csrf);
  fdV.append('file', new Blob([FAKE_MP4], { type: 'video/mp4' }), 'clip.mp4');
  const rv = await req('/admin/api/upload', { method: 'POST', headers: { 'x-csrf-token': csrf }, body: fdV });
  check('T8v1 视频上传被拒（multipart 表单）', rv.status === 415, `status=${rv.status}`);
  const rawVideo = await req('/admin/api/upload', {
    method: 'POST',
    headers: { 'x-csrf-token': csrf, 'content-type': 'video/mp4', 'x-file-name': 'raw-clip.mp4' },
    body: FAKE_MP4,
  });
  const rawVideoJson = await rawVideo.json();
  check('T8v2 视频上传被拒（原始二进制路径）', rawVideo.status === 415 && rawVideoJson.ok === false,
    `status=${rawVideo.status} ${JSON.stringify(rawVideoJson).slice(0, 140)}`);

  const fd3 = new FormData();
  fd3.append('_csrf', csrf);
  fd3.append('file', new Blob([Buffer.from('<?php echo 1; ?>')], { type: 'image/png' }), 'evil.png');
  const r3 = await req('/admin/api/upload', { method: 'POST', headers: { 'x-csrf-token': csrf }, body: fd3 });
  check('T8g 伪装成 PNG 的文本被拒（按 magic bytes 判定）', r3.status === 415, `status=${r3.status}`);

  const fd4 = new FormData();
  fd4.append('_csrf', csrf);
  fd4.append('file', new Blob([Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"><script>alert(1)</script></svg>')], { type: 'image/svg+xml' }), 'x.svg');
  const r4 = await req('/admin/api/upload', { method: 'POST', headers: { 'x-csrf-token': csrf }, body: fd4 });
  check('T8h SVG 被拒（可携带脚本，同源提供等于 XSS 入口）', r4.status === 415, `status=${r4.status}`);

  const r5 = await req('/admin/api/upload', { method: 'POST', headers: { 'x-csrf-token': csrf }, body: new FormData() });
  check('T8i 没有文件的请求被拒', r5.status === 400, `status=${r5.status}`);
}

{
  const page = await html('/admin/system');
  check('T8j-1 首页封面表单：一行缩略格 + 末尾「添加」格 + 蒙版文案 + 保存，没有轮播方式/地址/替代文字栏',
    page.includes('id="heroForm"') && page.includes('id="heroFile"') && page.includes('id="heroPick"')
    && page.includes('<input type="hidden" id="heroImages"') && page.includes('id="heroOverlay"')
    && !page.includes('id="heroMode"')
    && !page.includes('id="heroUrl"') && !page.includes('图片地址') && !page.includes('替代文字') && !page.includes('id="heroAlt"')
    && !page.includes('上传图片'), '');

  check('T8j-1a 空列表：只有一枚铺满行的「添加」格，没有缩略格，也没有常驻的说明文字',
    page.includes('a-hero-list is-empty') && !page.includes('class="a-hero-item"')
    && /id="heroPick"[^>]*data-wide/.test(page)
    && !page.includes('id="heroHint"') && !page.includes('只有一张时不轮播'), '');

  check('T8j-1c 首页封面可以从媒体库选择（与编辑器共用选择器）',
    page.includes('id="a-picker"') && page.includes('从媒体库选择') && page.includes('id="a-picker-upload"'), '');

  check('T8j-1b 全部移除入口挂在操作条上，空图片时隐藏',
    page.includes('id="heroX"') && page.includes('formaction="/admin/hero/clear"')
    && /id="heroX"[^>]*hidden/.test(page) && !page.includes('>移除<'), '');

  const csrf = csrfOf(page);
  const save = (fields) => req('/admin/hero', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ _csrf: csrf, ...fields }),
  });

  // 校验失败可能直接重渲染表单（保留刚填内容），也可能 303 回页面；两种都认。
  const rejected = async (res, needle) => {
    if (res.status === 303) return decodeURIComponent(res.headers.get('location') ?? '').includes(needle);
    return res.status === 200 && (await res.text()).includes(needle);
  };
  const bad = await save({ url: 'javascript:alert(1)' });
  const bad2 = await save({ url: 'https://example.com/x.jpg' });
  check('T8j-2 站外地址与非白名单协议被拒（手填地址这条路已经关掉）',
    await rejected(bad, '站内上传') && await rejected(bad2, '站内上传'), '');

  const okSave = await save({ url: uploadedUrl, w: '1', h: '1' });
  check('T8j-3 上传得到的站内地址保存成功',
    okSave.status === 303 && decodeURIComponent(okSave.headers.get('location') ?? '').includes('已保存'), '');

  const withHero = await html('/admin/system');
  check('T8j-3b 有图时那个叉不再隐藏',
    /id="heroX"[^>]*>/.test(withHero) && !/id="heroX"[^>]*hidden/.test(withHero), '');

  const home = await (await fetch(BASE + '/')).text();
  check('T8j-4 首页用 <img> 顶替站名，带上宽高与站身份的 alt，灯箱展示最大档变体，并 preload LCP 封面',
    home.includes(`<img src="${uploadedUrl}.v4-w1.webp"`) && home.includes(`data-full="${uploadedUrl}.v4-w1.webp"`)
    && !home.includes('data-original') && /alt="[^"]+"/.test(home)
    && home.includes('width="1" height="1"') && !/<h1 class="hero-title">/.test(home)
    && /<link rel="preload" as="image"[^>]*imagesrcset="[^"]*v4-w1\.webp 1w"[^>]*imagesizes="[^"]+"/.test(home), '');

  // 封面文字已下线：表单里再带 title/subtitle/link/tone 也会被忽略，落地只剩 path/w/h。
  const textSaved = await save({
    images: JSON.stringify([{
      path: uploadedUrl, w: '1', h: '1',
      title: '封面标题 <测试>', subtitle: '一行副标题', link: '/about/', linkText: '关于我',
    }]),
    layout: 'center', tone: 'dark',
  });
  const homeText = await (await fetch(BASE + '/')).text();
  const sysText = await html('/admin/system');
  check('T8j-4b 封面文字已下线：文字字段被丢弃（不渲染、不入库），设置页不再有文字弹窗与颜色选择',
    textSaved.status === 303
    && !homeText.includes('hero-copy')
    && !homeText.includes('封面标题')
    && !homeText.includes('一行副标题')
    && !homeText.includes('关于我')
    && !sysText.includes('id="heroTextDialog"')
    && !sysText.includes('id="heroTone"')
    && !sysText.includes('id="heroLayout"')
    && !/name="(?:tone|layout)"/.test(sysText),
    `status=${textSaved.status}`);

  const fdX = new FormData();
  fdX.append('_csrf', csrf);
  fdX.append('file', new Blob([PNG_1x1], { type: 'image/png' }), 'x.png');
  const upX = await (await req('/admin/api/upload', { method: 'POST', headers: { 'x-csrf-token': csrf }, body: fdX })).json();
  const xUrl = upX.url;
  const trashBefore = fs.existsSync(path.join(DATA_DIR, '.trash', 'uploads'))
    ? fs.readdirSync(path.join(DATA_DIR, '.trash', 'uploads')).length : 0;
  await save({ url: xUrl, w: '1', h: '1' });
  const cleared = await req('/admin/hero/clear', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ _csrf: csrf }),
  });
  const home2 = await (await fetch(BASE + '/')).text();
  check('T8j-5 移除后首页回落到站名',
    cleared.status === 303 && /<h1 class="hero-title">[^<]+<\/h1>/.test(home2) && !home2.includes('hero-figure'), '');

  // 回收站可能本就有同名文件（PNG 内容哈希每次一样），看清空前后有没有多出文件而非存在与否 —— 否则上次残渣会让这条变红。
  const trashDir = path.join(DATA_DIR, '.trash', 'uploads');
  const trashAfter = fs.existsSync(trashDir) ? fs.readdirSync(trashDir).length : 0;
  const xTrash = trashAfter > trashBefore;
  const rowGone = !db.prepare('SELECT 1 FROM media WHERE path = ?').get(xUrl);
  check('T8j-6 移除首页展示时保留媒体记录和文件',
    !rowGone && !xTrash && (await fetch(BASE + xUrl)).status === 200,
    `row=${rowGone} trash=${xTrash}`);

  // 封面只收图片：视频路径写进首页封面会被服务端拒收，设置页也不再有视频/文字相关的控件。
  const savedVideoHero = await save({ images: JSON.stringify([{ path: `${uploadedUrl}.mp4`, w: '1920', h: '1080' }]) });
  // 拒收是把表单重渲染回来（不是 303），提示只在这一次响应里，所以要在 POST 的响应体里找。
  const videoPostHtml = await savedVideoHero.text();
  const sysVideo = await html('/admin/system');
  check('T8j-6v 非图片不能当封面：服务端拒收并给出提示，设置页没有视频文件类型/播放开关/文字弹窗',
    savedVideoHero.status === 200
    && videoPostHtml.includes('首页封面只能用图片')
    && sysVideo.includes('accept="image/png,image/jpeg,image/gif,image/webp"')
    && !sysVideo.includes('video/mp4')
    && !sysVideo.includes('id="heroVideoModeRow"')
    && !sysVideo.includes('id="heroTextDialog"')
    && !sysVideo.includes('id="heroTone"'),
    `status=${savedVideoHero.status} err=${videoPostHtml.includes('首页封面只能用图片')}`);

  const PNG_2x2 = await sharp({ create: { width: 2, height: 2, channels: 4, background: '#0033ff' } }).png().toBuffer();
  const fdY = new FormData();
  fdY.append('_csrf', csrf);
  fdY.append('file', new Blob([PNG_2x2], { type: 'image/png' }), 'y.png');
  const upY = await (await req('/admin/api/upload', { method: 'POST', headers: { 'x-csrf-token': csrf }, body: fdY })).json();
  const yUrl = upY.url;
  const saveImages = (list, overlay = '') => save({ images: JSON.stringify(list), overlay });

  const savedMulti = await saveImages(
    [{ path: uploadedUrl, w: '1', h: '1' }, { path: yUrl, w: '2', h: '2' }], '沉沦的独立博客');
  check('T8j-7 两张图 + 自动轮播保存成功', savedMulti.status === 303
    && decodeURIComponent(savedMulti.headers.get('location') ?? '').includes('已保存'), '');

  const homeMulti = await (await fetch(BASE + '/')).text();
  const slideCount = (homeMulti.match(/class="hero-slide/g) ?? []).length;
  check('T8j-8 首页渲染轮播：两张 slide、无控制条无圆点、蒙版文案压在渐变上、自动轮播',
    homeMulti.includes('data-hero-carousel') && !homeMulti.includes('data-hero-mode')
    && slideCount === 2 && homeMulti.includes('class="hero-slide is-active"')
    && !homeMulti.includes('hero-ctrl') && !homeMulti.includes('hero-dot')
    && homeMulti.includes('data-lightbox="hero"')
    && homeMulti.includes('class="hero-copy"') && homeMulti.includes('沉沦的独立博客')
    && homeMulti.includes('style="--hero-ar: 16 / 9"') && homeMulti.includes('style="aspect-ratio:16/9"')
    && !homeMulti.includes('hero-nav'),
    `slides=${slideCount}`);

  const sysMulti = await html('/admin/system');
  check('T8j-9 设置页回显两张缩略格（图下带序号、第一张标封面），轮播方式已从表单移除',
    (sysMulti.match(/class="a-hero-item"/g) ?? []).length === 2
    && sysMulti.includes('id="heroList" style="--hero-ar: 16 / 9"')
    && (sysMulti.match(/class="a-hero-cap"/g) ?? []).length === 2
    && sysMulti.includes('<em>封面</em>')
    && !sysMulti.includes('data-hero-cover')    && (sysMulti.match(/draggable="true"/g) ?? []).length === 2
    && sysMulti.includes('class="a-hero-grip"')
    && !sysMulti.includes('is-empty')
    && !sysMulti.includes('id="heroMode"'), '');

  const tooMany = await saveImages(Array.from({ length: 9 }, (_, i) => ({ path: `/uploads/x/${i}.png` })));
  const dup = await saveImages([{ path: uploadedUrl }, { path: uploadedUrl }]);
  const outside = await saveImages([{ path: 'https://example.com/x.jpg' }]);
  check('T8j-10 超过 8 项 / 同项重复 / 站外地址都被拒',
    await rejected(tooMany, '最多 8 项')
    && await rejected(dup, '重复出现')
    && await rejected(outside, '站内上传'), '');

  const mediaMulti = await html('/admin/media');
  check('T8j-11 两张首页图在媒体库都被标出',
    (mediaMulti.match(/首页封面/g) ?? []).length >= 2, '');
  const heroId = db.prepare('SELECT id FROM media WHERE path = ?').get(uploadedUrl)?.id ?? 0;
  const guardPage = await html(`/admin/media/delete/${heroId}`);
  const guardTry = await req(`/admin/media/delete/${heroId}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ _csrf: csrfOf(guardPage) }),
  });
  check('T8j-12 轮播里正在用的图删不掉',
    guardTry.status === 303 && decodeURIComponent(guardTry.headers.get('location') ?? '').includes('先换掉或移除它'), '');

  const savedManual = await saveImages([{ path: uploadedUrl, w: '1', h: '1' }]);
  const homeSingle = await (await fetch(BASE + '/')).text();
  check('T8j-13 单图回落旧渲染（无轮播壳、无蒙版层挂在轮播上）',
    savedManual.status === 303 && !homeSingle.includes('data-hero-carousel') && homeSingle.includes('hero-figure'), '');

  await save({});
  check('T8j-14 空 images 清空首页展示',
    /<h1 class="hero-title">[^<]+<\/h1>/.test(await (await fetch(BASE + '/')).text())
    && !db.prepare("SELECT value FROM settings WHERE key = 'hero_images'").get()?.value, '');
}

{
  const pageForUpload = await html('/admin/media');
  const csrfU = csrfOf(pageForUpload);
  const fdU = new FormData();
  fdU.append('_csrf', csrfU);
  fdU.append('file', new Blob([PNG_1x1], { type: 'image/png' }), 'media.png');
  const upU = await (await req('/admin/api/upload', { method: 'POST', headers: { 'x-csrf-token': csrfU }, body: fdU })).json();
  const uploadedUrl = upU.url;

  const listed = await html('/admin/media');

  check('T8k-0 删除入口带弹窗参数，页面里挂着共用的 dialog',
    listed.includes('id="a-modal"') && /href="\/admin\/media\/delete\/\d+"[\s\S]{0,200}data-modal-action="\/admin\/media\/delete\/\d+"/.test(listed)
    && listed.includes('data-modal-ok='), '');

  check('T8k-1 媒体页每张卡片都有删除入口', listed.includes('href="/admin/media/delete/'), '');

  // 媒体库这一页不要搜索框（一屏缩略图靠眼睛找比打字快）；编辑器里选图弹窗的搜索照旧（走 /admin/api/media）。
  check('T8k-1a 媒体库没有搜索框了',
    !listed.includes('class="a-search"') && !listed.includes('name="q"'), '');

  const heroSave = await req('/admin/hero', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ _csrf: csrfOf(listed), url: uploadedUrl, w: '1', h: '1' }),
  });
  const listed2 = await html('/admin/media');
  check('T8k-1b 正在当首页图的那张被标出来（T8j 清过设置，所以标记要在设置之后查）',
    heroSave.status === 303 && listed2.includes('首页封面'), '');

  // 认行按路径查库，别按页面里第一个删除链接猜 —— 媒体库不止一行时后者会抓到别人的行
  const idOf = String(db.prepare('SELECT id FROM media WHERE path = ?').get(uploadedUrl)?.id ?? 0);
  const confirmPage = await html(`/admin/media/delete/${idOf}`);
  check('T8k-2 确认页给出路径与"文件会进回收站"的说明',
    heroSave.status === 303 && confirmPage.includes(uploadedUrl) && confirmPage.includes('data/.trash/uploads/'), '');

  const blocked = await req(`/admin/media/delete/${idOf}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ _csrf: csrfOf(confirmPage) }),
  });
  const stillThere = await (await fetch(BASE + uploadedUrl)).status;
  check('T8k-3 正在当首页图的文件删不掉（页面也把确认按钮禁用了）',
    blocked.status === 303 && !(blocked.headers.get('location') ?? '').includes('/admin/media?w=')
    && confirmPage.includes('disabled') && stillThere === 200, `status=${stillThere}`);

  await req('/admin/hero/clear', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ _csrf: csrfOf(confirmPage) }),
  });
  const confirmed = await req(`/admin/media/delete/${idOf}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ _csrf: csrfOf(confirmPage) }),
  });
  const after = await (await fetch(BASE + uploadedUrl)).status;

  const trashDir = path.join(DATA_DIR, '.trash', 'uploads');
  const trashed = fs.existsSync(trashDir) ? fs.readdirSync(trashDir).some((f) => f.endsWith(path.basename(uploadedUrl))) : false;
  const rowGone = !db.prepare('SELECT 1 FROM media WHERE path = ?').get(uploadedUrl);
  check('T8k-4 确认后：记录删掉、文件进回收站、原 URL 404',
    confirmed.status === 303 && rowGone && trashed && after === 404,
    `row=${rowGone} trash=${trashed} url=${after}`);

  const noAuth = await fetch(`${BASE}/admin/media/delete/${idOf}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ _csrf: 'x' }),
    redirect: 'manual',
  });
  check('T8k-5 未登录删不了媒体',
    noAuth.status === 303 && (noAuth.headers.get('location') ?? '').includes('/admin/login'), `status=${noAuth.status}`);
}

{
  // 评论列表分页：以前两列表各写死上限（待审 200 / 最近 60），第 61 条后翻不到。现在各自分页、参数分开（pending / recent）、越界夹回最后一页。
  const pid = db.prepare('SELECT id FROM posts LIMIT 1').get().id;
  const ins = db.prepare(`INSERT INTO comments(post_id, author, body_md, status, is_author, moderation_nonce, created_at)
    VALUES(?, '分页测试员', ?, 'pending', 0, 'pg', datetime('now'))`);
  const added = [];
  for (let i = 0; i < 65; i += 1) added.push(Number(ins.run(pid, `分页用待审 #${i}`).lastInsertRowid));
  const rowsIn = (page, prefix) => (page.match(new RegExp(`id="reply-row-${prefix}-`, 'g')) ?? []).length;

  try {
    const p1 = await html('/admin/comments');
    check('T8n-1 待审超过一页就出翻页器，第一页正好一页的量（60）',
      p1.includes('aria-label="待审核分页"') && rowsIn(p1, 'pending') === 60, `rows=${rowsIn(p1, 'pending')}`);
    check('T8n-2 下一页的链接把另一个列表的页码一起带上（翻一个不动另一个）',
      p1.includes('/admin/comments?pending=2&amp;recent=1'), '');
    check('T8n-3 第一页的「上一页」是失效态，不是链接',
      p1.includes('<span class="a-pager-btn is-off">上一页</span>'), '');

    const p2 = await html('/admin/comments?pending=2');
    check('T8n-4 第二页只剩余下的 5 条，且没有可点的「下一页」',
      rowsIn(p2, 'pending') === 5 && p2.includes('<span class="a-pager-btn is-off">下一页</span>'), `rows=${rowsIn(p2, 'pending')}`);

    const p99 = await html('/admin/comments?pending=99');
    check('T8n-5 页码越界被夹回最后一页（不是一张空表）',
      rowsIn(p99, 'pending') === 5, `rows=${rowsIn(p99, 'pending')}`);

    const pr = await html('/admin/comments?recent=2&pending=2');
    check('T8n-6 翻「最近评论」时待审那一页原样保留',
      /aria-label="最近评论分页"[\s\S]{0,400}pending=2/.test(pr), '');
  } finally {
    for (const id of added) db.prepare('DELETE FROM comments WHERE id = ?').run(id);
  }
}

{
  const page = await html('/admin/system');
  check('T8l-1 菜单与页面标题都叫「设置」，不再是「系统」',
    page.includes('>设置<') && page.includes('<title>设置 · ') && !page.includes('>系统<'), '');
  check('T8l-2 站点信息卡片墙已删除（设置页第一个区块就是"站点与阅读"）',
    !page.includes('a-facts') && !page.includes('站点信息')
    && page.includes('站点与阅读'), '');
  check('T8l-3 设置页仍是那几项可改的（每页条数 / 最近更新 / 每页评论串数）',
    ['id="s-page"', 'id="s-recent"', 'id="s-cpage"'].every((k) => page.includes(k))
    && !page.includes('站点描述')
    && !page.includes('name="moderate"') && !page.includes('新评论一律先审'), '');

  const csrf = csrfOf(page);
  const save = (fields) => req('/admin/settings', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ _csrf: csrf, ...fields }),
  });

  const bad = await save({ pageSize: '999', homeRecent: '12', commentsPerPage: '20' });
  check('T8l-4 越界值被拒，并说清范围',
    bad.status === 303 && decodeURIComponent(bad.headers.get('location') ?? '').includes('5—100'), '');
  const badCpage = await save({ pageSize: '20', homeRecent: '12', commentsPerPage: '2' });
  check('T8l-4b 每页评论串数越界同样被拒',
    badCpage.status === 303 && decodeURIComponent(badCpage.headers.get('location') ?? '').includes('5—100'), '');

  const ok = await save({ pageSize: '5', homeRecent: '3', commentsPerPage: '7' });
  const saved = Object.fromEntries(db.prepare("SELECT key, value FROM settings WHERE key IN ('page_size','home_recent','comments_per_page')").all().map((r) => [r.key, r.value]));
  check('T8l-5 保存写入 settings 表（含每页评论串数）',
    ok.status === 303 && saved.page_size === '5'
    && saved.home_recent === '3' && saved.comments_per_page === '7', JSON.stringify(saved));

  const listed = await (await fetch(BASE + '/posts/')).text();
  const recent = await (await fetch(BASE + '/')).text();
  const home = recent;
  check('T8l-6 每页条数立刻生效（5 条）',
    ((/<ul class="list"[^>]*>([\s\S]*?)<\/ul>/.exec(listed)?.[1] ?? '').match(/<li\b/g) ?? []).length === 5, `${((/<ul class="list"[^>]*>([\s\S]*?)<\/ul>/.exec(listed)?.[1] ?? '').match(/<li\b/g) ?? []).length} 条`);
  check('T8l-7 首页条数立刻生效（3 条）',
    ((/<ul class="entries entries-rel">([\s\S]*?)<\/ul>/.exec(home)?.[1] ?? '').match(/<li\b/g) ?? []).length === 3, `${((/<ul class="entries entries-rel">([\s\S]*?)<\/ul>/.exec(home)?.[1] ?? '').match(/<li\b/g) ?? []).length} 条`);

  check('T8l-8 站点公告已移除：设置页无该字段，首页封面也没有 hero-notice',
    !page.includes('站点公告') && !page.includes('hero-notice') && !home.includes('hero-notice'), '');

  const postHtml = await (await fetch(BASE + '/p/why-single-column/')).text();
  check('T8l-9 评论开关已移除后，文章页照常有评论表单（不再有全站开关）',
    postHtml.includes('class="c-form"') && !postHtml.includes('评论已关闭'), '');

  await save({ pageSize: '20', homeRecent: '12', commentsPerPage: '20' });
  const fallback = await (await fetch(BASE + '/')).text();
  check('T8l-10 首页 meta 一直是 config 的说明，与设置项无关',
    fallback.includes('<meta name="description" content="写代码，也写字。'), '');

  // 默认版式：存进 settings、立刻挂到 <html>，且后台下拉回填当前值。
  await save({ pageSize: '20', homeRecent: '12', commentsPerPage: '20', layoutDefault: 'box' });
  const boxedPosts = await (await fetch(BASE + '/posts/')).text();
  const boxedHome = await (await fetch(BASE + '/')).text();
  check('T8l-11 默认版式设为素匣：内页 <html data-layout="box">，首页不受影响（只由 CSS 排除）',
    /<html lang="[^"]+" data-layout="box">/.test(boxedPosts)
    && /<html lang="[^"]+" data-layout="box">/.test(boxedHome), '');
  const sysBoxed = await html('/admin/system');
  check('T8l-12 后台默认样式块回填素匣（两格单选，没有第三个选项）',
    /name="layoutDefault" value="box" checked/.test(sysBoxed)
    && /name="layoutDefault" value="paper"/.test(sysBoxed)
    && !/name="layoutDefault" value="wide"/.test(sysBoxed), '');
  await save({ pageSize: '20', homeRecent: '12', commentsPerPage: '20', layoutDefault: 'paper' });
  const paperPosts = await (await fetch(BASE + '/posts/')).text();
  check('T8l-13 改回纸面：<html> 不再挂 data-layout',
    !/<html[^>]*data-layout=/.test(paperPosts), '');

  // 默认明暗与「自定义」配色：一个挂属性，一个连首帧 CSS 一起出。
  await save({
    pageSize: '20', homeRecent: '12', commentsPerPage: '20',
    themeDefault: 'dark', palette: 'custom', layoutDefault: 'paper',
    hue: '210', chroma: '1', paper: '1',
  });
  const styled = await (await fetch(BASE + '/posts/')).text();
  check('T8l-14 默认明暗设为暗色：<html data-theme="dark">',
    /<html lang="[^"]+" data-theme="dark"[^>]*>/.test(styled), '');
  check('T8l-15 默认配色设为自定义：data-palette="custom" 且 <head> 里有服务端算好的首帧 CSS',
    /data-palette="custom"/.test(styled)
    && /<style id="palDefault">html\[data-palette="custom"\]\{--bg:#/.test(styled), '');

  await save({
    pageSize: '20', homeRecent: '12', commentsPerPage: '20',
    themeDefault: 'auto', palette: '', layoutDefault: 'paper',
    hue: '210', chroma: '1', paper: '1',
  });
  const plain = await (await fetch(BASE + '/posts/')).text();
  check('T8l-16 改回跟随系统 + 素笺：属性与内联 style 都撤掉',
    !/<html[^>]*data-theme=/.test(plain) && !/id="palDefault"/.test(plain), '');
}

{
  const attempts = [
    '/uploads/../blog.db',
    '/uploads/%2e%2e%2fblog.db',
    '/uploads/../../etc/passwd',
  ];
  let blocked = 0;
  for (const a of attempts) {
    const r = await fetch(BASE + a);
    if (r.status !== 200) blocked++;
  }
  check('T9 目录穿越尝试全部被挡', blocked === attempts.length, `${blocked}/${attempts.length}`);
}

{
  const revs = db.prepare('SELECT id FROM revisions WHERE post_id = ? ORDER BY id ASC').all(postId);
  const page = await html(`/admin/edit/${postId}`);
  check('T10a 编辑器列出修订历史', page.includes('修订历史'));

  const target = revs[0].id;
  const r = await req(`/admin/restore/${target}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ _csrf: csrfOf(page) }),
  });
  check('T10b 回滚请求成功', r.status === 303, `status=${r.status}`);
  const after = db.prepare('SELECT title FROM posts WHERE id = ?').get(postId) ?? {};
  check('T10c 回滚后内容变成旧版本', after.title !== '测试文章：定时发布', after.title);
  const preRestore = db.prepare("SELECT COUNT(*) AS n FROM revisions WHERE post_id = ? AND note = 'pre-restore'").get(postId);
  check('T10d 回滚前自动存了一份当前版本（回滚可逆）', preRestore.n > 0, `pre-restore ${preRestore.n} 条`);
}

{

  const AUTHOR = `后台测试员-${Date.now().toString(36)}`;
  const page = await fetch(`${BASE}/p/why-single-column/`).then((r) => r.text());
  const ts = /name="ts" value="([^"]+)"/.exec(page)?.[1] ?? '';
  await sleep(300);
  const sub = await fetch(`${BASE}/p/why-single-column/comment`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      ts, hp_fax: '', author: AUTHOR, email: 'admin-check@example.com',
      body: '这条评论用来测试后台审核。',
    }),
  });
  const mine = db.prepare('SELECT id, status FROM comments WHERE author = ? ORDER BY id DESC LIMIT 1').get(AUTHOR);
  check('T11a 本次提交的评论真的进了库且为待审',
    Boolean(mine) && mine.status === 'pending',
    `HTTP ${sub.status}${sub.status === 429 ? '（被评论限流拒绝）' : ''} 行=${JSON.stringify(mine)}`);
  const pending = mine;

  const cmPage = await html('/admin/comments');
  check('T11b 后台评论页列出待审评论', cmPage.includes(AUTHOR));
  {
    // 显示相对时间（久远的退化为日期）；曾经是 ISO 硬切（缺年份、残留 T）
    const visible = cmPage.replace(/<[^>]*>/g, ' ');
    const precise = /title="精确时间：(\d{4}-\d{2}-\d{2} \d{2}:\d{2})"/.exec(cmPage)?.[1];
    check('T11b1 评论时间显示为相对时间，悬停给出精确时刻',
      /(刚刚|分钟前|小时前|昨天|前天|天前|个月前|年前|去年|\d{4}-\d{2}-\d{2})/.test(visible)
      && Boolean(precise) && !/\d{2}-\d{2}T\d{2}:\d{2}/.test(visible),
      `可见=${(visible.match(/刚刚|\d+ 分钟前|\d+ 小时前|前天|昨天|\d+ 天前|\d+ 个月前|去年|\d+ 年前|\d{4}-\d{2}-\d{2}/) ?? ['?'])[0]} 精确=${precise}`);
    check('T11b2 界面上不再出现 UTC 字样（时间不标时区）',
      !/UTC/.test(visible), (visible.match(/\S*UTC\S*/) ?? [''])[0]);
    check('T11b3 评论行显示评论人邮箱，且可直接点开回信',
      visible.includes('admin-check@example.com')
      // 不写死属性顺序：链接上可能带其它属性
      && /<a\s[^>]*href="mailto:admin-check@example\.com"/.test(cmPage), '');
    {
      // 列表时间要和编辑器/前台的时区一致，不能是 UTC 原样（曾经差 8 小时）
      const raw = db.prepare('SELECT created_at FROM comments WHERE author = ? ORDER BY id DESC LIMIT 1').get(AUTHOR)?.created_at ?? '';
      const shown = toLocalInput(raw).replace('T', ' ').slice(0, 16);
      const rawStamp = String(raw).replace('T', ' ').replace('Z', '').slice(0, 16);
      check('T11b5 悬停的精确时刻按站点时区给出，而不是 UTC 原样',
        cmPage.includes(`精确时间：${shown}`) && (rawStamp === shown || !cmPage.includes(`精确时间：${rawStamp}`)),
        `期望 ${shown}，UTC 原样 ${rawStamp}`);
    }

    // 造一条「邮箱还是可选年代」留下的评论（email_enc / email_hash 都 NULL），后台要显示占位符而非空白；旧断言后半截恒真、等于没验过。
    const legacyId = Number(db.prepare(`INSERT INTO comments(post_id, parent_id, author, email_hash, email_enc, body_md, status, is_author)
      VALUES(? , NULL, '早年评论人', NULL, NULL, '那时邮箱还不是必填项。', 'approved', 0)`)
      .run(db.prepare('SELECT id FROM posts WHERE slug = ?').get('why-single-column').id).lastInsertRowid);
    const legacyPage = await html('/admin/comments');
    const legacyRow = legacyPage.split('<tr>').find((r) => r.includes('早年评论人')) ?? '';
    check('T11b4 没有邮箱的历史评论显示占位符而不是空白',
      legacyRow.includes('a-col-contact') && legacyRow.includes('—') && !legacyRow.includes('mailto:'),
      `contact=${legacyRow.includes('a-col-contact')} dash=${legacyRow.includes('—')} mailto=${legacyRow.includes('mailto:')} :: ${legacyRow.replace(/\s+/g, ' ').slice(0, 160)}`);
    db.prepare('DELETE FROM comments WHERE id = ?').run(legacyId);

    const siteId = Number(db.prepare(`INSERT INTO comments(post_id, parent_id, author, email_hash, email_enc, website, body_md, status, is_author)
      VALUES(?, NULL, '带网址的人', NULL, NULL, 'https://example.org/me', '带个人网址的评论。', 'approved', 0)`)
      .run(db.prepare('SELECT id FROM posts WHERE slug = ?').get('why-single-column').id).lastInsertRowid);
    const sitePage = await html('/admin/comments');
    const siteRow = sitePage.split('<tr>').find((r) => r.includes('带网址的人')) ?? '';
    check('T11b6 带网址的评论：评论人名字本身就是链接',
      /<b><a class="a-link" href="https:\/\/example\.org\/me"[^>]*>带网址的人<\/a><\/b>/.test(siteRow),
      siteRow.replace(/\s+/g, ' ').slice(0, 200));
    const contactCell = /<div class="a-dim a-col-contact">([\s\S]*?)<\/div>/.exec(siteRow)?.[1] ?? '';
    check('T11b7 评论人网址不再单独显示在联系方式里',
      contactCell !== '' && !contactCell.includes('example.org'),
      `contact=${JSON.stringify(contactCell.replace(/\s+/g, ' '))}`);
    const siteArt = /<td class="a-col-post" data-label="文章">([\s\S]*?)<\/td>/.exec(siteRow)?.[1] ?? '';
    check('T11b8 新增「文章」列，新窗口直达该评论在文章里的位置',
      new RegExp(`<a class="a-link" href="/p/why-single-column/#c${siteId}" target="_blank" rel="noopener"`).test(siteArt),
      siteArt.replace(/\s+/g, ' ').slice(0, 200));
    const pendRow = cmPage.split('<tr>').find((r) => r.includes(AUTHOR)) ?? '';
    const pendArt = /<td class="a-col-post" data-label="文章">([\s\S]*?)<\/td>/.exec(pendRow)?.[1] ?? '';
    check('T11b9 未公开的评论回退到评论区锚点（#c<id> 在公开页面上并不存在）',
      /href="\/p\/why-single-column\/#comments"/.test(pendArt),
      pendArt.replace(/\s+/g, ' ').slice(0, 160));
    const firstTable = sitePage.slice(sitePage.indexOf('<table'), sitePage.indexOf('</table>'));
    const heads = [...firstTable.matchAll(/<th[^>]*>([^<]*)<\/th>/g)].map((m) => m[1]);
    check('T11b10 评论表是四列：作者 / 内容 / 文章 / 操作',
      heads.join(',') === '作者,内容,文章,操作', heads.join(','));
    // 「文章」列标题单行截断：块级省略号，但必须压住单元格固有宽度贡献，否则 nowrap 会撑宽该列、从「内容」列抢宽度。
    const adminCss = fs.readFileSync('public/admin.css', 'utf8');
    const truncRule = /\.a-table-comments \.a-col-post \.a-link \{[^}]*display: block[^}]*width: 0[^}]*min-width: 100%[^}]*text-overflow: ellipsis[^}]*white-space: nowrap/.test(adminCss);
    const m640Start = adminCss.indexOf('@media (max-width: 640px)');
    let m640 = '', depth = 0, i640 = m640Start >= 0 ? adminCss.indexOf('{', m640Start) : -1;
    for (let i = i640; i >= 0 && i < adminCss.length; i++) {
      depth += adminCss[i] === '{' ? 1 : adminCss[i] === '}' ? -1 : 0;
      if (depth === 0 && i > i640) { m640 = adminCss.slice(i640, i + 1); break; }
    }
    check('T11b11 「文章」列标题单行截断 + 卡片模式还原列宽与换行',
      truncRule
      && /\.a-col-author,\s*\.a-table-comments \.a-col-post \{ width: auto; min-width: 0; \}/.test(m640)
      && /\.a-table-comments \.a-col-post \.a-link \{ display: inline; white-space: normal; \}/.test(m640),
      `trunc=${truncRule} m640found=${m640Start >= 0} authorReset=${/a-col-author,[\s\S]*?width: auto; min-width: 0/.test(m640)} linkInline=${/a-col-post \.a-link \{ display: inline/.test(m640)}`);
    check('T11b12 手机内容卡：标题独占一行，评论与时间同排；状态下拉给箭头留位',
      /grid-template-areas: "state title title" "comments comments time"/.test(adminCss)
      && /\.a-search \.a-select \{ padding-left: \.6rem; padding-right: 2rem; \}/.test(adminCss), '');
    // 手机后台是独立的 App 壳：藏左轨、顶部应用栏、底部四标签、内容分段；编辑页隐藏整套壳。
    const mobileBlock = adminCss.slice(adminCss.lastIndexOf('/* —— 手机 App 壳'));
    check('T11b13 手机后台是 App 壳（左轨隐藏 / 底部四标签 / 内容分段 / 编辑页让位）',
      /@media \(max-width: 640px\)[\s\S]*?\.a-rail \{ display: none; \}/.test(mobileBlock)
      && /\.a-tabbar \{[\s\S]*?grid-template-columns: repeat\(4, 1fr\)/.test(mobileBlock)
      && /\.a-seg \{ display: grid/.test(mobileBlock)
      && /\.page-is-editor \.a-mbar/.test(mobileBlock),
      `block=${mobileBlock.length}`);
    check('T11b14 手机动作区紧凑：30px 胶囊 + 44px 命中 + 编辑底栏 38px',
      /\.a-table td\.a-ops a,[\s\S]*?height: 30px; min-height: 30px/.test(mobileBlock)
      && /inset: -7px 0/.test(mobileBlock)
      && /#editorForm :where\(\.a-bar-actions\) button \{ height: 38px; min-height: 38px/.test(mobileBlock),
      '');
    check('T11b15 手机媒体动作同一行，友圈工具行 30px',
      /\.a-media-actions \.a-media-reference \{ grid-column: auto; min-height: 30px/.test(mobileBlock)
      && /\.a-media-ref-more \{ display: none; \}/.test(mobileBlock)
      && /\.a-feeds-bar-ops button,[\s\S]*?height: 30px; min-height: 30px/.test(mobileBlock),
      '');
    db.prepare('DELETE FROM comments WHERE id = ?').run(siteId);
  }
  const csrf = csrfOf(cmPage);
  const r = await req(`/admin/comments/${pending.id}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ _csrf: csrf, status: 'approved' }),
  });
  check('T11c 后台通过评论', r.status === 303, `status=${r.status}`);
  const st = (db.prepare('SELECT status FROM comments WHERE id = ?').get(pending.id) ?? {}).status;
  check('T11d 评论状态变为 approved', st === 'approved', st);

  await req(`/admin/comments/${pending.id}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ _csrf: csrf, status: 'deleted' }),
  });
  const delPage = await html('/admin/comments');
  check('T11j 已删除的评论在列表里才有「彻底删除」入口',
    delPage.includes(`/admin/comments/${pending.id}/purge`), '');

  // 以作者身份回复评论（以前后台没有入口，只能从审核邮件绕）
  {
    const listPage2 = await html('/admin/comments');
    check('T11j1 评论行里有「回复」入口，指向后台回复页',
      new RegExp(`href="/admin/comments/${pending.id}/reply"`).test(listPage2), '');
    check('T11j1b 回复框就折叠在该行下方（隐藏的 tr，含 CSRF 与取消按钮）',
      new RegExp(`<tr class="a-reply-row" id="reply-row-(pending|recent)-${pending.id}" hidden>`).test(listPage2)
      && /data-reply-toggle data-no-pjax/.test(listPage2)
      && new RegExp(`<form class="a-reply-form" method="post" action="/admin/comments/${pending.id}/reply">`).test(listPage2)
      && new RegExp(`data-reply-cancel="${pending.id}"`).test(listPage2), '');
    check('T11j1c 入口带 data-no-pjax（否则会被 nav.js 接管，点了照样跳页）',
      /<a class="a-link" href="\/admin\/comments\/\d+\/reply" data-reply-toggle data-no-pjax/.test(listPage2), '');
    check('T11j1d 两张表里的同一条评论不会产生重复 id',
      (() => {
        const ids = listPage2.match(/id="reply-row-[^"]+"/g) ?? [];
        return ids.length === new Set(ids).size;
      })(), '');

    const replyPage = await html(`/admin/comments/${pending.id}/reply`);
    check('T11j2 回复页能打开，并带上被回复的那条评论与联系邮箱',
      replyPage.includes(AUTHOR) && replyPage.includes('admin-check@example.com'), '');
    check('T11j3 回复页有输入框和「发布回复」按钮',
      /<textarea[^>]*name="body"[^>]*required/.test(replyPage) && replyPage.includes('发布回复'), '');

    const noCsrf = await req(`/admin/comments/${pending.id}/reply`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ body: '伪造的回复' }),
    });
    check('T11j4 回复也要 CSRF 令牌（缺了被拒）', noCsrf.status === 403, `status=${noCsrf.status}`);

    const rr = await req(`/admin/comments/${pending.id}/reply`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ _csrf: csrfOf(listPage2), body: '谢谢留言，这个问题我再补一段。' }),
    });
    const inserted = db.prepare(`SELECT * FROM comments WHERE body_md = '谢谢留言，这个问题我再补一段。'`).get();
    check('T11j5 回复发布成功并回到评论列表',
      rr.status === 303 && (rr.headers.get('location') ?? '').startsWith('/admin/comments?w='),
      `status=${rr.status} loc=${rr.headers.get('location')}`);
    check('T11j6 回复以作者身份写入且直接通过审核',
      inserted?.is_author === 1 && inserted?.status === 'approved', JSON.stringify(inserted ?? {}));
    check('T11j7 回复挂在同一条讨论下（顶层评论回复到它自己那一层）',
      inserted?.parent_id === pending.id, `parent=${inserted?.parent_id} 期望 ${pending.id}`);

    const front = await fetch(`${BASE}/p/why-single-column/`).then((x) => x.text());
    check('T11j8 前台立刻显示这条回复并标出「作者」',
      front.includes('谢谢留言，这个问题我再补一段。') && front.includes('badge-author'), '');
    db.prepare('DELETE FROM comments WHERE id = ?').run(inserted.id);
  }

  db.prepare(`INSERT INTO comments(post_id, parent_id, author, body_md, status, created_at)
    VALUES(?, ?, '回复者', '一条回复', 'approved', datetime('now'))`).run(
    db.prepare('SELECT post_id FROM comments WHERE id = ?').get(pending.id).post_id, pending.id);
  const replyCount = db.prepare('SELECT COUNT(*) AS n FROM comments WHERE parent_id = ?').get(pending.id).n;
  const confirm = await html(`/admin/comments/${pending.id}/purge`);
  check('T11k 确认页说清"不可恢复"（不进回收站、没有还原入口）',
    confirm.includes('不进回收站') && confirm.includes('没有还原入口') && !confirm.includes('**'), '');
  check('T11k-2 确认页写明回复条数', confirm.includes('确认彻底删除') && confirm.includes(String(replyCount)), '');

  const pr = await req(`/admin/comments/${pending.id}/purge`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ _csrf: csrf }),
  });
  const gone = !db.prepare('SELECT 1 FROM comments WHERE id = ?').get(pending.id);
  const repliesGone = db.prepare('SELECT COUNT(*) AS n FROM comments WHERE parent_id = ?').get(pending.id).n === 0;
  check('T11l 确认后那行真的从库里消失，回复也一起没了',
    pr.status === 303 && gone && repliesGone, `status=${pr.status} gone=${gone} replies=${repliesGone}`);
}

{
  const postsPage = await html('/admin');
  const notesPage = await html('/admin/notes');
  const kindsOn = (h) => [...h.matchAll(/<td class="a-mono a-hide-sm"[^>]*>\/([pn])\//g)].map((m) => m[1]);
  const pKinds = [...new Set(kindsOn(postsPage))];
  const nKinds = [...new Set(kindsOn(notesPage))];

  check('T8m-1 侧栏「内容」里文章与笔记各一项',
    postsPage.includes('href="/admin/notes"') && notesPage.includes('href="/admin/notes"'),
    '');
  check('T8m-2 文章页只列文章（链接全是 /p/）',
    kindsOn(postsPage).length > 0 && pKinds.join(',') === 'p', `出现 ${pKinds.join(',') || '无'}`);
  check('T8m-3 笔记页只列笔记（链接全是 /n/）',
    kindsOn(notesPage).length > 0 && nKinds.join(',') === 'n', `出现 ${nKinds.join(',') || '无'}`);
  check('T8m-4 两页统计条各说各的文体',
    postsPage.includes('<span>全部文章</span>') && notesPage.includes('<span>全部笔记</span>'), '');
  check('T8m-5 两页的新建按钮各自只给自己的文体',
    /href="\/admin\/new\?kind=post">写文章</.test(postsPage) && !/kind=note/.test(postsPage)
    && /href="\/admin\/new\?kind=note">写笔记</.test(notesPage) && !/kind=post/.test(notesPage), '');
  check('T8m-6 行内不再重复标"文章/笔记"（整页只有一种文体）',
    !postsPage.includes('<div class="a-dim">文章') && !notesPage.includes('<div class="a-dim">笔记'), '');
}

{
  const file = path.join(CONTENT_DIR, 'posts', `${slug}.md`);
  const page = await html('/admin');
  const r = await req(`/admin/delete/${postId}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ _csrf: csrfOf(page) }),
  });
  check('T12a 删除请求成功', r.status === 303, `status=${r.status}`);
  check('T12b 数据库记录已删除', !db.prepare('SELECT 1 AS x FROM posts WHERE id = ?').get(postId));
  check('T12c 原文件已不在 content/posts', !fs.existsSync(file));
  const trash = fs.existsSync(path.join(CONTENT_DIR, '.trash'))
    ? fs.readdirSync(path.join(CONTENT_DIR, '.trash')).filter((f) => f.includes(PREFIX)) : [];
  check('T12d 文件被移到 .trash（误删可手工救回）', trash.length > 0, JSON.stringify(trash));
  check('T12e 前台该文章已 404', (await fetch(`${BASE}/p/${slug}/`)).status === 404);

  for (const f of trash) { try { fs.unlinkSync(path.join(CONTENT_DIR, '.trash', f)); } catch {  } }
  const left = fs.existsSync(path.join(CONTENT_DIR, '.trash'))
    ? fs.readdirSync(path.join(CONTENT_DIR, '.trash')).filter((f) => f.includes(PREFIX)) : [];
  check('T12f 测试自己清理了回收站（不往用户内容目录堆垃圾）', left.length === 0, JSON.stringify(left));
}

// 同一个保存里既改 slug 又改类型：必须更新原来那一行
// 老实现只按 filePath/slug 定位旧行：改名+换类型都匹配不上 → 插出新记录，原行连同评论与修订留在原地而文件已删（下次启动才标 missing_file）。
{
  const tmpSlug = `${PREFIX}kindmove`;
  const newSlug = `${PREFIX}kindmove-note`;
  const fileBefore = path.join(CONTENT_DIR, 'posts', `${tmpSlug}.md`);
  const fileAfter = path.join(CONTENT_DIR, 'notes', `${newSlug}.md`);
  createdFiles.push(fileBefore, fileAfter);

  const newPage = await html('/admin/new?kind=post');
  const saved = await req('/admin/save', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      _csrf: csrfOf(newPage), action: 'publish', id: '', kind: 'post',
      title: '测试文章：一会儿改成笔记', slug: tmpSlug,
      date: toLocalInput(new Date().toISOString()), body: '先是一篇文章。', draft: '', comments: '1',
    }),
  });
  const moveId = Number(/\/admin\/edit\/(\d+)/.exec(saved.headers.get('location') ?? '')?.[1] ?? 0);
  created.push({ id: moveId, slug: tmpSlug });
  check('T16a 先建出一篇文章（前置条件）',
    saved.status === 303 && moveId > 0 && fs.existsSync(fileBefore), `status=${saved.status} id=${moveId}`);

  const editPage = await html(`/admin/edit/${moveId}`);
  const moved = await req('/admin/save', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      _csrf: csrfOf(editPage), action: 'save', id: String(moveId), kind: 'note',
      title: '测试笔记：改成笔记并改名', slug: newSlug,
      date: toLocalInput(new Date().toISOString()), body: '现在是笔记了。', draft: '', comments: '1',
    }),
  });
  const rowsWithPrefix = db.prepare('SELECT COUNT(*) AS n FROM posts WHERE slug LIKE ?').get(`${PREFIX}kindmove%`).n;
  const row = db.prepare('SELECT id, slug, kind FROM posts WHERE id = ?').get(moveId) ?? {};
  check('T16b 改 slug + 改类型后还是同一行，没有插出重复记录',
    moved.status === 303 && row.id === moveId && row.slug === newSlug && row.kind === 'note' && rowsWithPrefix === 1,
    `status=${moved.status} rows=${rowsWithPrefix} row=${JSON.stringify(row)}`);
  check('T16c 文件从 posts/ 移到 notes/，旧文件不残留',
    fs.existsSync(fileAfter) && !fs.existsSync(fileBefore), `${fs.existsSync(fileAfter)}/${fs.existsSync(fileBefore)}`);
  const oldUrl = await fetch(`${BASE}/p/${tmpSlug}/`, { redirect: 'manual' });
  check('T16d 旧地址 301 到改类型后的新地址',
    oldUrl.status === 301 && (oldUrl.headers.get('location') ?? '').includes(`/n/${newSlug}`),
    `${oldUrl.status} ${oldUrl.headers.get('location')}`);
  check('T16e 新地址可访问', (await fetch(`${BASE}/n/${newSlug}/`)).status === 200);
}

// 非 ASCII slug 的旧地址也要 301
// alias 表以前按 encodeURIComponent(slug) 存，而 c.req.path 已被 Hono 解码 —— 两种形态对不上，中文 slug 改名后旧地址只剩 404；ASCII slug 恰好相同所以一直没被发现。
{
  const zhSlug = `${PREFIX}中文-slug`;
  const asciiSlug = `${PREFIX}zh-renamed`;
  const fileZh = path.join(CONTENT_DIR, 'posts', `${zhSlug}.md`);
  const fileAscii = path.join(CONTENT_DIR, 'posts', `${asciiSlug}.md`);
  createdFiles.push(fileZh, fileAscii);

  const newPage = await html('/admin/new?kind=post');
  const saved = await req('/admin/save', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      _csrf: csrfOf(newPage), action: 'publish', id: '', kind: 'post',
      title: '中文标题', slug: zhSlug,
      date: toLocalInput(new Date().toISOString()), body: '中文 slug 的正文。', draft: '', comments: '1',
    }),
  });
  const zhId = Number(/\/admin\/edit\/(\d+)/.exec(saved.headers.get('location') ?? '')?.[1] ?? 0);
  created.push({ id: zhId, slug: zhSlug });
  check('T17a 中文 slug 能保存，且编码后的地址可访问',
    saved.status === 303 && zhId > 0 && (await fetch(`${BASE}/p/${encodeURIComponent(zhSlug)}/`)).status === 200,
    `status=${saved.status} id=${zhId}`);

  const editZh = await html(`/admin/edit/${zhId}`);
  const renamed = await req('/admin/save', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      _csrf: csrfOf(editZh), action: 'save', id: String(zhId), kind: 'post',
      title: '改成了 ASCII slug', slug: asciiSlug,
      date: toLocalInput(new Date().toISOString()), body: '中文 slug 的正文。', draft: '', comments: '1',
    }),
  });
  const oldZh = await fetch(`${BASE}/p/${encodeURIComponent(zhSlug)}/`, { redirect: 'manual' });
  check('T17b 中文 slug 改名后，旧的（编码）地址 301 到新地址，而不是 404',
    renamed.status === 303 && oldZh.status === 301 && (oldZh.headers.get('location') ?? '').includes(asciiSlug),
    `status=${oldZh.status} loc=${oldZh.headers.get('location')}`);
  check('T17c 直接用汉字写地址也能跳到新地址',
    (await fetch(`${BASE}/p/${zhSlug}/`, { redirect: 'manual' })).status === 301, '');
  const alias = db.prepare('SELECT path FROM aliases WHERE post_id = ?').all(zhId).map((r) => r.path);
  check('T17d alias 存的是解码路径（与 c.req.path 同一种形态）',
    alias.includes(`/p/${zhSlug}/`), JSON.stringify(alias));
  check('T17e 新地址可访问', (await fetch(`${BASE}/p/${asciiSlug}/`)).status === 200);
}

{
  const empty = await (await req(`/admin?q=${encodeURIComponent('zzz-no-such-post')}`)).text();
  check('T15a 搜索无结果时提示指向"没有匹配"，而不是"还没有内容"',
    empty.includes('没有匹配') && !empty.includes('还没有内容'), '');
  check('T15b 搜索无结果时提供"清除搜索"入口', empty.includes('清除搜索'), '');
  check('T15c 搜索无结果时不显示分页（省掉无意义的"第 1 页"）',
    !empty.includes('a-pager'), '');

  const all = await (await req('/admin')).text();
  check('T15d 列表非空时仍显示分页与搜索框',
    all.includes('a-pager') && all.includes('a-search'), '');
  check('T15e 列表非空时不会误显示"没有匹配"', !all.includes('没有匹配'), '');
}

// 固定页（kind='page'）：关于页就是一份内容文件
{
  const gone = await req('/admin/about');
  check('T18a 原来的 /admin/about 入口已经撤掉（登录后是 404）', gone.status === 404, `status=${gone.status}`);

  const editNew = await html('/admin/new?kind=page');
  check('T18b 固定页用的是常规文章编辑器，类型里能选「页面」',
    editNew.includes('id="editorForm"') && editNew.includes('value="page"') && editNew.includes('页面')
    && editNew.includes('id="f-body"'), '');

  const csrf = csrfOf(editNew);
  const created = await req('/admin/save', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      _csrf: csrf, action: 'publish', id: '', kind: 'page', slug: 'about',
      title: '关于这个站', body: '# 你好\n\n固定页正文，用来验证它落成文件。',
      date: toLocalInput(new Date().toISOString()),
    }),
  });
  check('T18c 保存固定页返回 303', created.status === 303, `status=${created.status}`);

  const row = db.prepare('SELECT id, kind, file_path FROM posts WHERE slug = ?').get('about');
  check('T18d 固定页落在 content/pages/ 下（不是 posts/notes）',
    row?.kind === 'page' && (row.file_path ?? '').includes(`${path.sep}pages${path.sep}`), row?.file_path ?? '(无)');
  check('T18e 文件真的写到了磁盘上', Boolean(row?.file_path) && fs.existsSync(row.file_path), row?.file_path ?? '');

  const front = await (await fetch(`${BASE}/about/`)).text();
  check('T18f 前台 /about/ 渲染这份固定页（标题 + 正文）',
    front.includes('关于这个站') && front.includes('固定页正文'), '');

  // 关键：固定页不算内容，列表/归档/Feed 一处都不能出现。判据用正文片段而非标题 —— 标题会出现在每页导航里。
  const has = async (u) => (await (await fetch(BASE + u)).text()).includes('固定页正文');
  check('T18g 固定页不进文章列表、笔记、归档与三种 Feed',
    !(await has('/posts/')) && !(await has('/notes/')) && !(await has('/archive/'))
    && !(await has('/feed.xml')) && !(await has('/feed.json')) && !(await has('/atom.xml')), '');
  const sitemap = await (await fetch(`${BASE}/sitemap.xml`)).text();
  check('T18h 固定页进 sitemap', /<loc>[^<]*\/about<\/loc>/.test(sitemap),
    sitemap.match(/<loc>[^<]*\/about<\/loc>/)?.[0] ?? '（sitemap 里没有 /about）');

  const health = await (await fetch(`${BASE}/healthz`)).json();
  const contentCount = db.prepare("SELECT COUNT(*) AS n FROM posts WHERE kind IN ('post','note') AND draft = 0 AND published_at IS NOT NULL").get().n;
  check('T18i 固定页不计入内容统计（healthz 的篇数只算文章与笔记）',
    health.posts === contentCount, `healthz=${health.posts} 内容=${contentCount}`);


  const pagesList = await html('/admin/pages');
  const rail = /<nav class="a-rail-nav"[\s\S]*?<\/nav>/.exec(pagesList)?.[0] ?? '';
  check('T18k 侧栏「内容」里的顺序是 文章 → 笔记 → 页面 → 评论 → 媒体',
    /文章[\s\S]*笔记[\s\S]*页面[\s\S]*评论[\s\S]*媒体/.test(rail)
    && rail.includes('href="/admin/pages"') && rail.includes('aria-current="page"'), '');
  const tabs = /<nav class="a-tabbar"[\s\S]*?<\/nav>/.exec(pagesList)?.[0] ?? '';
  check('T18p 手机底栏四个入口，当前「内容」高亮',
    /内容[\s\S]*评论[\s\S]*媒体[\s\S]*更多/.test(tabs)
    && tabs.includes('href="/admin/more"') && /class="a-tab on" aria-current="page"/.test(tabs), '');
  check('T18q 内容页有 文章/笔记/页面 分段，页面处于当前项',
    pagesList.includes('class="a-seg"')
    && /aria-label="内容类型"[\s\S]*文章[\s\S]*笔记[\s\S]*页面/.test(pagesList)
    && /<a href="\/admin\/pages" aria-current="page">页面<\/a>/.test(pagesList), '');
  const morePageHtml = await html('/admin/more');
  check('T18r 「更多」页有友圈/友链/设置与退出',
    morePageHtml.includes('href="/admin/feeds"') && morePageHtml.includes('href="/admin/links"')
    && morePageHtml.includes('href="/admin/system"') && morePageHtml.includes('action="/admin/logout"'), '');
  // 页面列表以前刻意不显示评论列；现在固定页也能评论，这一列必须和文章/笔记一致；地址列跟着前台真实地址走（固定页 /about、无尾斜杠）。
  check('T18l 页面列表列着这份固定页（标题 + /about 地址列，与 canonical 同形），且和文章一样有评论列',
    pagesList.includes('关于这个站') && pagesList.includes('title="/about"') && pagesList.includes('全部页面')
    && pagesList.includes('data-label="评论"'), '');
  const fromList = /href="\/admin\/edit\/(\d+)"/.exec(pagesList)?.[1];
  check('T18m 列表里的编辑入口指向常规编辑器', fromList === String(row?.id), `列表=${fromList} 行=${row?.id}`);
  check('T18n 页面列表不带文章/笔记（固定页是独立的一类）',
    !pagesList.includes('为什么单栏是唯一正确的选择') && !pagesList.includes('示例笔记'), '');
  const searchPage = await html('/admin/pages?q=zzz-no-such-page');
  check('T18o 页面列表支持搜索，清除链接回到 /admin/pages',
    searchPage.includes('没有匹配') && searchPage.includes('href="/admin/pages"'), '');

  if (row) {
    if (row.file_path && fs.existsSync(row.file_path)) fs.unlinkSync(row.file_path);
    db.prepare('DELETE FROM posts WHERE id = ?').run(row.id);
  }
}

// 表单提交的正文行尾：浏览器 new FormData(form) 会把换行转成 CRLF，落盘必须回到 LF
// 曾出现整篇 diff 漂移（about.md 带 41 个 CR）。写入层逐字保留正文，所以归一化放在请求入口（shared.js formBody）。
{
  const slug = `${PREFIX}crlf`;
  const file = path.join(CONTENT_DIR, 'posts', `${slug}.md`);
  createdFiles.push(file);

  const page = await html('/admin/new?kind=post');
  const saved = await req('/admin/save', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      _csrf: csrfOf(page), action: 'publish', id: '', kind: 'post',
      title: '测试文章：正文带 CRLF', slug,
      date: toLocalInput(new Date().toISOString()),
      body: '第一行\r\n第二行\r\n\r\n引用\r\n', draft: '', comments: '1',
    }),
  });
  const crlfId = Number(/\/admin\/edit\/(\d+)/.exec(saved.headers.get('location') ?? '')?.[1] ?? 0);
  created.push({ id: crlfId, slug });
  const raw = fs.existsSync(file) ? fs.readFileSync(file, 'utf8') : '';
  const row = db.prepare('SELECT body_md FROM posts WHERE id = ?').get(crlfId) ?? {};
  check('T20a 表单提交的 CRLF 正文落盘为 LF，且内容没被改动',
    saved.status === 303 && !raw.includes('\r') && raw.includes('第一行\n第二行\n\n引用\n'),
    `status=${saved.status} CR=${(raw.match(/\r/g) ?? []).length} raw=${JSON.stringify(raw.slice(-40))}`);
  check('T20b 入库的 body_md 同样是 LF',
    typeof row.body_md === 'string' && !row.body_md.includes('\r') && row.body_md.includes('第一行\n第二行\n\n引用'),
    JSON.stringify(row.body_md));
}

// 内容维护：一键清空全站修订历史与旧链接（301 映射）
{
  const before = {
    revisions: db.prepare('SELECT COUNT(*) AS n FROM revisions').get().n,
    aliases: db.prepare('SELECT COUNT(*) AS n FROM aliases').get().n,
  };
  const oldAlias = db.prepare('SELECT path FROM aliases ORDER BY path LIMIT 1').get()?.path ?? '';

  const page = await html('/admin/system');
  check('T21a 设置页有「内容维护」，标出修订与旧链接数量，并给出清空入口',
    page.includes('内容维护') && page.includes('id="historyClear"')
    && page.includes('action="/admin/history/clear"')
    && page.includes(`<b>${before.revisions}</b>`) && page.includes(`<b>${before.aliases}</b>`)
    && before.revisions > 0 && before.aliases > 0,
    `rev=${before.revisions} alias=${before.aliases}`);

  const r = await req('/admin/history/clear', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ _csrf: csrfOf(page) }),
  });
  const after = {
    revisions: db.prepare('SELECT COUNT(*) AS n FROM revisions').get().n,
    aliases: db.prepare('SELECT COUNT(*) AS n FROM aliases').get().n,
  };
  check('T21b 清空后 revisions 与 aliases 两张表都空了',
    r.status === 303 && after.revisions === 0 && after.aliases === 0,
    `status=${r.status} rev=${after.revisions} alias=${after.aliases}`);
  check('T21c 清空只动历史表，正文条目还在',
    db.prepare('SELECT COUNT(*) AS n FROM posts').get().n > 0, '');
  check('T21d 被清掉的旧链接不再 301（直接 404）',
    oldAlias !== '' && (await fetch(BASE + oldAlias, { redirect: 'manual' })).status === 404,
    `alias=${oldAlias}`);

  const page2 = await html('/admin/system');
  check('T21e 清空后计数归零，按钮隐藏',
    page2.includes('修订历史 <b>0</b> 条 · 旧链接（301 映射）<b>0</b> 条')
    && /id="historyClear"[^>]*hidden/.test(page2), '');

  const noAuth = await fetch(`${BASE}/admin/history/clear`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ _csrf: 'x' }),
    redirect: 'manual',
  });
  check('T21f 未登录清不了历史',
    noAuth.status === 303 && (noAuth.headers.get('location') ?? '').includes('/admin/login'), `status=${noAuth.status}`);
}

for (const f of createdFiles) {
  const p = path.resolve(f);
  if (p.startsWith(path.resolve(CONTENT_DIR)) && fs.existsSync(p)) fs.unlinkSync(p);
}
db.prepare("DELETE FROM comments WHERE author LIKE '后台测试员%'").run();

if (uploadedUrl) {
  const p = path.join(UPLOADS_DIR, uploadedUrl.replace(/^\/uploads\//, ''));
  if (fs.existsSync(p)) fs.unlinkSync(p);
  db.prepare('DELETE FROM media WHERE path = ?').run(uploadedUrl);
}
if (uploadedRawUrl) {
  const p = path.join(UPLOADS_DIR, uploadedRawUrl.replace(/^\/uploads\//, ''));
  if (fs.existsSync(p)) fs.unlinkSync(p);
  db.prepare('DELETE FROM media WHERE path = ?').run(uploadedRawUrl);
}
db.prepare('DELETE FROM posts WHERE slug LIKE ?').run(`${PREFIX}%`);

db.close();
await srv.stop();
process.exit(report() ? 1 : 0);

import './_test-env.mjs';
import { cookieJar, createClient, csrfOf, loginAdmin } from './_shared.mjs';
import { navItemsOf, visibleNavOf, saveNav } from '../src/site/nav.js';
import { saveSiteIdentity, siteIdentityOf } from '../src/site/identity.js';
import { safeLinkHref } from '../src/site/copy.js';
import { open } from '../db/driver.js';

// 站点配置（后台「设置」页新增的七块）的端到端 + 纯函数测试。
// 覆盖：站点身份热生效与 .env 回落、导航改名/换序/隐藏/外链增删、页面文案、
// 评论三开关（含全站关闭后前台与提交端点）、改密码、图标上传与 /site/* 服务。

const { startServer } = await import('./_server.mjs');
const srv = await startServer();
const BASE = srv.base;
const { requireAdminPassword } = await import('./_admin-password.mjs');
const PASSWORD = requireAdminPassword('test-site-admin.mjs');
const { createChecker } = await import('./_check.mjs');
const { check, report } = createChecker();

const jar = cookieJar();
const client = createClient(BASE, jar);
const html = async (url) => (await client(url)).text();
const form = (fields) => ({
  method: 'POST',
  headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
  body: new URLSearchParams(fields),
});

console.log('\n站点配置测试');
console.log('────────────────────────────────────────────');

await loginAdmin(client, PASSWORD);
let page = await html('/admin/system');
let csrf = csrfOf(page);

// —— 渲染 ——
for (const heading of ['站点身份', '导航菜单', '页面文案', '评论', '账号安全']) {
  check(`S1 设置页有「${heading}」一块`, page.includes(`>${heading}</h2>`), heading);
}
check('S1b 设置页把「站点与阅读」改成了「阅读与外观」', page.includes('>阅读与外观</h2>'));

// —— 表单可访问性与文案密度（曾出过的问题，钉住）——
// 1) 一条 <label> 必须有关联控件：带 for，或自己把 input/select/textarea 包在里面。
//    曾经「社交链接」那格是个光秃秃的 <label>，DevTools 直接报 “A <label> isn't associated with a form field”。
// 2) 本次新增的表单里不许出现 placeholder（一输入就消失、对比度也不合格），也不许有解释性小字（a-dim）。
{
  const { identitySection, navSection, copySection, commentsSection, accountSection } =
    await import('../src/admin/views/site.js');
  const html = [
    identitySection({ identity: { title: 't', desc: 'd', author: 'a', email: 'e@x.io', mark: 'm', icp: '', lang: 'zh-CN' }, csrf: 'c' }),
    navSection({ nav: { items: [{ key: 'home', label: '首页', href: '/', group: 'main', show: 1 }], moreLabel: '页面' }, csrf: 'c' }),
    copySection({ copy: { heroPosts: '篇文章', heroNotes: '篇笔记', recent: '最近更新', postsTitle: '文章', postsDesc: '', notesTitle: '笔记', notesDesc: '' }, csrf: 'c' }),
    commentsSection({ comments: { open: true, moderateAll: false, rate: 5 }, csrf: 'c' }),
    accountSection({ csrf: 'c', configured: true }),
  ].join('\n');

  const orphan = [...html.matchAll(/<label\b([^>]*)>([\s\S]*?)<\/label>/g)]
    .filter(([, attrs, body]) => !/\bfor="/.test(attrs) && !/<(?:input|select|textarea)\b/.test(body));
  check('S1c 新增表单里没有孤立 <label>', orphan.length === 0, orphan.map((m) => m[0].slice(0, 60)).join(' | '));

  // 把「嵌套 label」整块去掉（里面的控件已由 S1c 保证有关联名），剩下的控件必须自带 for 指向或 aria-label。
  const flat = html.replace(/<label\b([^>]*)>[\s\S]*?<\/label>/g, (m, attrs) => (/\bfor="/.test(attrs) ? m : ''));
  const forIds = new Set([...flat.matchAll(/\bfor="([^"]+)"/g)].map((m) => m[1]));
  const unlabeled = [...flat.matchAll(/<(input|select|textarea)\b([^>]*)>/g)]
    .filter(([, tag, attrs]) => !(tag === 'input' && /type="hidden"/.test(attrs)))
    .filter(([, , attrs]) => {
      const id = /\bid="([^"]+)"/.exec(attrs)?.[1];
      if (id && forIds.has(id)) return false;
      return !/\baria-label(?:ledby)?="/.test(attrs);
    });
  check('S1d 新增表单里每个字段都有可访问名', unlabeled.length === 0, unlabeled.map((m) => m[0].slice(0, 60)).join(' | '));

  check('S1e 新增表单里没有 placeholder', !html.includes('placeholder='));
  check('S1f 新增表单里没有解释性小字（a-dim）', !html.includes('a-dim'));
}

// —— 站点身份 ——
{
  const r = await client('/admin/site/identity', form({
    _csrf: csrf, title: '测试用的站名', desc: '一句话简介',
    author: '测试作者', email: 'a@example.com', mark: '印', icp: '京ICP备00000000号', lang: 'zh-CN',
  }));
  check('S2a 保存站点身份返回 303 且带成功提示', r.status === 303 && decodeURIComponent(r.headers.get('location') ?? '').includes('✓'), `${r.status} ${r.headers.get('location')}`);

  const home = await html('/');
  check('S2b 站名立刻出现在前台标题', home.includes('测试用的站名'), '标题未更新');
  check('S2c 简介进了 meta description', /<meta name="description" content="一句话简介">/.test(home));
  check('S2d 印章字出现在首页封面', home.includes('class="hero-mark"') && home.includes('印'));
  check('S2e 作者与备案号进了页脚', home.includes('测试作者') && home.includes('京ICP备00000000号'));
  check('S2f 语言标记写进 <html lang>', /<html lang="zh-CN"/.test(home));

  // 校验：邮箱形状
  const bad = await client('/admin/site/identity', form({ _csrf: csrf, title: 'x', email: 'not-an-email', lang: 'zh-CN' }));
  check('S2g 非邮箱地址被拒', decodeURIComponent(bad.headers.get('location') ?? '').includes('不像邮箱'), bad.headers.get('location'));

  // 清空 → 回落到环境变量/域名，而不是把空串写死在前台
  await client('/admin/site/identity', form({ _csrf: csrf, title: '', desc: '', author: '', email: '', mark: '', icp: '', lang: 'zh-CN' }));
  const after = await html('/');
  check('S2h 清空站名后回落到出厂身份', !after.includes('测试用的站名'), '旧站名仍在');
  check('S2i 清空作者后页脚不再显示作者', !after.includes('测试作者'));
}

// —— 导航：改名 / 隐藏 / 排序 ——
{
  // 导航编辑器在后台页面里（前台没有表单），从那里读真实的 key 顺序。
  page = await html('/admin/system');
  const keys = [...page.matchAll(/name="key\[(\d+)\]" value="([^"]*)"/g)];
  check('S3a 后台导航表单列出了全部内置项', keys.length >= 6, `找到 ${keys.length} 项`);

  // 用表单里的原始顺序构造一次提交：文章改名「随笔」，笔记隐藏，并上移归档。
  const rowCount = keys.length;
  const labelOf = (key) => ({ home: '首页', posts: '文章', notes: '笔记', friends: '友圈', links: '友链', archive: '归档' }[key] ?? key);
  const payload = { _csrf: csrf, moreLabel: '页面' };
  [0, 1, 2, 3, 4, 5].slice(0, rowCount).forEach((i, idx) => {
    const key = keys[i]?.[2] ?? '';
    payload[`key[${idx}]`] = key;
    payload[`href[${idx}]`] = '';
    payload[`label[${idx}]`] = key === 'posts' ? '随笔' : labelOf(key);
    payload[`group[${idx}]`] = ['home', 'posts', 'notes'].includes(key) ? 'main' : 'more';
    if (key !== 'notes') payload[`show[${idx}]`] = '1';
  });
  const r = await client('/admin/site/nav', form(payload));
  check('S3b 导航保存成功', decodeURIComponent(r.headers.get('location') ?? '').includes('✓'), r.headers.get('location'));

  // 只在页头导航这一段里断言：「笔记」在别处也会出现（最近更新的条目上有个「笔记」方章），
  // 整页 includes 会把那个也算进来。
  const after = await html('/');
  const navBlock = (html) => {
    const start = html.indexOf('<nav class="nav"');
    return start < 0 ? '' : html.slice(start, html.indexOf('</nav>', start));
  };
  check('S3c 改名后顶栏显示新名称', navBlock(after).includes('随笔'), navBlock(after).slice(0, 120));
  check('S3d 隐藏的项不再出现在导航里', !navBlock(after).includes('笔记'), navBlock(after).slice(0, 200));
}

// —— 导航：加外链 / 删外链 ——
{
  const r = await client('/admin/site/nav', form({
    ...Object.fromEntries([...Array(6)].flatMap((_, i) => [
      [`key[${i}]`, ['home', 'posts', 'notes', 'friends', 'links', 'archive'][i]],
      [`href[${i}]`, ''], [`label[${i}]`, ['首页', '随笔', '笔记', '友圈', '友链', '归档'][i]],
      [`group[${i}]`, i < 3 ? 'main' : 'more'], [`show[${i}]`, '1'],
    ])),
    _csrf: csrf, moreLabel: '页面',
    newLabel: 'GitHub', newHref: 'https://github.com/chenlun', newGroup: 'more',
  }));
  check('S4a 新增外链保存成功', decodeURIComponent(r.headers.get('location') ?? '').includes('✓'), r.headers.get('location'));

  const home = await html('/');
  check('S4b 外链出现在「页面」下拉里', home.includes('>GitHub</span>') && home.includes('https://github.com/chenlun'));
  check('S4c 外链地址原样输出（不强加尾斜杠）', !home.includes('href="https://github.com/chenlun/"'));

  const adminAgain = await html('/admin/system');
  const key = /name="key\[\d+\]" value="(link:[a-z0-9]+)"/.exec(adminAgain)?.[1];
  check('S4d 后台表单里能认到外链的 key', Boolean(key), '没找到 link:* 键');

  const del = await client('/admin/site/nav', form({
    ...Object.fromEntries([...Array(7)].flatMap((_, i) => [
      [`key[${i}]`, ['home', 'posts', 'notes', 'friends', 'links', 'archive'][i] ?? key],
      [`href[${i}]`, ['home', 'posts', 'notes', 'friends', 'links', 'archive'][i] ? '' : 'https://github.com/chenlun'],
      [`label[${i}]`, ['首页', '随笔', '笔记', '友圈', '友链', '归档'][i] ?? 'GitHub'],
      [`group[${i}]`, i < 3 ? 'main' : 'more'], [`show[${i}]`, '1'],
    ])),
    _csrf: csrf, moreLabel: '页面', remove: key,
  }));
  check('S4e 删除外链保存成功', del.status === 303);
  check('S4f 删除后前台不再出现', !(await html('/')).includes('>GitHub</span>'));

  // 非法地址
  const bad = await client('/admin/site/nav', form({
    ...Object.fromEntries([...Array(6)].flatMap((_, i) => [
      [`key[${i}]`, ['home', 'posts', 'notes', 'friends', 'links', 'archive'][i]],
      [`href[${i}]`, ''], [`label[${i}]`, ['首页', '随笔', '笔记', '友圈', '友链', '归档'][i]],
      [`group[${i}]`, i < 3 ? 'main' : 'more'], [`show[${i}]`, '1'],
    ])),
    _csrf: csrf, moreLabel: '页面', newLabel: '坏链', newHref: 'javascript:alert(1)',
  }));
  check('S4g javascript: 地址被拒', decodeURIComponent(bad.headers.get('location') ?? '').includes('不合法'), bad.headers.get('location'));
}

// —— 页面文案 ——
{
  const r = await client('/admin/site/copy', form({
    _csrf: csrf, heroPosts: '篇拙作', heroNotes: '条碎念', recent: '近来写下的',
    postsTitle: '长文', postsDesc: '写就写透。', notesTitle: '碎片', notesDesc: '没长成文章的。',
  }));
  check('S6a 文案保存成功', decodeURIComponent(r.headers.get('location') ?? '').includes('✓'), r.headers.get('location'));

  const home = await html('/');
  check('S6b 首页统计行换成自定义量词', home.includes('篇拙作') && home.includes('条碎念'));
  check('S6c 首页「最近更新」标题已改', home.includes('近来写下的'));

  const posts = await html('/posts/');
  check('S6d 文章列表刊头用新标题', posts.includes('>长文</h1>'), '刊头没换');
  check('S6e 文章列表简介进了 meta', posts.includes('content="写就写透。"'));

  const notes = await html('/notes/');
  check('S6f 笔记页标题已改', notes.includes('>碎片</h1>'), '刊头没换');

  // 空标题必须被拒：空刊头等于页面没标题
  const bad = await client('/admin/site/copy', form({ _csrf: csrf, heroPosts: '', heroNotes: '条', recent: 'x', postsTitle: 'y', notesTitle: 'z' }));
  check('S6g 量词留空被拒', decodeURIComponent(bad.headers.get('location') ?? '').includes('不能为空'), bad.headers.get('location'));

  await client('/admin/site/copy', form({
    _csrf: csrf, heroPosts: '篇文章', heroNotes: '篇笔记', recent: '最近更新',
    postsTitle: '文章', postsDesc: '', notesTitle: '笔记', notesDesc: '',
  }));
}

// —— 评论三开关 ——
{
  // 先埋一条早就通过的评论：要验证的是「关掉全站评论只收撰写框，已有讨论照常显示」。
  // fixtures 的库是空的，不埋就分不清「没有评论」和「评论被一起藏了」。
  const db = open(srv.dbFile);
  const post = db.prepare("SELECT id FROM posts WHERE slug = 'why-single-column'").get();
  db.prepare(`INSERT INTO comments
    (post_id, parent_id, author, email_hash, email_enc, website, website_host, body_md, status, is_author, moderation_nonce, submission_id)
    VALUES (?, NULL, '老读者', 'test-hash', NULL, NULL, NULL, '这条是关闭评论之前就有的。', 'approved', 0, 'nonce-site', NULL)`).run(post.id);
  db.close();

  const r = await client('/admin/site/comments', form({ _csrf: csrf, rate: '7' }));
  check('S7a 关闭全站评论保存成功', decodeURIComponent(r.headers.get('location') ?? '').includes('✓'), r.headers.get('location'));

  const article = await html('/p/why-single-column/');
  check('S7b 前台收起撰写框', article.includes('评论暂时关闭'), '没看到关闭提示');
  check('S7c 已有评论仍在页面上', article.includes('这条是关闭评论之前就有的。'), '旧评论被一起藏起来了');

  const submit = await client('/p/why-single-column/comment', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded', Origin: BASE },
    body: new URLSearchParams({ body: '还想偷偷发一条', author: '测试', email: 't@example.com' }),
  });
  // 无 JS 的表单路径：提交后 303 回文章页并带一条 flash（c=pause），不是 JSON。
  check('S7d 关闭期间直接 POST 被拒（回落到 pause 提示）',
    submit.status === 303 && (submit.headers.get('location') ?? '').includes('c=pause'),
    `${submit.status} ${submit.headers.get('location')}`);

  // 打开 + 全部先审
  await client('/admin/site/comments', form({ _csrf: csrf, open: '1', moderateAll: '1', rate: '9' }));
  const reopened = await html('/p/why-single-column/');
  check('S7e 重新打开后撰写框回来了', reopened.includes('data-comment-form'));

  // 限流值越界
  const bad = await client('/admin/site/comments', form({ _csrf: csrf, open: '1', rate: '99' }));
  check('S7f 越界限流值被拒', decodeURIComponent(bad.headers.get('location') ?? '').includes('1—20'), bad.headers.get('location'));

  await client('/admin/site/comments', form({ _csrf: csrf, open: '1', rate: '5' }));
}

// —— 改密码 ——
{
  const wrong = await client('/admin/password', form({ _csrf: csrf, current: 'not-the-password', next: 'brand-new-password', confirm: 'brand-new-password' }));
  check('S9a 旧密码不对被拒', decodeURIComponent(wrong.headers.get('location') ?? '').includes('当前密码不正确'), wrong.headers.get('location'));

  const short = await client('/admin/password', form({ _csrf: csrf, current: PASSWORD, next: 'short', confirm: 'short' }));
  check('S9b 太短的新密码被拒', decodeURIComponent(short.headers.get('location') ?? '').includes('至少 8 位'), short.headers.get('location'));

  const mismatch = await client('/admin/password', form({ _csrf: csrf, current: PASSWORD, next: 'brand-new-password', confirm: 'brand-new-passwerd' }));
  check('S9c 两次输入不一致被拒', decodeURIComponent(mismatch.headers.get('location') ?? '').includes('不一致'), mismatch.headers.get('location'));

  const ok = await client('/admin/password', form({ _csrf: csrf, current: PASSWORD, next: 'brand-new-password', confirm: 'brand-new-password' }));
  check('S9d 改密码成功', decodeURIComponent(ok.headers.get('location') ?? '').includes('密码已更新'), ok.headers.get('location'));

  // 当前这台保持登录：改完还能打开设置页
  check('S9e 改完自己没被踢下线', (await client('/admin/system')).status === 200);

  // 新开一个会话验证：旧密码失败、新密码成功
  const jar2 = cookieJar();
  const client2 = createClient(BASE, jar2);
  const old = await loginAdmin(client2, PASSWORD);
  check('S9f 旧密码已失效', (old.headers.get('location') ?? '').includes('e=bad'), old.headers.get('location'));
  const nu = await loginAdmin(client2, 'brand-new-password');
  check('S9g 新密码可登录', nu.status === 303 && jar2.cookie.startsWith('blog_admin='), `status=${nu.status}`);

  // 改回去，免得影响同进程里后续套件（fixtures 的密码是共享的）
  const restore = await client2('/admin/password', form({
    _csrf: csrfOf(await (await client2('/admin/system')).text()),
    current: 'brand-new-password', next: PASSWORD, confirm: PASSWORD,
  }));
  check('S9h 密码可改回原值', restore.status === 303);
}

// —— 纯函数：导航合并规则 ——
{
  const pages = [{ slug: 'about', title: '关于' }, { slug: 'colophon', title: '' }];
  const merged = navItemsOf(null, pages);
  check('S10a 固定页自动追加在末尾', merged.filter((i) => ['about', 'colophon'].includes(i.key)).length === 2);
  check('S10b 固定页地址用 /<slug>（不带尾斜杠）', merged.find((i) => i.key === 'about').href === '/about');
  check('S10c 没有标题的页用 slug 当名称', merged.find((i) => i.key === 'colophon').label === 'colophon');

  const store = new Map();
  const set = (k, v) => store.set(k, v);
  saveNav({
    keys: ['posts', 'home'], labels: ['随笔', '首页'], groups: ['main', 'main'], hrefs: [], shows: [1, 0],
    moreLabel: '页面', move: { index: 0, dir: 1 },
  }, set);
  const saved = JSON.parse(store.get('nav_items'));
  check('S10d 库里只存覆盖量与顺序', saved[0].key === 'home' && saved[1].key === 'posts', JSON.stringify(saved));
  // move 把第 0 行上移一格 → home(隐藏) 排到了最前，所以隐藏状态落在 saved[0] 上。
  check('S10e 隐藏状态被存下来', saved[0].show === 0, JSON.stringify(saved[0]));

  const reread = navItemsOf((k) => store.get(k), pages);
  check('S10f 回读时按存的顺序排', reread.slice(0, 2).map((i) => i.key).join(',') === 'home,posts');
  const visible = visibleNavOf(reread);
  check('S10g 隐藏项不进入渲染视图', !visible.all.some((i) => i.key === 'home'), visible.all.map((i) => i.key).join(','));

  // .env 回落：存空串等于「没设过」
  const idStore = new Map();
  saveSiteIdentity({ title: '', desc: '', author: '', email: '', mark: '', icp: '', lang: 'zh-CN' },
    (k, v) => idStore.set(k, v), (b, k) => b[k] ?? '');
  check('S10h 出厂值不写进库（改 .env 仍跟着变）', [...idStore.values()].every((v) => v === ''), JSON.stringify([...idStore]));
  const ident = siteIdentityOf((k) => idStore.get(k));
  check('S10i 空串回落到 ENV_SITE', ident.lang === 'zh-CN' && ident.desc.length > 0);

  check('S10j mailto: 链接被接受', safeLinkHref('mailto:a@uua.me') === 'mailto:a@uua.me');
  check('S10k data: 链接被拒', safeLinkHref('data:text/html,<script>') === '');
  check('S10l 相对地址被拒', safeLinkHref('/admin') === '');
}

const failed = report({ label: '站点配置' });
await srv.stop();
process.exit(failed ? 1 : 0);

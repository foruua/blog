import './_test-env.mjs';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { open } from '../db/driver.js';
import { createCrypto } from '../src/auth.js';
import { emailMd5 } from '../src/avatar/md5.js';
import { SITE } from '../src/config.js';

const { startServer } = await import('./_server.mjs');
const srv = await startServer({ isolateDb: true });
const BASE = srv.base;
const DB_FILE = srv.dbFile;
const SLUG = process.env.SLUG ?? 'why-single-column';

const db = open(DB_FILE);
const crypt = createCrypto(db);
const moderationToken = (payload, ttl) => crypt.sign({ ...payload, purpose: 'moderation', nonce: db.prepare('SELECT moderation_nonce FROM comments WHERE id=?').get(payload.c)?.moderation_nonce, ep: Number(db.prepare("SELECT value FROM settings WHERE key='admin_session_epoch'").get()?.value ?? 0) }, ttl);

const { createChecker, sleep } = await import('./_check.mjs');
const { check, report } = createChecker();
const countComments = () => db.prepare('SELECT COUNT(*) AS n FROM comments').get().n;
const lastComment = () => db.prepare('SELECT * FROM comments ORDER BY id DESC LIMIT 1').get();

async function getPost() {
  const res = await fetch(`${BASE}/p/${SLUG}/`);
  const html = await res.text();
  const token = /name="ts" value="([^"]+)"/.exec(html)?.[1] ?? '';
  return { html, token };
}

async function post(fields) {
  const form = new URLSearchParams(fields);
  const res = await fetch(`${BASE}/p/${SLUG}/comment`, {
    method: 'POST', body: form, redirect: 'manual',
  });
  return { status: res.status, location: res.headers.get('location') ?? '' };
}

async function postJson(fields) {
  const res = await fetch(`${BASE}/api/comments`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ slug: SLUG, ...fields }),
  });
  return { status: res.status, body: await res.json().catch(() => ({})) };
}

const base = {
  author: '陈', email: 'chen@example.com', website: '', body: '这是一条测试评论。',
};

console.log('\n评论系统端到端测试');
console.log('────────────────────────────────────────────');

{
  const { createCommentRepo } = await import('../db/comments.js');
  const { commentRoutes } = await import('../src/routes/comments.js');
  const comments = createCommentRepo(db);
  const postId = db.prepare('SELECT id FROM posts WHERE slug=?').get(SLUG).id;
  const emailHash = crypt.fingerprint('profile-test@example.com');
  const ids = [];
  for (const [author, website, status] of [
    ['旧昵称', 'https://old.example.com/', 'approved'],
    ['新昵称', 'https://new.example.com/', 'approved'],
    ['待审昵称', 'https://pending.example.com/', 'pending'],
  ]) ids.push(comments.add({ postId, author, website, emailHash, bodyMd: 'profile fixture', status }));
  const app = commentRoutes({ repo: {}, comments, crypt });
  const lookup = (email) => app.request('/api/comments/reader', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email }),
  });
  try {
    const response = await lookup(' PROFILE-TEST@EXAMPLE.COM ');
    const data = await response.json();
    check('邮箱查询返回最近获批的昵称与网址', data.profile?.author === '新昵称' && data.profile?.website === 'https://new.example.com/');
    check('邮箱查询禁止缓存且只返回公开字段', response.headers.get('cache-control') === 'no-store' && Object.keys(data.profile).sort().join(',') === 'author,website');
    check('陌生邮箱不自动填写', (await (await lookup('unknown-profile@example.com')).json()).profile === null);
    check('无效邮箱查询被拒绝', (await lookup('invalid')).status === 400);
    const { html } = await getPost();
    check('邮箱字段排在昵称之前', html.indexOf('name="email"') < html.indexOf('name="author"'));
  } finally {
    const remove = db.prepare('DELETE FROM comments WHERE id=?');
    ids.forEach(id => remove.run(id));
  }
}


{
  // 邮箱查询限流：单 IP 不同邮箱、单邮箱跨 IP、全站新邮箱三层。独立实例，避免污染其他用例的计数桶。
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'comment-probe-'));
  const dirs = { data: path.join(root, 'data'), content: path.join(root, 'content'), uploads: path.join(root, 'uploads') };
  for (const d of Object.values(dirs)) fs.mkdirSync(d, { recursive: true });
  fs.cpSync(process.env.CONTENT_DIR ?? 'content', dirs.content, { recursive: true });

  const srv3 = await startServer({
    isolateDb: true,
    env: { DATA_DIR: dirs.data, CONTENT_DIR: dirs.content, UPLOADS_DIR: dirs.uploads, TRUST_PROXY: 'true' },
  });
  const lookup = async (email, ip) => {
    const res = await fetch(`${srv3.base}/api/comments/reader`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-forwarded-for': ip },
      body: JSON.stringify({ email }),
    });
    return { status: res.status, retryAfter: res.headers.get('retry-after'), body: await res.json().catch(() => ({})) };
  };
  const { ipBucket, createReaderProbeLimiter } = await import('../src/comments/reader-limit.js');
  try {
    const ip = '10.60.0.1';
    let last = null;
    for (let i = 0; i < 13; i++) last = await lookup(`probe-ip-${i}@example.com`, ip);
    check('T20a 同一 IP 连续查不同邮箱，超出上限后 429', last.status === 429, String(last.status));
    check('T20b 限流响应不泄露邮箱是否存在，并带 Retry-After',
      last.body.profile === null && Number(last.retryAfter) > 0, JSON.stringify(last.body));
    check('T20c 限流按 IP 隔离，换 IP 可继续查',
      (await lookup('probe-ip-fresh@example.com', '10.60.0.2')).status === 200);

    const ip2 = '10.60.0.3';
    for (let i = 0; i < 5; i++) await lookup('probe-repeat@example.com', ip2);
    let allOk = true;
    for (let i = 0; i < 7; i++) {
      if ((await lookup(`probe-more-${i}@example.com`, ip2)).status !== 200) allOk = false;
    }
    check('T20d 重复查同一邮箱不占单 IP 的新邮箱名额', allOk);

    const target = 'probe-target@example.com';
    let lastEmail = null;
    for (let i = 0; i < 7; i++) lastEmail = await lookup(target, `10.61.0.${i + 1}`);
    check('T20e 同一邮箱换 IP 也会被邮箱维度限流', lastEmail.status === 429, String(lastEmail.status));

    check('T20f IPv6 按 /64 归桶，换地址绕不过限额',
      ipBucket('2001:db8:1:2:aaaa::1') === ipBucket('2001:db8:1:2:bbbb::9'));
    check('T20g IPv4-mapped 地址还原成 IPv4，避免所有直连 IPv4 挤进同一个桶',
      ipBucket('::ffff:127.0.0.1') === '127.0.0.1' && ipBucket('::ffff:10.0.0.8') === '10.0.0.8');

    const lim = createReaderProbeLimiter({ perEmail: 10, perIp: 10, globalMax: 2, windowMs: 60_000 });
    check('T20h 全站新邮箱数封顶，挡住代理池分摊到大量 IP',
      !lim.check('a@x', '1.1.1.1').limited && !lim.check('b@x', '1.1.1.2').limited
      && lim.check('c@x', '1.1.1.3').limited);
    check('T20i 窗口内已出现过的邮箱不受全站上限影响',
      !lim.check('a@x', '1.1.1.4').limited);
  } finally {
    await srv3.stop();
    fs.rmSync(root, { recursive: true, force: true });
  }
}

{
  const { html, token } = await getPost();
  check('T1a 文章页渲染出评论表单', html.includes('data-comment-form'));
  check('T1b 带有签名的时间戳令牌', token.length > 40, `token 长度 ${token.length}`);
  check('T1c 存在 honeypot 字段', html.includes('name="hp_fax"'));
}

{
  const before = countComments();
  const r = await post({ ...base, hp_fax: 'bot-filled-this' });
  // 只能验 JSON 端点：必须 200 + discarded（旧断言 `303 || 200` 恒真）。
  check('T2a honeypot 命中时表单 303 回文章（不带任何 ?c= 提示）',
    r.status === 303 && !r.location.includes('?c='), `实际 ${r.status} ${r.location}`);
  const j = await postJson({ ...base, hp_fax: 'bot-filled-this' });
  check('T2a-2 honeypot 命中时 JSON 端点返回 200 + discarded（不给爬虫信号）',
    j.status === 200 && j.body.status === 'discarded', `${j.status} ${JSON.stringify(j.body)}`);
  check('T2b honeypot 命中时不写入数据库', countComments() === before, `${before} → ${countComments()}`);
}

{
  const before = countComments();
  const { token } = await getPost();
  const r = await post({ ...base, ts: token, hp_fax: '', body: '提交太快，应被丢弃。' });
  check('T3a 最小填表时间内提交被静默丢弃', countComments() === before, `${before} → ${countComments()}`);
  check('T3b 丢弃时仍回跳文章页', r.status === 303);
}

const { token: goodToken } = await getPost();
await sleep(300);

let firstId = 0;
{
  const before = countComments();
  const r = await post({ ...base, ts: goodToken, hp_fax: '', body: '单栏这点我同意，但 65ch 在 27 寸屏上会不会显得空？' });
  const n = countComments();
  check('T4a 正常提交写入数据库', n === before + 1, `${before} → ${n}`);
  check('T4b 回跳带 pending 提示', r.location.includes('c=pending'), r.location);
  const row = lastComment();
  firstId = row.id;
  check('T4c 首次评论状态为 pending', row.status === 'pending', row.status);
  check('T4d 邮箱只存指纹与密文，不存明文',
    Boolean(row.email_hash) && Boolean(row.email_enc) && !JSON.stringify(row).includes('chen@example.com'));
  check('T4e 网址被规范化', row.website === null || /^https?:\/\//.test(row.website), String(row.website));
}

{
  // 双击/网络重试带同一个 submission_id：第二次不能再写一行，但仍要回 pending 提示。
  // 用独立 commentRoutes 实例，避免这次提交占用主服务器那条限流额度（后面的 T10 依赖剩余额度）。
  const { createRepo } = await import('../db/repo.js');
  const { createCommentRepo } = await import('../db/comments.js');
  const { commentRoutes } = await import('../src/routes/comments.js');
  const isolated = commentRoutes({ repo: createRepo(db), comments: createCommentRepo(db), crypt });
  const postId = db.prepare('SELECT id FROM posts WHERE slug=?').get(SLUG).id;
  const ts = crypt.sign({ purpose: 'comment-ts', ts: Date.now() - 5000, p: postId }, 3600);
  const before = countComments();
  const submission_id = 'test-idempotency-0001';
  const fields = { ...base, ts, hp_fax: '', submission_id, body: '同一次提交只应落一条。' };
  const send = () => isolated.request(`/p/${SLUG}/comment`, {
    method: 'POST', body: new URLSearchParams(fields), redirect: 'manual',
  });
  const first = await send();
  const second = await send();
  const after = countComments();
  check('T4f 同一 submission_id 重复提交只落一条', after === before + 1, `${before} → ${after}`);
  const locations = [first.headers.get('location') ?? '', second.headers.get('location') ?? ''];
  check('T4g 重复提交仍回 pending 提示', locations.every((l) => l.includes('c=pending')), locations.join(' | '));
}

{
  const res = await fetch(`${BASE}/p/${SLUG}/`);
  const html = await res.text();
  check('T5 待审核评论不出现在页面上', !html.includes('27 寸屏上会不会显得空'));
  check('T5b 评论表单的邮箱是必填项',
    /<input[^>]*name="email"[^>]*required/.test(html), '');
  {
    // 邮箱下那行说明已删 —— 钉住别被加回来。
    const form = /<form[^>]*class="c-form"[\s\S]*?<\/form>/.exec(html)?.[0] ?? '';
    check('T5c 邮箱字段不再挂"不会公开"的说明（表单保持干净）',
      form.length > 0 && !/不会公开/.test(form), `表单长度 ${form.length}`);
  }
}

{
  // 邮箱必填：缺失/格式不对都要被拒，且不该消耗提交配额（校验在限流之前）
  const miss = await postJson({ ...base, email: '', ts: goodToken, hp_fax: '', body: '不填邮箱。' });
  check('T5d 不填邮箱被拒绝', miss.status === 400 && miss.body.status === 'bad-email',
    `${miss.status} ${miss.body.status}`);
  const bad = await postJson({ ...base, email: '不是邮箱', ts: goodToken, hp_fax: '', body: '邮箱格式错。' });
  check('T5e 邮箱格式不合法被拒绝', bad.status === 400 && bad.body.status === 'bad-email',
    `${bad.status} ${bad.body.status}`);
  check('T5f 拒绝理由以可读文案返回给前端', typeof bad.body.error === 'string' && bad.body.error.includes('邮箱'),
    String(bad.body.error));
  const n = db.prepare('SELECT COUNT(*) AS n FROM comments WHERE body_md IN (?, ?)').get('不填邮箱。', '邮箱格式错。').n;
  check('T5g 被拒的提交没有写进数据库', n === 0, `${n} 条`);
}

{
  const token = moderationToken({ c: firstId, a: 'approve' }, 3600);
  const pageMod = await (await fetch(`${BASE}/moderate/${token}`)).text();
  const row = (db.prepare('SELECT status FROM comments WHERE id = ?').get(firstId) ?? {});
  check('T6a GET 审核链接后状态不变', row.status === 'pending', row.status);

  // 邮件里点的动作审核页排第一 —— 但**仍要在页面上再点一次**：客户端会预取链接，直接生效可能误删。
  check('T6a2 邮件里点的「批准」被标出并排在第一个',
    pageMod.includes('你在邮件里点的是「批准并显示」')
    && /<button type="submit" name="action" value="approve">批准并显示（邮件里点的）<\/button>/.test(pageMod)
    && pageMod.indexOf('value="approve"') < pageMod.indexOf('value="spam"')
    && pageMod.includes('<pre class="mod-source"><code>'), '');
  const pageSpam = await (await fetch(`${BASE}/moderate/${moderationToken({ c: firstId, a: 'spam' }, 3600)}`)).text();
  check('T6a3 换个动作就换个排头（点「垃圾」时它是第一个）',
    pageSpam.includes('你在邮件里点的是「标记为垃圾」')
    && pageSpam.indexOf('value="spam"') < pageSpam.indexOf('value="approve"'), '');

  await fetch(`${BASE}/moderate/${token}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: 'action=approve',
  });
  const after = (db.prepare('SELECT status FROM comments WHERE id = ?').get(firstId) ?? {});
  check('T6b POST 批准后状态变为 approved', after.status === 'approved', after.status);
  const pageDone = await (await fetch(`${BASE}/moderate/${token}`)).text();
  check('T6b2 已是 approved 时，邮件里的 a=approve 不再误导（没有可"批准"的按钮）',
    !pageDone.includes('你在邮件里点的是') && !pageDone.includes('value="approve"'), '');

  const res2 = await fetch(`${BASE}/p/${SLUG}/`);
  const html2 = await res2.text();
  check('T6c 批准后前台可见', html2.includes('27 寸屏上会不会显得空'));
  check('T6c2 前台页面不出现评论人邮箱（邮箱只进后台）',
    !html2.includes('chen@example.com') && !html2.includes('mailto:'), '');
  check('T6d 没填网址的名字用 <b class="c-name">（深色加粗）',
    /<b class="c-name">陈<\/b>/.test(html2), '');
}


{
  const html = await (await fetch(`${BASE}/p/${SLUG}/`)).text();
  const links = [...html.matchAll(/<a class="c-reply" href="([^"]+)"/g)].map((m) => m[1]);
  const rendered = (html.match(/<li class="comment" id="c\d+"/g) ?? []).length;
  check('T6d 每条评论都带「回复」链接，指向本页 ?reply=<id>#reply',
    links.length > 0 && links.every((h) => h.startsWith(`/p/${SLUG}/?reply=`) && h.endsWith('#reply')),
    `${links.length} 个链接 / ${rendered} 条评论`);
  // 旧断言 `nested >= 0` 恒真、半句没测；换成入口数与评论数一致。
  check('T6e 每条可见评论恰好一个「回复」入口，且没有重复指向',
    links.length === rendered && rendered > 0 && new Set(links).size === links.length,
    `链接 ${links.length} / 评论 ${rendered} / 去重后 ${new Set(links).size}`);

  const id = /\?reply=(\d+)/.exec(links[0])?.[1];
  const form = await (await fetch(`${BASE}/p/${SLUG}/?reply=${id}`)).text();
  check('T6f 带 ?reply= 进来时回复框预填「回复 X」并带上 parent',
    form.includes('回复 ') && new RegExp(`name="parent" value="${id}"`).test(form),
    `id=${id}`);
  check('T6g 带一个不存在的 reply 时不预填（parent 为空）',
    /name="parent" value=""/.test(await (await fetch(`${BASE}/p/${SLUG}/?reply=999999`)).text()), '');
}

{
  const before = countComments();
  await post({ ...base, ts: goodToken, hp_fax: '', body: '补充一句：空出来的不是浪费，是呼吸。' });
  const n = countComments();
  check('T7a 老读者的第二条评论成功写入', n === before + 1, `${before} → ${n}`);
  check('T7b 同昵称和邮箱的老读者无需凭证即可免审', lastComment().status === 'approved', lastComment().status);
}

{
  await post({
    ...base, ts: goodToken, hp_fax: '', author: '链接哥',
    body: '看这里 https://a.example.com 和 https://b.example.com 还有 https://c.example.com',
  });
  const row = lastComment();
  check('T8 多外链评论被强制审核', row.status === 'pending', `author=${row.author} status=${row.status}`);
}

{
  await postJson({
    ...base, ts: goodToken, hp_fax: '', author: 'XSS探针',
    body: '<script>alert(1)</script><img src=x onerror="alert(2)">[恶意](javascript:alert(3))',
  });
  const row = lastComment();

  const { renderComment } = await import('../src/comments/render.js');
  const out = renderComment(row.body_md);
  check('T9a 评论中的 <script> 被转义', !out.includes('<script>'), out.slice(0, 80));
  check('T9b 评论中的 onerror 属性被转义', !/<img[^>]*onerror/i.test(out));
  check('T9c javascript: 链接被降级', !/href="javascript:/i.test(out));
}

{

  // 不假设前面消耗了几个额度：一直提交到出现 429 为止（额度 5/10 分钟）
  let ok = 0; let limited = 0;
  for (let i = 0; i < 8 && !limited; i++) {
    const r = await postJson({ ...base, ts: goodToken, hp_fax: '', body: `限流测试 ${i}` });
    if (r.status === 200) ok++;
    else if (r.status === 429) limited++;
  }
  check('T10a 额度内仍可提交（本用例前应至少剩一个名额）', ok >= 1, `成功 ${ok} 次`);
  check('T10b 超出额度返回 429', limited === 1, `限流 ${limited} 次`);
}

{
  const replyBody = '会。但空出来的不是浪费，是呼吸。';
  const token = moderationToken({ c: firstId, a: 'reply' }, 3600);
  const before = countComments();
  await fetch(`${BASE}/moderate/${token}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: `action=reply&body=${encodeURIComponent(replyBody)}`,
  });
  const n = countComments();
  check('T11a 作者回复被写入', n === before + 1, `${before} → ${n}`);
  const row = lastComment();
  check('T11b 回复标记为作者', row.is_author === 1, String(row.is_author));
  check('T11c 回复直接通过审核', row.status === 'approved', row.status);
  check('T11d 回复挂在被回复的评论下', row.parent_id === firstId, `parent_id=${row.parent_id}`);

  const token2 = moderationToken({ c: row.id, a: 'reply' }, 3600);
  await fetch(`${BASE}/moderate/${token2}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: `action=reply&body=${encodeURIComponent('对回复的回复')}`,
  });
  const deep = lastComment();
  check('T11e 回复的回复挂在被回复的那一条下（真多级嵌套，不再归一化到根）',
    deep.parent_id === row.id, `parent_id=${deep.parent_id}，期望 ${row.id}`);
}

{
  const { MAX_DEPTH } = await import('../db/comments.js');
  const pid = db.prepare('SELECT id FROM posts WHERE slug = ?').get(SLUG).id;
  const ins = db.prepare(`INSERT INTO comments (post_id, parent_id, author, email_hash, email_enc, website, body_md, status, is_author, moderation_nonce, created_at)
    VALUES (?, ?, ?, NULL, NULL, NULL, ?, 'approved', 0, ?, ?)`);
  let parent = null;
  const chain = [];
  for (let level = 1; level <= 4; level++) {
    parent = Number(ins.run(pid, parent, `第${level}层`, `第 ${level} 层的内容`, `nonce-nest-${level}`,
      `2026-02-0${level}T00:00:00.000Z`).lastInsertRowid);
    chain.push(parent);
  }

  const { JSDOM } = await import('jsdom');
  const doc = new JSDOM(await (await fetch(`${BASE}/p/${SLUG}/`)).text()).window.document;
  const owner = (el) => el?.parentElement?.parentElement?.parentElement ?? null;
  const [l1, l2, l3, l4] = chain.map((id) => doc.getElementById('c' + id));
  check('T14a 四层评论按父子关系真正嵌套在 DOM 里（每层都挂在上一条下面）',
    Boolean(l1 && l2 && l3 && l4) && owner(l2) === l1 && owner(l3) === l2 && owner(l4) === l3,
    [l2, l3, l4].map((el) => (el ? owner(el)?.id ?? '(未找到归属者)' : '缺失')).join(' / ') + ` 期望 ${chain.map((id) => 'c' + id).join(' < ')}`);
  check('T14b 缩进只给一层：第 2 层缩进，第 3、4 层回拉对齐（不再逐层右移）',
    l2.parentElement.classList.contains('c-nest')
    && l3.parentElement.classList.contains('c-flush') && l4.parentElement.classList.contains('c-flush'),
    `${l2.parentElement.className} | ${l3.parentElement.className} | ${l4.parentElement.className}`);
  const headOf = (el) => el.querySelector('.c-head')?.innerHTML ?? '';
  check('T14c 第 3 层起用「回复 @上一层作者」标明对象（第 2 层不需要，缩进已经说明了）',
    /@第2层/.test(headOf(l3)) && /@第3层/.test(headOf(l4)) && !/c-at/.test(headOf(l2)),
    `L2=${headOf(l2)} | L3=${headOf(l3)} | L4=${headOf(l4)}`);
  check('T14d 回复本身也带「回复」链接（回复的回复走得通），且挂在头部行右侧',
    [l1, l2, l3, l4].every((el) => el.querySelector(':scope > .c-main > .c-head [data-reply]')),
    chain.map((id) => Boolean(doc.querySelector(`#c${id} [data-reply]`))).join(','));

  // 深链：?reply=<第 3 层 id> 必须能进回复模式
  const deepHtml = await (await fetch(`${BASE}/p/${SLUG}/?reply=${l3.id.slice(1)}`)).text();
  check('T14e ?reply= 指向深层评论时也能预填「回复 X」',
    /<span data-reply-title>回复 第3层<\/span>/.test(deepHtml)
    && new RegExp(`name="parent" value="${l3.id.slice(1)}"`).test(deepHtml), '');

  {
    // 层级只靠缩进和头像大小说话；头像尺寸必须走 --c-avatar（嵌套层覆盖成 30px）、
    // 深层归零必须显式写 0 —— 若把缩进写死或删了 flush 规则，层级就只剩「回复 @某人」一行字撑。
    const css = fs.readFileSync('public/style.css', 'utf8');
    check('T14h 层级由缩进与头像大小表达：头像走 --c-avatar，深层缩进显式归零',
      /\.avatar\s*\{[^}]*width:\s*var\(--c-avatar\)/.test(css)
      && /\.c-replies > \.comment\s*\{[^}]*--c-avatar:\s*30px/.test(css)
      && /\.c-replies\.c-flush\s*\{[^}]*margin-left:\s*0/.test(css)
      && !/\.c-replies\.c-flush\s*\{[^}]*calc\(/.test(css),
      '缩进/头像没有共用同一套变量，或深层回拉机制残留');
  }

  // 深度硬上限：超过 MAX_DEPTH 挂到上限那层的祖先，而不是拒绝写入
  const { createCommentRepo } = await import('../db/comments.js');
  const crepo = createCommentRepo(db);
  let tail = chain[3];
  for (let level = 5; level <= MAX_DEPTH + 2; level++) tail = crepo.add({ postId: pid, parentId: tail, author: `第${level}层`, bodyMd: '很深', status: 'approved' });
  const tooDeep = crepo.add({ postId: pid, parentId: tail, author: '超限', bodyMd: '不该超过上限', status: 'approved' });
  const depthOf = (id) => { let n = 0, cur = id; while (cur != null && n < 50) { n++; cur = db.prepare('SELECT parent_id FROM comments WHERE id=?').get(cur)?.parent_id ?? null; } return n; };
  const stored = db.prepare('SELECT parent_id FROM comments WHERE id=?').get(tooDeep).parent_id;
  check(`T14f 深度超过 ${MAX_DEPTH} 时被收敛到上限内（不拒收、也不无限深）`,
    depthOf(tooDeep) <= MAX_DEPTH && stored !== tail,
    `深度=${depthOf(tooDeep)}，期望 ≤${MAX_DEPTH}`);

  const { createAdminRepo } = await import('../db/admin.js');
  const arepo = createAdminRepo(db);
  check('T14g 彻底删除按子孙总数计数，而不是只数直接回复',
    arepo.repliesOf(chain[0]) === 8, String(arepo.repliesOf(chain[0])));

  db.prepare('DELETE FROM comments WHERE id = ?').run(chain[0]);
}

{
  const pid = db.prepare('SELECT id FROM posts WHERE slug = ?').get(SLUG).id;
  db.prepare("INSERT INTO settings(key,value) VALUES('comments_per_page','5') ON CONFLICT(key) DO UPDATE SET value='5'").run();
  const ins = db.prepare(`INSERT INTO comments (post_id, parent_id, author, email_hash, email_enc, website, body_md, status, is_author, moderation_nonce, created_at)
    VALUES (?, ?, ?, NULL, NULL, NULL, ?, 'approved', 0, ?, ?)`);
  const roots = [];
  const chain = [];
  for (let i = 1; i <= 7; i++) {
    let cur = Number(ins.run(pid, null, `分页根${i}`, `第 ${i} 串`, `nonce-pg-${i}`, `2030-01-0${i}T00:00:00.000Z`).lastInsertRowid);
    roots.push(cur);
    if (i === 1) {
      chain.push(cur);
      for (let d = 2; d <= 4; d++) {
        cur = Number(ins.run(pid, cur, `分页根1-${d}层`, `第 ${d} 层`, `nonce-pg-1-${d}`, `2030-01-01T00:00:0${d}.000Z`).lastInsertRowid);
        chain.push(cur);
      }
    }
  }

  const { JSDOM } = await import('jsdom');
  const pageDoc = async (query) => new JSDOM(await (await fetch(`${BASE}/p/${SLUG}/${query}`)).text()).window.document;
  const idsOf = (doc) => [...doc.querySelectorAll('.c-list > li.comment')].map((li) => li.id);

  const p1 = await pageDoc('');
  const p2 = await pageDoc('?cpage=2#comments');
  check('T15a 默认第 1 页只放 5 个讨论串', idsOf(p1).length === 5, idsOf(p1).join(','));
  check('T15b 分页器出现、页码正确、有下一页链接',
    /第 1 \/ \d+ 页/.test((p1.querySelector('.c-pager')?.textContent ?? '').replace(/\s+/g, ' '))
    && Boolean(p1.querySelector('.c-pager a[href="?cpage=2#comments"]')),
    (p1.querySelector('.c-pager')?.textContent ?? '').replace(/\s+/g, ' '));
  check('T15c 第 1 页有「跳到最新」入口', Boolean(p1.querySelector('.c-pager-last')), '');
  check('T15d 相邻两页的讨论串不重复', idsOf(p1).every((id) => !idsOf(p2).includes(id)),
    `${idsOf(p1).join(',')} | ${idsOf(p2).join(',')}`);

  let chainDoc = null;
  for (const q of ['', '?cpage=2#comments', '?cpage=3#comments', '?cpage=4#comments']) {
    const doc = await pageDoc(q);
    if (doc.getElementById('c' + chain[0])) { chainDoc = doc; break; }
  }
  check('T15e 四层深的那一串整串落在同一页（线程不被拆页）',
    Boolean(chainDoc) && chain.every((id) => chainDoc.getElementById('c' + id) !== null)
    && Boolean(chainDoc.querySelector(`#c${chain[0]} .c-replies .c-replies .c-replies > .comment`)),
    chainDoc ? `根在第 ${chainDoc.querySelector('.c-form')?.dataset.cpage} 页，链上 ${chain.filter((id) => chainDoc.getElementById('c' + id)).length}/4 条` : '前四页都没找到该串');

  const last = await pageDoc('?cpage=999#comments');
  check('T15f 页码越界时收敛到最后一页',
    /第 (\d+) \/ \1 页/.test((last.querySelector('.c-pager')?.textContent ?? '').replace(/\s+/g, ' ')),
    (last.querySelector('.c-pager')?.textContent ?? '').replace(/\s+/g, ' '));

  // ?reply= 指向别页评论：自动切到那页并把表单 prefill 成「回复 X」；用最末那条根评论（否则没测）。
  const tailId = roots[roots.length - 1];
  let tailPage = null;
  for (const n of [1, 2, 3, 4]) {
    const doc = await pageDoc(n === 1 ? '' : `?cpage=${n}#comments`);
    if (doc.getElementById('c' + tailId)) { tailPage = String(n); break; }
  }
  const off = await pageDoc(`?reply=${tailId}#reply`);
  check('T15g ?reply= 指向别的页时自动切页，并预填回复对象',
    tailPage !== null && tailPage !== '1'
    && off.getElementById('c' + tailId) !== null
    && /分页根7/.test(off.querySelector('[data-reply-title]')?.textContent ?? '')
    && off.querySelector('.c-form').dataset.cpage === tailPage,
    `目标在第 ${tailPage} 页；?reply= 渲染出 cpage=${off.querySelector('.c-form')?.dataset.cpage}，标题=${off.querySelector('[data-reply-title]')?.textContent}`);

  // 局部刷新要带上页码，否则在第 2 页发完评论会被弹回第 1 页
  const partial = await pageDoc('?partial=comments&cpage=2');
  check('T15h ?partial=comments 返回第 2 页，且表单带着 data-cpage',
    partial.querySelector('.c-form')?.dataset.cpage === '2'
    && idsOf(partial).join(',') === idsOf(p2).join(','),
    `cpage=${partial.querySelector('.c-form')?.dataset.cpage}`);

  const pagerCss = fs.readFileSync('public/style.css', 'utf8');
  check('T15i 分页器样式已定义', /\.c-pager\b/.test(pagerCss) && /\.c-pager-last\b/.test(pagerCss), '');

  db.prepare(`DELETE FROM comments WHERE moderation_nonce LIKE 'nonce-pg-%'`).run();
  db.prepare("DELETE FROM settings WHERE key='comments_per_page'").run();
}

{
  // 笔记列表与文章列表完全一致：评论区只在详情页里，按 comments_per_page 分页；列表只留「N 条评论」链接。
  const note = db.prepare(
    "SELECT id, slug FROM posts WHERE kind='note' AND draft=0 AND comments_on=1 ORDER BY id",
  ).get();
  const npid = note.id;
  // 注意 commentsPerPage 合法区间 5—100（更小会被夹取），要用 8 条串触发分页
  db.prepare("INSERT INTO settings(key,value) VALUES('comments_per_page','5') ON CONFLICT(key) DO UPDATE SET value='5'").run();
  const ins = db.prepare(`INSERT INTO comments (post_id, parent_id, author, email_hash, email_enc, website, body_md, status, is_author, moderation_nonce, created_at)
    VALUES (?, NULL, ?, NULL, NULL, NULL, '笔记上的评论', 'approved', 0, ?, '2031-01-01T00:00:00.000Z')`);
  for (let i = 0; i < 8; i++) ins.run(npid, `笔记读者${i}`, `nonce-note-pg-${i}`);
  const notesHtml = await (await fetch(`${BASE}/notes/`)).text();
  const detailUrl = `/n/${encodeURIComponent(note.slug)}/`;
  const detail = await (await fetch(`${BASE}${detailUrl}`)).text();
  check('T15j 笔记列表不再内嵌评论抽屉；评论链接直达详情页，详情页评论区按每页条数分页',
    !/data-comment-form/.test(notesHtml) && !/ncp-/.test(notesHtml)
    && notesHtml.includes(`href="${detailUrl}#comments"`) && notesHtml.includes('8 条评论')
    && /class="c-form"/.test(detail) && /class="c-pager"/.test(detail) && !/ncp-/.test(detail), '');
  db.prepare(`DELETE FROM comments WHERE moderation_nonce LIKE 'nonce-note-pg-%'`).run();
  db.prepare("DELETE FROM settings WHERE key='comments_per_page'").run();
}

{
  // 评论区视觉：把看起来乱的根因钉住，别改回来
  // 形态：分界只有一种 —— 横线。顶层与嵌套兄弟回复都画同一条 --rule 横线；左侧竖线、满宽淡底块、
  // 头像列连接线都不回来。链式回复（每层 ul 只有一个孩子）不画线，靠缩进和 margin 分开。
  const css = fs.readFileSync('public/style.css', 'utf8');
  // 取**所有**同名规则块而非首条：规则常追加到末尾覆盖前者，只读首块会把已被盖掉看成还在。
  const blocksOf = (sel) => [...css.matchAll(new RegExp(sel + '\\s*\\{([^}]*)\\}', 'g'))].map((m) => m[1]);
  const declsOf = (sel) => blocksOf(sel).join(';');
  const visible = (sel, prop) => [...declsOf(sel).matchAll(new RegExp(prop + '\\s*:\\s*([^;]+)', 'g'))]
    .map((m) => m[1].trim().replace(/!important$/, '').trim())
    .filter((v) => !/^(0|none|transparent|normal|""|'')$/i.test(v));
  check('T15k 顶层评论之间、每条子评论（含第一条）头顶都画同一种横线（分界只有这一种）',
    visible('\\.c-list > \\.comment', 'border-top').length > 0
    && visible('\\.c-replies > \\.comment', 'border-top').length > 0,
    `串: ${declsOf('\\.c-list > \\.comment').trim()} | 子评论: ${declsOf('\\.c-replies > \\.comment').trim()}`);
  check('T15l 嵌套不再画左侧竖线、也不回满宽淡底块（层级交给缩进与头像大小）',
    visible('\\.c-replies\\.c-nest', 'border-left').length === 0
    && visible('\\.c-replies\\.c-nest', 'background(?:-color)?').length === 0,
    declsOf('\\.c-replies\\.c-nest').trim());
  check('T15m 「回复」挂在头部行右侧，hover 设备上默认隐形、悬停/聚焦这条评论才显形（触屏常显）',
    /margin-left:\s*auto/.test(declsOf('.c-reply'))
    && /color:\s*color-mix\(in srgb,\s*var\(--accent\) 82%,\s*var\(--fg\)\)/.test(declsOf('.c-reply'))
    && /@media \(hover: hover\)\s*\{[^@]*\.c-reply\s*\{[^}]*opacity:\s*0/.test(css)
    && /\.comment:hover \.c-reply,\s*\.comment:focus-within \.c-reply\s*\{\s*opacity:\s*1/.test(css)
    && !/\.c-foot\s*\{[^}]*\[data-reply\]/.test(css),
    declsOf('.c-reply').trim());

  // 子评论间距：margin 与 padding 必须等值成对（线落在空隙正中），不再有旧版连环误伤的清零写法。
  check('T15n 每条子评论（含第一条）的横线由成对等值的 margin/padding 托住，且无 :first-child 清零',
    /\.c-replies > \.comment\s*\{[^}]*margin-top:\s*([\d.]+)rem[^}]*padding-top:\s*([\d.]+)rem/.test(css)
    && (() => { const m = /\.c-replies > \.comment\s*\{[^}]*margin-top:\s*([\d.]+)rem[^}]*padding-top:\s*([\d.]+)rem/.exec(css); return m && m[1] === m[2]; })()
    && !/\.c-replies > \.comment:first-child\s*\{/.test(css),
    declsOf('.c-replies > .comment').trim());
  check('T15o 头像列不再单独画一条连接线（分界已交给横线，两条线并存会互相打架）',
    visible('\\.c-replies \\.comment::before', 'content').length === 0,
    declsOf('\\.c-replies \\.comment::before').trim() || '(规则已不存在)');
}

{
  const row = (db.prepare('SELECT email_enc FROM comments WHERE id = ?').get(firstId) ?? {});
  check('T12a 加密邮箱能解密回原值', crypt.decrypt(row.email_enc) === 'chen@example.com',
    String(crypt.decrypt(row.email_enc)));
  check('T12b 篡改密文后解密失败而非返回垃圾',
    crypt.decrypt(String(row.email_enc).slice(0, -4) + 'AAAA') === null);
}

{
  const forged = Buffer.from(JSON.stringify({ c: firstId, a: 'delete', exp: 9e9 })).toString('base64url') + '.fake';
  const res = await fetch(`${BASE}/moderate/${forged}`, { method: 'POST', body: 'action=delete' });
  const row = (db.prepare('SELECT status FROM comments WHERE id = ?').get(firstId) ?? {});
  check('T13 伪造令牌无法删除评论', res.status === 400 && row.status === 'approved',
    `http=${res.status} status=${row.status}`);
}

{
  // 填了网址的名字是链接，样式不能比不填更弱（曾退回 .c-head 浅灰）。走公共接口会撞写入限流，直接入库再读页面、用完删除。
  const pid = db.prepare('SELECT id FROM posts WHERE slug = ?').get(SLUG).id;
  const ins = db.prepare(`INSERT INTO comments (post_id, parent_id, author, email_hash, email_enc, website, body_md, status, is_author, moderation_nonce, created_at)
    VALUES (?, NULL, '陈', NULL, NULL, 'https://example.com/me', '带网址的一条，用来核对名字样式。', 'approved', 0, 'nonce-cname', '2026-01-01T00:00:00.000Z')`).run(pid);
  const id = Number(ins.lastInsertRowid);
  const html3 = await (await fetch(`${BASE}/p/${SLUG}/`)).text();
  check('T6i 带网址的评论入库后网址保留', (db.prepare('SELECT website FROM comments WHERE id = ?').get(id) ?? {}).website === 'https://example.com/me');
  check('T6j 填了网址的名字仍用 .c-name（与不填时同色同字重）',
    /<a class="c-name" href="https:\/\/example\.com\/me"[^>]*>陈<\/a>/.test(html3), '');
  check('T6k 没填网址的名字用 .c-name，且两者选择器同规则',
    /<b class="c-name">/.test(html3)
    && /\.c-head b,\s*\.c-head \.c-name \{[^}]*color: var\(--fg\)[^}]*font-weight: 600/.test(await (await fetch(`${BASE}/style.css`)).text()), '');
  check('T6l 链接名字有悬停反馈（金色 + 下划线），仍然可点击辨认',
    /\.c-head a\.c-name:hover \{[^}]*color: var\(--accent\)/.test(await (await fetch(`${BASE}/style.css`)).text()), '');
  const badIns = db.prepare(`INSERT INTO comments (post_id, parent_id, author, email_hash, email_enc, website, body_md, status, is_author, moderation_nonce, created_at)
    VALUES (?, NULL, '旧数据', NULL, NULL, 'javascript:alert(1)', '历史脏网址', 'approved', 0, 'nonce-badurl', '2026-01-01T00:00:00.000Z')`).run(pid);
  const badId = Number(badIns.lastInsertRowid);
  try {
    const badHtml = await (await fetch(`${BASE}/p/${SLUG}/`)).text();
    check('T6m 非 http(s) 的历史网址不会渲染成可点击链接',
      !badHtml.includes('href="javascript:') && /<b class="c-name">旧数据<\/b>/.test(badHtml), '');
  } finally { db.prepare('DELETE FROM comments WHERE id = ?').run(badId); }
  db.prepare('DELETE FROM comments WHERE id = ?').run(id);
}

{
  // 熟客按相同昵称和邮箱的获批历史识别；不同 IP 避免触发评论限流。
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'comment-reader-'));
  const dirs = { data: path.join(root, 'data'), content: path.join(root, 'content'), uploads: path.join(root, 'uploads') };
  for (const d of Object.values(dirs)) fs.mkdirSync(d, { recursive: true });
  fs.cpSync(process.env.CONTENT_DIR ?? 'content', dirs.content, { recursive: true });

  const srv2 = await startServer({
    isolateDb: true,
    env: { DATA_DIR: dirs.data, CONTENT_DIR: dirs.content, UPLOADS_DIR: dirs.uploads, TRUST_PROXY: 'true' },
  });
  const db2 = open(srv2.dbFile);
  const crypt2 = createCrypto(db2, { secretFile: path.join(dirs.data, '.app-secret') });
  const pid2 = db2.prepare('SELECT id FROM posts WHERE slug = ?').get(SLUG).id;
  const EMAIL = 'repeat-reader@example.com';
  const hash2 = crypt2.fingerprint(EMAIL);

  // 时间戳令牌只是年龄证明：拿到后等过最小填表时间即可反复使用（只看年龄，不记账）
  const ts2 = /name="ts" value="([^"]+)"/.exec(await (await fetch(`${srv2.base}/p/${SLUG}/`)).text())?.[1] ?? '';
  await sleep(300);

  let ipSeq = 0;
  const say = async (body, { author = '回头客', email = EMAIL, cookie = null } = {}) => {
    const headers = { 'Content-Type': 'application/json', 'x-forwarded-for': `10.20.0.${++ipSeq}` };
    if (cookie) headers.cookie = cookie;
    const res = await fetch(`${srv2.base}/api/comments`, {
      method: 'POST', headers,
      body: JSON.stringify({ slug: SLUG, author, email, body, ts: ts2, hp_fax: '' }),
    });
    return {
      status: res.status,
      body: await res.json().catch(() => ({})),
      cookie: (res.headers.get('set-cookie') ?? '').split(';')[0] || null,      id: db2.prepare('SELECT id FROM comments ORDER BY id DESC LIMIT 1').get()?.id,
    };
  };
  const mark = (status, hash = hash2) => db2.prepare(`INSERT INTO comments (post_id, parent_id, author, email_hash, email_enc, website, body_md, status, is_author, moderation_nonce, created_at)
    VALUES (?, NULL, '回头客', ?, NULL, NULL, '历史评论', ?, 0, 'nonce-reader', '2026-01-01T00:00:00.000Z')`).run(pid2, hash, status);

  try {
    const fresh = await say('第一次来。');
    check('T16a 首次评论 → 待审', fresh.body.status === 'pending', fresh.body.status);
    check('T16b 评论不再下发读者凭证', fresh.cookie === null, String(fresh.cookie));
    const early = await say('前两条都还没有批准。');
    check('T16c 仅有待审历史 → 待审', early.body.status === 'pending', early.body.status);
    db2.prepare("UPDATE comments SET status = 'approved' WHERE id = ?").run(fresh.id);
    const trusted = await say('换浏览器也可以直接发布。');
    check('T16d 同昵称和邮箱、不带 cookie → 直接发布', trusted.body.status === 'ok', trusted.body.status);
    check('T16d2 直接发布也不下发读者凭证', trusted.cookie === null, String(trusted.cookie));
    check('T16e 落库状态确实是 approved', db2.prepare('SELECT status FROM comments WHERE id = ?').get(trusted.id)?.status === 'approved', '');
    const renamed = await say('只匹配邮箱。', { author: '另一昵称' });
    check('T16f 仅邮箱相同 → 待审', renamed.body.status === 'pending', renamed.body.status);
    const stranger = await say('只匹配昵称。', { email: 'someone-else@example.com' });
    check('T16g 仅昵称相同 → 待审', stranger.body.status === 'pending', stranger.body.status);
    const normalized = await say('邮箱大小写和首尾空格不影响识别。', { email: ' REPEAT-READER@EXAMPLE.COM ' });
    check('T16g2 邮箱规范化后仍免审', normalized.body.status === 'ok', normalized.body.status);
    db2.prepare("UPDATE comments SET status = 'deleted' WHERE id = ?").run(fresh.id);
    const retained = await say('删掉首条后仍有其他获批评论。');
    check('T16g3 其他获批历史仍可作为熟客线索', retained.body.status === 'ok', retained.body.status);
    mark('spam');
    const spammed = await say('邮箱有垃圾评论。');
    check('T16h 邮箱有垃圾评论 → 待审', spammed.body.status === 'pending', spammed.body.status);
    db2.prepare("DELETE FROM comments WHERE status = 'spam'").run();
    const spammy = await say('看 https://a.example.com 和 https://b.example.com 还有 https://c.example.com');
    check('T16i 外链 ≥3 条 → 待审', spammy.body.status === 'pending', spammy.body.status);
    const oneLink = await say('引用 https://d.example.com');
    check('T16k 只有 1 条外链仍免审', oneLink.body.status === 'ok', oneLink.body.status);
    db2.prepare("UPDATE comments SET status = 'deleted' WHERE email_hash = ? AND status = 'approved'").run(hash2);
    const revoked = await say('已无获批历史。', { cookie: `blog_reader=${crypt2.sign({ purpose: 'commenter', h: hash2, c: trusted.id })}` });
    check('T16l 无获批历史时旧 cookie 不能免审', revoked.body.status === 'pending', revoked.body.status);
  } finally {
    db2.close();
    await srv2.stop();
    fs.rmSync(root, { recursive: true, force: true });
  }
}

{
  // 后台三种 kind 都有「允许评论」、内容管线默认开着，所以固定页必须真能评。以前三处都缺：/about 不渲染评论区、
  // 表单地址被拼成 /p/about/comment、提交端只查 post/note。限流按 IP 计在进程内存 —— 所以另起独立实例用不同 x-forwarded-for。
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'comment-page-'));
  const dirs = { data: path.join(root, 'data'), content: path.join(root, 'content'), uploads: path.join(root, 'uploads') };
  for (const d of Object.values(dirs)) fs.mkdirSync(d, { recursive: true });
  fs.cpSync(process.env.CONTENT_DIR ?? 'content', dirs.content, { recursive: true });
  fs.mkdirSync(path.join(dirs.content, 'pages'), { recursive: true });
  fs.writeFileSync(path.join(dirs.content, 'pages', 'about.md'),
    '---\ntitle: 关于\nslug: about\ndate: 2025-01-01\ncomments: true\n---\n关于页正文，用于测试固定页的评论。\n');

  const srv3 = await startServer({
    isolateDb: true,
    env: { DATA_DIR: dirs.data, CONTENT_DIR: dirs.content, UPLOADS_DIR: dirs.uploads, TRUST_PROXY: 'true' },
  });
  const db3 = open(srv3.dbFile);
  const B = srv3.base;
  const PAGE = 'about';
  let nth = 0;
  const ip = () => ({ 'x-forwarded-for': `198.51.100.${++nth}` });
  const count3 = () => db3.prepare('SELECT COUNT(*) AS n FROM comments').get().n;
  const getPage = async () => {
    const html = await (await fetch(`${B}/${PAGE}/`, { headers: ip() })).text();
    return { html, token: /name="ts" value="([^"]+)"/.exec(html)?.[1] ?? '' };
  };
  const postPage = async (fields) => {
    const res = await fetch(`${B}/${PAGE}/comment`, {
      method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded', ...ip() },
      body: new URLSearchParams(fields), redirect: 'manual',
    });
    return { status: res.status, location: res.headers.get('location') ?? '' };
  };

  try {
    {
      const { html } = await getPage();
      check('T17a 固定页渲染出评论区与评论表单',
        html.includes('class="comments"') && html.includes('data-comment-form'), '');
      check('T17b 固定页的表单地址是 /about/comment（不是 /p/about/comment）',
        html.includes('action="/about/comment"') && !html.includes('/p/about/comment'), '');
    }

    {
      const { token } = await getPage();
      await sleep(300);
      const before = count3();
      const r = await postPage({
        ...base, ts: token, hp_fax: '', email: 'about-reader@example.com', body: '关于页也能评论了。',
      });
      check('T17c 固定页提交的评论会落库', count3() === before + 1, `${before} → ${count3()}`);
      check('T17d 提交后 303 回 /about 并带上提示',
        r.status === 303 && /^\/about\?c=(pending|ok)/.test(r.location), `${r.status} ${r.location}`);
      const row = db3.prepare('SELECT * FROM comments ORDER BY id DESC LIMIT 1').get();
      check('T17e 这条评论挂在固定页（kind=page）上',
        row != null && db3.prepare('SELECT kind FROM posts WHERE id = ?').get(row.post_id)?.kind === 'page',
        JSON.stringify(row ?? null));
    }

    {
      const partial = await (await fetch(`${B}/${PAGE}/?partial=comments`, { headers: ip() })).text();
      check('T17f 固定页支持 ?partial=comments 就地回刷',
        partial.trimStart().startsWith('<section class="comments"'), partial.slice(0, 40));
    }

    {
      // 关掉「允许评论」：只剩一句「已关闭」、表单消失；提交端必须拒掉并且不落库
      db3.prepare("UPDATE posts SET comments_on = 0 WHERE slug = ? AND kind = 'page'").run(PAGE);
      const { html, token } = await getPage();
      check('T17g 关掉评论后固定页只剩「已关闭」文案，没有表单',
        html.includes('本文的评论已关闭') && !html.includes('data-comment-form'), '');
      await sleep(300);
      const before = count3();
      const res = await fetch(`${B}/api/comments`, {
        method: 'POST', headers: { 'Content-Type': 'application/json', ...ip() },
        body: JSON.stringify({ slug: PAGE, ...base, ts: token, hp_fax: '', body: '关掉了不该进来' }),
      });
      const body = await res.json().catch(() => ({}));
      check('T17h 关掉评论后提交被拒（403 off）且不落库',
        res.status === 403 && body.status === 'off' && count3() === before,
        `${res.status} ${JSON.stringify(body)}`);
    }
  } finally {
    db3.close();
    await srv3.stop();
    fs.rmSync(root, { recursive: true, force: true });
  }
}

{
  // 博主从前台回复（作者模式）：前台表单切成作者模式，提交以会话认定身份、直接发布；
  // 未登录时 as_author=1 一律无视，冒充不进来。与 /admin、/moderate 同一口径，所以连 Notify 路径一起走真实服务端。
  // 独立 DATA_DIR/CONTENT_DIR/UPLOADS_DIR：不与主线实例抢维护锁。
  const rootA = fs.mkdtempSync(path.join(os.tmpdir(), 'comment-author-'));
  const dirsA = { data: path.join(rootA, 'data'), content: path.join(rootA, 'content'), uploads: path.join(rootA, 'uploads') };
  for (const d of Object.values(dirsA)) fs.mkdirSync(d, { recursive: true });
  fs.cpSync(process.env.CONTENT_DIR ?? 'content', dirsA.content, { recursive: true });
  const srvA = await startServer({
    isolateDb: true,
    env: { DATA_DIR: dirsA.data, CONTENT_DIR: dirsA.content, UPLOADS_DIR: dirsA.uploads },
  });
  const dbA = open(srvA.dbFile);
  const BA = srvA.base;
  const countA = () => dbA.prepare('SELECT COUNT(*) AS n FROM comments').get().n;
  try {
    const { hashPassword } = await import('../src/admin/auth.js');
    // 隔离库克隆自真实库、多半带着密码哈希 —— 用 UPSERT 覆盖成测试口令
    dbA.prepare("INSERT INTO settings(key,value) VALUES('admin_password_hash', ?) ON CONFLICT(key) DO UPDATE SET value=excluded.value")
      .run(hashPassword('test-pw-1234'));
    const loginRes = await fetch(`${BA}/admin/login`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ password: 'test-pw-1234', to: '/admin' }),
      redirect: 'manual',
    });
    const cookie = (loginRes.headers.getSetCookie?.() ?? [])
      .map((s) => s.split(';')[0]).find((s) => s.startsWith('blog_admin='));
    check('T18a 后台登录拿到会话 cookie', Boolean(cookie), `status ${loginRes.status}`);
    const authHeaders = cookie ? { Cookie: cookie } : {};

    const page = await (await fetch(`${BA}/p/${SLUG}/`, { headers: authHeaders })).text();
    check('T18b 登录后前台表单切成作者模式：as_author 暗桩在场、署名三栏与说明落款退场',
      page.includes('name="as_author"') && !page.includes('c-email') && !page.includes('身份回复'), '');
    const anon = await (await fetch(`${BA}/p/${SLUG}/`)).text();
    check('T18c 未登录访客看到的仍是普通表单', !anon.includes('name="as_author"') && anon.includes('c-email'), '');
    // 作者模式必须带后台 CSRF：同站子域能带上 Lax cookie，光凭会话不足以证明是本站页面提交的。
    const authorCsrf = /name="_csrf" value="([^"]*)"/.exec(page)?.[1] ?? '';
    check('T18c2 作者评论表单带 CSRF 令牌', Boolean(authorCsrf), '');

    const t1 = /name="ts" value="([^"]+)"/.exec(await (await fetch(`${BA}/p/${SLUG}/`, { headers: authHeaders })).text())?.[1] ?? '';
    await sleep(300);   // 令牌是年龄证明：领了要等过最小填表时间才有效，刚领就交会被静默丢弃
    const before = countA();
    // 有会话但没 CSRF：同站子域也能带 Lax cookie，必须拒绝，不能当成作者评论。
    const noCsrf = await fetch(`${BA}/api/comments`, {
      method: 'POST', headers: { 'Content-Type': 'application/json', ...authHeaders },
      body: JSON.stringify({ slug: SLUG, as_author: '1', author: '冒充者', email: 'fake@example.com',
        ts: t1, hp_fax: '', body: '没有 CSRF 的伪造作者评论。' }),
    });
    check('T18d0 作者模式缺少 CSRF 令牌被拒绝', noCsrf.status === 403 && countA() === before,
      `${noCsrf.status} ${countA()} → ${before}`);

    const res = await fetch(`${BA}/api/comments`, {
      method: 'POST', headers: { 'Content-Type': 'application/json', ...authHeaders },
      body: JSON.stringify({ slug: SLUG, as_author: '1', _csrf: authorCsrf, author: '冒充者', email: 'fake@example.com',
        ts: t1, hp_fax: '', body: '站主从前台回复。' }),
    });
    const out = await res.json().catch(() => ({}));
    const row = dbA.prepare('SELECT * FROM comments ORDER BY id DESC LIMIT 1').get();
    check('T18d 登录后 as_author=1 直接以站主身份发布（approved、is_author、署名站主、不存邮箱）',
      out.status === 'ok' && row && row.is_author === 1 && row.status === 'approved'
        && row.author === (SITE.author || '博主') && row.email_hash === null,
      `${res.status} ${JSON.stringify(out)} ${JSON.stringify({ a: row?.author, is: row?.is_author, st: row?.status })}`);
    check('T18e 作者回复不计过客的限流与待审口径', countA() === before + 1 && row.status === 'approved',
      `${before} → ${countA()}`);
    const after = await (await fetch(`${BA}/p/${SLUG}/`, { headers: authHeaders })).text();
    check('T18f 新回复在页面上带「作者」徽章', /badge-author/.test(after), '');

    const t2 = /name="ts" value="([^"]+)"/.exec(await (await fetch(`${BA}/p/${SLUG}/`)).text())?.[1] ?? '';
    await sleep(300);
    const res2 = await fetch(`${BA}/api/comments`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ slug: SLUG, as_author: '1', author: '伪装者', email: 'fake2@example.com',
        ts: t2, hp_fax: '', body: '未登录想冒充博主。' }),
    });
    const out2 = await res2.json().catch(() => ({}));
    const row2 = dbA.prepare('SELECT * FROM comments ORDER BY id DESC LIMIT 1').get();
    check('T18g 未登录时 as_author=1 被无视，走普通读者路径（待审、不冒充）',
      out2.status === 'pending' && row2 && row2.is_author === 0 && row2.author === '伪装者',
      `${JSON.stringify(out2)} ${JSON.stringify({ a: row2?.author, is: row2?.is_author })}`);
  } finally {
    dbA.close();
    await srvA.stop();
    fs.rmSync(rootA, { recursive: true, force: true });
  }
}

{
  // T19 评论头像：独立文章 + 直接入库评论，避开前面用例的评论数。
  const avatarSlug = 'avatar-fixture';
  db.prepare(`INSERT INTO posts(slug,kind,title,body_md,body_html,draft,source,word_count,published_at,comments_on)
    VALUES(?, 'post', '头像夹具', 'x', '<p>x</p>', 0, 'admin', 1, '2026-01-01T00:00:00Z', 1)`).run(avatarSlug);
  const avatarPostId = db.prepare('SELECT id FROM posts WHERE slug = ?').get(avatarSlug).id;
  const email = 'avatar-check@example.com';
  const md5 = emailMd5(email);
  const ins = db.prepare(`INSERT INTO comments(post_id, parent_id, author, email_hash, email_enc, body_md, status, is_author, moderation_nonce, created_at)
    VALUES(?,?,?,?,?,?,?,?,?, datetime('now'))`);
  ins.run(avatarPostId, null, '头像读者', crypt.fingerprint(email), crypt.encrypt(email), '带头像的评论', 'approved', 0, 'n1');
  ins.run(avatarPostId, null, '博主', null, null, '作者回复没有邮箱', 'approved', 1, 'n2');

  const page = await (await fetch(`${BASE}/p/${avatarSlug}/`)).text();
  check('T19a 有邮箱的评论挂上本站反代头像（img 指向 /avatar/<邮箱 md5>）',
    page.includes(`<img class="avatar avatar-img" src="/avatar/${md5}"`), '');
  check('T19b 作者回复（无邮箱）保持字母头像，不出现 img',
    (page.match(/class="avatar avatar-img"/g) ?? []).length === 1, `${(page.match(/class="avatar avatar-img"/g) ?? []).length} 张`);
  check('T19c HTML 里没有任何第三方图片地址（CSP 的 img-src 不必放开）',
    !/gravatar/i.test(page) && !/<img[^>]+src="https?:\/\//i.test(page), '');
  check('T19d 头像 md5 不落库：comments 表里没有 md5 列（渲染时从 email_enc 现算）',
    !db.prepare('PRAGMA table_info(comments)').all().some((col) => /md5/i.test(col.name)), '');

  const av = await fetch(`${BASE}/avatar/${md5}`);
  // 夹具清空上游故这里必是「占位图 + no-store」，断言回合法图片且不被页面级 no-cache 覆盖；真图见 test-avatar。
  check('T19e /avatar/<md5> 回合法图片，缓存策略由路由自己给',
    av.status === 200 && (av.headers.get('content-type') ?? '').startsWith('image/')
      && !/no-cache/.test(av.headers.get('cache-control') ?? ''),
    `${av.status} ${av.headers.get('content-type')} ${av.headers.get('cache-control')}`);
}

{
  // T19f 博主头像：作者回复不存邮箱，头像取自 SITE_EMAIL（进程级配置，主实例没配验不了）—— 单起实例、
  // 用独立临时目录（不独立会被维护锁挡在门外）。DB_FILE 也显式给，别用 startServer 的 srv.dbFile（按父进程环境算，指向夹具库）。
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'blog-owner-avatar-'));
  for (const sub of ['posts', 'notes']) fs.mkdirSync(path.join(root, 'content', sub), { recursive: true });
  fs.mkdirSync(path.join(root, 'uploads'), { recursive: true });
  fs.writeFileSync(path.join(root, 'content', 'posts', 'owner-avatar.md'),
    '---\ntitle: 博主头像\nslug: owner-avatar\ndate: 2026-01-01\n---\n正文。\n');
  const dbFileB = path.join(root, 'data', 'blog.db');
  const srvB = await startServer({ env: {
    DATA_DIR: path.join(root, 'data'), DB_FILE: dbFileB,
    CONTENT_DIR: path.join(root, 'content'), UPLOADS_DIR: path.join(root, 'uploads'),
    SITE_EMAIL: 'owner@example.com',
  } });
  try {
    const dbB = open(dbFileB);
    try {
      const pid = dbB.prepare('SELECT id FROM posts WHERE slug = ?').get('owner-avatar').id;
      dbB.prepare(`INSERT INTO comments(post_id, author, body_md, status, is_author, moderation_nonce, created_at)
        VALUES(?, '沉沦', '作者的回复', 'approved', 1, 'n', datetime('now'))`).run(pid);
    } finally { dbB.close(); }
    const owned = await (await fetch(`${srvB.base}/p/owner-avatar/`)).text();
    check('T19f 博主回复的头像取自 SITE_EMAIL',
      owned.includes(`<img class="avatar avatar-img" src="/avatar/${emailMd5('owner@example.com')}"`), '');
  } finally {
    await srvB.stop();
    fs.rmSync(root, { recursive: true, force: true });
  }
}

db.close();
await srv.stop();
process.exit(report() ? 1 : 0);

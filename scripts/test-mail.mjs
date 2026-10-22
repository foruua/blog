#!/usr/bin/env node
import './_test-env.mjs';
import { cookieJar, createClient, csrfOf, loginAdmin } from './_shared.mjs';

import net from 'node:net';
import { open, close } from '../db/driver.js';
import { requireAdminPassword } from './_admin-password.mjs';
import { createCrypto } from '../src/auth.js';

const { startServer } = await import('./_server.mjs');

function fakeSmtp() {
  const received = [];
  const server = net.createServer((sock) => {
    let buf = '', data = '', inData = false, authStep = 0;
    sock.write('220 test ESMTP\r\n');
    sock.on('data', (chunk) => {
      buf += chunk.toString('utf8');
      let i;
      while ((i = buf.indexOf('\r\n')) !== -1) {
        const line = buf.slice(0, i);
        buf = buf.slice(i + 2);
        if (inData) {
          if (line === '.') { inData = false; received.push(data); data = ''; sock.write('250 ok\r\n'); }
          else data += (line.startsWith('..') ? line.slice(1) : line) + '\n';
          continue;
        }
        const cmd = line.split(/[ \t]/)[0].toUpperCase();
        if (cmd === 'EHLO' || cmd === 'HELO') sock.write('250-test\r\n250-AUTH LOGIN PLAIN\r\n250 OK\r\n');
        else if (cmd === 'AUTH') {
          if (/[ \t]PLAIN/i.test(line)) sock.write('235 ok\r\n');
          else { authStep = 1; sock.write('334 VXNlcm5hbWU6\r\n'); }
        } else if (authStep === 1) { authStep = 2; sock.write('334 UGFzc3dvcmQ6\r\n'); }
        else if (authStep === 2) { authStep = 0; sock.write('235 ok\r\n'); }
        else if (cmd === 'MAIL' || cmd === 'RCPT' || cmd === 'RSET' || cmd === 'NOOP') sock.write('250 ok\r\n');
        else if (cmd === 'DATA') { inData = true; sock.write('354 go ahead\r\n'); }
        else if (cmd === 'QUIT') { sock.write('221 bye\r\n'); sock.end(); }
        else sock.write('250 ok\r\n');
      }
    });
    sock.on('error', () => {});
  });
  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => resolve({
      port: server.address().port,
      received,
      close: () => new Promise((r) => server.close(r)),
    }));
  });
}

// RFC 2047 主题解码：nodemailer 按内容长度在 B/Q 间自选，两边都要认（早先只解 B，改域名就误报）；按 RFC 5322 展开折行。
function decodeSubject(rawHeader) {
  const unfolded = String(rawHeader).replace(/\r?\n[ \t]+/g, ' ');
  const words = [...unfolded.matchAll(/=\?UTF-8\?([BQ])\?([^?]*)\?=/gi)];
  if (!words.length) return unfolded.trim();
  return words.map(([, enc, payload]) => (enc.toUpperCase() === 'B'
    ? Buffer.from(payload, 'base64').toString('utf8')
    : Buffer.from(payload.replace(/_/g, ' ').replace(/=([0-9A-F]{2})/gi, (_, h) => String.fromCharCode(parseInt(h, 16))), 'latin1').toString('utf8')
  )).join('').trim();
}

function decodeByCte(head, payload) {
  const enc = (/^Content-Transfer-Encoding:[ \t]*(\S+)/mi.exec(head)?.[1] ?? '').toLowerCase();
  if (enc === 'base64') {
    return Buffer.from(payload.replace(/[^A-Za-z0-9+/=]/g, ''), 'base64').toString('utf8');
  }
  if (enc === 'quoted-printable') {
    return Buffer.from(payload.replace(/=\r?\n/g, '').replace(/=([0-9A-F]{2})/gi, (_, h) => String.fromCharCode(parseInt(h, 16))), 'latin1').toString('utf8');
  }
  return payload;
}

// 取指定 MIME 段的正文。通知信是 multipart/alternative，早先「取第一个空行后全部内容」会把边界和 HTML 段一起吃进来。
function decodePart(raw, type) {
  const s = String(raw).replace(/\r\n/g, '\n');
  const boundary = /^Content-Type: multipart\/[^;]+;\s*boundary="?([^"\n]+)"?/mi.exec(s)?.[1];
  const chunks = boundary ? s.split(`\n--${boundary}`) : [s];
  for (const chunk of chunks) {
    const [head, ...rest] = chunk.split('\n\n');
    if (!new RegExp(`^Content-Type: ${type}`, 'mi').test(head)) continue;
    return decodeByCte(head, rest.join('\n\n'));
  }
  const [head, ...rest] = s.split('\n\n');
  return decodeByCte(head, rest.join('\n\n'));
}

const decodeBody = (raw) => decodePart(raw, 'text/plain');
const decodeHtml = (raw) => decodePart(raw, 'text/html');

const { createChecker } = await import('./_check.mjs');
const { check, report } = createChecker();

const PASSWORD = requireAdminPassword('test-mail.mjs');

const CLEAN_ENV = { SMTP_HOST: '', SMTP_PORT: '', SMTP_USER: '', SMTP_PASS: '', OWNER_EMAIL: '', MAIL_FROM: '' };

const srv = await startServer({ isolateDb: true, env: CLEAN_ENV });
const BASE = srv.base;
const db = open(srv.dbFile);

const jar = cookieJar();
const req = createClient(BASE, jar);
const text = async (u, o) => (await req(u, o)).text();

async function postForm(url, fields) {
  const r = await req(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams(fields),
  });
  const loc = r.headers.get('location') ?? '';
  let w = new URLSearchParams(loc.split('?')[1] ?? '').get('w') ?? '';
  // 校验失败现在直接重渲染表单（保留输入），提示在 .a-notice 里而不是重定向 query。
  if (!w && r.status === 200) {
    const html = await r.text();
    w = /<p class="a-notice">([\s\S]*?)<\/p>/.exec(html)?.[1]?.replace(/<[^>]*>/g, '') ?? '';
  }
  return { status: r.status, loc, w };
}
const setting = (k) => db.prepare('SELECT value FROM settings WHERE key = ?').get(k)?.value ?? null;

console.log('\n邮件配置测试');
console.log('─'.repeat(58));
console.log(`  受控服务 ${BASE}\n`);

try {

  {
    const r = await loginAdmin(req, PASSWORD);
    if (!jar.cookie.startsWith('blog_admin=')) {
      console.error(`  ✗ 登录失败（status=${r.status}），无法继续`);
      process.exit(2);
    }
  }

  {
    const page = await text('/admin/system');
    check('T1a 系统页可访问', page.length > 0);

    check('T1b 未配置时表单是空的', /id="m-host"[^>]*value=""/.test(page), '');
    check('T1c 表单存在', page.includes('action="/admin/mail"'));
    check('T1d 未保存过时不显示「清除页面配置」按钮', !page.includes('/admin/mail/clear'));

    const hostField = /<input[^>]*id="m-host"[^>]*>/.exec(page)?.[0] ?? '';
    check('T1e 默认不预设任何服务商主机', !/value="[^"]+"/.test(hostField) && !hostField.includes('placeholder='), hostField.slice(0, 90));
    const presetOpts = [...page.matchAll(/data-host="([^"]*)"/g)].map((m) => m[1]);
    check('T1f 提供了多家服务商预设', presetOpts.length >= 6, `预设 ${presetOpts.length} 家`);
    check('T1g 预设里有 587 / STARTTLS 的服务商（不是只有 465）',
      /data-port="587"[^>]*data-tls="starttls"|data-tls="starttls"[^>]*data-port="587"/.test(page), '');
    check('T1h 加密方式三档齐全', ['ssl', 'starttls', 'none'].every((m) => page.includes(`<option value="${m}"`)), '');
  }

  const SECRET = 'abcd1234efgh5678';
  {
    const page = await text('/admin/system');
    const r = await postForm('/admin/mail', {
      _csrf: csrfOf(page),
      host: 'smtp.qq.com', port: '465', tls: 'ssl', user: '123456@qq.com', pass: SECRET,
      to: 'owner@example.com', from: '无隅 <123456@qq.com>',
    });
    check('T2a 保存后 303 且带成功提示', r.status === 303 && r.w.includes('已保存'), `${r.status} ${r.w}`);
    check('T2b 主机已落库', setting('mail_smtp_host') === 'smtp.qq.com', String(setting('mail_smtp_host')));
    check('T2c 端口已落库', setting('mail_smtp_port') === '465', String(setting('mail_smtp_port')));
    check('T2d 收件人与发信人已落库',
      setting('mail_to') === 'owner@example.com' && setting('mail_from') === '无隅 <123456@qq.com>');

    const blob = setting('mail_smtp_pass') ?? '';
    check('T2e 授权码以密文存储（库里查不到明文）', blob && !blob.includes(SECRET), blob.slice(0, 24));
    check('T2f 密文格式正确（v1.iv.data.tag）', blob.split('.').length === 4 && blob.startsWith('v1.'));

    const after = await text('/admin/system');
    check('T2g 保存后表单显示已配置的主机', after.includes('value="smtp.qq.com"'), '');
    check('T2h 页面不回显授权码', !after.includes(SECRET));
    check('T2i 授权码字段保留且没有辅助提示', /id="m-pass"[^>]*value=""/.test(after) && !after.includes('class="a-hint"'));
    check('T2j 有配置后才出现「清除页面配置」按钮', after.includes('/admin/mail/clear'));
    check('T2k 加密方式已落库', setting('mail_smtp_tls') === 'ssl', String(setting('mail_smtp_tls')));
    check('T2l 页面显示所选加密方式', after.includes('>SSL<'), '');
  }

  {
    const before = setting('mail_smtp_pass');
    const page = await text('/admin/system');
    await postForm('/admin/mail', {
      _csrf: csrfOf(page),
      host: 'smtp.qq.com', port: '465', tls: 'ssl', user: '123456@qq.com', pass: '',
      to: 'owner@example.com', from: '',
    });
    check('T3a 授权码留空时密文不变', setting('mail_smtp_pass') === before);
    const page2 = await text('/admin/system');
    check('T3b 留空保存后密码字段仍为空且没有占位说明',
      /id="m-pass"[^>]*value=""/.test(page2) && !/id="m-pass"[^>]*placeholder=/.test(page2));

    const page3 = await text('/admin/system');
    const r = await postForm('/admin/mail', {
      _csrf: csrfOf(page3), host: 'smtp.office365.com', port: '587', tls: 'starttls',
      user: 'me@example.com', pass: 'secret123', to: 'owner@example.com', from: '',
    });
    check('T3c 587 + STARTTLS 配置可保存', r.w.includes('已保存'), r.w);
    check('T3d 加密方式落库为 starttls', setting('mail_smtp_tls') === 'starttls', String(setting('mail_smtp_tls')));
    const page4 = await text('/admin/system');
    check('T3e 页面显示 STARTTLS 与 587', page4.includes('>STARTTLS<') && page4.includes('value="587"'), '');
    check('T3f 服务商下拉自动选中了匹配项', /data-host="smtp\.office365\.com"[^>]*selected/.test(page4), '');

    const rr = await postForm('/admin/mail', {
      _csrf: csrfOf(page4), host: 'smtp.qq.com', port: '465', tls: 'ssl',
      user: '123456@qq.com', pass: '', to: 'owner@example.com', from: '',
    });
    check('T3g 能换回 SSL', rr.w.includes('已保存') && setting('mail_smtp_tls') === 'ssl', rr.w);
  }

  {
    const page = await text('/admin/system');
    const csrf = csrfOf(page);
    const bad = [
      ['T4a 主机不能为空', { host: '' }, '不能为空'],
      ['T4b 主机格式校验', { host: 'http://smtp.qq.com' }, '格式不对'],
      ['T4c 端口下限', { host: 'smtp.qq.com', port: '0' }, '端口不合法'],
      ['T4d 端口上限', { host: 'smtp.qq.com', port: '70000' }, '端口不合法'],
      ['T4e 端口非数字', { host: 'smtp.qq.com', port: 'abc' }, '端口不合法'],
      ['T4f 收件人格式', { host: 'smtp.qq.com', to: 'not-an-email' }, '不像邮箱'],
      ['T4g 发信人必须含地址', { host: 'smtp.qq.com', from: '无隅' }, '必须带一个邮箱'],
      ['T4h 授权码首尾不能有空白', { host: 'smtp.qq.com', pass: ' xyz12345 ' }, '首尾不能有空白'],
      ['T4i 账号格式', { host: 'smtp.qq.com', user: 'not@@ok' }, '不像邮箱地址'],
      ['T4k 加密方式非法', { host: 'smtp.qq.com', tls: 'plaintext-maybe' }, '加密方式不合法'],
      ['T4l 加密方式不能为空', { host: 'smtp.qq.com', tls: '' }, '加密方式不合法'],
    ];
    for (const [name, fields, hint] of bad) {
      const r = await postForm('/admin/mail', {
        _csrf: csrf, to: 'owner@example.com', tls: 'ssl', ...fields,
      });
      check(name, r.w.includes('✗') && r.w.includes(hint), r.w);
    }

    check('T4j 校验失败时不改动已有配置', setting('mail_smtp_host') === 'smtp.qq.com', String(setting('mail_smtp_host')));
  }

  const smtpA = await fakeSmtp();
  const smtpB = await fakeSmtp();
  {

    const pageFail = await text('/admin/system');
    const rf = await postForm('/admin/mail/test', {
      _csrf: csrfOf(pageFail), host: '127.0.0.1', port: '1', tls: 'none', user: 'a@b.com', pass: 'x',
      to: 'owner@example.com', from: '',
    });
    check('T5a 发不出去时返回明确原因', rf.w.includes('发送失败'), rf.w);

    const page = await text('/admin/system');
    const r1 = await postForm('/admin/mail/test', {
      _csrf: csrfOf(page), host: '127.0.0.1', port: String(smtpA.port), tls: 'none', user: 'a@b.com', pass: 'x',
      to: 'owner@example.com', from: '无隅 <a@b.com>',
    });
    check('T5b 配置正确时测试邮件发送成功', r1.w.includes('测试邮件已发送'), r1.w);
    check('T5c A 服务器真的收到了这封信', smtpA.received.length === 1, `收到 ${smtpA.received.length} 封`);
    const letter = smtpA.received[0] ?? '';
    check('T5d 信的收件人正确', /^To: owner@example\.com/m.test(letter), JSON.stringify(letter.slice(0, 60)));
    check('T5e 信的发信人用了表单里的显示名', /^From: .*a@b\.com/m.test(letter), JSON.stringify((letter.match(/^From:.*/m) ?? [''])[0]));

    // 必须先展开折行再取 Subject：长主题折成多行，只匹配第一行会截断。
    const unfoldedLetter = letter.replace(/\r?\n[ \t]+/g, ' ');
    const subjectHeader = (unfoldedLetter.match(/^Subject: (.*)$/m) ?? ['', ''])[1];
    const encoded = /=\?UTF-8\?[BQ]\?/i.test(subjectHeader);
    const decodedSubject = decodeSubject(subjectHeader);
    check('T5f 中文主题按 RFC 2047 编码（否则收件方看到乱码）', encoded, JSON.stringify(subjectHeader.slice(0, 40)));
    check('T5g 解码后的主题正确', decodedSubject.includes('邮件配置测试'), decodedSubject);

    const letterHtml = decodeHtml(letter);
    check('T5g2 测试邮件同样带 HTML 信纸（multipart + table 版式）',
      /Content-Type: multipart\/alternative/i.test(letter)
      && letterHtml.includes('<table') && letterHtml.includes('style="'), '');
    check('T5g3 测试信里列出了生效的 SMTP 参数（纯文本与 HTML 两版都有）',
      decodeBody(letter).includes(`127.0.0.1:${smtpA.port}`)
      && letterHtml.includes(`127.0.0.1:${smtpA.port}`), '');

    const page2 = await text('/admin/system');
    const r2 = await postForm('/admin/mail/test', {
      _csrf: csrfOf(page2), host: '127.0.0.1', port: String(smtpB.port), tls: 'none', user: 'a@b.com', pass: 'x',
      to: 'owner@example.com', from: '',
    });
    check('T5h 改配置后立即生效（B 收到了信）',
      smtpB.received.length === 1 && r2.w.includes('已发送'), `B 收到 ${smtpB.received.length} 封`);
    check('T5i 旧连接没有被复用（A 仍然只有 1 封）', smtpA.received.length === 1, `A 收到 ${smtpA.received.length} 封`);

    const page3 = await text('/admin/system');
    await postForm('/admin/mail/clear', { _csrf: csrfOf(page3) });
    const page4 = await text('/admin/system');
    const r3 = await postForm('/admin/mail/test', {
      _csrf: csrfOf(page4), host: '', port: '465', tls: 'ssl', user: '', pass: '', to: '', from: '',
    });
    check('T5j 主机为空时测试发信给出提示', r3.w.includes('不能为空') || r3.w.includes('还没配'), r3.w);

    const beforeA = smtpA.received.length;
    const page5 = await text('/admin/system');
    const r5 = await postForm('/admin/mail/test', {
      _csrf: csrfOf(page5), host: '127.0.0.1', port: String(smtpA.port), tls: 'starttls',
      user: 'a@b.com', pass: 'x', to: 'owner@example.com', from: '',
    });
    check('T5k 服务器不支持 STARTTLS 时发送失败（requireTLS 生效）', r5.w.includes('发送失败'), r5.w);
    check('T5l 失败时明文内容没有被发出去', smtpA.received.length === beforeA, `收到 ${smtpA.received.length - beforeA} 封`);

    const page6 = await text('/admin/system');
    const r6 = await postForm('/admin/mail', {
      _csrf: csrfOf(page6), verify: '1', host: '127.0.0.1', port: String(smtpA.port), tls: 'none',
      user: 'a@b.com', pass: 'x', to: 'owner@example.com', from: '',
    });
    check('T5m 表单那个「保存」会顺带发测试邮件（保存即验证）',
      r6.w.includes('测试邮件已发送') && smtpA.received.length === 2,
      `${r6.w} / A 收到 ${smtpA.received.length} 封`);

    // 读者之间的回复：审核通过后才通知被回复的人
    {
      const crypt = createCrypto(db);
      const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
      const addComment = (sql, ...args) => Number(db.prepare(sql).run(...args).lastInsertRowid);
      const insert = `INSERT INTO comments
        (post_id, parent_id, author, email_hash, email_enc, website, body_md, status, ip_hash, created_at, is_author, moderation_nonce)
        VALUES (?, ?, ?, ?, ?, NULL, ?, ?, NULL, ?, ?, ?)`;
      // 夹具里 posts 首行可能是笔记（kind='note'），按 /p/ 取页面会 404，所以显式排序取文章
      const postId = db.prepare("SELECT id FROM posts WHERE kind = 'post' ORDER BY id LIMIT 1").get().id;
      const parentEmail = 'reader-parent@example.com';
      const parentId = addComment(insert, postId, null, '楼上的',
        crypt.fingerprint(parentEmail), crypt.encrypt(parentEmail), '顶层评论', 'approved', '2026-01-01T00:00:00.000Z', 0, 'nm-parent');
      const replyId = addComment(insert, postId, parentId, '路过的',
        null, null, '读者回复，等审核', 'pending', '2026-01-02T00:00:00.000Z', 0, 'nm-reply');
      const topId = addComment(insert, postId, null, '新人',
        null, null, '顶层待审评论', 'pending', '2026-01-03T00:00:00.000Z', 0, 'nm-top');

      const before = smtpA.received.length;
      check('T5n 未审核的回复不会发信', (await sleep(250), smtpA.received.length === before), `多了 ${smtpA.received.length - before} 封`);

      const pageR = await text('/admin/comments');
      const rApprove = await postForm(`/admin/comments/${replyId}`, { _csrf: csrfOf(pageR), status: 'approved' });
      await sleep(500);
      check('T5o 读者回复通过审核后，会给被回复的人发提醒',
        rApprove.status === 303 && smtpA.received.length === before + 1,
        `status=${rApprove.status} 新信 ${smtpA.received.length - before} 封`);

      const letter = smtpA.received.at(-1) ?? '';
      check('T5p 收件人正是被回复的那位',
        new RegExp(`^To: ${parentEmail}$`, 'm').test(letter),
        JSON.stringify((letter.match(/^To:.*/m) ?? [''])[0]));
      // 邮件头会折行（续行以空格开头），先按 RFC5322 展开再解码，否则主题像被截断
      const unfolded = letter.replace(/\r?\n[ \t]+/g, ' ');
      const subj = (unfolded.match(/^Subject: (.*)$/m) ?? ['', ''])[1];
      const decoded = decodeSubject(subj);
      check('T5q 主题用「读者」口径，不冒充作者',
        decoded.includes('路过的') && decoded.includes('回复了你的评论') && !decoded.includes('作者'),
        `${decoded}  ←原始: ${subj}`);

      const pageR2 = await text('/admin/comments');
      await postForm(`/admin/comments/${replyId}`, { _csrf: csrfOf(pageR2), status: 'approved' });
      await sleep(400);
      check('T5r 重复点「通过」不会重复发信', smtpA.received.length === before + 1, `又发了 ${smtpA.received.length - before - 1} 封`);

      const pageT = await text('/admin/comments');
      await postForm(`/admin/comments/${topId}`, { _csrf: csrfOf(pageT), status: 'approved' });
      await sleep(400);
      check('T5s 顶层评论通过不触发回复提醒（没有 parent）', smtpA.received.length === before + 1, `多了 ${smtpA.received.length - before - 1} 封`);

      // 一键退订用展开折行后的报文 —— 长 token 会让 List-Unsubscribe 折行（同一坑踩过两次）。
      const unsubUrl = (/^List-Unsubscribe: <([^>]+)>/m.exec(unfolded) ?? [])[1] ?? '';
      check('T5t 提醒邮件带一键退订链接（邮件客户端也能直接用）',
        unsubUrl.includes('/unsubscribe/')
        && /^List-Unsubscribe-Post: List-Unsubscribe=One-Click$/m.test(unfolded), unsubUrl);
      const unsubPath = unsubUrl ? new URL(unsubUrl).pathname + new URL(unsubUrl).search : '';

      // 打开链接**不能**有副作用：邮件客户端与企业网关会预取链接，点开即退订会让用户没看就被退订。
      const pageUnsub = await text(unsubPath);
      check('T5u 打开退订链接只给确认页，不生效',
        pageUnsub.includes('确认退订') && !pageUnsub.includes('已退订'),
        `含确认按钮=${pageUnsub.includes('确认退订')} 含已退订=${pageUnsub.includes('已退订')}`);

      const mkReply = (body) => addComment(insert, postId, parentId, '又一个路过的',
        null, null, body, 'pending', '2026-01-04T00:00:00.000Z', 0, `nm-${Math.random().toString(36).slice(2)}`);
      const approve = async (id) => {
        const page = await text('/admin/comments');
        await postForm(`/admin/comments/${id}`, { _csrf: csrfOf(page), status: 'approved' });
      };

      const stillOn = mkReply('只打开过退订页，不该被退订');
      const beforeStillOn = smtpA.received.length;
      await approve(stillOn);
      await sleep(500);
      check('T5v 只打开退订页不会退订（预取链接是安全的）', smtpA.received.length === beforeStillOn + 1,
        `收到 ${smtpA.received.length - beforeStillOn} 封`);

      const postRaw = (url, fields) => req(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams(fields),
      });
      const confirmed = await postRaw(unsubPath, {});
      const confirmedHtml = await confirmed.text();
      check('T5w 表单确认退订生效，并给出撤销入口',
        confirmedHtml.includes('已退订') && confirmedHtml.includes(`${unsubPath}?undo=1`),
        `status=${confirmed.status}`);

      const muted = mkReply('退订后不该再收到');
      const beforeMuted = smtpA.received.length;
      await approve(muted);
      await sleep(500);
      check('T5x 退订之后不再发提醒', smtpA.received.length === beforeMuted,
        `又发了 ${smtpA.received.length - beforeMuted} 封`);

      const undone = await postRaw(`${unsubPath}?undo=1`, {});
      check('T5y 撤销退订可恢复', (await undone.text()).includes('已恢复'), `status=${undone.status}`);

      const resumed = mkReply('撤销后应该能收到');
      const beforeResumed = smtpA.received.length;
      await approve(resumed);
      await sleep(500);
      check('T5z 撤销后确实又能收到提醒', smtpA.received.length === beforeResumed + 1,
        `收到 ${smtpA.received.length - beforeResumed} 封`);

      // 邮件头声明 One-Click 就要接得住它那个固定体（只要 2xx、不回 HTML）。放最后：它会把提醒重新关掉。
      const oneClick = await postRaw(unsubPath, { 'List-Unsubscribe': 'One-Click' });
      const oneClickBody = await oneClick.text();
      check('T5z2 一键退订（One-Click POST）返回 2xx 且不回页面',
        oneClick.status >= 200 && oneClick.status < 300 && oneClickBody === '',
        `status=${oneClick.status} body=${JSON.stringify(oneClickBody.slice(0, 40))}`);

      const pageAdmin = await text('/admin/comments');
      check('T5z3 退订只记指纹、不删邮箱（后台仍能看到）',
        pageAdmin.includes(parentEmail), '');

      // 嵌套：回复「一条回复」时收件人必须是那条回复的作者。放最后：上面用例比对 smtpA.received 增量，插中间会打乱计数。
      const midEmail = 'reader-mid@example.com';
      const midId = addComment(insert, postId, parentId, '中间的',
        crypt.fingerprint(midEmail), crypt.encrypt(midEmail), '第 2 层，有自己的邮箱',
        'approved', '2026-01-04T00:00:00.000Z', 0, 'nm-mid');
      const deepId = addComment(insert, postId, midId, '更深的',
        null, null, '回复第 2 层，等审核', 'pending', '2026-01-05T00:00:00.000Z', 0, 'nm-deep');
      const beforeDeep = smtpA.received.length;
      const pageD = await text('/admin/comments');
      await postForm(`/admin/comments/${deepId}`, { _csrf: csrfOf(pageD), status: 'approved' });
      await sleep(500);
      const deepLetter = smtpA.received.at(-1) ?? '';
      check('T5p2 回复「一条回复」时，提醒发给那条回复的作者（不落到根评论作者）',
        smtpA.received.length === beforeDeep + 1
        && new RegExp(`^To: ${midEmail}$`, 'm').test(deepLetter)
        && !deepLetter.includes(parentEmail),
        `新信 ${smtpA.received.length - beforeDeep} 封；${(deepLetter.match(/^To:.*/m) ?? [''])[0]}`);

      // 老读者免审直发：站主同样收通知，文案变「已上线、可一键撤」。真走 HTTP：已有获批评论 → 同昵称邮箱、不带 cookie 提交 → 看 smtpA 收到什么。
      {
        const EMAIL = 'trusted-reader@example.com';
        const hash = crypt.fingerprint(EMAIL);
        // 得挑一篇**真能评论的文章**：posts 里也有 kind='note'，笔记正文页走 /n/、按 slug 拼 /p/ 会 404 抓不到 ts token。
        const livePost = db.prepare(
          "SELECT id, slug FROM posts WHERE kind = 'post' AND draft = 0 AND comments_on = 1 ORDER BY id LIMIT 1").get();
        const seedId = addComment(insert, livePost.id, null, '老读者',
          hash, crypt.encrypt(EMAIL), '在此之前已经被批准过的那条', 'approved', '2026-01-06T00:00:00.000Z', 0, 'nm-trusted');

        const pageTrust = await (await fetch(`${BASE}/p/${livePost.slug}/`)).text();
        const tsTrust = /name="ts" value="([^"]+)"/.exec(pageTrust)?.[1] ?? '';
        await sleep(300);   // 反垃圾要求填表过了最小时间

        const beforeLive = smtpA.received.length;
        const resLive = await fetch(`${BASE}/api/comments`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ slug: livePost.slug, author: '老读者', email: EMAIL, body: '免审直发的这一条。', ts: tsTrust, hp_fax: '' }),
        });
        const bodyLive = await resLive.json().catch(() => ({}));
        await sleep(600);
        const liveId = Number(db.prepare('SELECT id FROM comments ORDER BY id DESC LIMIT 1').get()?.id ?? 0);

        check('T5z1 老读者同昵称和邮箱提交 → 直接发布（不再排队）',
          resLive.status === 200 && bodyLive.status === 'ok',
          `${resLive.status} ${bodyLive.status}（ts ${tsTrust ? '已取到' : '为空'}）`);
        check('T5z2 免审直发的评论也通知站主（不再静默上线）',
          smtpA.received.length === beforeLive + 1, `多了 ${smtpA.received.length - beforeLive} 封`);

        const liveLetter = smtpA.received.at(-1) ?? '';
        const liveUnfolded = liveLetter.replace(/\r?\n[ \t]+/g, ' ');
        const liveSubject = decodeSubject((liveUnfolded.match(/^Subject: (.*)$/m) ?? ['', ''])[1]);
        check('T5z3 主题点明「已直接发布」，不再是「待审核」',
          liveSubject.includes('已直接发布') && !liveSubject.includes('待审核'), liveSubject);
        check('T5z4 收件人是站主',
          /^To: owner@example\.com$/m.test(liveLetter),
          JSON.stringify((liveLetter.match(/^To:.*/m) ?? [''])[0]));

        const liveBody = decodeBody(liveLetter);
        check('T5z5 正文说明它已经可见，并去掉没意义的「批准」动作',
          liveBody.includes('已经直接发布') && !liveBody.includes('批准'), '');
        check('T5z6 撤销动作仍在（垃圾 / 删除 / 回复 / 查看都给了）',
          liveBody.includes('垃圾') && liveBody.includes('删除')
          && liveBody.includes('回复') && liveBody.includes('查看')
          && /\/moderate\//.test(liveBody), '');

        // HTML 版（src/email/ 的「纸墨金石」版式）：收件人实际看到的部分，守卫结构、配色、零外部请求。
        const liveHtml = decodeHtml(liveLetter);
        check('T5z7 通知信是 multipart/alternative，纯文本之外还有 HTML 版',
          /Content-Type: multipart\/alternative/i.test(liveLetter)
          && /Content-Type: text\/html/i.test(liveLetter) && liveHtml.includes('<html'), '');
        check('T5z8 HTML 版是完整的信纸（table 布局 + 内联样式 + 金色点缀）',
          liveHtml.includes('<table') && liveHtml.includes('style="') && /#926922/i.test(liveHtml)
          && /<h1[^>]*font-family:'Songti SC'/i.test(liveHtml), '');
        check('T5z9 HTML 版不引用任何外部图片（邮件里默认不加载，会缺一块）',
          !/<img\b/i.test(liveHtml) && !/(?:src|url\()\s*=?\s*["'(]?https?:/i.test(liveHtml), '');
        check('T5z10 HTML 版同样带签名审核链接，且说明了深色模式',
          (liveHtml.match(/\/moderate\//g) ?? []).length >= 3
          && /prefers-color-scheme:\s*dark/.test(liveHtml), '');
        check('T5z11 HTML 版也守「已直接发布、不出现批准」的口径',
          liveHtml.includes('已经直接发布') && !liveHtml.includes('批准'), '');

        db.prepare('DELETE FROM comments WHERE id IN (?, ?)').run(seedId, liveId);
      }

      // 固定页上的评论：待审通知里**不再**给「查看这条评论」（待审评论在公开页面不渲染，`#c<id>` 锚点不存在，要看就去页脚「后台评论管理」）；
      // contentUrl() 的固定页口径改由「已发布评论的回复通知」守 —— 回复通知同一套 commentUrl()、只发给已发布评论：
      // 固定页（kind='page'）走自己的固定路由、不在 /p/ 下，手写 kind 三元会漏掉这一档 → 404。
      // 这里直接往库里插一条固定页（不走文件同步，免得往真实 content/ 落文件）。
      {
        const pageSlug = 'mail-page-regression';
        const { createRepo } = await import('../db/repo.js');
        createRepo(db).upsertFromFile({
          slug: pageSlug, kind: 'page', title: '邮件回归 · 固定页',
          bodyMd: '固定页正文', bodyHtml: '<p>固定页正文</p>', toc: [], commentsOn: true,
          draft: false, publishedAt: '2026-01-01T00:00:00Z', wordCount: 5,
          filePath: null, fileHash: null, source: 'file',
        }, { force: true });

        const pageRes = await fetch(`${BASE}/${pageSlug}`);
        const pageHtml = await pageRes.text();
        const tsPage = /name="ts" value="([^"]+)"/.exec(pageHtml)?.[1] ?? '';
        check('T5aa 固定页在 /<slug> 上可访问，评论表单也在那儿（/p/<slug>/ 那种拼法必 404）',
          pageRes.status === 200 && tsPage !== ''
          && (await fetch(`${BASE}/p/${pageSlug}/`)).status === 404,
          `页面 ${pageRes.status}，ts ${tsPage ? '已取到' : '为空'}`);

        await sleep(300);        const beforePage = smtpA.received.length;
        const resPage = await fetch(`${BASE}/api/comments`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ slug: pageSlug, author: '凌云', email: 'page-reader@example.com', body: '测试数据库和', ts: tsPage, hp_fax: '' }),
        });
        const bodyPage = await resPage.json().catch(() => ({}));
        await sleep(600);
        check('T5ab 固定页上的评论能提交',
          resPage.status === 200 && bodyPage.status === 'pending', `${resPage.status} ${bodyPage.status}`);
        check('T5ac 固定页的评论也通知站主',
          smtpA.received.length === beforePage + 1, `多了 ${smtpA.received.length - beforePage} 封`);

        const pageLetter = smtpA.received.at(-1) ?? '';
        const pageBody = decodeBody(pageLetter);
        check('T5ad 待审通知里不再出现「查看这条评论」（评论还没公开，点过去也看不到）',
          !/^\s*查看\s+\S+/m.test(pageBody),
          `正文里仍有「查看」那一行：${JSON.stringify(pageBody.slice(-200))}`);
        check('T5ae 页脚仍指向后台评论管理（要看待审的评论就去那儿）',
          decodeHtml(pageLetter).includes(`${BASE}/admin/comments`), '');

        // 已发布评论的回复通知：链接必须落在固定页自己的地址上
        const pagePost = db.prepare('SELECT id FROM posts WHERE slug = ?').get(pageSlug);
        const pageReaderEmail = 'page-reader@example.com';
        const pageParentId = addComment(insert, pagePost.id, null, '固定页读者',
          crypt.fingerprint(pageReaderEmail), crypt.encrypt(pageReaderEmail),
          '固定页上已经被批准的评论', 'approved', '2026-01-07T00:00:00.000Z', 0, 'nm-page-parent');
        const pageReplyId = addComment(insert, pagePost.id, pageParentId, '路过的',
          null, null, '对固定页评论的回复', 'pending', '2026-01-07T01:00:00.000Z', 0, 'nm-page-reply');
        const beforePageReply = smtpA.received.length;
        const pageAdmin = await text('/admin/comments');
        await postForm(`/admin/comments/${pageReplyId}`, { _csrf: csrfOf(pageAdmin), status: 'approved' });
        await sleep(500);
        const replyBody = decodeBody(smtpA.received.at(-1) ?? '');
        const replyHref = (/查看完整讨论：(\S+)/.exec(replyBody) ?? [])[1] ?? '';
        check('T5af 回复通知里的链接落在固定页自己的地址上（不是 404 的 /p/<slug>/）',
          smtpA.received.length === beforePageReply + 1 && replyHref === `${BASE}/${pageSlug}#c${pageParentId}`,
          `新信 ${smtpA.received.length - beforePageReply} 封；${replyHref || JSON.stringify(replyBody.slice(-200))}`);
        check('T5ag 那条链接真的打得开（不是 404）',
          replyHref !== '' && (await fetch(replyHref)).status === 200, replyHref);

        db.prepare('DELETE FROM comments WHERE id IN (?, ?)').run(pageParentId, pageReplyId);
      }

      db.prepare('DELETE FROM comments WHERE id IN (?, ?, ?, ?, ?, ?, ?)').run(parentId, replyId, topId, muted, resumed, midId, deepId);
    }
  }

  await smtpA.close();
  await smtpB.close();

  {

    const put = (k, v) => db.prepare(`INSERT INTO settings(key,value) VALUES(?,?)
      ON CONFLICT(key) DO UPDATE SET value=excluded.value`).run(k, v);
    put('mail_smtp_host', 'smtp.legacy.example');
    put('mail_smtp_port', '465');
    db.prepare("DELETE FROM settings WHERE key='mail_smtp_tls'").run();
    const page = await text('/admin/system');
    check('T8a 老配置（465 无 tls）按 SSL 推断', page.includes('>SSL<') && page.includes('smtp.legacy.example'), '');

    put('mail_smtp_port', '587');
    const page2 = await text('/admin/system');
    check('T8b 老配置（587 无 tls）按 STARTTLS 推断', page2.includes('>STARTTLS<'), '');

    const page3 = await text('/admin/system');
    const r = await postForm('/admin/mail', {
      _csrf: csrfOf(page3), host: '127.0.0.1', port: '25', tls: 'none',
      user: '', pass: '', to: 'owner@example.com', from: '',
    });
    const page4 = await text('/admin/system');
    check('T8c 不加密模式可保存（localhost 中继场景）', r.w.includes('已保存') && page4.includes('>不加密<'), r.w);
    check('T8d 不填账号时不要求认证（auth 为空也能存）', setting('mail_smtp_user') === '', String(setting('mail_smtp_user')));
  }

  {
    const page = await text('/admin/system');
    const r = await postForm('/admin/mail/clear', { _csrf: csrfOf(page) });
    check('T6a 清除返回成功', r.w.includes('已清除'), r.w);
    check('T6b 清除后库里的键为空', (setting('mail_smtp_host') ?? '') === '', String(setting('mail_smtp_host')));
    check('T6c 加密方式的键也被清空', (setting('mail_smtp_tls') ?? '') === '', String(setting('mail_smtp_tls')));
    const page2 = await text('/admin/system');
    check('T6d 清除后表单重新变空', /id="m-host"[^>]*value=""/.test(page2), '');

    db.prepare(`INSERT INTO settings(key,value) VALUES('mail_unsub', ?)
      ON CONFLICT(key) DO UPDATE SET value=excluded.value`).run(JSON.stringify(['h1', 'h2', 'h3']));
    const unsubPage = await text('/admin/system');
    check('T6e 设置页显示已退订人数',
      /已退订回复提醒：\s*<b>3<\/b>/.test(unsubPage), '');
    check('T6f 名单非空时才显示「清空名单」',
      unsubPage.includes('/admin/mail/unsub/clear') && unsubPage.includes('清空名单'), '');

    const rClear = await postForm('/admin/mail/unsub/clear', { _csrf: csrfOf(unsubPage) });
    check('T6g 清空退订名单生效',
      rClear.status === 303 && setting('mail_unsub') === '[]', `${rClear.status} / ${setting('mail_unsub')}`);

    const afterClear = await text('/admin/system');
    check('T6h 清空后人数归零，按钮也随之消失',
      /已退订回复提醒：\s*<b>0<\/b>/.test(afterClear) && !afterClear.includes('/admin/mail/unsub/clear'), '');
  }

  {

    const css = (await import('node:fs')).readFileSync(new URL('../public/admin.css', import.meta.url), 'utf8');
    const selBlocks = [...css.matchAll(/\.a-select\s*\{([^}]*)\}/g)].map((m) => m[1]).join('\n');
    check('T9a 下拉框去掉了原生外观', /appearance:\s*none/.test(selBlocks), selBlocks.slice(0, 60));
    check('T9b 下拉框用内联 SVG 自绘箭头（零外部请求）', /data:image\/svg\+xml/.test(selBlocks), '');
    check('T9c 暗色模式下箭头换色', /\[data-theme="dark"\][^{]*\.a-select[^{]*\{[^}]*data:image\/svg/.test(css), '');
  }

  {
    const files = await import('node:fs');
    const os = await import('node:os');
    const path = await import('node:path');
    // 建在系统临时目录里：以前拼 `${CONTENT_DIR}-mail-secondary`，会在仓库根留下 content-mail-secondary/ 且从不清理。
    // 不要在这里传 DB_FILE —— startServer 已指向临时克隆库，覆盖会得到空库（没有后台密码）。
    const secondary = files.mkdtempSync(path.join(os.tmpdir(), 'blog-mail-secondary-'));
    const secondaryContent = path.join(secondary, 'content');
    const secondaryUploads = path.join(secondary, 'uploads');
    for (const sub of ['posts','notes']) files.mkdirSync(path.join(secondaryContent, sub), { recursive: true });
    const srv2 = await startServer({
      isolateDb: true,
      env: {
        DATA_DIR: path.join(secondary, 'data'),
        CONTENT_DIR: secondaryContent, UPLOADS_DIR: secondaryUploads,
        SMTP_HOST: 'smtp.env.example', SMTP_PORT: '587', SMTP_USER: 'env@example.com', SMTP_PASS: 'envpass', OWNER_EMAIL: 'env-owner@example.com',
      },
    });
    try {
      let c2 = '';
      const r = await fetch(srv2.base + '/admin/login', {
        method: 'POST', redirect: 'manual',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({ password: PASSWORD, to: '/admin' }),
      });
      c2 = (r.headers.getSetCookie?.() ?? []).map((x) => x.split(';')[0]).find((x) => x.startsWith('blog_admin=')) ?? '';
      const page = await (await fetch(srv2.base + '/admin/system', { headers: { Cookie: c2 } })).text();
      check('T7a 环境变量兜底时，表单显示的是环境变量里的主机与端口',
        page.includes('value="smtp.env.example"') && /id="m-port"[^>]*value="587"/.test(page), '');
      check('T7b 收件人也来自环境变量', page.includes('value="env-owner@example.com"'), '');
      check('T7c 环境变量不泄露授权码', !page.includes('envpass'));

      const csrf = csrfOf(page);
      await fetch(srv2.base + '/admin/mail', {
        method: 'POST', redirect: 'manual',
        headers: { Cookie: c2, 'Content-Type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({
          _csrf: csrf, host: 'smtp.page.example', port: '465', tls: 'ssl', user: 'page@example.com', pass: 'pagepass1',
          to: 'page-owner@example.com', from: '',
        }),
      });
      const page2 = await (await fetch(srv2.base + '/admin/system', { headers: { Cookie: c2 } })).text();
      check('T7d 页面配置覆盖环境变量（表单里显示的是页面配的那份）', page2.includes('value="smtp.page.example"'), '');
      check('T7e 覆盖后不再显示环境变量主机', !page2.includes('smtp.env.example'));
    } finally {
      await srv2.stop();
      files.rmSync(secondary, { recursive: true, force: true });
    }
  }
} catch (err) {
  check(`测试过程中抛出异常：${err.message}`, false);
} finally {
  close(db);
  await srv.stop();
  process.exit(report() ? 1 : 0);
}

#!/usr/bin/env node

/* 邮件版式预览：把这四封信渲染成静态 HTML，用浏览器打开看效果。npm run preview:mail [目录]，默认写 data/mail-preview/。
   只走 src/email/ 的模板，不连数据库、不发信、不碰真实配置；改版式(layout.js)/文案(letters.js)时用它反复看最省事。邮件客户端的深色模式靠 prefers-color-scheme，浏览器里能一并验证。 */

import fs from 'node:fs';
import path from 'node:path';
import { SITE } from '../src/config.js';
import { DEFAULT_PALETTE } from '../src/site/tokens.js';
import { ownerCommentLetter, replyCommentLetter, smtpTestLetter } from '../src/email/letters.js';

// 只认「不是选项」的第一个参数：以前 `--help` 之类会被当成目录名，在当前目录建出一个叫 `--help` 的目录。
const arg = process.argv[2] && !process.argv[2].startsWith('-') ? process.argv[2] : null;
const outDir = path.resolve(arg ?? path.join('data', 'mail-preview'));
fs.mkdirSync(outDir, { recursive: true });

const base = SITE.url.replace(/\/$/, '');
const moderate = (a) => `${base}/moderate/dev-preview-token-${a}`;
const commentAt = `${base}/p/one-thing-tool/?cpage=2#c41`;
const unsub = `${base}/unsubscribe/dev-preview-token`;

const LONG = '第二段想说的是：这类“只做一件事”的工具，真正的成本不在写，而在**忍住不往里加功能**。'
  + '\n我给自己定的线是：超过 200 行就砍，砍不动就承认它其实是两件事。';

const letters = [
  ['owner-pending', '站主通知 · 新评论待审', ownerCommentLetter({
    postTitle: '给自己写一个只做一件事的工具',
    live: false,
    author: '阿泽',
    website: 'https://azhe.example.com',
    bodyMd: `读到最后一句笑了，我也干过同样的事。\n${LONG}`,
    when: '2026-10-06 13:24',
    actions: [
      { label: '批准发布', href: moderate('approve'), role: 'primary' },
      { label: '标为垃圾', href: moderate('spam'), role: 'ghost', tone: 'danger' },
      { label: '删除', href: moderate('delete'), role: 'ghost', tone: 'danger' },
      { label: '以作者身份回复', href: moderate('reply'), role: 'ghost' },
    ],
  })],
  ['owner-live', '站主通知 · 老读者免审直发', ownerCommentLetter({
    postTitle: '中文网页的字体子集：从 8MB 到 90KB',
    live: true,
    author: '常年潜水的老读者',
    website: '',
    bodyMd: '子集化那步我用 fonttools 也做过一版，结论一样：先砍字符集，再谈压缩。',
    when: '2026-10-06 13:31',
    actions: [
      { label: '标为垃圾', href: moderate('spam'), role: 'ghost', tone: 'danger' },
      { label: '删除', href: moderate('delete'), role: 'ghost', tone: 'danger' },
      { label: '以作者身份回复', href: moderate('reply'), role: 'ghost' },
      { label: '查看这条评论', href: commentAt, role: 'primary' },
    ],
  })],
  ['reply-author', '读者收到 · 作者回复', replyCommentLetter({
    readerName: '阿泽',
    postTitle: '给自己写一个只做一件事的工具',
    lead: '收到了作者回复',
    byAuthor: true,
    replier: '',
    bodyMd: '确实是这个道理，我上一版写了 900 行，最后能用的只有三分之一。已经删到 180 行了。',
    when: '2026-10-06 13:40',
    url: commentAt,
    unsub,
  })],
  ['reply-reader', '读者收到 · 其他读者回复', replyCommentLetter({
    readerName: '路过的',
    postTitle: '雨天，走一条不常走的路',
    lead: '有了新的回复（来自 阿泽）',
    byAuthor: false,
    replier: '阿泽',
    bodyMd: '同感。我把那条路走了三次，第三次才注意到巷口有棵石榴树。',
    when: '2026-10-06 13:44',
    url: commentAt,
    unsub,
  })],
  ['smtp-test', '后台 · 邮件配置测试', smtpTestLetter({
    to: 'owner@example.com',
    host: 'smtp.qq.com',
    port: 465,
    tlsLabel: 'SSL',
    from: `${SITE.identity} <a@uua.me>`,
    at: new Date().toISOString(),
  })],
];

for (const [name, , mail] of letters) {
  fs.writeFileSync(path.join(outDir, `${name}.html`), mail.html);
}

const index = (() => {
  const L = DEFAULT_PALETTE.light;
  return `<!DOCTYPE html>
<html lang="zh-CN"><head><meta charset="utf-8"><title>邮件模版预览</title>
<style>body{font:15px/1.8 -apple-system,"PingFang SC",sans-serif;max-width:40rem;margin:3rem auto;padding:0 1.2rem;color:${L.ink};background:${L.paper}}
h1{font-family:"Songti SC",serif;font-size:1.5rem}ul{list-style:none;padding:0}li{padding:.6rem 0;border-bottom:1px solid #e2e2e2;display:flex;justify-content:space-between;gap:1rem}
a{color:${L.accent};text-decoration:none}b{font-weight:600}.m{color:${L.mutedSoft};font-size:.82rem;font-family:ui-monospace,Menlo,monospace}</style>
</head><body>
<h1>邮件模版预览</h1>
<p class="m">${letters.length} 封信 · 由 scripts/preview-mail.mjs 生成</p>
<ul>
${letters.map(([name, label]) => `<li><a href="./${name}.html">${label}</a><span class="m">${name}.html</span></li>`).join('\n')}
</ul>
</body></html>`;
})();
fs.writeFileSync(path.join(outDir, 'index.html'), index);

console.log(`已写出 ${letters.length + 1} 个文件到 ${outDir}`);
console.log(`打开 ${path.join(outDir, 'index.html')} 查看`);

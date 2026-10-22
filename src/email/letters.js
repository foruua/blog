import { SITE } from '../config.js';
import { esc, formatDateTime } from '../util/text.js';
import {
  letter, mark, hair, spacer, kicker, title, meta, paragraph, caption,
  quote, notice, button, ghostLinks, keyValues, footLine, accentLink,
  richText, safeUrl,
} from './layout.js';

// 站点发出的全部邮件都在这里成型（版式零件见 layout.js）：ownerCommentLetter（站主收到的新评论通知，待审/老
// 读者免审直发两种口径）、replyCommentLetter（有人回复了你的评论）、smtpTestLetter（后台「保存并测试发信」）。
// 每封都同时给 text 与 html：html 是正脸（多数客户端显示它），text 是兜底、也是测试断言依据——test-mail.mjs
// 直接读纯文本段，故 text 排版刻意与历史逐字一致，改前先看那套测试。

// 站主通知信。actions 里的 text 是纯文本版短标签（测试依赖），label 是版式里的完整说法。
export function ownerCommentLetter({ postTitle, live = false, author, website, bodyMd, when, actions = [] }) {
  const url = safeUrl(website);
  const who = `${author}${website ? `（${website}）` : ''}`;
  const subject = live
    ? `[${SITE.identity}] 老读者评论已直接发布`
    : `[${SITE.identity}] 新评论待审核`;

  const text = `${live
    ? `《${postTitle}》有一条来自老读者的评论，已经直接发布（访客现在就能看到）。`
    : `《${postTitle}》有一条新评论等待处理。`}

${who} 写道：

${bodyMd}

────────────────────────────
${live
    ? '如果这条不该出现（点开后需再确认一次，避免邮件客户端预取链接造成误操作）：'
    : '审核（点开后需再确认一次，避免邮件客户端预取链接造成误操作）：'}
${actions.map((a) => `  ${a.text ?? a.label}  ${a.href}`).join('\n')}
`;

  const primary = actions.find((a) => a.role === 'primary');
  const ghosts = actions.filter((a) => a.role === 'ghost');
  const byline = url ? `— ${accentLink(website, url)}` : '';

  const main = [
    mark(),
    spacer(22),
    hair(),
    spacer(26),
    kicker(live ? '老读者 · 已直接发布' : '新评论 · 待审核'),
    spacer(12),
    title(`《${esc(postTitle)}》`),
    spacer(10),
    meta([esc(SITE.identity), esc(when), live ? '已上线' : '等待处理']),
    spacer(24),
    hair(),
    spacer(24),
    caption(`${esc(author)} 写道`, 'padding-bottom:11px;'),
    quote(richText(bodyMd), byline),
    spacer(22),
    ...(live
      ? [notice('这是免审老读者的评论，<strong>已经直接发布</strong> —— 访客现在就能看到。'), spacer(20)]
      : []),
    ...(primary ? [button(primary), spacer(16)] : []),
    ...(ghosts.length ? [ghostLinks(ghosts), spacer(18)] : []),
    caption('点开后要在页面上再确认一次才生效（邮件客户端会预取链接）；审核链接 7 天内有效，改过后台密码即失效。'),
  ].join('\n');

  const foot = [
    footLine(`也可以到 ${accentLink('后台评论管理', `${SITE.url}/admin/comments`)} 一次处理完。`),
    spacer(7),
    footLine(`这封信由 ${accentLink(SITE.identity, SITE.url)} 自动发出。`),
  ].join('\n');

  return { subject, text, html: letter({ subject, preheader: live ? `《${postTitle}》有一条评论已直接发布` : `《${postTitle}》有一条新评论等待处理`, main, foot }) };
}

// 回复提醒信：收信人正是《postTitle》下被回复的那位读者。
export function replyCommentLetter({ readerName, postTitle, lead, byAuthor = true, replier = '', bodyMd, when, url, unsub }) {
  const subject = `[${SITE.identity}] ${byAuthor ? '作者' : replier}回复了你的评论`;

  const text = `${readerName}，你好：

你在《${postTitle}》下的评论${lead}：

  ${String(bodyMd).split('\n').join('\n  ')}

查看完整讨论：${url}

────────────────────────────
不想再收到回复通知？点这里一键退订（退错了可再点一次撤销）：
  ${unsub}
`;

  const main = [
    mark(),
    spacer(22),
    hair(),
    spacer(26),
    kicker(byAuthor ? '作者回复了你' : `${replier} 回复了你`),
    spacer(12),
    title(`《${esc(postTitle)}》`),
    spacer(10),
    meta([esc(SITE.identity), esc(when), '评论回复']),
    spacer(24),
    hair(),
    spacer(24),
    paragraph(`${esc(readerName)}，你好 —— 你在《${esc(postTitle)}》下的评论<strong>${esc(lead)}</strong>：`),
    spacer(16),
    quote(richText(bodyMd), byAuthor ? '— 作者' : `— ${esc(replier)}`),
    spacer(24),
    button({ label: '查看完整讨论', href: url }),
    spacer(20),
    caption('不想再收到这类提醒，用下面页脚里的退订链接；邮件客户端顶部的「退订」按钮同样有效。'),
  ].join('\n');

  const foot = [
    footLine(`${accentLink('一键退订', unsub)}（点错了可以再点一次撤销）。`),
    spacer(7),
    footLine(`这封信由 ${accentLink(SITE.identity, SITE.url)} 自动发出 —— 因为你在它下面留过评论。`),
  ].join('\n');

  return { subject, text, html: letter({ subject, preheader: `你在《${postTitle}》下的评论${lead}`, main, foot }) };
}

// 后台「保存并测试发信」那封：把当前生效的 SMTP 参数以薄册子列出。
export function smtpTestLetter({ to, host, port, tlsLabel, from, at }) {
  const subject = `[${SITE.identity}] 邮件配置测试`;

  const text = `这是一封测试邮件。\n\n收到它就说明评论通知能正常发到 ${to}。\n`
    + `SMTP: ${host}:${port}（${tlsLabel}）\n发信人: ${from}\n时间: ${at}`;

  const main = [
    mark(),
    spacer(22),
    hair(),
    spacer(26),
    kicker('邮件配置测试'),
    spacer(12),
    title('发信通道已就绪'),
    spacer(10),
    meta([esc(SITE.identity), esc(formatDateTime(at)), '测试邮件']),
    spacer(24),
    hair(),
    spacer(24),
    paragraph(`这是一封测试邮件。收到它就说明评论通知能正常发到 <strong>${esc(to)}</strong>。`),
    spacer(20),
    keyValues([
      ['SMTP', `${host}:${port}（${tlsLabel}）`],
      ['发信人', from],
      ['收件人', to],
      ['时间', formatDateTime(at)],
    ]),
    spacer(20),
    caption('参数以「设置 → 邮件通知」页面为准；页面里配的优先于环境变量。'),
  ].join('\n');

  const foot = [
    footLine(`测试信只发给你自己，不影响评论通知的收件人设置。`),
    spacer(7),
    footLine(`这封信由 ${accentLink(SITE.identity, SITE.url)} 自动发出。`),
  ].join('\n');

  return { subject, text, html: letter({ subject, preheader: `测试发信：${host}:${port}`, main, foot }) };
}

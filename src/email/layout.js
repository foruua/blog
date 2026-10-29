import crypto from 'node:crypto';
import { SITE } from '../config.js';
import { esc } from '../util/text.js';

// 邮件版式——与前台 style.css 的「纸墨金石」同源。三条不能越的线：1. 只用 table 布局 + 内联样式
// （Outlook 桌面版是 Word 引擎不认 flex/grid，Gmail 会剥 body 里的 <style>，视觉须靠内联独立成立）；
// 2. 不引用任何外部图片（邮件图默认「未下载」，装饰全用底色与 1px 边框，也避开追踪像素）；3. 间距一律用
// spacer()、不给 div 写 margin（写死高度的空 div 是唯一跨客户端一致的间距）。深色模式：浅色写死内联，
// 深色用 <head> 的 <style> + !important 压，并给 [data-ogsc]（Outlook.com 反转标记）发一份。

// 字体名一律用单引号：这些串会进 style="…" 属性，内部再出现双引号会把属性截断（症状隐蔽：字体名之后的
// 所有声明——含 color——全被丢掉，链接变回默认蓝）。
const FAMILY = {
  sans: "-apple-system,BlinkMacSystemFont,'Segoe UI','PingFang SC','Hiragino Sans GB','Noto Sans CJK SC','Microsoft YaHei',sans-serif",
  display: "'Songti SC','Source Han Serif SC','Noto Serif CJK SC','Noto Serif SC','STSong',SimSun,Georgia,'Times New Roman',serif",
  mono: "ui-monospace,SFMono-Regular,'SF Mono',Menlo,Consolas,'Liberation Mono',monospace",
};

const C = {
  paper: '#faf8f4', card: '#fffefb', sunken: '#f7f4ec', soft: '#f8f5ef',
  ink: '#17160f', inkSoft: '#3a362e', muted: '#716c62', faint: '#8a857a',
  rule: '#eae4d8', ruleSoft: '#efe9dd', accentLine: '#ddcfae', sep: '#c8bfa9',
  accent: '#926922', goldBar: '#a87c26',
  gold: 'linear-gradient(120deg,#c9a24a 0%,#a87c26 42%,#e0c47c 100%)',
  btnInk: '#fffdf6', danger: '#a8452c',
  noteBg: '#fbf6ea', noteBd: '#f0e6cf', noteInk: '#7a5c1c',
  glyph: '#e2d5b0',
};

const DARK = [
  ['.bg-page', 'background-color:#0b0b0d !important'],
  ['.card', 'background-color:#101013 !important;border-color:#26262b !important'],
  ['.foot', 'background-color:#141417 !important;border-top-color:#26262b !important'],
  ['.ink', 'color:#f4f2ec !important'],
  ['.ink-soft', 'color:#c6c3b9 !important'],
  ['.muted', 'color:#8a877d !important'],
  ['.faint', 'color:#7c7972 !important'],
  ['.accent', 'color:#dcb066 !important'],
  ['.danger', 'color:#e08566 !important'],
  ['.sep', 'color:#4a4436 !important'],
  ['.rule-bg', 'background-color:#26262b !important'],
  ['.code', 'background-color:#1f1f24 !important;color:#ddd9cd !important'],
  ['.rule-bd', 'border-top-color:#26262b !important;border-bottom-color:#26262b !important'],
  ['.quote', 'background-color:#17171b !important;border-left-color:#dcb066 !important'],
  ['.quote-glyph', 'color:#4a4436 !important'],
  ['.notice', 'background-color:#1c1a12 !important;border-color:#34301f !important'],
  ['.notice-ink', 'color:#e6c07c !important'],
  ['.btn', 'background-color:#dcb066 !important'],
  ['.btn-a', 'color:#141208 !important'],
];

function styleBlock() {
  const dark = (prefix) => DARK.map(([sel, decl]) => `${prefix}${sel}{${decl}}`).join('\n');
  return `<style>
:root{color-scheme:light dark}
body{margin:0!important;padding:0!important;width:100%!important}
a{text-decoration:none}
img{border:0;outline:none}
@media (max-width:600px){
.pad{padding-left:22px!important;padding-right:22px!important}
.h1{font-size:20px!important}
.q-pad{padding:15px 16px!important}
}
@media (prefers-color-scheme:dark){
${dark('')}
}
${dark('[data-ogsc] ')}
</style>`;
}

// 定高空隙：邮件里唯一可靠的间距手段，别改成 margin。
export const spacer = (n) => `<div style="height:${n}px;line-height:${n}px;font-size:0;">&nbsp;</div>`;

export const hair = (bg = C.rule) =>
  `<div class="rule-bg" style="height:1px;line-height:1px;font-size:0;background-color:${bg};">&nbsp;</div>`;

// 刊头：等宽大写 + 宽字距 + 两侧渐隐金线（对应前台 .hero-mark/.mast-mark）。金线要包一层 1px div：
// 直接给 td 上底色会把 td 撑到整行高，细线变成两块色斑。
export const mark = (text = SITE.mark || SITE.identity) => `<table role="presentation" align="center" cellpadding="0" cellspacing="0" border="0" style="margin:0 auto;">
<tr>
<td width="52" valign="middle" style="padding:0;"><div style="height:1px;line-height:1px;font-size:0;background-color:${C.accentLine};">&nbsp;</div></td>
<td class="accent" style="padding:0 15px;font-family:${FAMILY.mono};font-size:11px;font-weight:600;letter-spacing:.34em;text-indent:.34em;color:${C.accent};white-space:nowrap;">${esc(String(text).toUpperCase())}</td>
<td width="52" valign="middle" style="padding:0;"><div style="height:1px;line-height:1px;font-size:0;background-color:${C.accentLine};">&nbsp;</div></td>
</tr>
</table>`;

export const kicker = (text) =>
  `<p class="accent" style="margin:0;font-family:${FAMILY.mono};font-size:11px;line-height:1.6;letter-spacing:.2em;color:${C.accent};">${esc(text)}</p>`;

export const title = (html) =>
  `<h1 class="h1 ink" style="margin:0;font-family:${FAMILY.display};font-size:23px;font-weight:700;line-height:1.45;letter-spacing:.012em;color:${C.ink};">${html}</h1>`;

export const meta = (parts) =>
  `<p class="muted" style="margin:0;font-family:${FAMILY.mono};font-size:11px;line-height:1.8;letter-spacing:.08em;color:${C.muted};">${parts
    .filter(Boolean).join(`<span class="sep" style="padding:0 7px;color:${C.sep};">·</span>`)}</p>`;

export const paragraph = (html, extra = '') =>
  `<p class="ink-soft" style="margin:0;font-family:${FAMILY.sans};font-size:15px;line-height:1.85;color:${C.inkSoft};${extra}">${html}</p>`;

export const caption = (html, extra = '') =>
  `<p class="faint" style="margin:0;font-family:${FAMILY.mono};font-size:11px;line-height:1.8;letter-spacing:.05em;color:${C.faint};${extra}">${html}</p>`;

export const quote = (bodyHtml, byline = '') => `<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" class="quote" style="background-color:${C.sunken};border-left:2px solid #c9a24a;border-radius:0 8px 8px 0;">
<tr>
<td class="q-pad ink-soft" valign="top" style="padding:18px 20px;font-family:${FAMILY.sans};font-size:15px;line-height:1.85;color:${C.inkSoft};word-break:break-word;">${bodyHtml}</td>
<td class="quote-glyph" width="34" valign="top" style="padding:8px 14px 0 0;font-family:${FAMILY.display};font-size:40px;line-height:1;color:${C.glyph};">&rdquo;</td>
</tr>
</table>${byline ? `\n<p class="faint" style="margin:0;padding-top:10px;font-family:${FAMILY.mono};font-size:11px;line-height:1.7;letter-spacing:.06em;color:${C.faint};">${byline}</p>` : ''}`;

export const notice = (html) => `<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" class="notice" style="background-color:${C.noteBg};border:1px solid ${C.noteBd};border-radius:8px;">
<tr><td class="notice-ink" style="padding:13px 16px;font-family:${FAMILY.sans};font-size:13px;line-height:1.75;color:${C.noteInk};">${html}</td></tr>
</table>`;

export const button = ({ label, href }) => `<table role="presentation" cellpadding="0" cellspacing="0" border="0">
<tr>
<td class="btn" align="center" style="background-color:${C.accent};border-radius:7px;">
<a class="btn-a" href="${esc(href)}" style="display:inline-block;padding:13px 30px;font-family:${FAMILY.mono};font-size:12px;font-weight:700;letter-spacing:.16em;color:${C.btnInk};border-radius:7px;">${esc(label)}</a>
</td>
</tr>
</table>`;

export const ghostLinks = (items) => {
  const cells = items.map((it, i) => {
    const color = it.tone === 'danger' ? C.danger : C.muted;
    const sep = i
      ? `<td class="sep" style="padding:0 9px;font-size:11px;line-height:1.6;color:${C.sep};">·</td>` : '';
    return `${sep}<td style="white-space:nowrap;"><a class="${it.tone === 'danger' ? 'danger' : 'muted'}" href="${esc(it.href)}" style="font-family:${FAMILY.mono};font-size:11px;letter-spacing:.08em;color:${color};border-bottom:1px solid ${C.ruleSoft};padding-bottom:2px;">${esc(it.label)}</a></td>`;
  }).join('');
  return `<table role="presentation" cellpadding="0" cellspacing="0" border="0"><tr>${cells}</tr></table>`;
};

export const keyValues = (rows) => `<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" class="quote" style="background-color:${C.sunken};border:1px solid ${C.ruleSoft};border-radius:8px;">
${rows.map(([k, v], i) => `${i ? `<tr><td colspan="2" style="padding:0 16px;">${hair(C.ruleSoft)}</td></tr>` : ''}
<tr>
<td class="faint" width="100" valign="top" style="padding:10px 12px 10px 16px;font-family:${FAMILY.mono};font-size:11px;line-height:1.7;letter-spacing:.1em;color:${C.faint};">${esc(k)}</td>
<td class="ink-soft" valign="top" style="padding:10px 16px 10px 0;font-family:${FAMILY.mono};font-size:12.5px;line-height:1.7;color:${C.inkSoft};word-break:break-all;">${esc(v)}</td>
</tr>`).join('\n')}
</table>`;

export const footLine = (html, extra = '') =>
  `<p class="muted" style="margin:0;font-family:${FAMILY.mono};font-size:11px;line-height:1.9;letter-spacing:.05em;color:${C.muted};${extra}">${html}</p>`;

export const accentLink = (label, href) =>
  `<a class="accent" href="${esc(href)}" style="color:${C.accent};">${esc(label)}</a>`;

export function letter({ subject = '', preheader = '', main = '', foot = '' }) {
  const year = new Date().getFullYear();
  return `<!DOCTYPE html>
<html lang="${esc(SITE.lang)}">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<meta name="color-scheme" content="light dark">
<meta name="supported-color-schemes" content="light dark">
<title>${esc(subject)}</title>
${styleBlock()}
</head>
<body class="bg-page" style="margin:0;padding:0;background-color:${C.paper};">
<div style="display:none;font-size:1px;line-height:1px;max-height:0;max-width:0;opacity:0;overflow:hidden;mso-hide:all;">${esc(preheader)}</div>
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" class="bg-page" style="background-color:${C.paper};">
<tr>
<td align="center" style="padding:34px 14px 40px;">
<table role="presentation" width="600" cellpadding="0" cellspacing="0" border="0" class="card" style="width:100%;max-width:600px;background-color:${C.card};border:1px solid ${C.rule};border-radius:0 0 12px 12px;">
<tr><td class="rule-bg" style="height:3px;line-height:3px;font-size:0;background-color:${C.goldBar};background-image:${C.gold};">&nbsp;</td></tr>
<tr><td class="pad" style="padding:38px 44px 36px;">
${main}
</td></tr>
<tr><td class="pad foot" style="padding:20px 44px 24px;border-top:1px solid ${C.rule};background-color:${C.soft};border-radius:0 0 11px 11px;">
${foot}
</td></tr>
</table>
<table role="presentation" width="600" cellpadding="0" cellspacing="0" border="0" style="width:100%;max-width:600px;">
<tr><td class="faint" align="center" style="padding-top:16px;font-family:${FAMILY.mono};font-size:10.5px;line-height:1.8;letter-spacing:.1em;color:${C.faint};">© ${year} <a class="faint" href="${esc(SITE.url)}" style="color:${C.faint};">${esc(SITE.identity)}</a><br>这封信由站点自动发出</td></tr>
</table>
</td>
</tr>
</table>
</body>
</html>`;
}

const escapedLines = (s) => esc(String(s ?? '')).replace(/\r?\n/g, '<br>');

// 评论正文：整体转义后再认几种行内 Markdown（行内代码/粗体/斜体/链接）。评论在站内按 Markdown 渲染，
// 邮件里把 `**加粗**` 原样吐出很业余；只做行内语法（块级标题/列表/引用在 600px 信纸里不划算，也易与版式
// 打架）。转义在前，故不存在把访客输入当 HTML 执行的可能；链接还必须是 http(s) 才认。
export function richText(s) {
  // 先把行内代码抠成占位符，处理完强调/链接再回填；否则 `code *x*` 里的星号会被强调规则命中。占位符每次
  // 调用随机生成：固定哨兵一旦被评论正文原样写出就会被当代码占位，随机 token 避免碰撞。
  const codes = [];
  const token = `\uE000${crypto.randomUUID()}\uE000`;
  // 链接先整体换成占位符再处理强调：否则 URL 里的 * 会被 <em> 包住，href 直接损坏。
  const links = [];
  const ltoken = `\uE001${crypto.randomUUID()}\uE001`;
  const out = escapedLines(s)
    .replace(/`([^`\n]+)`/g, (_, code) => `${token}${codes.push(code) - 1}${token}`)
    .replace(/\[([^\]\n]+)\]\((https?:\/\/[^\s)]+)\)/g, (_, label, href) => {
      links.push({ label, href });
      return `${ltoken}${links.length - 1}${ltoken}`;
    })
    .replace(/\*\*([^*\n]+)\*\*/g, '<strong>$1</strong>')
    .replace(/(^|[^*])\*([^*\n]+)\*/g, '$1<em>$2</em>');
  const withLinks = out.replace(new RegExp(`${ltoken}(\\d+)${ltoken}`, 'g'), (_, i) => {
    const { label, href } = links[Number(i)];
    return `<a class="accent" href="${href}" style="color:${C.accent};">${label}</a>`;
  });
  return withLinks.replace(new RegExp(`${token}(\\d+)${token}`, 'g'), (_, i) =>
    `<code class="code" style="font-family:${FAMILY.mono};font-size:.88em;color:#3b372e;background-color:#efece3;border-radius:4px;padding:1px 5px;">${codes[Number(i)]}</code>`);
}

// 只在确实像 http(s) 链接时才当链接用（评论者填的网址不可信）。
export const safeUrl = (u) => (/^https?:\/\/\S+$/i.test(String(u ?? '').trim()) ? String(u).trim() : '');

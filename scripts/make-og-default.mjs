#!/usr/bin/env node
// 生成站点默认分享封面 public/og-default.jpg（1200×630）。
//
//   npm run make:og          # 重新生成并覆盖 public/og-default.jpg
//
// 为什么用代码画而不是丢一张手作图进仓库：分享封面里有一个「域名里的点换成五角星」的品牌手法
// （见 render/layout.js 的 .bmark），手作图每次改字号都要重来；写成脚本后，颜色与字号就是
// base.css 里那几个令牌的值，改版式只改下面这组常量。
//
// 版式沿用站点自己的语言：左对齐、纸底墨字、宋体大标、金色发丝线、等宽小字做页脚。

import path from 'node:path';
import { fileURLToPath } from 'node:url';
import sharp from 'sharp';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const OUT = path.join(ROOT, 'public', 'og-default.jpg');

// —— 设计令牌：与 public/base.css 的素笺配色逐字对应 ——
const PAPER = '#faf8f4';
const INK = '#17160f';
const INK_SOFT = '#433f37';
const MUTED = '#6b665d';
const GOLD = '#926922';
const RULE = 'rgba(23, 22, 15, 0.10)';

const W = 1200;
const H = 630;
const LEFT = 88;          // 左右版心
const RIGHT = W - 88;

const SERIF = 'Songti SC, STSong, Georgia, serif';
const MONO = 'Menlo, SF Mono, monospace';

const WORD_SIZE = 220;    // 主标题字号
const WORD_BASE = 330;    // 主标题基线
const TAG_SIZE = 46;      // 副标题字号
const TAG_BASE = 470;     // 副标题基线
const RULE_Y = 398;       // 主标题下的金线
const FOOT_Y = 542;       // 页脚上方发丝线
const FOOT_BASE = 588;    // 页脚基线

// 「uua」与「me」分两段画：中间那个点换成一枚五角星（与页头 .bmark 同一个手法）。
// 字母宽度不靠手算——用 sharp 把单段文字渲染出来 trim 到墨迹，量出真实宽度再拼。
// 这样换字号、换字体都不用回来对数字（早先手估 306px，实测 290px，星星前就空出一条缝）。
const WORD_A = 'uua';
const WORD_B = 'me';
const STAR_R = 25;
const STAR_GAP = 5;       // 星徽两侧的视觉间隙，约等于句号自带的一侧边距

async function inkWidth(text, { size, family, weight }) {
  const probe = `<svg xmlns="http://www.w3.org/2000/svg" width="2000" height="400">
    <text x="40" y="300" font-family="${family}" font-size="${size}"${weight ? ` font-weight="${weight}"` : ''}
          fill="#000" letter-spacing="-2">${text}</text>
  </svg>`;
  const { info } = await sharp(Buffer.from(probe)).trim({ threshold: 1 }).toBuffer({ resolveWithObject: true });
  return info.width;
}

/** 五角星：外接圆半径 R，内接圆按 ~0.38R（比 0.382 的黄金比例略收，缩到 40px 也不发糊）。 */
function starPath(cx, cy, r) {
  const inner = r * 0.38;
  const pts = [];
  for (let i = 0; i < 10; i += 1) {
    const radius = i % 2 === 0 ? r : inner;
    const angle = -Math.PI / 2 + (i * Math.PI) / 5;
    pts.push(`${(cx + radius * Math.cos(angle)).toFixed(2)},${(cy + radius * Math.sin(angle)).toFixed(2)}`);
  }
  return `M${pts.join('L')}Z`;
}

const widthA = await inkWidth(WORD_A, { size: WORD_SIZE, family: SERIF, weight: 700 });
const widthB = await inkWidth(WORD_B, { size: WORD_SIZE, family: SERIF, weight: 700 });

const WORD_A_X = LEFT;
const STAR_CX = LEFT + widthA + STAR_GAP + STAR_R;
// 五角星当句号用：底尖落在基线附近，重心略高于基线，读起来才是「点」不是「下标」。
const STAR_CY = WORD_BASE - STAR_R;
const WORD_B_X = STAR_CX + STAR_R + STAR_GAP;

const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}" viewBox="0 0 ${W} ${H}">
  <rect width="${W}" height="${H}" fill="${PAPER}"/>

  <text x="${WORD_A_X}" y="${WORD_BASE}" font-family="${SERIF}" font-size="${WORD_SIZE}"
        font-weight="700" fill="${INK}" letter-spacing="-2">${WORD_A}</text>
  <path d="${starPath(STAR_CX, STAR_CY, STAR_R)}" fill="${GOLD}"/>
  <text x="${WORD_B_X}" y="${WORD_BASE}" font-family="${SERIF}" font-size="${WORD_SIZE}"
        font-weight="700" fill="${INK}" letter-spacing="-2">${WORD_B}</text>

  <rect x="${LEFT}" y="${RULE_Y}" width="132" height="3" fill="${GOLD}"/>

  <text x="${LEFT}" y="${TAG_BASE}" font-family="${SERIF}" font-size="${TAG_SIZE}"
        fill="${INK_SOFT}">写代码，也写字。</text>

  <rect x="${LEFT}" y="${FOOT_Y}" width="${RIGHT - LEFT}" height="1" fill="${RULE}"/>

  <text x="${LEFT}" y="${FOOT_BASE}" font-family="${MONO}" font-size="23" letter-spacing="2.5"
        fill="${MUTED}">沉沦</text>
  <text x="${RIGHT}" y="${FOOT_BASE}" font-family="${MONO}" font-size="23" letter-spacing="2.5"
        text-anchor="end" fill="${MUTED}">UUA.ME</text>
</svg>`;

await sharp(Buffer.from(svg))
  .jpeg({ quality: 90, mozjpeg: true, chromaSubsampling: '4:4:4' })
  .toFile(OUT);

const { width: outW, height: outH } = await sharp(OUT).metadata();
const bytes = (await import('node:fs')).statSync(OUT).size;
console.log(`✓ ${path.relative(ROOT, OUT)}  ${outW}×${outH}  ${Math.round(bytes / 1024)}KB  （uua ${widthA}px / me ${widthB}px）`);

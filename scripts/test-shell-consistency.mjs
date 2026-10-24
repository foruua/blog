#!/usr/bin/env node
// 外壳/配色的一致性守卫：两处「注释约束」换成机器检查。
//   1. 深色配色成对守卫：base.css 的 html[data-theme="dark"] 与 prefers-color-scheme: dark 两段
//      逐字重复（light-dark() 兼容性兜底，见 base.css 注释）；style.css / admin.css 里是
//      「显式深色规则 + 紧随的系统深色孪生」成对出现——改一处忘另一处会让系统深色用户看到
//      半新半旧的配色。按文件顺序把每个系统深色块与最近的显式深色块配对逐变量比对。
//   2. themes/classic/templates/layout.liquid 与 src/render/layout.js 的 builtinLayout 是手工同步的
//      双实现——漂移表现为主题页与回退页结构不一致，这里按 chrome 注入点序列比对。
import fs from 'node:fs';
import { createChecker } from './_check.mjs';

const { check, report } = createChecker();

/* —— 1. 深色配色成对守卫 —— */

// 取「某选择器规则」的块体（大括号配平）。
function ruleBlock(css, from, openerRe) {
  openerRe.lastIndex = from;
  const opener = openerRe.exec(css);
  if (!opener) return null;
  const i = css.indexOf('{', opener.index);
  let depth = 0;
  const start = i + 1;
  let j = i;
  for (; j < css.length; j++) {
    if (css[j] === '{') depth++;
    else if (css[j] === '}') { depth--; if (!depth) break; }
  }
  return { body: css.slice(start, j), end: j };
}

// media 块体里通常就一条规则：取最内层规则体（首个 { 与最后一个 } 之间）。
function innerRule(mediaBody) {
  const open = mediaBody.indexOf('{');
  const close = mediaBody.lastIndexOf('}');
  return open >= 0 && close > open ? mediaBody.slice(open + 1, close) : mediaBody;
}

const normalize = (text) => text.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\s+/g, ' ').trim();

const EXPLICIT_DARK = /html\[data-theme="dark"\][^{]*\{/g;
const SYSTEM_DARK = /@media[^{]*prefers-color-scheme:\s*dark[^{]*\{/g;

for (const file of ['public/base.css', 'public/style.css', 'public/admin.css']) {
  const css = fs.readFileSync(file, 'utf8');
  let cursor = 0;
  let lastExplicit = null;
  let pairs = 0;
  const diffs = [];
  for (;;) {
    const nextExplicit = ruleBlock(css, cursor, EXPLICIT_DARK);
    const nextSystem = ruleBlock(css, cursor, SYSTEM_DARK);
    if (!nextExplicit && !nextSystem) break;
    if (nextSystem && (!nextExplicit || nextSystem.end < nextExplicit.end)) {
      // 系统深色块：与最近的显式深色块比对（去掉注释与空白后整块比对，不限于 --var 声明）。
      if (lastExplicit) {
        const a = normalize(lastExplicit);
        const b = normalize(innerRule(nextSystem.body));
        if (a && a !== b) diffs.push(a.slice(0, 60) + ' ↔ ' + b.slice(0, 60));
        pairs++;
      }
      cursor = nextSystem.end;
    } else {
      lastExplicit = nextExplicit.body;
      cursor = nextExplicit.end;
    }
  }
  if (!pairs) { check(`${file} 深色配色成对守卫`, false, '没找到成对块（结构变了？请同步更新本守卫）'); continue; }
  check(`${file} 深色配色显式/系统两段一致（${pairs} 对）`, diffs.length === 0, diffs.slice(0, 2).join('；'));
}

/* —— 2. 布局外壳双实现同构 —— */

const liquid = fs.readFileSync('themes/classic/templates/layout.liquid', 'utf8');
const layoutJs = fs.readFileSync('src/render/layout.js', 'utf8');
const start = layoutJs.indexOf('function builtinLayout');
const end = layoutJs.indexOf('\n}', layoutJs.indexOf('</html>`', start));
const builtin = layoutJs.slice(start, end);

// chrome 注入点序列：两边的顺序必须一致（外壳结构的骨架）。
// liquid 多出的 htmlAttrs 在 builtin 里由 paletteAttr() 直接内联，不算注入点，比对时忽略。
const seq = (text, re) => [...text.matchAll(re)].map((m) => m[1]).filter((k) => k !== 'htmlAttrs');
const liquidSeq = seq(liquid, /chrome\.(\w+)/g);
const builtinSeq = seq(builtin, /chrome\.(\w+)/g);
check('classic 布局与 builtinLayout 的 chrome 注入点序列一致',
  JSON.stringify(liquidSeq) === JSON.stringify(builtinSeq),
  `liquid: ${liquidSeq.join(',')} / builtin: ${builtinSeq.join(',')}`);

// main 元素在 builtin 里经 ctx.mainHtml 由调用方拼装，比对不到字面量；只查其余骨架标记。
for (const marker of ['<div id="app">', 'class="wrap"', 'data-page=']) {
  check(`外壳骨架标记两处都有：${marker}`, liquid.includes(marker) && builtin.includes(marker),
    `liquid=${liquid.includes(marker)} builtin=${builtin.includes(marker)}`);
}

process.exit(report() ? 1 : 0);

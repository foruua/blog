// 生产环境按需精简静态资源：CSS 用 css-tree 解析后序列化（去注释/空白，语义等价），
// JS 只安全地摘掉注释（用 acorn 真解析拿到注释区间，绝不误伤字符串/正则/模板里的 // 或 /*）。
// 开发与测试环境不精简——源码保持可读，测试里那批「按可读格式断言线上 CSS/JS」的用例照旧。
// 压缩器惰性加载：万一生产环境漏装（比如 --omit=dev），也只是不精简，绝不连累服务启动。
let modsPromise = null;
function loadMinifiers() {
  if (!modsPromise) {
    modsPromise = Promise.all([import('css-tree'), import('acorn')])
      .then(([csstree, acorn]) => ({ csstree, acorn }))
      .catch((error) => { modsPromise = null; throw error; });
  }
  return modsPromise;
}

async function minifyCss(source) {
  const { csstree } = await loadMinifiers();
  return csstree.generate(csstree.parse(String(source), { positions: false }));
}

export async function minifyJs(source) {
  const text = String(source);
  const { acorn } = await loadMinifiers();
  // 浏览器脚本是经典脚本；万一有 ES module 语法（import/export、顶层 await）再按 module 解析一次。
  for (const sourceType of ['script', 'module']) {
    const comments = [];
    let ok = false;
    try {
      acorn.parse(text, { ecmaVersion: 'latest', sourceType, onComment: comments });
      ok = true;
    } catch { /* 换一种解析方式再试 */ }
    if (!ok) continue;
    if (!comments.length) return text;
    // 摘注释必须补分隔符：直接把注释两侧拼起来会把两个 token 粘连（`a/*\n*/b` → `ab`，吞掉换行/ASI），
    // 甚至产生语法错误（`throw/*c*/new` → `thrownew`）。注释里含换行就补换行，否则补一个空格。
    let out = '', pos = 0;
    for (const c of comments) {
      out += text.slice(pos, c.start);
      out += /[\r\n\u2028\u2029]/.test(text.slice(c.start, c.end)) ? '\n' : ' ';
      pos = c.end;
    }
    return out + text.slice(pos);
  }
  return text;
}

export async function minifyAsset(file, source) {
  if (file.endsWith('.css')) return minifyCss(source);
  if (file.endsWith('.js')) return minifyJs(source);
  return String(source);
}

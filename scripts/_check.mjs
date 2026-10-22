/* 测试脚本共用的断言计数与结果输出：失败怎么算、长什么样只有一种定义，避免各套件行为漂移。 */
export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/* 轮询到条件成立，或超时后返回最后一次的值。给「要等某状态真的生效」的用例用：固定 sleep 余量不足，机器一忙就假失败。 */
export async function waitFor(fn, { timeoutMs = 15000, stepMs = 100 } = {}) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    let value;
    try { value = await fn(); } catch { value = null; }
    if (value) return value;
    if (Date.now() >= deadline) return value;
    await sleep(stepMs);
  }
}

/** 用例主动跳过（例如本机没装 Playwright）：报告里明确写「跳过」，不伪装成验证通过。 */
export class SkipTest extends Error {}

export function createChecker() {
  let pass = 0, fail = 0, skipped = 0;
  const out = [];

  const record = (name, ok, detail = '') => {
    if (ok) { pass++; out.push(`  ✓ ${name}`); }
    else { fail++; out.push(`  ✗ ${name}${detail ? `  ← ${detail}` : ''}`); }
  };
  const skip = (name, reason = '') => {
    skipped++;
    out.push(`  - ${name}${reason ? `（跳过：${reason}）` : '（跳过）'}`);
  };

  const check = (name, cond, detail = '') => record(name, Boolean(cond), detail);

  // 异步用例：失败只记一条并继续跑后面的用例——第一个失败就中断会掩盖其余问题，也让"0 断言"守卫失效。
  const test = async (name, fn) => {
    try { await fn(); record(name, true); }
    catch (error) {
      if (error instanceof SkipTest) { skip(name, error.message); return; }
      record(name, false, error?.message ?? String(error));
      if (error?.stack) out.push(error.stack);
    }
  };

  const report = ({ label = '' } = {}) => {
    console.log(out.join('\n'));
    console.log('─'.repeat(58));
    // 一条断言都没跑 = 什么都没验过，绝不能算通过（旧版会打印「全部通过」并 exit 0）。
    // 全部用例都是显式 skip（例如缺 Playwright）时例外：报告里已经写明跳过，且 UI_AUDIT_REQUIRED 会另行收紧。
    if (!pass && !fail) {
      if (skipped) { console.log(`  - ${skipped} 个用例跳过\n`); return 0; }
      console.log('  ✗ 没有执行任何断言（套件被跳过或提前退出？）\n');
      return 1;
    }
    console.log(`  ${label ? `${label}：` : ''}${pass} 通过 / ${fail} 失败${skipped ? ` / ${skipped} 跳过` : ''}`);
    console.log(fail ? '  ✗ 存在失败用例\n' : '  ✓ 全部通过\n');
    return fail;
  };

  return { check, test, report, out, counts: () => ({ pass, fail }) };
}

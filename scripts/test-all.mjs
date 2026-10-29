import path from 'node:path';
import { runSuite as runIsolatedSuite } from './_run-suite.mjs';
import { FUNCTIONAL_SUITES, BROWSER_SUITES } from './_suites.mjs';
import { createFixtures } from './_fixtures.mjs';
import { fileURLToPath } from 'node:url';

const project = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const runSuite = async (suite) => {
  // 并发时 stdout 会交错；套件边界至少打一行标签，失败时能看出是哪一段。
  const loud = concurrency > 1;
  if (loud) console.log(`\n── 套件 ${suite} 开始`);
  const code = await runIsolatedSuite(suite, { cwd: project });
  if (loud) console.log(`── 套件 ${suite} ${code === 0 ? '完成' : `失败（${code}）`}`);
  return code;
};
// 套件清单只维护在 _suites.mjs；`npm test -- --only test-comments` 可单跑一个，不必在 package.json 再记一份。
const onlyAt = process.argv.indexOf('--only');
const only = onlyAt >= 0 ? process.argv[onlyAt + 1] : '';
if (onlyAt >= 0 && !only) { console.error('用法：npm test -- --only <suite>'); process.exit(2); }
if (only && !FUNCTIONAL_SUITES.includes(only) && !BROWSER_SUITES.includes(only)) {
  console.error(`未知套件：${only}`); process.exit(2);
}
// 功能套件各自有独立 fixture（_test-env 建临时 DATA_DIR/CONTENT_DIR），可以并行；默认仍为 1，
// CI 可用 TEST_CONCURRENCY=2/3 提速。无头浏览器套件仍串行，避免多个 Chromium 抢同一份 fixtures。
const concurrencyRaw = process.argv.includes('--concurrency')
  ? process.argv[process.argv.indexOf('--concurrency') + 1]
  : process.env.TEST_CONCURRENCY;
const concurrency = Math.min(4, Math.max(1, Number.parseInt(concurrencyRaw, 10) || 1));
if (only && BROWSER_SUITES.includes(only)) process.exit(await runSuite(only));
// 功能套件各自创建私有 fixture；父进程只在最后跑真实浏览器审计时才需要共享库与登录口令。
// 以前无论 UI_AUDIT=off 还是功能套件第一项就失败，都先花一份建库/同步成本。
let fixtures = null;
let status = 0;
try {
  if (concurrency > 1 && !only) status = await runFunctionalsInParallel(FUNCTIONAL_SUITES, concurrency);
  else {
    for (const suite of (only ? [only] : FUNCTIONAL_SUITES)) {
      const code = await runSuite(suite);
      if (code !== 0) { status = code; break; }
    }
  }

  // playwright 与浏览器二进制都可选 —— 缺了就明确跳过并说明怎么装，绝不静默地看起来通过了。
  if (!status && !only && process.env.UI_AUDIT !== 'off') {
    fixtures = await createFixtures();
    const code = await uiAuditSuite();
    if (code !== 0) status = code;
  }
} finally { fixtures?.cleanup(); }
process.exitCode = status;

async function runFunctionalsInParallel(suites, limit) {
  let next = 0;
  let failed = 0;
  const worker = async () => {
    for (;;) {
      const index = next++;
      if (index >= suites.length || failed) return;
      const code = await runSuite(suites[index]);
      if (code !== 0) { failed = code; return; }
    }
  };
  await Promise.all(Array.from({ length: Math.min(limit, suites.length) }, worker));
  return failed;
}

async function uiAuditSuite() {
  console.log('\n── UI 细节审计（真实浏览器）');
  let auditUi, AuditUnavailable, formatFinding;
  try {
    ({ auditUi, AuditUnavailable, formatFinding } = await import('./ui-audit.mjs'));
  } catch (e) {
    // 只有「脚本真的不在」才算跳过。脚本语法错/顶层初始化炸了必须让 npm test 失败 —— 否则最后套件被静默关掉、看着全绿。
    // （playwright 缺失是 ui-audit 内部抛 AuditUnavailable，走下面的 catch，不在这里。）
    if (e?.code !== 'ERR_MODULE_NOT_FOUND') throw e;
    console.log(`  跳过：找不到审计脚本（${e.message}）`);
    return process.env.UI_AUDIT_REQUIRED === '1' ? 1 : 0;
  }
  let srv;
  try {
    const { startServer } = await import('./_server.mjs');
    srv = await startServer({ isolateDb: false });
    // 口令用本套件自己的临时值；缺 playwright / 浏览器会抛 AuditUnavailable
    const res = await auditUi({ base: srv.base, password: process.env.ADMIN_PASSWORD, quiet: true });
    const bad = res.pagesWithFailures;
    console.log(`  ${res.pagesAudited - bad} 通过 / ${bad} 失败`);
    for (const f of res.findings.filter((x) => x.fail)) console.log('  ' + formatFinding(f));
    if (res.hints) console.log(`  （另有 ${res.hints} 条非阻塞提示：字号偏小、渐变需人工确认等）`);
    if (res.failures) return 1;
    for (const suite of BROWSER_SUITES) {
      const code = await runSuite(suite);
      if (code) return code;
    }
    return 0;
  } catch (e) {
    if (e instanceof AuditUnavailable) {
      console.log(`  跳过：${e.message}`);
      return process.env.UI_AUDIT_REQUIRED === '1' ? 1 : 0;
    }
    // 审计自己崩了也算失败 —— 不能把「没跑成」混成「没问题」
    console.log(`  ✗ 审计自身出错：${e.stack ?? e.message}`);
    return 1;
  } finally { if (srv) await srv.stop(); }
}

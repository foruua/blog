/* 真实浏览器套件共用的小件：起浏览器、登录后台。
   七处各写一遍的登录流程（goto → fill → click → waitForURL）在这里收成一份 —— 登录页一改，
   只改这里，不会出现「六个套件跟着改、第七个忘了」的漂移。

   playwright 用动态 import：没装它的时候本模块仍可被导入，套件自己的「缺 Playwright 就跳过」
   逻辑才不会被一个静态 import 提前炸掉。 */

/** 起一个 Chromium。缺浏览器二进制时给一句能照做的提示，而不是 Playwright 的原始堆栈。 */
export async function launchBrowser(options = { headless: true }) {
  const { chromium } = await import('playwright');
  try {
    return await chromium.launch(options);
  } catch (error) {
    throw new Error(`Playwright 浏览器不可用（先 npm i -D playwright，再 npx playwright install chromium）：${error.message.split('\n')[0]}`, { cause: error });
  }
}

/** 在已有 page 上登录后台：成功返回 page，地址停在 /admin。 */
export async function loginAdminPage(page, base, password) {
  await page.goto(`${base}/admin/login`);
  await page.fill('[name=password]', password);
  await Promise.all([page.waitForURL('**/admin'), page.click('button[type=submit]')]);
  return page;
}

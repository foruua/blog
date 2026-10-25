// 服务端复用 public/palette.js 那份 OKLCH 生成器。
//
// 为什么用 vm 而不是复制逻辑：生成器是经典脚本（挂 globalThis.PaletteLib），页面里按需注入，
// 测试里也是用 vm 跑同一份文件。站主把「自定义」设成站点默认后，首帧那段 CSS 必须由服务端算出来
// （访客的 localStorage 里没有），所以这里也在同一个沙箱里跑一遍 —— 生成器改了，三处同时变。
//
// 只用一次、结果缓存在模块级：文件 10KB，vm 启动成本一次性，不进请求路径。
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import { PUBLIC_DIR } from './config.js';

let lib = null;

/** 生成器实例（PaletteLib）。读不到/跑不起来时返回 null —— 调用方按「素笺」兜底，不阻断整页渲染。 */
export function paletteLib() {
  if (lib) return lib;
  try {
    const source = fs.readFileSync(path.join(PUBLIC_DIR, 'palette.js'), 'utf8');
    const sandbox = vm.createContext({});
    vm.runInContext(source, sandbox, { filename: 'public/palette.js' });
    lib = sandbox.PaletteLib ?? null;
  } catch (error) {
    console.error('[palette] 生成器加载失败，自定义默认配色退化为素笺：', error);
    lib = null;
  }
  return lib;
}

/**
 * 站点默认「自定义配色」的那段 CSS（浅色 / 显式深色 / 系统深色三段）。
 * 入参是种子（{ hue, chroma, paper, ink }），由 settings.js 校验并归一化过。
 * 生成器不可用时返回空串 —— 页面就不注入 style，等于素笺。
 */
export function defaultPaletteCss(seed) {
  const instance = paletteLib();
  if (!instance || !seed) return '';
  try {
    const norm = instance.normalizeSeed(seed.hue, seed);
    return instance.customCss(norm.hue, norm);
  } catch (error) {
    console.error('[palette] 默认配色生成失败：', error);
    return '';
  }
}

/** 预设配色在面板/后台里的种子（切到「自定义」时滑块从这里接上，观感不跳）。 */
export function seedOfPreset(preset) {
  return { hue: preset?.hue ?? 210, chroma: preset?.chroma ?? 1, paper: 1, ink: 0 };
}

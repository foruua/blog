import { AsyncLocalStorage } from 'node:async_hooks';

// 主题解析需要知道「当前请求是否带预览主题」。layout() 是同步函数、拿不到 Hono 的 c，
// 所以用 AsyncLocalStorage 把少量请求状态带进渲染层，避免给 12 处 layout() 调用逐个加参数。
const storage = new AsyncLocalStorage();

export const THEME_PREVIEW_COOKIE = 'blog_theme_preview';

export const runWithThemeRequest = (state, fn) => storage.run(state, fn);
export const themeRequest = () => storage.getStore() ?? null;

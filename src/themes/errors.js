// 主题渲染失败的环形缓冲。渲染失败会自动回退内置外壳，前台看不出问题——
// 这正是它难被发现的原因：后台必须能看到「主题在悄悄失败」。
const MAX = 20;
const items = [];

export function recordThemeError(error, at = Date.now()) {
  const entry = {
    at,
    theme: String(error?.themeId ?? ''),
    template: String(error?.template ?? ''),
    message: String(error?.message ?? error ?? '').slice(0, 500),
  };
  // 模板坏了是「每个请求都挂」：同一条错误只留一条并累加次数，别让缓冲被刷成同一条 20 遍。
  const last = items[0];
  if (last && last.theme === entry.theme && last.template === entry.template && last.message === entry.message) {
    last.count += 1;
    last.at = at;
    return;
  }
  items.unshift({ ...entry, count: 1 });
  if (items.length > MAX) items.length = MAX;
}

export function listThemeErrors() {
  return items.slice();
}

export function clearThemeErrors() {
  items.length = 0;
}

// 环境变量整数解析：非法/缺失回退到 fallback，结果夹在 [min, max]。
export const envInt = (raw, fallback, { min, max }) => {
  const n = Number.parseInt(String(raw ?? ''), 10);
  if (!Number.isFinite(n)) return fallback;
  return Math.min(max, Math.max(min, n));
};

// 毫秒/秒级的间隔解析：0 一律表示「关闭」（定时器/后台任务），负数/非数字回退。
// 与 envInt 的区别是不用 parseInt：`1e3`、`60000.0` 这类写法按数值理解；缺失/空白仍回退。
export const envDurationMs = (raw, fallback, { min = 0, max = Number.MAX_SAFE_INTEGER } = {}) => {
  const text = String(raw ?? '').trim();
  if (!text) return fallback;
  const n = Number(text);
  if (!Number.isFinite(n) || n < 0) return fallback;
  if (n === 0) return 0;
  return Math.min(max, Math.max(min, n));
};

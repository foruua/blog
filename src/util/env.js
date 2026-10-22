// 环境变量整数解析：非法/缺失回退到 fallback，结果夹在 [min, max]。
export const envInt = (raw, fallback, { min, max }) => {
  const n = Number.parseInt(String(raw ?? ''), 10);
  if (!Number.isFinite(n)) return fallback;
  return Math.min(max, Math.max(min, n));
};

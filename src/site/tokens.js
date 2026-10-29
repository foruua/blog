// 站点默认配色（素笺）的令牌快照。base.css 是唯一真相源 —— 那里是 CSS 变量，邮件、分享图与
// 预览工具只能用内联样式或像素，读不到变量，所以把「跨载体要用」的那一小组固化成常量。
// 改 base.css 后跑 scripts/test-regressions.mjs（或 npm test）：它会按 TOKEN_VARS 逐项比对
// :root / 深色块，漂了当场失败。不要再在脚本里手抄这些 hex。

export const TOKEN_VARS = {
  paper: '--bg',
  paperSoft: '--bg-soft',
  paperElev: '--bg-elev',
  ink: '--fg',
  inkSoft: '--fg-soft',
  muted: '--muted',
  mutedSoft: '--muted-soft',
  accent: '--accent',
  accentInk: '--accent-ink',
  danger: '--danger',
  codeBg: '--code-bg',
  codeFg: '--code-fg',
};

export const DEFAULT_PALETTE = {
  light: {
    paper: '#f8f8f8',
    paperSoft: '#eeeeee',
    paperElev: '#fefefe',
    ink: '#17160f',
    inkSoft: '#433f37',
    muted: '#6b665d',
    mutedSoft: '#736e65',
    accent: '#926922',
    accentInk: '#8a6420',
    danger: '#a8452c',
    codeBg: '#f2f2f2',
    codeFg: '#3b372e',
  },
  dark: {
    paper: '#0b0b0b',
    paperSoft: '#141414',
    paperElev: '#101010',
    ink: '#f4f2ec',
    inkSoft: '#c6c3b9',
    muted: '#928e85',
    mutedSoft: '#807d76',
    accent: '#dcb066',
    accentInk: '#e6c07c',
    danger: '#e08566',
    codeBg: '#121212',
    codeFg: '#ddd9cd',
  },
};

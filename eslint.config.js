import js from '@eslint/js';
import globals from 'globals';

const base = {
  languageOptions: { ecmaVersion: 'latest', sourceType: 'module' },
  rules: {
    'no-unused-vars': ['error', { args: 'after-used', caughtErrors: 'none', varsIgnorePattern: '^_' }],
    'no-useless-assignment': 'off',
    'no-empty': ['error', { allowEmptyCatch: true }],
  },
};

export default [
  { ignores: ['node_modules/**', 'data/**', '.workbuddy/**', 'output/**', 'design/**', 'themes/**', 'scripts/fixtures/**', 'public/.build/**'] },
  js.configs.recommended,
  // 服务端与数据层只给 Node 全局：误用 document / window 会当场被 lint 抓到。
  { ...base, files: ['server.js', 'src/**/*.js', 'db/**/*.js'], languageOptions: { ...base.languageOptions, globals: globals.node } },
  // 浏览器脚本只给浏览器全局：误用 process / Buffer 会当场被抓到。
  { ...base, files: ['public/**/*.js'], languageOptions: { ...base.languageOptions, globals: globals.browser } },
  // 测试脚本在 Node 里跑，但 page.evaluate() 的回调字面量会使用浏览器全局，故两边都给。
  { ...base, files: ['scripts/**/*.mjs', 'eslint.config.js'], languageOptions: { ...base.languageOptions, globals: { ...globals.node, ...globals.browser } } },
];

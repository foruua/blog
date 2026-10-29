import assert from 'node:assert/strict';
import fs from 'node:fs';
import { JSDOM } from 'jsdom';
import { createChecker, sleep } from './_check.mjs';

const { test, report } = createChecker();
const source = fs.readFileSync('public/app.js', 'utf8');
function mount({ owner = false, request } = {}) {
  const dom = new JSDOM(`<form data-comment-form data-slug="test">${owner ? '<input name="as_author" value="1">' : '<input name="email" type="email"><input name="author"><input name="website">'}<textarea name="body">test</textarea><button type="submit">发布</button></form>`, { url: 'https://example.com/', runScripts: 'outside-only' });
  const w = dom.window;
  w.matchMedia = () => ({ matches: false });
  // 真实页面总先加载 request.js（提供 __request/__csrf/__reducedMotion/__openDialog），这里照做，再把它换成测试替身。
  w.eval(fs.readFileSync('public/request.js', 'utf8'));
  w.__request = request ?? (async () => ({ ok: false, json: async () => ({ ok: false }) }));
  w.localStorage.setItem('commenter', JSON.stringify({ author: '旧昵称', email: 'old@example.com', website: 'https://old.example.com' }));
  w.eval(fs.readFileSync('public/ui.js', 'utf8'));
  w.eval(source);
  return { dom, w, form: w.document.querySelector('form') };
}
await test('作者模式提交保留浏览器中已有读者信息', async () => {
  const { dom, w, form } = mount({ owner: true });
  try {
    const before = w.localStorage.getItem('commenter');
    form.dispatchEvent(new w.Event('submit', { bubbles: true, cancelable: true }));
    await sleep(0);
    assert.equal(w.localStorage.getItem('commenter'), before);
  } finally { dom.window.close(); }
});
await test('邮箱输入后的防抖等待期间手动编辑昵称不会被覆盖', async () => {
  const { dom, w, form } = mount({ request: async () => ({ ok: true, json: async () => ({ profile: { author: '数据库昵称', website: 'https://db.example.com' } }) }) });
  try {
    const email = form.querySelector('[name=email]'), author = form.querySelector('[name=author]');
    email.value = 'new@example.com'; email.dispatchEvent(new w.Event('input'));
    author.value = '手动昵称'; author.dispatchEvent(new w.Event('input'));
    await sleep(500);
    assert.equal(author.value, '手动昵称');
    assert.equal(form.querySelector('[name=website]').value, 'https://db.example.com');
  } finally { dom.window.close(); }
});
await test('change 和 blur 连续触发仅查询一次', async () => {
  let hits = 0;
  const { dom, w, form } = mount({ request: async () => { hits++; return { ok: true, json: async () => ({ profile: null }) }; } });
  try {
    const email = form.querySelector('[name=email]');
    email.value = 'new@example.com'; email.dispatchEvent(new w.Event('change')); email.dispatchEvent(new w.Event('blur'));
    await sleep(0); assert.equal(hits, 1);
  } finally { dom.window.close(); }
});
await test('切换邮箱后迟到的旧查询结果不会覆盖新资料', async () => {
  const pending = [];
  const { dom, w, form } = mount({ request: () => new Promise(resolve => pending.push(resolve)) });
  try {
    const email = form.querySelector('[name=email]');
    email.value = 'first@example.com'; email.dispatchEvent(new w.Event('change'));
    email.value = 'second@example.com'; email.dispatchEvent(new w.Event('input')); email.dispatchEvent(new w.Event('change'));
    pending[1]({ ok: true, json: async () => ({ profile: { author: '新资料', website: '' } }) });
    await sleep(0);
    pending[0]({ ok: true, json: async () => ({ profile: { author: '旧资料', website: 'https://old.example.com' } }) });
    await sleep(0);
    assert.equal(form.querySelector('[name=author]').value, '新资料');
    assert.equal(form.querySelector('[name=website]').value, '');
  } finally { dom.window.close(); }
});
await test('邮箱查询失败后离开输入框可以重试', async () => {
  let hits = 0;
  const { dom, w, form } = mount({ request: async () => { hits++; return { ok: hits > 1, json: async () => ({ profile: { author: '重试成功', website: '' } }) }; } });
  try {
    const email = form.querySelector('[name=email]');
    email.value = 'retry@example.com'; email.dispatchEvent(new w.Event('change'));
    await sleep(0); email.dispatchEvent(new w.Event('blur')); await sleep(0);
    assert.equal(hits, 2); assert.equal(form.querySelector('[name=author]').value, '重试成功');
  } finally { dom.window.close(); }
});
await test('查询进行期间手动清空网址也不会被覆盖', async () => {
  let finish;
  const { dom, w, form } = mount({ request: () => new Promise(resolve => { finish = resolve; }) });
  try {
    const email = form.querySelector('[name=email]'), website = form.querySelector('[name=website]');
    email.value = 'new@example.com'; email.dispatchEvent(new w.Event('change'));
    website.value = ''; website.dispatchEvent(new w.Event('input'));
    finish({ ok: true, json: async () => ({ profile: { author: '新昵称', website: 'https://db.example.com' } }) });
    await sleep(0); assert.equal(website.value, ''); assert.equal(form.querySelector('[name=author]').value, '新昵称');
  } finally { dom.window.close(); }
});
await test('列表里选中文字后回车替换选区，不保留被选中文字', () => {
  const dom = new JSDOM('', { runScripts: 'outside-only' });
  try {
    dom.window.eval(fs.readFileSync('public/editor.js', 'utf8'));
    const out = dom.window.__writer.continueList('- hello world', 7, 13);
    assert.equal(out.value, '- hello\n- ');
    assert.equal(dom.window.__writer.continueList('- hello', 7).value, '- hello\n- ');
    assert.equal(dom.window.__writer.continueList('- ', 2).value, '');
    assert.equal(dom.window.__writer.continueList('1. hello world', 8, 14).value, '1. hello\n2. ');
  } finally { dom.window.close(); }
});
process.exitCode = report();

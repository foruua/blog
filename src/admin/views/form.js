import { esc } from '../../util/text.js';

// 后台表单的最小字段组件：label + 控件 + 可选说明。以前 site.js / system.js / content.js
// 各写一份同样的 <div class="a-field"> 样板，加 maxlength / autocomplete 时很容易漏一边。
export const field = (id, label, input, { desc = '' } = {}) => `        <div class="a-field">
          <label for="${id}">${label}</label>
          ${input}
        </div>${desc ? `\n        <small class="a-dim">${desc}</small>` : ''}`;

export const textInput = (id, name, value, options = {}) => {
  const { maxlength = null, autocomplete = 'off' } =
    typeof options === 'number' ? { maxlength: options } : options;
  return `<input class="a-input" id="${id}" name="${name}" type="text"
                 ${maxlength == null ? '' : `maxlength="${maxlength}" `}value="${esc(value ?? '')}" autocomplete="${autocomplete}" spellcheck="false">`;
};

export const saveRow = (label = '保存') => `      <div class="a-actions">
        <button type="submit" class="a-btn">${label}</button>
      </div>`;

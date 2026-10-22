import { csrfField, esc } from '../../util/text.js';
import { adminLayout } from '../layout.js';
import { pickerDialog } from './picker.js';

const optionField = (option, value) => {
  const id = `opt-${option.key}`;
  const name = `opt_${option.key}`;
  const label = `<label class="a-field" for="${id}"><span>${esc(option.label)}</span>`;
  const desc = option.description ? `<small class="a-dim">${esc(option.description)}</small>` : '';
  if (option.type === 'boolean') {
    return `<label class="a-check"><input type="checkbox" id="${id}" name="${name}" value="1"${value ? ' checked' : ''}><span>${esc(option.label)}</span></label>${desc}`;
  }
  if (option.type === 'textarea') {
    return `${label}<textarea class="a-textarea" id="${id}" name="${name}" rows="4">${esc(value ?? '')}</textarea></label>${desc}`;
  }
  if (option.type === 'select') {
    const opts = option.options.map((item) => `<option value="${esc(item.value)}"${String(item.value) === String(value) ? ' selected' : ''}>${esc(item.label)}</option>`).join('');
    return `${label}<select class="a-select" id="${id}" name="${name}">${opts}</select></label>${desc}`;
  }
  if (option.type === 'number') {
    return `${label}<input class="a-input" id="${id}" name="${name}" type="number" value="${esc(value)}" min="${option.min}" max="${option.max}" step="${option.step}"></label>${desc}`;
  }
  if (option.type === 'color') {
    return `${label}<span class="a-color-row"><input class="a-input" id="${id}" name="${name}" type="text" value="${esc(value ?? '')}" placeholder="#926922" spellcheck="false"><input type="color" value="${esc(/^#[0-9a-f]{6}$/i.test(String(value ?? '')) ? value : '#926922')}" aria-label="${esc(option.label)}取色" data-color-for="${id}"></span></label>${desc}`;
  }
  if (option.type === 'image') {
    // 只接受站内路径（CSP 的 img-src 'self' 拦外站图）：文本框可手填，也可从媒体库挑。
    return `${label}<span class="a-image-row">
          <input class="a-input" id="${id}" name="${name}" type="text" value="${esc(value ?? '')}" placeholder="/uploads/…" spellcheck="false" autocomplete="off">
          <button type="button" class="a-btn-ghost" data-theme-image="${id}">媒体库</button>
          <button type="button" class="a-btn-ghost" data-theme-image-clear="${id}" aria-label="清空${esc(option.label)}">清空</button>
        </span>
        <span class="a-image-preview" data-image-preview="${id}"${value ? '' : ' hidden'}><img${value ? ` src="${esc(value)}"` : ''} alt="" loading="lazy" decoding="async"></span></label>${desc}`;
  }
  return `${label}<input class="a-input" id="${id}" name="${name}" type="text" value="${esc(value ?? '')}"></label>${desc}`;
};

const optionsForm = (theme, csrf) => {
  if (!theme.options?.length) return '';
  return `<details class="a-theme-opts">
        <summary>主题设置</summary>
        <form method="post" action="/admin/themes/options">
          ${csrfField(csrf)}
          <input type="hidden" name="id" value="${esc(theme.id)}">
${theme.options.map((option) => `          ${optionField(option, theme.optionValues?.[option.key])}`).join('\n')}
          <p class="a-actions"><button class="a-btn" type="submit">保存设置</button></p>
        </form>
      </details>`;
};

const shot = (theme) => theme.screenshot_url
  ? `<img class="a-theme-shot" src="${esc(theme.screenshot_url)}" alt="${esc(theme.name)} 预览" loading="lazy" decoding="async">`
  : `<div class="a-theme-shot a-theme-shot-empty" aria-hidden="true">无截图</div>`;

const ago = (at) => {
  const s = Math.max(0, Math.round((Date.now() - at) / 1000));
  if (s < 60) return `${s} 秒前`;
  if (s < 3600) return `${Math.round(s / 60)} 分钟前`;
  if (s < 86400) return `${Math.round(s / 3600)} 小时前`;
  return `${Math.round(s / 86400)} 天前`;
};

const card = (theme, { csrf, active, preview, canDelete }) => {
  const isActive = active === theme.id;
  // 正在使用的主题不需要“预览中”角标，也不需要再点“预览”看自己。
  const isPreview = Boolean(preview) && preview === theme.id && !isActive;
  return `<article class="a-theme-card${isActive ? ' is-active' : ''}">
      <div class="a-theme-shot-wrap">${shot(theme)}${isActive ? '<span class="a-theme-on">使用中</span>' : ''}${isPreview ? '<span class="a-theme-preview">预览中</span>' : ''}</div>
      <div class="a-theme-body">
        <div class="a-theme-heading">
          <h2 class="a-theme-name">${esc(theme.name)}</h2>
          ${theme.version ? `<span class="a-theme-ver">v${esc(theme.version)}</span>` : ''}
        </div>
        <p class="a-theme-meta">${esc(theme.author || '未署名')}</p>
        ${theme.description ? `<p class="a-theme-desc">${esc(theme.description)}</p>` : ''}
        <div class="a-theme-actions">
          ${isActive ? '<span class="a-pill a-pill-live">正在使用</span>' : `<form method="post" action="/admin/themes/activate">
            ${csrfField(csrf)}
            <input type="hidden" name="id" value="${esc(theme.id)}">
            <button class="a-btn" type="submit">启用</button>
          </form>`}
          ${isActive ? '' : `<a class="a-btn-ghost" href="/admin/themes/preview?id=${encodeURIComponent(theme.id)}&to=/" data-no-pjax>预览</a>`}
          ${canDelete ? `<form method="post" action="/admin/themes/delete">
            ${csrfField(csrf)}
            <input type="hidden" name="id" value="${esc(theme.id)}">
            <button class="a-btn-danger" type="submit"
              data-modal-title="删除主题「${esc(theme.name)}」？"
              data-modal-body="主题文件会移入 themes/.trash，删除后不能恢复。"
              data-modal-note="使用中的主题不能删除；请先启用其它主题。"
              data-modal-ok="删除主题">删除</button>
          </form>` : ''}
        </div>
        ${optionsForm(theme, csrf)}
      </div>
    </article>`;
};

export function themesPage({ themes = [], active = '', preview = '', errors = [], renderErrors = [], csrf, notice = '', badges }) {
  // 有 image 类型设置项才渲染媒体库弹窗：没有它就是一个空 dialog，白占 DOM。
  const needPicker = themes.some((theme) => (theme.options ?? []).some((option) => option.type === 'image'));
  const errorBlock = errors.length ? `<div class="a-card a-panel a-theme-errors">
      <h2 class="a-h2">未加载的主题</h2>
      <p class="a-dim">这些目录里的 theme.json 没通过校验，修好后刷新本页即可。</p>
      <ul>${errors.map((error) => `<li><code>${esc(error.id)}</code>：${esc(error.errors.join('；'))}</li>`).join('')}</ul>
    </div>` : '';

  // 渲染失败是静默回退：前台看着一切正常，只有这里能看出主题其实一直在挂。
  const renderErrorBlock = renderErrors.length ? `<div class="a-card a-panel a-theme-errors">
      <h2 class="a-h2">最近的主题渲染失败</h2>
      <p class="a-dim">这些页面已自动回退到内置外壳，访客看不出异常。改好模板后这里不再新增。</p>
      <ul>${renderErrors.slice(0, 5).map((item) => `<li><code>${esc(item.theme || '未知主题')}</code> · <code>${esc(item.template || '—')}</code> · ${esc(ago(item.at))}${item.count > 1 ? `（${item.count} 次）` : ''}<br><span class="a-dim">${esc(item.message)}</span></li>`).join('')}</ul>
      <form method="post" action="/admin/themes/errors/clear">
        ${csrfField(csrf)}
        <p class="a-actions"><button class="a-btn-ghost" type="submit">清空记录</button></p>
      </form>
    </div>` : '';

  // notice 统一由 adminLayout 渲染；这里再拼一次会在同一页出现两条相同提示。
  const body = `    <h2 class="a-h2">主题</h2>
${themes.length ? `    <div class="a-themes">
${themes.map((theme) => card(theme, { csrf, active, preview, canDelete: theme.id !== active && themes.length > 1 })).join('\n')}
    </div>` : '    <div class="a-card a-panel a-empty">还没有主题。上传一个 ZIP 主题包开始使用。</div>'}

    <h2 class="a-h2">安装主题</h2>
    <div class="a-card a-panel a-theme-install">
      <form class="a-theme-upload" method="post" action="/admin/themes/upload" enctype="multipart/form-data" data-timeout="120000">
        ${csrfField(csrf)}
        <label class="a-theme-picker" for="themeZip" data-theme-picker>
          <input class="a-theme-picker-input" id="themeZip" name="theme" type="file" accept=".zip,application/zip" required data-theme-picker-input>
          <span class="a-theme-picker-ico" aria-hidden="true"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"><path d="M12 16V5"/><path d="m7.5 9.5 4.5-4.5 4.5 4.5"/><path d="M5 15v3.2c0 .9.7 1.6 1.6 1.6h10.8c.9 0 1.6-.7 1.6-1.6V15"/></svg></span>
          <span class="a-theme-picker-main">
            <b data-theme-picker-name>选择主题 ZIP 包</b>
            <small data-theme-picker-meta aria-live="polite">点击选择，或拖入文件</small>
          </span>
          <span class="a-theme-picker-action">浏览</span>
        </label>
        <div class="a-theme-upload-foot">
          <label class="a-check"><input type="checkbox" name="replace" value="1"><span>允许覆盖同名主题</span></label>
          <button class="a-btn" type="submit">上传并安装</button>
        </div>
      </form>
    </div>
${errorBlock}
${renderErrorBlock}
${needPicker ? pickerDialog({ title: '选择主题图片' }) : ''}`;

  return adminLayout({ title: '外观', sub: '主题管理', active: 'themes', page: 'themes', csrf, badges, notice, body });
}

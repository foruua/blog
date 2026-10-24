import { csrfField, esc } from '../../util/text.js';
import { adminLayout } from '../layout.js';
import { PALETTES, HERO_MAX } from '../../settings.js';
import { TLS_MODES, TLS_LABEL } from '../../mail.js';
import { pickerDialog } from './picker.js';

export function systemPage({ mail = {}, hero = {}, site = {}, history = {}, csrf, notice = '', badges, unsub = 0 }) {


  const paletteOptions = PALETTES
    .map((p) => `<option value="${esc(p.key)}"${p.key === (site.palette ?? '') ? ' selected' : ''}>${esc(p.name)}</option>`)
    .join('\n            ');

  // 首页轮播图列表：缩略图一行排开，图下编号、第一张标「封面」，末尾一枚虚线「添加」格；点保存才生效。首屏（JS 没跑时）类名与 data-* 要与 admin.js 的 tile() 逐字一致。
  const heroItems = hero.images.map((im, i) => {
    const dim = /^\d+$/.test(String(im.w ?? '')) && /^\d+$/.test(String(im.h ?? ''))
      ? ` width="${im.w}" height="${im.h}"` : '';
    const shot = `<img class="a-hero-shot" decoding="async" draggable="false" src="${esc(im.thumbnail || im.path)}" alt=""${dim}>`;
    return `        <figure class="a-hero-item" draggable="true" data-path="${esc(im.path)}" title="拖动排序">
          ${shot}
          <figcaption class="a-hero-cap">
            <span class="a-hero-grip" aria-hidden="true"></span>
            <span class="a-hero-idx">${String(i + 1).padStart(2, '0')}</span>
            ${i === 0 ? '<em>封面</em>' : ''}
            <span class="a-hero-move">
              <button type="button" class="a-hero-nudge" data-hero-move="-1"
                      aria-label="上移第 ${i + 1} 项"${i === 0 ? ' disabled' : ''}>↑</button>
              <button type="button" class="a-hero-nudge" data-hero-move="1"
                      aria-label="下移第 ${i + 1} 项"${i === hero.images.length - 1 ? ' disabled' : ''}>↓</button>
            </span>
          </figcaption>
          <button type="button" class="a-hero-x" data-hero-remove="${esc(im.path)}"
                  title="从列表移除第 ${i + 1} 项" aria-label="从列表移除第 ${i + 1} 项">×</button>
        </figure>`;
  }).join('\n');

  const heroAdd = hero.images.length >= HERO_MAX ? '' : `        <button type="button" class="a-hero-add" id="heroPick"${hero.images.length ? '' : ' data-wide="1"'}>
          <span class="a-hero-add-plus" aria-hidden="true">＋</span><span class="a-hero-add-txt">添加图片</span>
        </button>`;
  // data-thumbs 给 JS「路径 → 预览图」对照。整段 JSON 一次 esc：结构引号在属性值里也必须转义，否则属性会被截断。
  const heroThumbs = esc(JSON.stringify(Object.fromEntries(hero.images.map((im) => [im.path, im.thumbnail || '']))));
  const heroValue = JSON.stringify(hero.images.map(({ path, w, h }) => ({ path, w, h })));
  const heroSection = `    <h2 class="a-h2">首页封面</h2>
    <div class="a-card a-panel">
    <form method="post" action="/admin/hero" id="heroForm">
      ${csrfField(csrf)}
      <div class="a-hero-list${hero.images.length ? '' : ' is-empty'}" id="heroList" style="--hero-ar: 16 / 9">
${hero.images.length ? heroItems + '\n' : ''}${heroAdd}
      </div>
      <div class="a-hero-mode" id="heroModeRow"${hero.images.length > 1 ? '' : ' hidden'}>
        <label for="heroMode">轮播方式</label>
        <select class="a-select" id="heroMode" name="mode">
          <option value="manual"${hero.mode !== 'auto' ? ' selected' : ''}>手动切换</option>
          <option value="auto"${hero.mode === 'auto' ? ' selected' : ''}>自动轮播</option>
        </select>
      </div>
      <input type="hidden" id="heroImages" name="images" value="${esc(heroValue)}" data-thumbs="${heroThumbs}">
      <div class="a-actions">
        <button type="submit" class="a-btn">保存</button>
        <span class="a-dim" id="heroState" role="status" aria-live="polite"></span>
        <button type="submit" class="a-btn-danger" id="heroX" formaction="/admin/hero/clear"
                title="移除全部首页封面（文件保留在媒体库）" aria-label="移除全部首页封面"
                data-modal-title="移除全部首页封面？"
                data-modal-body="首页会回到显示站名。"
                data-modal-note="只移除首页展示，图片仍保留在媒体库和正文中。"
                data-modal-ok="全部移除"
                ${hero.images.length ? '' : 'hidden'}>全部移除</button>
      </div>
      <input type="file" id="heroFile" accept="image/png,image/jpeg,image/gif,image/webp" multiple hidden>
    </form>
    </div>`;

  const presets = mail.presets ?? [];
  const matched = presets.find((p) => p.host && p.host === (mail.host ?? ''))?.id ?? 'custom';
  const options = presets.map((p) => `<option value="${esc(p.id)}" data-host="${esc(p.host)}" data-port="${p.port}"`
    + ` data-tls="${esc(p.tls)}"${p.id === matched ? ' selected' : ''}>${esc(p.label)}</option>`).join('\n            ');
  const queue = mail.queue ?? null;
  const queueBlock = queue ? `    <div class="a-dim a-unsub">
      <span>发信队列：待发 <b>${queue.pending}</b> · 失败 <b>${queue.failed}</b> · 最近 1 小时 <b>${queue.sentLastHour}</b> / ${queue.maxPerHour}${queue.lastError ? ` · 最近错误：${esc(queue.lastError.message)}` : ''}</span>${queue.failed ? `
      <form method="post" action="/admin/mail/queue/retry" class="a-inline">
        ${csrfField(csrf)}
        <button type="submit" class="a-link">重试失败邮件</button>
      </form>` : ''}
    </div>` : '';

  // 内容维护：全站修订历史 + 旧链接（301 映射）一键清空。两者都是历史数据，清空后当前正文与评论不受影响。
  const historyRevisions = Number(history.revisions ?? 0);
  const historyAliases = Number(history.aliases ?? 0);
  const historySection = `    <h2 class="a-h2">内容维护</h2>
    <div class="a-card a-panel">
    <p class="a-dim">修订历史 <b>${historyRevisions}</b> 条 · 旧链接（301 映射）<b>${historyAliases}</b> 条。清空后旧地址不再跳转，也无法再回滚到历史版本。</p>
    <form method="post" action="/admin/history/clear">
      ${csrfField(csrf)}
      <div class="a-actions">
        <button type="submit" class="a-btn-danger" id="historyClear"
          data-modal-title="清空修订历史与旧链接？"
          data-modal-body="所有文章、笔记和固定页的修订快照，以及改名留下的 301 旧链接，都会被删除。"
          data-modal-note="删除后无法恢复，旧地址会直接返回 404；当前正文与评论不受影响。"
          data-modal-ok="全部清空"
          ${historyRevisions + historyAliases ? '' : 'hidden'}>清空修订历史与旧链接</button>
      </div>
    </form>
    </div>`;

  const tls = mail.tls ?? 'ssl';
  const tlsOptions = TLS_MODES
    .map((v) => `<option value="${v}"${tls === v ? ' selected' : ''}>${TLS_LABEL[v] ?? v}</option>`).join('\n            ');

  const body = `    <h2 class="a-h2 a-h2-first">站点与阅读</h2>
    <div class="a-card a-panel">
    <form method="post" action="/admin/settings">
      ${csrfField(csrf)}
      <div class="a-grid2">
        <div class="a-field">
          <label for="s-page">列表每页条数</label>
          <input class="a-input" id="s-page" name="pageSize" type="number" min="5" max="100" value="${esc(site.pageSize ?? 20)}">
        </div>
        <div class="a-field">
          <label for="s-recent">首页「最近更新」条数</label>
          <input class="a-input" id="s-recent" name="homeRecent" type="number" min="0" max="30" value="${esc(site.homeRecent ?? 10)}">
        </div>
        <div class="a-field">
          <label for="s-cpage">评论每页讨论串数</label>
          <input class="a-input" id="s-cpage" name="commentsPerPage" type="number" min="5" max="100" value="${esc(site.commentsPerPage ?? 20)}">
        </div>
        <div class="a-field">
          <label for="s-palette">访客默认配色</label>
          <select class="a-select" id="s-palette" name="palette">
            ${paletteOptions}
          </select>
        </div>
      </div>
      <div class="a-actions">
        <button type="submit" class="a-btn">保存</button>
      </div>
    </form>
    </div>

${heroSection}

    <h2 class="a-h2">邮件通知</h2>
    <div class="a-card a-panel">
    <form method="post" action="/admin/mail" data-timeout="120000">
      ${csrfField(csrf)}
      <input type="hidden" name="verify" value="1">
      <div class="a-grid2">
        <div class="a-field">
          <label for="m-preset">服务商</label>
          <select class="a-select" id="m-preset" data-mail-preset>
            ${options}
          </select>
        </div>
        <div class="a-field">
          <label for="m-tls">加密方式</label>
          <select class="a-select" id="m-tls" name="tls">
            ${tlsOptions}
          </select>
        </div>
      </div>
      <div class="a-grid2">
        <div class="a-field">
          <label for="m-host">SMTP 主机</label>
          <input class="a-input" id="m-host" name="host" value="${esc(mail.host ?? '')}" autocomplete="off" spellcheck="false">
        </div>
        <div class="a-field">
          <label for="m-port">端口</label>
          <input class="a-input" id="m-port" name="port" type="number" min="1" max="65535" value="${esc(mail.port ?? 465)}">
        </div>
      </div>
      <div class="a-field">
        <label for="m-user">账号</label>
        <input class="a-input" id="m-user" name="user" value="${esc(mail.user ?? '')}" autocomplete="off" spellcheck="false">
      </div>
      <div class="a-field">
        <label for="m-pass">密码 / 授权码</label>
        <input class="a-input" id="m-pass" name="pass" type="password" value="" autocomplete="new-password">
      </div>
      <div class="a-grid2">
        <div class="a-field">
          <label for="m-to">通知收件人</label>
          <input class="a-input" id="m-to" name="to" value="${esc(mail.to ?? '')}">
        </div>
        <div class="a-field">
          <label for="m-from">发信人显示名</label>
          <input class="a-input" id="m-from" name="from" value="${esc(mail.from ?? '')}">
        </div>
      </div>
      <div class="a-actions">
        <button type="submit" class="a-btn">保存</button>
        ${mail.source === 'page' ? `<button type="submit" class="a-btn-danger" formaction="/admin/mail/clear"
          data-modal-title="清除页面上的邮件配置？"
          data-modal-body="页面里存的 SMTP 主机、账号与授权码都会被清掉。"
          data-modal-note="清掉之后回落到环境变量（若配过），否则就是未配置状态。"
          data-modal-ok="清除邮件配置">清除页面配置</button>` : ''}
      </div>
    </form>
    <div class="a-dim a-unsub">
      <span>已退订回复提醒：<b>${unsub}</b> 个邮箱${unsub ? '（只记指纹，邮箱仍保留在评论区）' : ''}</span>${unsub ? `
      <form method="post" action="/admin/mail/unsub/clear" class="a-inline">
        ${csrfField(csrf)}
        <button type="submit" class="a-link"
                data-modal-title="清空退订名单？"
                data-modal-body="清空后这 ${unsub} 个邮箱会重新收到「有人回复了你的评论」的提醒。"
                data-modal-note="一般只在清理测试数据时用。"
                data-modal-ok="清空退订名单">清空名单</button>
      </form>` : ''}
    </div>
${queueBlock}
    </div>

${historySection}

${pickerDialog({ title: '从媒体库选择' })}`;

  return adminLayout({ title: '设置', active: 'system', csrf, notice, badges, body });
}

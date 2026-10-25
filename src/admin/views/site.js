import { esc, csrfField } from '../../util/text.js';
import { IDENTITY_MAX } from '../../site/identity.js';
import { COPY_MAX, FOOTER_LINK_MAX, FOOTER_TEXT_MAX } from '../../site/copy.js';
import { NAV_GROUP_LABEL, NAV_GROUPS, NAV_MAX, BUILTIN_KEYS } from '../../site/nav.js';
import { COMMENT_RATE_RANGE } from '../../settings.js';

// 设置页新增的几块表单：站点身份 / 导航菜单 / 页脚与社交 / 页面文案 / 站点图标 / 评论 / 账号安全。
// 拆在这里而不是继续堆进 system.js：那一份已经两百多行，再加七块会变成没人愿意改的长文件。
// 每块都是独立 <form>：改站名不该连带把导航顺序一起提交。

const field = (id, label, input, hint = '') => `        <div class="a-field">
          <label for="${id}">${label}</label>
          ${input}${hint ? `\n          <p class="a-dim">${hint}</p>` : ''}
        </div>`;

const text = (id, name, value, maxlength, placeholder = '') => `<input class="a-input" id="${id}" name="${name}" type="text"
                 maxlength="${maxlength}" value="${esc(value ?? '')}"${placeholder ? ` placeholder="${esc(placeholder)}"` : ''} autocomplete="off">`;

const saveRow = (extra = '') => `      <div class="a-actions">
        <button type="submit" class="a-btn">保存</button>${extra}
      </div>`;

/** 站点身份：站名 / 简介 / 作者 / 邮箱 / 印章字 / 备案号 / 语言。地址与域名不在这里——见卡片下的说明。 */
export function identitySection({ identity, env, csrf }) {
  return `    <h2 class="a-h2 a-h2-first">站点身份</h2>
    <div class="a-card a-panel">
    <form method="post" action="/admin/site/identity">
      ${csrfField(csrf)}
      <div class="a-grid2">
${field('i-title', '站名', text('i-title', 'title', identity.title, IDENTITY_MAX.title, env.title || '留空则显示域名'), '显示在页头、标题后缀与 RSS/sitemap、通知邮件里。')}
${field('i-mark', '印章字', text('i-mark', 'mark', identity.mark, IDENTITY_MAX.mark, env.mark), '首页封面顶上那行小字，留空则不显示。')}
      </div>
${field('i-desc', '站点简介', text('i-desc', 'desc', identity.desc, IDENTITY_MAX.desc, env.desc), '首页/列表页的 description 与分享摘要，一句话说清这个站写什么。')}
      <div class="a-grid2">
${field('i-author', '作者', text('i-author', 'author', identity.author, IDENTITY_MAX.author, env.author), '页脚版权行与「博主」默认署名。')}
${field('i-email', '博主邮箱', text('i-email', 'email', identity.email, IDENTITY_MAX.email, 'you@example.com'), '只用来给你的回复算 Gravatar 头像，不写进评论、不发信。')}
      </div>
      <div class="a-grid2">
${field('i-icp', '备案号', text('i-icp', 'icp', identity.icp, IDENTITY_MAX.icp, env.icp), '页脚那一行，留空则不显示。')}
${field('i-lang', '语言标记', text('i-lang', 'lang', identity.lang, IDENTITY_MAX.lang, 'zh-CN'), '写进 &lt;html lang&gt;、RSS 与分享卡片，形如 zh-CN / en / ja。')}
      </div>
${saveRow('        <span class="a-dim">网址与域名来自环境变量（SITE_URL / SITE_DOMAIN），不在此处改。</span>')}
    </form>
    </div>`;
}

/** 一条导航项。顺序靠行内 ↑↓ 按钮整表提交，不依赖 JS——禁用脚本时也能调。 */
function navRow(item, i, total) {
  const idx = String(i + 1).padStart(2, '0');
  const groupOptions = NAV_GROUPS
    .map((group) => `<option value="${group}"${item.group === group ? ' selected' : ''}>${NAV_GROUP_LABEL[group]}</option>`)
    .join('');
  // 来源标签：内置项改不了地址（只能隐藏），固定页跟着内容走，外链条目可以删。三者在界面上要能分辨，
  // 否则站主会疑惑「为什么这一行没有删除按钮」。
  const kindLabel = item.custom ? '外链' : (BUILTIN_KEYS.has(item.key) ? '内置' : '固定页');
  return `        <div class="a-navrow${item.show ? '' : ' is-off'}">
          <input type="hidden" name="key[${i}]" value="${esc(item.key)}">
          <input type="hidden" name="href[${i}]" value="${esc(item.href ?? '')}">
          <span class="a-navrow-idx" aria-hidden="true">${idx}</span>
          <input class="a-input a-navrow-label" type="text" name="label[${i}]" value="${esc(item.label)}"
                 maxlength="20" aria-label="第 ${i + 1} 项的名称" required>
          <select class="a-select a-navrow-group" name="group[${i}]" aria-label="第 ${i + 1} 项的位置">${groupOptions}</select>
          <label class="a-check a-navrow-show"><input type="checkbox" name="show[${i}]" value="1"${item.show ? ' checked' : ''}><span>显示</span></label>
          <span class="a-navrow-move">
            <button type="submit" class="a-iconbtn" name="move" value="${i}:-1" aria-label="上移第 ${i + 1} 项"${i === 0 ? ' disabled' : ''}>↑</button>
            <button type="submit" class="a-iconbtn" name="move" value="${i}:1" aria-label="下移第 ${i + 1} 项"${i === total - 1 ? ' disabled' : ''}>↓</button>
          </span>
          ${item.custom
    ? `<button type="submit" class="a-iconbtn a-iconbtn-x" name="remove" value="${esc(item.key)}"
                     aria-label="删除「${esc(item.label)}」" title="删除这条外链">×</button>`
    : `<span class="a-navrow-kind">${kindLabel}</span>`}
        </div>`;
}

/** 导航菜单：改名、换位置、临时藏起来、加一条站外链接。固定页自动出现在末尾，不必手动同步。 */
export function navSection({ nav, csrf }) {
  const rows = nav.items.map((item, i) => navRow(item, i, nav.items.length)).join('\n');
  return `    <h2 class="a-h2">导航菜单</h2>
    <div class="a-card a-panel">
    <p class="a-dim">顺序即显示顺序。藏在「显示」里不勾的项仍保留在列表中，随时能点回来。固定页会自动追加在末尾。</p>
    <form method="post" action="/admin/site/nav">
      ${csrfField(csrf)}
      <div class="a-nav">
${rows || '        <p class="a-empty">还没有导航项。</p>'}
      </div>

      <div class="a-navadd">
        <p class="a-navadd-title">加一条外链</p>
        <div class="a-navadd-row">
          <input class="a-input" type="text" name="newLabel" maxlength="20" placeholder="名称，如 GitHub" aria-label="新链接名称" autocomplete="off">
          <input class="a-input" type="text" name="newHref" maxlength="300" placeholder="https://…" aria-label="新链接地址" autocomplete="off" spellcheck="false">
          <select class="a-select" name="newGroup" aria-label="新链接位置">
            ${NAV_GROUPS.map((group) => `<option value="${group}">${NAV_GROUP_LABEL[group]}</option>`).join('')}
          </select>
        </div>
        <p class="a-dim">最多 ${NAV_MAX} 项，只支持 http(s):// 与 mailto:。填好名称和地址后点下面的保存。</p>
      </div>

      <div class="a-field">
        <label for="navMore">「页面」下拉的名称</label>
        <input class="a-input" id="navMore" name="moreLabel" type="text" maxlength="8" value="${esc(nav.moreLabel)}" autocomplete="off">
        <p class="a-dim">二级项收进这一个下拉里；一个二级项都没有时它会自动消失。</p>
      </div>
${saveRow()}
    </form>
    </div>`;
}

/** 页脚与社交：一句自述 + 最多六条站外链接。 */
export function footerSection({ footer, csrf }) {
  const rows = Math.min(FOOTER_LINK_MAX, Math.max(3, footer.links.length + 1));
  const links = Array.from({ length: rows }, (_, i) => {
    const link = footer.links[i] ?? { label: '', href: '' };
    return `        <div class="a-linkrow">
          <input class="a-input" type="text" name="linkLabel${i}" value="${esc(link.label)}" maxlength="24"
                 placeholder="名称" aria-label="第 ${i + 1} 条链接的名称" autocomplete="off">
          <input class="a-input" type="text" name="linkHref${i}" value="${esc(link.href)}" maxlength="300"
                 placeholder="https://… 或 mailto:…" aria-label="第 ${i + 1} 条链接的地址" autocomplete="off" spellcheck="false">
        </div>`;
  }).join('\n');

  return `    <h2 class="a-h2">页脚与社交</h2>
    <div class="a-card a-panel">
    <form method="post" action="/admin/site/footer">
      ${csrfField(csrf)}
      <div class="a-field">
        <label for="f-text">页脚文案</label>
        <input class="a-input" id="f-text" name="footerText" type="text" maxlength="${FOOTER_TEXT_MAX}"
               value="${esc(footer.text)}" placeholder="例如：一手写代码，一手写字。" autocomplete="off">
        <p class="a-dim">排在 © 年号与备案号下面的一行小字，留空则不显示。</p>
      </div>
      <div class="a-field">
        <label>社交链接</label>
${links}
        <p class="a-dim">名称和地址都填了才会显示；留空的行直接忽略。站外链接一律 nofollow noopener。</p>
      </div>
${saveRow()}
    </form>
    </div>`;
}

/** 页面文案：首页统计行的量词、列表页刊头。字段少而固定，不做成整站文案系统。 */
export function copySection({ copy, csrf }) {
  return `    <h2 class="a-h2">页面文案</h2>
    <div class="a-card a-panel">
    <form method="post" action="/admin/site/copy">
      ${csrfField(csrf)}
      <div class="a-grid2">
${field('c-hposts', '首页「文章」量词', text('c-hposts', 'heroPosts', copy.heroPosts, COPY_MAX.word), '首页会渲染成「12 篇文章」，这里只填后三个字。')}
${field('c-hnotes', '首页「笔记」量词', text('c-hnotes', 'heroNotes', copy.heroNotes, COPY_MAX.word), '同理「12 篇笔记」。')}
      </div>
      <div class="a-grid2">
${field('c-recent', '「最近更新」标题', text('c-recent', 'recent', copy.recent, COPY_MAX.heading))}
${field('c-ptitle', '文章页标题', text('c-ptitle', 'postsTitle', copy.postsTitle, COPY_MAX.title), '同时用作导航默认名与「更早的文章」。')}
      </div>
${field('c-pdesc', '文章页简介', text('c-pdesc', 'postsDesc', copy.postsDesc, COPY_MAX.desc), '写进 description 与分享摘要。')}
      <div class="a-grid2">
${field('c-ntitle', '笔记页标题', text('c-ntitle', 'notesTitle', copy.notesTitle, COPY_MAX.title))}
      </div>
${field('c-ndesc', '笔记页简介', text('c-ndesc', 'notesDesc', copy.notesDesc, COPY_MAX.desc))}
${saveRow()}
    </form>
    </div>`;
}

/** 站点图标：一张方形源图生成全套，一张 1200×630 当分享图。 */
export function iconsSection({ icons = {}, csrf }) {
  // 这函数也可能被测试直接调用（只关心别的区块），故每个字段都给兜底，别让「没传图标状态」变成 500。
  const preview = icons.preview ?? {};
  const src = (value, fallback) => esc(value || fallback);
  const shot = (url, label) => `        <figure class="a-icprev">
          <img src="${url}" alt="" width="64" height="64" loading="lazy" decoding="async">
          <figcaption>${esc(label)}</figcaption>
        </figure>`;
  return `    <h2 class="a-h2">站点图标</h2>
    <div class="a-card a-panel">
    <div class="a-icrow">
${shot(src(preview.icon, '/icon-192.png'), '标签页图标')}
${shot(src(preview.apple, '/apple-touch-icon.png'), '主屏图标')}
${icons.custom?.icon ? '<span class="a-dim">用的是你上传的图</span>' : '<span class="a-dim">出厂图标</span>'}
    </div>
    <form method="post" action="/admin/site/icons" enctype="multipart/form-data">
      ${csrfField(csrf)}
      <div class="a-field">
        <label for="ic-file">方形图标</label>
        <input class="a-input" id="ic-file" name="icon" type="file" accept="image/png,image/jpeg,image/webp" required>
        <p class="a-dim">最短边 ≥ 180px。非正方形会从中间裁成正方形——别传横版 logo。会同时生成 512/192/32、Android maskable 与 Apple 五档。</p>
      </div>
      <div class="a-actions"><button type="submit" class="a-btn">上传图标</button></div>
    </form>

    <div class="a-field a-icog">
      <img class="a-ogshot" src="${src(preview.og, '/og-default.jpg')}" alt="" width="240" height="126" loading="lazy" decoding="async">
      <span class="a-dim">当前分享图（无首图的文章用它）</span>
    </div>
    <form method="post" action="/admin/site/og" enctype="multipart/form-data">
      ${csrfField(csrf)}
      <div class="a-field">
        <label for="og-file">分享图</label>
        <input class="a-input" id="og-file" name="og" type="file" accept="image/png,image/jpeg,image/webp" required>
        <p class="a-dim">按 1200×630 居中裁切，转成 JPG。写一张带站名的图就够了。</p>
      </div>
      <div class="a-actions">
        <button type="submit" class="a-btn">上传分享图</button>
      </div>
    </form>

    <form method="post" action="/admin/site/icons/clear">
      ${csrfField(csrf)}
      <div class="a-actions">
        <button type="submit" class="a-btn-danger"
                data-modal-title="恢复出厂图标？"
                data-modal-body="上传的图标与分享图都会被删除，前台回到 public/ 里自带的那一套。"
                data-modal-note="删除后原始图片不可恢复，需要重新上传。"
                data-modal-ok="恢复出厂"
                ${icons.anyCustom ? '' : 'hidden'}>恢复出厂图标</button>      </div>
    </form>
    </div>`;
}

/** 评论：三个开关。反机器人参数（最短填写时间、蜜罐）不放在这里——调松了就是关防护。 */
export function commentsSection({ comments = {}, csrf }) {
  // 直接调用本函数（测试）时可能没传 state：限流格用默认值兜底，别把 undefined 写进 value。
  const rate = Number.isFinite(Number(comments.rate)) ? Number(comments.rate) : COMMENT_RATE_RANGE.fallback;
  return `    <h2 class="a-h2">评论</h2>
    <div class="a-card a-panel">
    <form method="post" action="/admin/site/comments">
      ${csrfField(csrf)}
      <div class="a-field a-field-checks">
        <label class="a-check"><input type="checkbox" name="open" value="1"${comments.open ? ' checked' : ''}> <span>允许访客发表评论</span></label>
        <p class="a-dim">关掉后全站收起撰写框，已有讨论照常显示，直接 POST 也会被拒。单篇的开关仍在编辑器里。</p>
        <label class="a-check"><input type="checkbox" name="moderateAll" value="1"${comments.moderateAll ? ' checked' : ''}> <span>所有新评论都先审核（含老读者）</span></label>
        <p class="a-dim">默认只审第一次来的访客；勾上后连留过言的读者也要过一遍。</p>
      </div>
      <div class="a-field">
        <label for="cm-rate">每 10 分钟每个来源最多几条</label>
        <input class="a-input" id="cm-rate" name="rate" type="number" min="${COMMENT_RATE_RANGE.min}" max="${COMMENT_RATE_RANGE.max}"
               value="${rate}">
        <p class="a-dim">按访问者地址计数，${COMMENT_RATE_RANGE.min}—${COMMENT_RATE_RANGE.max} 之间。调太松等于不设防。</p>
      </div>
${saveRow()}
    </form>
    </div>`;
}

/** 账号安全：改密码。原先只能 ssh 上去跑 npm run set-password。 */
export function accountSection({ csrf, configured }) {
  if (!configured) {
    return `    <h2 class="a-h2">账号安全</h2>
    <div class="a-card a-panel">
      <p class="a-dim">还没有设置后台密码。请在服务器上运行 <code>npm run set-password</code> 设一次，之后就能在这里改。</p>
    </div>`;
  }
  const pw = (id, name, label, ac) => `        <div class="a-field">
          <label for="${id}">${label}</label>
          <input class="a-input" id="${id}" name="${name}" type="password" autocomplete="${ac}" required>
        </div>`;
  return `    <h2 class="a-h2">账号安全</h2>
    <div class="a-card a-panel">
    <form method="post" action="/admin/password">
      ${csrfField(csrf)}
${pw('pw-cur', 'current', '当前密码', 'current-password')}
      <div class="a-grid2">
${pw('pw-new', 'next', '新密码', 'new-password')}
${pw('pw-again', 'confirm', '再输一次', 'new-password')}
      </div>
      <p class="a-dim">至少 8 位。改完之后其它设备上的登录会立即失效，当前这台保持登录。</p>
${saveRow()}
    </form>
    </div>`;
}

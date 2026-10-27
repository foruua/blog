import { esc, csrfField } from '../../util/text.js';
import { IDENTITY_MAX } from '../../site/identity.js';
import { NAV_GROUP_LABEL, NAV_GROUPS, BUILTIN_KEYS, NAV_LABEL_MAX, NAV_MORE_LABEL_MAX, LINK_HREF_MAX } from '../../site/nav.js';
import { COMMENT_RATE_RANGE } from '../../settings.js';

// 设置页新增的几块表单：站点身份 / 导航菜单 / 评论 / 账号安全。
// 拆在这里而不是继续堆进 system.js：那一份已经两百多行，再多几块会变成没人愿意改的长文件。
// 每块都是独立 <form>：改站名不该连带把导航顺序一起提交。
//
// 只留字段名与按钮，不写解释性小字：这些项本身就是自解释的（站名就是站名），
// 一屏十来个提示句只会把表单撑成说明书。唯一例外是「加一条外链」——三个输入框需要一句话说明它们是一组。

const field = (id, label, input) => `        <div class="a-field">
          <label for="${id}">${label}</label>
          ${input}
        </div>`;

const text = (id, name, value, maxlength) => `<input class="a-input" id="${id}" name="${name}" type="text"
                 maxlength="${maxlength}" value="${esc(value ?? '')}" autocomplete="off">`;

const saveRow = () => `      <div class="a-actions">
        <button type="submit" class="a-btn">保存</button>
      </div>`;

/** 站点身份：站名 / 简介 / 作者 / 邮箱 / 印章字 / 备案号 / 语言。 */
export function identitySection({ identity, csrf }) {
  return `    <h2 class="a-h2 a-h2-first">站点身份</h2>
    <div class="a-card a-panel">
    <form method="post" action="/admin/site/identity">
      ${csrfField(csrf)}
      <div class="a-grid2">
${field('i-title', '站名', text('i-title', 'title', identity.title, IDENTITY_MAX.title))}
${field('i-mark', '印章字', text('i-mark', 'mark', identity.mark, IDENTITY_MAX.mark))}
      </div>
${field('i-desc', '站点简介', text('i-desc', 'desc', identity.desc, IDENTITY_MAX.desc))}
      <div class="a-grid2">
${field('i-author', '作者', text('i-author', 'author', identity.author, IDENTITY_MAX.author))}
${field('i-email', '博主邮箱', text('i-email', 'email', identity.email, IDENTITY_MAX.email))}
      </div>
      <div class="a-grid2">
${field('i-icp', '备案号', text('i-icp', 'icp', identity.icp, IDENTITY_MAX.icp))}
${field('i-lang', '语言标记', text('i-lang', 'lang', identity.lang, IDENTITY_MAX.lang))}
      </div>
${field('i-police', '公安备案号', text('i-police', 'police', identity.police, IDENTITY_MAX.police))}
${saveRow()}
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
                 maxlength="${NAV_LABEL_MAX}" aria-label="第 ${i + 1} 项的名称" required>
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
    <form method="post" action="/admin/site/nav">
      ${csrfField(csrf)}
      <div class="a-nav">
${rows || '        <p class="a-empty">还没有导航项。</p>'}
      </div>

      <div class="a-navadd">
        <p class="a-navadd-title">加一条外链</p>
        <div class="a-navadd-row">
          <div class="a-mini">
            <label for="navNewLabel">名称</label>
            <input class="a-input" id="navNewLabel" type="text" name="newLabel" maxlength="${NAV_LABEL_MAX}" autocomplete="off">
          </div>
          <div class="a-mini">
            <label for="navNewHref">地址</label>
            <input class="a-input" id="navNewHref" type="text" name="newHref" maxlength="${LINK_HREF_MAX}" autocomplete="off" spellcheck="false">
          </div>
          <div class="a-mini">
            <label for="navNewGroup">位置</label>
            <select class="a-select" id="navNewGroup" name="newGroup">
              ${NAV_GROUPS.map((group) => `<option value="${group}">${NAV_GROUP_LABEL[group]}</option>`).join('')}
            </select>
          </div>
        </div>
      </div>

      <div class="a-field">
        <label for="navMore">「页面」下拉的名称</label>
        <input class="a-input" id="navMore" name="moreLabel" type="text" maxlength="${NAV_MORE_LABEL_MAX}" value="${esc(nav.moreLabel)}" autocomplete="off">
      </div>
${saveRow()}
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
        <label class="a-check"><input type="checkbox" name="moderateAll" value="1"${comments.moderateAll ? ' checked' : ''}> <span>所有新评论都先审核</span></label>
      </div>
      <div class="a-field">
        <label for="cm-rate">每 10 分钟每个来源最多几条</label>
        <input class="a-input" id="cm-rate" name="rate" type="number" min="${COMMENT_RATE_RANGE.min}" max="${COMMENT_RATE_RANGE.max}"
               value="${rate}">
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
      <p class="a-dim">请在服务器上运行 <code>npm run set-password</code> 设置后台密码。</p>
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
${saveRow()}
    </form>
    </div>`;
}

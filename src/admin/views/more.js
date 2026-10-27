import { SITE } from '../../config.js';
import { csrfField, esc } from '../../util/text.js';
import { adminIcon, adminLayout } from '../layout.js';

// 手机底部标签的第四格：友圈/友链/设置这三个"不常驻"的入口，加上看站点与退出。
// 桌面端没有这一格（左侧导航已经全列出来），但路由仍可访问，避免手机上出现只在桌面存在的页面。

const row = ({ href, icon, title, desc, count = null, external = false }) => `<a class="a-more-row" href="${esc(href)}"${external ? ' target="_blank" rel="noopener"' : ''}>
        <span class="a-more-ic" aria-hidden="true">${adminIcon(icon)}</span>
        <span class="a-more-t"><b>${esc(title)}</b>${desc ? `<small>${esc(desc)}</small>` : ''}</span>
        ${count == null ? '' : `<span class="a-more-n">${esc(count)}</span>`}
        ${external ? '<span class="a-more-out" aria-hidden="true">↗</span>' : '<span class="a-more-chev" aria-hidden="true">›</span>'}
      </a>`;

export function morePage({ csrf, badges = {}, feedStats = null, linkStats = null }) {
  const site = [
    feedStats
      ? row({ href: '/admin/feeds', icon: 'feeds', title: '友圈', desc: `${feedStats.sources} 个源 · 抓取与订阅` })
      : '',
    linkStats
      ? row({ href: '/admin/links', icon: 'links', title: '友链', desc: `${linkStats.total} 个站 · 检查与隐藏` })
      : '',
    row({ href: '/admin/themes', icon: 'themes', title: '外观', desc: '主题安装、切换与主题设置' }),
    row({ href: '/admin/system', icon: 'system', title: '设置', desc: '站点身份、导航与邮件' }),
  ].filter(Boolean).join('\n');

  const body = `    <div class="a-more">
      <p class="a-more-label">站点</p>
      <div class="a-more-group">
${site}
      </div>

      <p class="a-more-label">账号</p>
      <div class="a-more-group">
        ${row({ href: '/', icon: 'site', title: '看站点', desc: SITE.url.replace(/^https?:\/\//, ''), external: true })}
        <form method="post" action="/admin/logout">
          ${csrfField(csrf)}
          <button type="submit" class="a-more-row a-more-button">
            <span class="a-more-ic" aria-hidden="true">${adminIcon('out')}</span>
            <span class="a-more-t"><b>退出登录</b><small>下次需要重新输入密码</small></span>
            <span class="a-more-chev" aria-hidden="true">›</span>
          </button>
        </form>
      </div>

      <p class="a-more-foot">${esc(SITE.identity)} · 写作者的控制台</p>
    </div>`;

  return adminLayout({ title: '更多', sub: '站点与账号', active: 'more', csrf, badges, body });
}

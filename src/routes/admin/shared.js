import { esc } from '../../util/text.js';
import { adminLayout } from '../../admin/layout.js';
import { decryptEmail } from '../../auth.js';


export { externalWrite } from '../../util/external-writes.js';



// 请求体解析：缓存到上下文——guard 校验 CSRF 已读过一次，路由里再读会拿到空对象。
export { readBody as bodyOf } from '../../util/http.js';

export const val = (b, k, fallback = '') => {
  if (b instanceof FormData) { const v = b.get(k); return v == null || typeof v !== 'string' ? fallback : v; }
  return b?.[k] == null ? fallback : String(b[k]);
};

// 正文行尾在入口收敛为 LF：浏览器 FormData 会把 textarea 换行转成 CRLF，原样落盘让整篇 diff 漂移；写入层逐字保留正文，故只在入口归一化。
export const formBody = (b) => val(b, 'body').replace(/\r\n?/g, '\n');

export const checked = (b, k) => {
  const v = b instanceof FormData ? b.get(k) : b?.[k];
  return v === true || v === 1 || v === '1' || v === 'on' || v === 'true';
};

// 页码：默认读 ?page=，也可指定参数名（评论页两个列表各带各的页码）。
// 夹取口径收敛在 util/http.js 的 pageParam()，公开列表页（/links）与后台共用同一份。
export { pageParam as pageNumber } from '../../util/http.js';

/** 列表页脚：一行工具栏（可选搜索框 + 翻页器）。opts：hidePager/hideSearch、status 状态筛选跟着翻页、param 页码参数名、label aria-label、preserve 别的列表页码跟着带下去——翻待审时别把最近评论那页踢回第一页。 */
export function pagination(base, page, hasMore, search = '', hint = '搜索标题或 slug', {
  hidePager = false, hideSearch = false, status = '', param = 'page', label = '分页', preserve = {},
} = {}) {
  const url = (n) => {
    const parts = [`${param}=${n}`];
    if (search) parts.push(`q=${encodeURIComponent(search)}`);
    if (status) parts.push(`status=${encodeURIComponent(status)}`);
    for (const [k, v] of Object.entries(preserve)) if (v && k !== param) parts.push(`${k}=${encodeURIComponent(v)}`);
    return `${base}?${parts.join('&')}`;
  };
  return `    <div class="a-toolbar">
      ${hideSearch ? '' : `<form method="get" action="${base}" class="a-search" role="search">
        <input class="a-input" name="q" value="${esc(search)}" placeholder="${esc(hint)}" aria-label="搜索">
        <button class="a-btn-ghost" type="submit">搜索</button>
      </form>`}
      ${hidePager ? '' : `<nav class="a-pager" aria-label="${esc(label)}">
        ${page > 1 ? `<a class="a-pager-btn" href="${esc(url(page - 1))}">上一页</a>` : '<span class="a-pager-btn is-off">上一页</span>'}
        <span class="a-pager-now">第 ${page} 页</span>
        ${hasMore ? `<a class="a-pager-btn" href="${esc(url(page + 1))}">下一页</a>` : '<span class="a-pager-btn is-off">下一页</span>'}
      </nav>`}
    </div>`;
}


export function makeShared({ auth, adminRepo, crypt }) {
  return {

    ctx: (c, extra = {}) => ({
      csrf: auth.csrfOf(c),
      badges: { comments: (extra.commentCounts ?? adminRepo.commentCounts()).pending ?? 0 },
      ...extra,
    }),
    // 评论人邮箱只以密文落库（明文不存），后台要显示就在此解出。
    withEmail: (rows) => rows.map((r) => ({ ...r, email: decryptEmail(crypt, r.email_enc) })),
  };
}


export const notice = (c, path, msg) => c.redirect(`${path}?w=${encodeURIComponent(msg)}`, 303);

// 后台「找不到」页：各路由组 404 页除措辞/标题外一致；文案按纯文本转义，调用方不拼 HTML。
export const notFoundPage = (c, ctx, message, title = '不存在') => c.html(
  adminLayout({ title, ...ctx(c), body: `<p class="a-empty">${esc(message)}</p>` }), 404,
);

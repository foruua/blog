import { previewSrcsetOf, previewSourceOf } from '../../media/variants.js';
import { isVideoSource } from '../../media/video.js';
import { csrfField, esc } from '../../util/text.js';
import { adminLayout } from '../layout.js';

// 媒体库显示「上传时那份原件」的大小，而非 sharp 重编码后的体积（通常更小，见 media/image.js）。老记录（022 前）没有原图大小，退回 bytes，好过显示「—」。
const sizeOf = (m) => m.original_bytes ?? m.bytes;
const isVideo = (m) => String(m.mime ?? '').startsWith('video/') || isVideoSource(m.path);
const dimensionOf = (m) => m.width && m.height ? `${m.width} × ${m.height}` : isVideo(m) ? '视频' : '尺寸未知';
const playBadge = '<span class="a-media-play" aria-hidden="true">▶</span>';

export function mediaPage({ pagination = '', items, stats, csrf, badges, heroPaths = [], notice = '', usage = new Map() }) {


  const heroSet = new Set(heroPaths);

  const nameOf = (m) => m.filename || m.path.split('/').pop();
  const copyIcon = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" aria-hidden="true"><rect x="8" y="8" width="12" height="12" rx="2"/><path d="M16 8V4H4v12h4"/></svg>';
  const trashIcon = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" aria-hidden="true"><path d="M4 7h16M9 7V4h6v3M6 7l1 13h10l1-13M10 11v5m4-5v5"/></svg>';
  const cells = items.map((m) => {
    const refs = usage.get(m.id)?.length ?? 0;
    const isHero = heroSet.has(m.path);
    const srcset = previewSrcsetOf(m);   // 同一次调用结果复用：以前连调两次，等于两次 JSON.parse + 拼串
    return `<figure class="a-media">
        <a class="a-media-shot" href="/admin/media/${m.id}" data-media-details aria-haspopup="dialog" aria-label="查看 ${esc(nameOf(m))} 的引用详情">
          ${isVideo(m)
            ? `<video src="${esc(m.path)}#t=0.1" muted playsinline preload="none" data-lazy-preload aria-hidden="true"></video>${playBadge}`
            : `<img src="${esc(previewSourceOf(m))}" alt="${esc(m.alt ?? '')}"${srcset ? ` srcset="${esc(srcset)}" sizes="auto, (max-width: 360px) calc(100vw - 32px), (max-width: 640px) calc((100vw - 44px) / 2), 260px"` : ''}${m.width > 0 && m.height > 0 ? ` width="${m.width}" height="${m.height}" style="aspect-ratio:${m.width}/${m.height}"` : ''} loading="lazy" decoding="async">`}
          ${isHero ? '<span class="a-media-flag">首页封面</span>' : ''}
        </a>
        <figcaption>
          <strong class="a-media-name" title="${esc(nameOf(m))}">${esc(nameOf(m))}</strong>
          <span class="a-media-meta">${dimensionOf(m)}<span>${sizeOf(m) ? `${Math.round(sizeOf(m) / 1024)} KB` : '—'}</span></span>
          <div class="a-media-actions">
            <a class="a-media-reference" href="/admin/media/${m.id}" data-media-details aria-haspopup="dialog"><span class="a-media-ref-lbl">引用<span class="a-media-ref-more">详情</span></span> <span class="a-media-ref-n">${refs}</span></a>
            <button class="a-media-icon" data-copy="${esc(m.path)}" title="复制路径" aria-label="复制 ${esc(nameOf(m))} 的路径" type="button">${copyIcon}</button>
            <a class="a-media-icon a-media-delete" href="/admin/media/delete/${m.id}" title="删除文件" aria-label="删除 ${esc(nameOf(m))}"
               data-modal-action="/admin/media/delete/${m.id}"
               data-modal-title="删除这个文件？"
               data-modal-body="${esc(nameOf(m))}"
               data-modal-note="文件会移到回收站${isHero ? '；请先更换或移除首页封面' : refs ? '；正文仍有引用，请先移除引用' : ''}。"
               data-modal-ok="删除文件"${isHero || refs ? ' data-modal-disabled="1"' : ''}>${trashIcon}</a>
          </div>
        </figcaption>
      </figure>`;
  }).join('\n');

  const body = `    <div class="a-media-grid">
${cells || '      <p class="a-empty">媒体库还是空的。</p>'}
    </div>${pagination}
    <dialog class="a-modal a-media-dialog" id="a-media-dialog" data-dismiss-outside aria-labelledby="a-media-dialog-title">
      <header class="a-media-dialog-head"><h2 id="a-media-dialog-title">引用详情</h2><button class="a-media-icon" type="button" data-media-close aria-label="关闭引用详情"><svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" aria-hidden="true"><path d="M4.4 4.4 11.6 11.6M11.6 4.4 4.4 11.6"/></svg></button></header>
      <div class="a-media-dialog-body" id="a-media-dialog-body"></div>
    </dialog>`;

  return adminLayout({
    title: '媒体', sub: `${stats.n} 个文件 · ${(stats.bytes / 1048576).toFixed(1)}MB`,
    active: 'media', csrf, badges, notice, body,
  });
}

export function mediaDeletePage({ item, isHero, usedBy = [], csrf, badges }) {
  const srcset = previewSrcsetOf(item, 1920);
  const usage = usedBy.length
    ? `      <p class="a-warn">正文里还在用它：${usedBy.map((p) => `<a href="/admin/edit/${p.id}">《${esc(p.title)}》</a>`).join('、')}。请先移除引用再删除。</p>`
    : '';
  const hero = isHero
    ? '      <p class="a-warn">这是当前首页封面。先去「设置 → 首页封面」换一张或点移除，再回来删它。</p>'
    : '';
  return adminLayout({
    title: '删除媒体', active: 'media', csrf, badges,
    actions: '<a class="a-back" href="/admin/media">← 取消，回媒体库</a>',
    body: `    <div class="a-card a-panel a-confirm">
      <p class="a-kicker">即将删除</p>
      <p class="a-notice a-notice-plain">${esc(item.filename || item.path)}</p>
      <div class="a-hero-preview">${isVideo(item)
        ? `<video controls preload="metadata" playsinline src="${esc(item.path)}" aria-label="${esc(item.filename || item.path)}"></video>`
        : `<img decoding="async" src="${esc(previewSourceOf(item, 960))}"${srcset ? ` srcset="${esc(srcset)}" sizes="(min-width: 700px) 480px, calc(100vw - 64px)"` : ''} alt=""${item.width > 0 && item.height > 0 ? ` width="${item.width}" height="${item.height}"` : ''}>`}</div>
      <p class="a-dim"><code>${esc(item.path)}</code>${item.width ? ` · ${item.width}×${item.height}` : ''}${sizeOf(item) ? ` · ${Math.round(sizeOf(item) / 1024)}KB` : ''}</p>
${hero}${usage}
      <form method="post" action="/admin/media/delete/${item.id}">
        ${csrfField(csrf)}
        <p class="a-actions"><button type="submit" class="a-btn-danger a-btn-danger-solid"${isHero || usedBy.length ? ' disabled' : ''}>确认删除</button></p>
      </form>
      <p class="a-dim">文件会移到 <code>data/.trash/uploads/</code>，不从磁盘上抹掉 —— 删错了把它搬回原路径、再在后台传一次同名文件就能复原。</p>
    </div>`,
  });
}

export function mediaDetailContent({ item, isHero, usedBy }) {
  const now = new Date().toISOString();
  const srcset = previewSrcsetOf(item, 1920);
  const state = (p) => p.missing_file ? '文件缺失' : p.draft ? '草稿' : p.published_at > now ? '定时发布' : '已发布';
  const kinds = { post: '文章', note: '笔记', page: '固定页' };
  return `<div class="a-media-detail">
      <div class="a-media-detail-top">
        ${isVideo(item)
          ? `<video class="a-media-detail-preview" controls preload="metadata" playsinline src="${esc(item.path)}" aria-label="${esc(item.filename || item.path)}"></video>`
          : `<a class="a-media-detail-preview" data-media-original href="${esc(item.path)}" target="_blank" rel="noopener" aria-label="查看完整原图"><img decoding="async" src="${esc(previewSourceOf(item, 960))}"${srcset ? ` srcset="${esc(srcset)}" sizes="(min-width: 700px) 480px, calc(100vw - 64px)"` : ''} alt="${esc(item.alt ?? '')}"${item.width > 0 && item.height > 0 ? ` width="${item.width}" height="${item.height}"` : ''}></a>`}
        <div class="a-media-detail-info"><p class="a-media-detail-name">${esc(item.filename || item.path)}</p>
          <p class="a-dim">${dimensionOf(item)}${sizeOf(item) ? ` · ${Math.round(sizeOf(item) / 1024)} KB` : ''}</p>
          <code>${esc(item.path)}</code><button class="a-btn-ghost" type="button" data-copy="${esc(item.path)}">复制路径</button></div>
      </div>
      <div class="a-media-ref-head"><h3>引用位置</h3><span>${usedBy.length} 篇正文${isHero ? ' · 首页封面' : ''}</span></div>
      <ul class="a-media-refs">
        ${isHero ? '<li><a href="/admin/system"><span><b>首页封面</b><small>到设置页更换</small></span><span aria-hidden="true">↗</span></a></li>' : ''}
        ${usedBy.map((p) => `<li><a href="/admin/edit/${p.id}"><span><b>${esc(p.title || '(无标题)')}</b><small>${esc(kinds[p.kind] ?? p.kind)} · ${state(p)}</small></span><span aria-hidden="true">↗</span></a></li>`).join('')}
      </ul>
      ${!usedBy.length ? '<p class="a-media-ref-empty">当前没有正文引用。</p>' : ''}
    </div>`;
}

export function mediaDetailPage({ item, isHero, usedBy, csrf, badges }) {
  return adminLayout({
    title: '媒体引用详情', active: 'media', csrf, badges,
    actions: '<a class="a-back" href="/admin/media">← 回媒体库</a>',
    body: `<div class="a-card a-panel">${mediaDetailContent({ item, isHero, usedBy })}</div>`,
  });
}

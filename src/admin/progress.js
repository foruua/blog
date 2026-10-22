/** 后台「批量活儿」的进度条（友圈「刷新全部」与友链「立即检查全部」共用）。两页只差类名/片段地址/量词；分两份写会改一处忘一处、客户端锚点在某一页失效。只管「正在跑」：没在跑时输出空壳（data-* 与片段地址还在，客户端只认这一个锚点），版面靠 CSS :empty 收掉。data-running="0" 必须留着：客户端靠它决定要不要再拉片段、按钮解不解禁。参数：cls / dataName / endpoint / meter / label / unit。 */
export const progressMarkup = (progress, { cls, dataName, endpoint, meter, label, unit }) => {
  const total = Math.max(0, Number(progress?.total) || 0);
  const completed = Math.min(total, Math.max(0, Number(progress?.completed) || 0));
  const running = Boolean(progress?.running);
  const attrs = `class="${cls}" data-${dataName}="${endpoint}"`
    + ` data-running="${running ? 1 : 0}" data-completed="${completed}" data-total="${total}"`;
  if (!running || total === 0) return `      <p ${attrs}></p>`;

  const pct = Math.round((completed / total) * 100);
  return `      <p ${attrs} role="status"><span>${label}：已完成 ${completed} / ${total} ${unit}</span>`
    + `<span class="${meter}" aria-hidden="true"><i style="width: ${pct}%"></i></span></p>`;
};

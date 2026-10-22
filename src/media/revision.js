// 媒体修订号 + 渲染器版本构成缓存失效键；图片信息变动时递增以触发存量正文重渲染。
export const MEDIA_REVISION_KEY = 'media_revision';

export const mediaRevision = (repo) => {
  const n = Number(repo.getSetting(MEDIA_REVISION_KEY) ?? 0);
  return Number.isInteger(n) && n >= 0 ? n : 0;
};

export function bumpMediaRevision(repo) {
  const next = mediaRevision(repo) + 1;
  repo.setSetting(MEDIA_REVISION_KEY, String(next));
  return next;
}

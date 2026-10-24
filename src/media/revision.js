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

// 裸 DatabaseSync 入口（运维脚本没有 repo 包装时用）：与 repo.setSetting 相同的 upsert 语义。
export function bumpMediaRevisionDb(db) {
  const current = Number(db.prepare('SELECT value FROM settings WHERE key = ?').get(MEDIA_REVISION_KEY)?.value ?? 0) || 0;
  const next = current + 1;
  db.prepare(`INSERT INTO settings(key,value) VALUES(?,?)
    ON CONFLICT(key) DO UPDATE SET value = excluded.value`).run(MEDIA_REVISION_KEY, String(next));
  return next;
}

// 页面/Feed 缓存修订号的唯一拼装口径。以前 html-cache 与 public.js 的 404 缓存各写一份，
// 一处漏掉媒体修订号、另一处漏掉主题签名，缓存就会在某个角落继续吐旧页面。
import { themeCacheStamp } from '../render/layout.js';
import { mediaRevision } from '../media/revision.js';

// 内容修订号的唯一读法：repo 可能为 null（后台/订阅模块允许不注入），故用可选调用。
export const contentRevisionOf = (repo) => String(repo?.contentStamp?.() ?? '');

/** HTML 页面缓存的修订号；withMedia=false 给不需要媒体变体的短缓存（如 404）用。 */
export const pageRevisionOf = (repo, { withMedia = true } = {}) =>
  `${contentRevisionOf(repo)}|${withMedia ? mediaRevision(repo) : ''}|${themeCacheStamp()}`;

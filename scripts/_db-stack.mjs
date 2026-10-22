// 隔离测试共用的「临时库 + 仓储」装配前置。这些模块读 src/config.js 环境变量，必须先设好 DATA_DIR/CONTENT_DIR 再加载：
// 调用方用 `await import()`，不能顶层静态 import（会被提升到赋值之前）。
export { open, close } from '../db/driver.js';
export { migrate } from '../db/migrate.js';
export { createRepo } from '../db/repo.js';
export { createAdminRepo } from '../db/admin.js';
export { createCommentRepo } from '../db/comments.js';
export { createCrypto } from '../src/auth.js';

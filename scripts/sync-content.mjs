import { acquireMaintenanceLock } from '../src/util/lock.js';
import { DB_FILE, CONTENT_DIR, UPLOADS_DIR } from '../src/config.js';
import { open, close } from '../db/driver.js';
import { migrate } from '../db/migrate.js';
import { createRepo } from '../db/repo.js';
import { createAdminRepo } from '../db/admin.js';
import { recoverWrites } from '../src/content/commit.js';
import { syncContent } from '../src/content/sync.js';
import { createRenderer } from '../src/render/markdown.js';
import { createImageInfo } from '../src/media/info.js';

const release = acquireMaintenanceLock([DB_FILE, CONTENT_DIR, UPLOADS_DIR], 'sync-content');
const db = open(DB_FILE);
try {
  migrate(db, { log() {} });
  const repo = createRepo(db);
  recoverWrites(repo);
  const renderer = createRenderer({ imageInfo: createImageInfo(createAdminRepo(db)) });
  const result = syncContent(repo, { renderer });
  if (result.errors.length) process.exitCode = 1;
} finally { close(db); release(); }

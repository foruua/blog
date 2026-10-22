import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

// 每套测试拥有全部资源的副本；不读取用户 .env，也不复用真实 content/uploads。
export async function createFixtures() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'blog-tests-'));
  const env = {
    BLOG_TEST_ROOT: root, DATA_DIR: path.join(root, 'data'), DB_FILE: path.join(root, 'data', 'blog.db'),
    CONTENT_DIR: path.join(root, 'content'), UPLOADS_DIR: path.join(root, 'uploads'),
    THEMES_DIR: path.join(root, 'themes'),
    BACKUP_DIR: path.join(root, 'data', 'backups'), ADMIN_PASSWORD: 'disposable-test-password',
    // 测试绝不能继承真实异地备份目标：备份 worker 会执行 `rsync --delete`，跑测试不该碰生产目录。
    BACKUP_REMOTE: '', BACKUP_HOOK: '',
    BACKUP_ON_PUBLISH: 'false', FEED_REFRESH_MS: '0', FEED_ALLOW_PRIVATE: 'false', TZ: 'Asia/Shanghai',
    // 反垃圾的“最小填表时间”只用于线上防机器人；测试里压到 200ms，既保留“太快提交被丢弃”的用例，
    // 又不必每个用例真等 3 秒（慢机器上 200ms 仍明显大于一次本地请求的耗时）。
    COMMENT_MIN_ELAPSED_MS: '200',
    // 友链可达性默认启动 40s 后首轮，久跑套件会拿真实站点发公网请求；测试期一律关掉（需它的套件自注入假 probe）。
    LINK_CHECK_MS: '0',
    // 评论头像默认服务端反代 Gravatar。测试里清空上游：套件不发公网请求，/avatar/<md5> 仍回合法图片（1×1 透明占位），
    // 标记/尺寸/alt 照样被 UI 审计量到；回源逻辑由 test-avatar.mjs 用假上游覆盖。
    AVATAR_UPSTREAMS: '',
  };
  Object.assign(process.env, env);
  const cleanup = () => fs.rmSync(root, { recursive: true, force: true });
  process.once('exit', cleanup);
  try {
    for (const sub of ['posts', 'notes', 'pages']) fs.mkdirSync(path.join(env.CONTENT_DIR, sub), { recursive: true });
    fs.mkdirSync(env.UPLOADS_DIR, { recursive: true });
    // 默认留空：既有套件继续走内置渲染兜底；主题套件会自己指定并填充 THEMES_DIR。
    fs.mkdirSync(env.THEMES_DIR, { recursive: true });
    for (let i = 0; i < 25; i++) {
      const slug = i === 0 ? 'why-single-column' : `fixture-${i}`;
      const title = i === 0 ? '为什么单栏是唯一正确的选择' : `示例文章 ${i}`;
      const date = i === 0 ? '2025-12-01' : `2025-01-${String(i + 1).padStart(2, '0')}`;
      fs.writeFileSync(path.join(env.CONTENT_DIR, 'posts', `${slug}.md`),
        `---\ntitle: ${title}\nslug: ${slug}\ndate: ${date}\n---\n## 示例标题\n\n${'示例正文用于测试完整渲染和无脚本阅读。'.repeat(15)}\n`);
    }
    // 笔记里带一个带语言名的代码围栏：保证 UI 审计每次 npm test 都在浏览器里量到代码高亮明暗两套配色的对比度（改 --hl-* 掉了要能自动红）。
    fs.writeFileSync(path.join(env.CONTENT_DIR, 'notes', 'fixture-note.md'),
      '---\ntitle: 示例笔记\ndate: 2025-02-01\n---\n示例笔记正文。\n\n```js\nconst a = 1; // 高亮审计样本\n```\n');
    fs.writeFileSync(path.join(env.CONTENT_DIR, 'pages', 'fixture-page.md'), '---\ntitle: 示例页面\nslug: fixture-page\ndate: 2025-01-01\n---\n这是测试固定页。');
    const { open, close } = await import('../db/driver.js');
    const { migrate } = await import('../db/migrate.js');
    const { createRepo } = await import('../db/repo.js');
    const { syncContent } = await import('../src/content/sync.js');
    const { hashPassword } = await import('../src/admin/auth.js');
    const { createCommentRepo } = await import('../db/comments.js');
    const db = open(env.DB_FILE);
    try {
      migrate(db, { log() {} });
      const repo = createRepo(db);
      const result = syncContent(repo, { quiet: true });
      if (result.errors.length) throw new Error(result.errors.join('; '));
      repo.setSetting('admin_password_hash', hashPassword(env.ADMIN_PASSWORD));
      const comments = createCommentRepo(db), postId = repo.getPost('fixture-note').id;
      const rootId = comments.add({ postId, author: '测试读者', bodyMd: '抽屉中的根评论', status: 'approved' });
      comments.add({ postId, parentId: rootId, author: '测试回复', bodyMd: '嵌套回复', status: 'approved' });
    } finally { close(db); }
    return { root, env, cleanup };
  } catch (error) { cleanup(); throw error; }
}

export function hasFixtures() {
  const root = process.env.BLOG_TEST_ROOT;
  return Boolean(root && path.resolve(root).startsWith(path.resolve(os.tmpdir()) + path.sep)
    && ['DATA_DIR', 'DB_FILE', 'CONTENT_DIR', 'UPLOADS_DIR'].every((key) => process.env[key]
      && path.resolve(process.env[key]).startsWith(path.resolve(root) + path.sep)));
}

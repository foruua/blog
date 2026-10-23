# 个人博客

Hono + Node.js 内置 SQLite，服务端渲染 Markdown。支持文章、笔记、固定页、评论审核、媒体库、RSS/Atom/JSON Feed、友圈订阅、友链及备份恢复。

## 启动

需要 Node.js ≥ 22.13.0；CI 覆盖 Node 22 / 24（`.node-version` 固定 24.22.1 LTS），浏览器测试另需 Playwright Chromium。

```sh
npm ci
cp .env.example .env
mkdir -p content/posts content/notes content/pages
npm run set-password
npm start
```

生产环境建议先跑一次 `npm run build:assets`：它把 CSS/JS 精简后生成 Brotli / gzip 预压缩文件到 `public/.build/`（该目录不进 Git）；没有构建产物时会自动退回运行时精简。

默认监听 `http://127.0.0.1:8787`，后台位于 `/admin`。已有数据目录可直接使用。生产环境配置 `SITE_URL`，反向代理部署时按实际情况配置可信代理。

## 生产运行与发布（腾讯云）

生产跑在腾讯云 Ubuntu：Nginx 终止 TLS（Let's Encrypt / certbot）并反代到 `127.0.0.1:8787`，应用由 systemd 的 `blog.service` 托管。代码在 `/srv/blog`，持久化数据在 `/srv/blog/state`（`data` / `content` / `uploads`），发布目录 `/srv/blog-releases`。

```sh
systemctl status blog          # 状态
journalctl -u blog -f          # 日志
systemctl restart blog         # 重启（停止后由 systemd 拉起）
```

发布：

```sh
DEPLOY_REMOTE=user@host \
DEPLOY_KEY=~/.ssh/blog-deploy.pem \
DEPLOY_DOMAIN=example.com \
BLOG_DEPLOY_NODE=/opt/node24/bin/node \
./scripts/deploy-tencent.sh
```

默认服务名 `blog`、应用目录 `/srv/blog`、发布目录 `/srv/blog-releases`、Node 路径 `/usr/bin/node`，可分别用 `BLOG_DEPLOY_SERVICE`、`BLOG_DEPLOY_APP_ROOT`、`BLOG_DEPLOY_RELEASE_ROOT`、`BLOG_DEPLOY_NODE` 覆盖；服务运行用户默认 `blog`，用 `BLOG_DEPLOY_USER` 改；保留最近 N 个发布版本用 `BLOG_DEPLOY_KEEP_RELEASES`（默认 5，0 = 不清理）。当前生产用官方 Node 24.22.1，装在 `/opt/node24`，所以发布时传 `BLOG_DEPLOY_NODE`，让 `npm ci`、语法检查、备份和恢复演练都用同一个 Node。发布前会做 Node 语法检查（`.js` 与 `.mjs`）、依赖安装（以服务用户执行，不用 root 跑 postinstall）、静态资源预构建（`npm run build:assets`，随后裁掉 devDependencies）、健康检查，失败自动回滚。

生产机的 Nginx 上传上限要覆盖视频：`client_max_body_size` 至少 160m（默认视频上限 128MB），`proxy_read_timeout` / `proxy_send_timeout` 放到 300s。完整装机步骤、DNS/ICP 与异地备份见 [`docs/deploy-tencent.md`](docs/deploy-tencent.md)。

### 发布回滚

发布失败会自动回滚到上一份完整源码。需要手动回滚时：

```sh
ssh ubuntu@<host>
sudo env BLOG_DEPLOY_APP_ROOT=/srv/blog \
  bash /srv/blog-releases/<版本>/next/scripts/deploy-release.sh rollback /srv/blog-releases/<版本>
```

生产日志走 journald，由系统轮转，不需要额外的日志轮转任务。

## 监控与告警

站点自监控有两层，探的是同一套指标（公网可达、可完整恢复的备份有多旧、异地备份是否成功）：

- **进程内看门狗**（`src/monitor.js`）：生产环境每 5 分钟探一次自己的公网 `/healthz`。反向代理或公网入口断开这类「进程活着但公网不可达」的故障靠它发现；连续 2 次失败才发信，恢复后再发一封，抖动不打扰。`WATCHDOG_INTERVAL_MS=0` 可关闭。
- **外部探针**（`scripts/monitor.mjs`）：进程挂了它才探得到，建议放在另一台机器上。`npm run monitor`，状态变化时发邮件或打 webhook。异地副本由 Mac 定时 `scripts/pull-offsite.sh` 拉取；配 `MONITOR_OFFSITE_DIR` 后，外部探针会直接检查该目录里最新清单的年龄，不依赖生产机自报异地状态。

告警默认走站点已有的 SMTP（后台「设置」里那套），不需要另配渠道；外部探针要发邮件需设 `MONITOR_MAIL=true`，并且能读到站点的 `data/blog.db` 与 `.app-secret`（否则解不开 SMTP 密码）。跨机器部署建议改用 webhook。`/healthz` 只在带 `MONITOR_TOKEN` 时才返回备份年龄、异地状态、磁盘剩余空间、数据库/WAL 大小与备份 worker 状态（匿名只回 `{ ok, posts, uptimeSec }`）——所以生产必须配这个 token，否则探针会一直报「读不到备份状态」。磁盘低于 `HEALTH_MIN_DISK_FREE_BYTES`（默认 512MB）或 WAL 超过 `HEALTH_MAX_WAL_BYTES`（默认 512MB）时 `/healthz` 也会返回 `ok:false`。

## 目录与内容

| 目录                                   | 用途                     |
| ------------------------------------ | ---------------------- |
| `server.js`                          | 启动、路由组装、安全头、静态文件与定时任务  |
| `src/routes`                         | 前台、评论和后台 HTTP 接口       |
| `src/http`                           | 静态文件、Range 分片响应与匿名 HTML 缓存 |
| `src/render`、`src/admin/views`       | 前台与后台 HTML 渲染          |
| `src/content`                        | Markdown 同步、原子写入与恢复日志  |
| `src/feeds`、`src/media`、`src/avatar` | 订阅抓取解析、图片处理、头像缓存       |
| `db`                                 | SQLite 数据访问、事务与 SQL 迁移 |
| `public`                             | 浏览器脚本和样式               |
| `themes`                             | 全部主题（Liquid 模板包）         |
| `scripts`                            | 测试、备份、恢复、维护及部署工具       |
| `content`                            | Markdown 原始内容          |
| `data`                               | 数据库、上传文件、备份与运行时数据      |

内容文件示例：

```markdown
---
title: 第一篇文章
slug: first-post
date: 2026-10-11 10:00
---
正文。
```

文章放在 `content/posts`，笔记放在 `content/notes`，固定页放在 `content/pages`。未填写日期或 `draft: true` 的内容为草稿。默认站点时区为 UTC+8，可配置为 UTC 或 UTC+9。后台编辑也写回 Markdown，数据库保存索引、修订和评论。设置页的「内容维护」可一键清空全站（文章 / 笔记 / 固定页）的修订历史与旧链接（301 映射），只删历史表，不动当前正文与评论。

后台「外观」页可以安装、启用、预览和配置主题。所有主题统一放在 `themes/<id>/`，没有「内置 / 用户安装」两套目录：上传的主题直接进 `themes/`，随完整备份一起归档。站点始终有一个主题在用；使用中的主题不能删除，必须先启用其它主题。主题是 Liquid 模板包，不执行服务端 JavaScript；按 `home`、`single-post`、`page`、`archive`、`search`、`404` 等模板层级覆盖页面，缺失的模板会回退，渲染失败也会自动兜底，不会白屏。结构、模板层级、上下文与安全边界见 [`docs/themes.md`](docs/themes.md)；`scripts/fixtures/fixture/` 是覆盖全部模板层级的可运行骨架，复制到 `themes/<id>/` 改名即可起步。

首页封面支持给每张图片/视频单独配文字：标题、副标题、按钮文字与链接，版式可选「左下标题 / 居中卡片 / 顶部标签 / 极简一行」，文字颜色可选浅色或深色；轮播时文字跟着当前封面切换，无 JS 时首屏文字也直接可见。

图片灯箱支持点击图片或按钮放大、拖动查看、滚轮缩放，键盘 `+` / `-` 缩放、`0` 还原。手机支持双指缩放；还原状态下左右滑动切换同组照片，放大状态下单指拖动查看。切图或关闭会重置缩放，后台原图查看也支持放大。

后台「插入图片/视频」也能传 MP4 / WebM / MOV：视频不重编码、按内容哈希原样存进 `data/uploads`，正文里仍然写成 `![说明](地址)`，渲染时自动变成带控制条的 `<video>`（`/uploads/*` 支持 Range 分片，Safari 可正常播放和拖进度）。视频也能设为首页封面（设置页「添加图片/视频」会打开媒体库，可直接挑已上传的视频，也可当场上传）：前台可选静音自动循环或点击进灯箱播放；文章、笔记内页和笔记图集里的视频都能在灯箱中放大播放。体积上限由 `MAX_VIDEO_UPLOAD_BYTES` 控制，默认 128MB；后台新上传路径会把原始请求体流式落到临时文件再处理，避免大视频整块占满 Node 堆，超长视频仍更适合放外部存储/CDN。

## 验证

```sh
npx playwright install chromium
npm test
```

`npm test` 先执行 ESLint，再运行隔离的功能回归与浏览器审计；不会读取 `.env` 或修改真实内容和上传目录。浏览器审计缺少运行依赖时明确报告跳过，CI 可使用 `UI_AUDIT_REQUIRED=1 npm test` 要求它必须运行。`test-lifecycle` / `test-maintenance` 里有真实浏览器用例，也需要先装 Chromium；想在无浏览器的机器上只跑功能回归，可用 `UI_AUDIT=off npm test`（仍会执行不需要浏览器的套件）。

## 备份与恢复

```sh
# 手动备份会获取与运行中服务相同的维护锁：先停服再跑。
# 在线备份由服务进程内的自动备份负责，不需要/不应该再手动抢锁。
npm run backup
npm run backup:list
npm run drill
```

完整备份由数据库压缩包、内容与附件压缩包、JSON 清单组成，三者一起保留。恢复前停止服务，再运行 `npm run restore`；交互确认后恢复，自动化需显式传入 `--yes`。维护锁用于阻止服务和离线维护脚本同时操作资源，不要手动删除正在使用的锁目录。

附件包按**内容哈希**命名（`<sha>.assets.json.gz`），并被多份备份共享。它占了整份备份的 99%，内容没变时名字、大小、mtime 都不变，rsync 才会真的跳过；跟着备份名走的话每份备份都得重传三十多 MB。清单里的 `assetsName` 记录实际文件名，老备份（`<name>.assets.json.gz`）仍然可恢复。清理时按引用计数回收：只要还有保留的备份指着它，就不会删。

数据库与上传目录含私有数据，发布代码时排除 `data` 和 `.env`。邮件参数见 `src/mail.js`；设置 SMTP 后可在后台系统页测试邮件。评论通知、看门狗与备份告警先写入 `mail_outbox`，失败按 1 分钟 → 5 分钟 → 15 分钟 → 1 小时 → 6 小时退避重试；全局默认每小时最多 30 封（`MAIL_MAX_PER_HOUR`），后台「设置」页能看到待发/失败数量与最近错误，并可手动重试失败邮件。

评论邮箱与 SMTP 密码用 AES-GCM 加密后落库，密钥默认在 `DATA_DIR/.app-secret`（600 权限），也可用 `APP_SECRET` 或 `APP_SECRET_FILE` 指定。**密钥不在备份里**：恢复备份到新机器时要一并带上这个文件/环境变量，否则旧邮箱和邮件密码解不开；反过来说，备份泄漏也不会顺带泄漏密钥。老库首次启动会自动把 `settings.app_secret` 搬到该文件并删除库内副本。

上传分两条路径：后台新前端的 raw 上传（`/admin/api/upload`，`x-raw-upload: 1`）会流式落到系统临时文件再处理，大视频不会整块进 Node 堆；旧的 multipart 表单仍会整块读入内存。两条路径都受单文件上限约束，`MAX_CONCURRENT_UPLOADS`（默认 2）限制同时在飞的上传数，超出时返回 503。要传更大的视频，建议放外置存储/CDN，而不是继续抬高内存上限。

异地副本有两种做法：生产机推送 `BACKUP_REMOTE=user@host:/path`（SSH 走 `~/.ssh/config` 或 agent）；或由另一台机器 pull。当前部署是后者：Mac 上的 launchd 任务 `me.uua.offsite` 每 6 小时跑 `scripts/pull-offsite.sh`，把 `/srv/blog/state/data/backups` 镜像到 `~/.local/share/blog-hosting/offsite-backups`，最新备份超过 48 小时时以非零退出。`/healthz` 的 `offsiteBackup` 只反映生产机自己的推送状态；pull 模式由外部探针的 `MONITOR_OFFSITE_DIR` 检查。推送模式下异地目录与本地**镜像同步**：本地按 `BACKUP_KEEP` 保留、资产包按引用计数回收，异地照抄这一份，不再按 mtime 删（共享资产包下按时间删必然删坏还能用的备份）。推送模式下 `/healthz` 的 `offsiteBackup.state` 为 `ok` 才算异地成功；也可用 `BACKUP_HOOK` 改走 rclone 等自定义命令。自动备份失败会立即发告警，并按 5 分钟 / 15 分钟 / 1 小时 / 6 小时退避重试；`/healthz` 的 `backupLastError`、`backupNextRetryAt` 记录最近失败与下次重试时间。

图片预览默认复用首帧像素，预算为 32MiB；缩略图使用 thumb-v3、响应式图片使用 v4。灯箱默认展示最大档 WebP 变体（体积通常只有原图的百分之几），原图不再进灯箱；动画图（多帧）原图是唯一带全部帧的文件，这类仍回原图，`media.animated` 记录该状态。附件回填和旧派生图清理的写入模式需要先停服，资源锁会阻止并发维护。回填后运行 `npm run sync:content`，再清理旧文件。`npm run cleanup:media` 和 `npm run cleanup:output` 默认只列清单，加 `-- --apply` 才移入回收站。

回收站由 `npm run cleanup:trash` 管理：默认只列清单，`-- --apply` 删除到期文件，`-- --derived` 可立即清掉可再生的缩略图与响应式变体（原图保留）。原图保留期默认 90 天（`TRASH_KEEP_DAYS`），派生图默认 7 天（`TRASH_DERIVED_KEEP_DAYS`），服务启动时也会按同一口径自动清一次；该脚本只动 `.trash`，服务运行时也能执行。

# 腾讯云部署

生产环境：腾讯云 Ubuntu + systemd + Nginx + Let's Encrypt。应用只监听 `127.0.0.1:8787`，不直接暴露 Node 端口。

```text
浏览器 → Nginx :443（TLS）→ 127.0.0.1:8787（Hono）→ /srv/blog/state
                                      ↑
                              systemd: blog.service
```

| 路径 | 用途 |
| --- | --- |
| `/srv/blog` | 运行目录（代码 + `.env`） |
| `/srv/blog/state/data` | SQLite、`.app-secret`、头像、备份 |
| `/srv/blog/state/content` | Markdown 原稿 |
| `/srv/blog/state/uploads` | 上传的图片 |
| `/srv/blog-releases` | 每次发布的完整源码与依赖 |

## 1. 首次装机

要求：域名已完成 ICP 备案；腾讯云安全组放行 80 / 443；`ubuntu` 等部署账号可免密 `sudo`。

```sh
# Nginx、certbot、rsync；Node 另行安装
sudo apt-get update
sudo apt-get install -y nginx certbot python3-certbot-nginx rsync xz-utils
```

Node 用官方二进制，版本和 `.node-version` 保持一致（当前 24.22.1）：

```sh
cd /tmp
curl -fsSLO https://npmmirror.com/mirrors/node/v24.22.1/node-v24.22.1-linux-x64.tar.xz
curl -fsSL https://npmmirror.com/mirrors/node/v24.22.1/SHASUMS256.txt | grep node-v24.22.1-linux-x64.tar.xz | sha256sum -c -
sudo tar -xJf node-v24.22.1-linux-x64.tar.xz -C /opt
sudo ln -sfn /opt/node-v24.22.1-linux-x64 /opt/node24
/opt/node24/bin/node -v
/opt/node24/bin/npm -v
```

`/opt/node24` 要同时给 systemd 和发布脚本用；两者不一致时，`sharp` 这类原生模块可能按错误的 ABI 安装。

```sh
# 服务用户；家目录指向 /srv/blog，但代码目录归 root，避免应用改自己的代码
sudo useradd --system --no-create-home --home-dir /srv/blog --shell /usr/sbin/nologin blog
sudo install -d -o root -g root -m 755 /srv/blog /srv/blog-releases
sudo install -d -o blog -g blog -m 750 \
  /srv/blog/state/data /srv/blog/state/content /srv/blog/state/uploads
```

`/srv/blog/.env`：

```sh
HOST=127.0.0.1
PORT=8787
NODE_ENV=production

SITE_URL=https://example.com
SITE_DOMAIN=example.com
SITE_ICP=冀ICP备00000000号
SITE_TZ_OFFSET=+08:00

# 只信任本机 Nginx
TRUST_PROXY=true
TRUSTED_PROXIES=127.0.0.1,::1,::ffff:127.0.0.1

DATA_DIR=/srv/blog/state/data
CONTENT_DIR=/srv/blog/state/content
UPLOADS_DIR=/srv/blog/state/uploads
BACKUP_DIR=/srv/blog/state/data/backups

# 生产必须配：/healthz 才会返回备份年龄等内部字段
MONITOR_TOKEN=换成一串随机值
MONITOR_URL=https://example.com/healthz
```

SMTP、评论审核等设置登录后台「设置」页填写。评论邮箱与 SMTP 密码用 `DATA_DIR/.app-secret` 加密，**这个文件不在备份里**，迁移或恢复时要单独带上。

## 2. systemd

`/etc/systemd/system/blog.service`：

```ini
[Unit]
Description=blog
After=network.target

[Service]
Type=simple
User=blog
Group=blog
WorkingDirectory=/srv/blog
ExecStart=/opt/node24/bin/node --disable-warning=ExperimentalWarning --env-file=/srv/blog/.env /srv/blog/server.js
Restart=on-failure
RestartSec=3
TimeoutStopSec=30
NoNewPrivileges=true
PrivateTmp=true
ProtectSystem=strict
ProtectHome=true
# state 放数据库/内容/上传；themes 让后台可以安装和删除主题
ReadWritePaths=/srv/blog/state /srv/blog/themes
UMask=0027

[Install]
WantedBy=multi-user.target
```

```sh
sudo systemctl daemon-reload
sudo systemctl enable --now blog
systemctl status blog
journalctl -u blog -f      # 日志由 journald 轮转，不需要再看文件大小
```

发布脚本在切换代码时需要写 `/srv/blog`，所以它先停服、以 root 同步文件，再启动服务；运行中的 Node 进程始终只有 `/srv/blog/state` 可写。

## 3. Nginx 与证书

`/etc/nginx/sites-available/blog.conf`：

```nginx
server {
    server_name example.com;
    # 服务端默认不限单文件体积，这里就是实际上限；要传更大的图就同步调大
    client_max_body_size 40m;
    client_body_timeout 300s;

    location / {
        proxy_pass http://127.0.0.1:8787;
        proxy_http_version 1.1;
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        # 覆盖而不是追加，客户端伪造的 XFF 不会透传
        proxy_set_header X-Forwarded-For $remote_addr;
        proxy_set_header X-Forwarded-Proto $scheme;
        proxy_read_timeout 300s;
        proxy_send_timeout 300s;
        proxy_request_buffering off;
    }

    listen 443 ssl; # managed by Certbot
    listen [::]:443 ssl ipv6only=on; # managed by Certbot
    ssl_certificate /etc/letsencrypt/live/example.com/fullchain.pem; # managed by Certbot
    ssl_certificate_key /etc/letsencrypt/live/example.com/privkey.pem; # managed by Certbot
    include /etc/letsencrypt/options-ssl-nginx.conf; # managed by Certbot
    ssl_dhparam /etc/letsencrypt/ssl-dhparams.pem; # managed by Certbot
}

server {
    if ($host = example.com) {
        return 301 https://$host$request_uri;
    }

    listen 80;
    listen [::]:80;
    server_name example.com;
    return 404;
}
```

```sh
sudo ln -s /etc/nginx/sites-available/blog.conf /etc/nginx/sites-enabled/blog.conf
sudo nginx -t && sudo systemctl reload nginx
sudo certbot --nginx -d example.com      # 自动续期由 certbot.timer 负责
sudo certbot renew --dry-run
```

`client_max_body_size` 小于单文件上限时，后台上传大图会得到 Nginx 的 413，而不是应用的错误。

## 4. 发布

```sh
DEPLOY_REMOTE=ubuntu@203.0.113.10 \
DEPLOY_KEY=~/.ssh/blog-deploy.pem \
DEPLOY_DOMAIN=example.com \
BLOG_DEPLOY_NODE=/opt/node24/bin/node \
./scripts/deploy-tencent.sh
```

脚本会：准备独立发布目录 → 以 `blog` 用户 `npm ci` / `build:assets` / `npm prune --omit=dev` → 语法检查 → 停服并做 `pre-deploy` 备份 → 同步代码 → `backfill-media` → 启动 → 本机健康检查 → 恢复演练 → 通过域名直连新机做 HTTPS 健康检查 → 清理旧发布。`npm` 的 `PATH` 会优先使用 `BLOG_DEPLOY_NODE` 所在目录，保证安装依赖和运行时是同一个 Node。

失败会自动回滚到上一份完整源码。手动回滚：

```sh
ssh ubuntu@203.0.113.10
sudo env BLOG_DEPLOY_APP_ROOT=/srv/blog \
  bash /srv/blog-releases/<版本>/next/scripts/deploy-release.sh rollback /srv/blog-releases/<版本>
```

发布目录只保留最近 5 份，用 `BLOG_DEPLOY_KEEP_RELEASES` 调整。npm 缓存写在发布目录内（`<release>/.npm-cache`），因为服务用户的家目录 `/srv/blog` 归 root，不能在下面建 `~/.npm`。

## 5. DNS 与备案

- 域名 NS 指向 DNSPod（或备案服务商要求的 DNS），添加 `A @ → 腾讯云公网 IP`。
- ICP 备案期间和通过后，域名应解析到已备案的腾讯云主机；不要再用 Cloudflare 代理遮住源站。
- 备案号写进 `.env` 的 `SITE_ICP`，页脚会自动显示。需要公安备案的，按备案要求补充。
- 可选：添加 `www` 记录后执行 `sudo certbot --nginx -d example.com -d www.example.com` 扩展证书，并在 Nginx 的 `server_name` 里加上 `www.example.com`。

## 6. 异地备份

生产机自己推自己不算异地。当前做法是家里 Mac 定时从生产机 **pull**：

```sh
# 手动跑一次（BLOG_OFFSITE_SOURCE 必填：脚本里不内置生产机地址）
BLOG_OFFSITE_SOURCE=ubuntu@203.0.113.10 npm run offsite:pull

# 从哪拉、拉到哪里、用哪把私钥，都用环境变量给
BLOG_OFFSITE_SOURCE=ubuntu@203.0.113.10 \
BLOG_OFFSITE_KEY=$HOME/.ssh/blog-deploy.pem \
BLOG_OFFSITE_DIR=$HOME/.local/share/blog-hosting/offsite-backups \
./scripts/pull-offsite.sh
```

`BLOG_OFFSITE_SOURCE` 缺失时脚本直接以退出码 2 中止（不再有硬编码的兜底主机）；`BLOG_OFFSITE_KEY` 留空则走 ssh-agent / `~/.ssh/config`。脚本用 `rsync --delete` 镜像生产机的 `/srv/blog/state/data/backups`，内容哈希命名的资产包未变化时不会重传；传输有 `--timeout`/`--contimeout`，网络半死不会把下一轮锁死；最新备份超过 48 小时会以非零退出。macOS 上用 launchd 每 6 小时跑一次：

`~/Library/LaunchAgents/me.uua.offsite.plist`：

```xml
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key><string>me.uua.offsite</string>
  <key>ProgramArguments</key>
  <array>
    <string>/bin/bash</string>
    <string>/Users/you/work/blog/scripts/pull-offsite.sh</string>
  </array>
  <key>WorkingDirectory</key><string>/Users/you/work/blog</string>
  <key>EnvironmentVariables</key>
  <dict>
    <key>HOME</key><string>/Users/you</string>
    <key>PATH</key><string>/usr/bin:/bin:/usr/sbin:/sbin</string>
    <key>BLOG_OFFSITE_SOURCE</key><string>ubuntu@203.0.113.10</string>
    <key>BLOG_OFFSITE_KEY</key><string>/Users/you/.ssh/blog-deploy.pem</string>
  </dict>
  <key>RunAtLoad</key><true/>
  <key>StartInterval</key><integer>21600</integer>
  <key>StandardOutPath</key><string>/Users/you/.local/share/blog-hosting/offsite.log</string>
  <key>StandardErrorPath</key><string>/Users/you/.local/share/blog-hosting/offsite.error.log</string>
</dict>
</plist>
```

```sh
launchctl bootstrap gui/$(id -u) ~/Library/LaunchAgents/me.uua.offsite.plist
```

用另一台 Linux 拉取时，把脚本放进 cron 即可；脚本同时兼容 BSD（macOS）与 GNU 的 `stat`。

## 7. 监控

- 生产进程内看门狗每 5 分钟探一次 `https://example.com/healthz`，连续两次失败才发信。
- 外部探针放在另一台机器：`npm run monitor`，建议由 launchd / cron 定时跑。
- 生产 `.env` 的 `MONITOR_TOKEN` 与外部探针必须一致，否则探针读不到备份年龄。
- pull 模式下外部探针配置：

```sh
MONITOR_URL=https://example.com/healthz
MONITOR_TOKEN=与生产一致
MONITOR_OFFSITE_DIR=/Users/you/.local/share/blog-hosting/offsite-backups
MONITOR_REQUIRE_OFFSITE=false   # 不要再要求生产机自报异地状态
MONITOR_MAIL=true
```

外部探针会直接检查 `MONITOR_OFFSITE_DIR` 里最新清单的年龄，生产站挂了和异地备份过期都会告警。

## 8. 回退

发布失败由脚本自动回滚。手动回滚到上一个完整版本：

```sh
ssh ubuntu@203.0.113.10
sudo env BLOG_DEPLOY_APP_ROOT=/srv/blog \
  bash /srv/blog-releases/<版本>/next/scripts/deploy-release.sh rollback /srv/blog-releases/<版本>
```

发布目录默认保留最近 5 个版本（`BLOG_DEPLOY_KEEP_RELEASES` 可改，0 = 不清理），回滚可以往回退不止一层。

## 9. 排错

| 现象 | 检查 |
| --- | --- |
| 502 | `systemctl status blog`、`journalctl -u blog -n 100` |
| 413 / 大图传不上去 | Nginx `client_max_body_size` 与 `client_body_timeout` |
| `/healthz` 没有备份字段 | 生产 `.env` 是否配 `MONITOR_TOKEN`，探针 header 是否一致 |
| 页面没有备案号 | `.env` 的 `SITE_ICP`，改完 `systemctl restart blog` |
| 证书快过期 | `systemctl list-timers | grep certbot`、`certbot renew --dry-run` |
| 发布时报 `EACCES /srv/blog/.npm` | 发布脚本应使用发布目录内的 npm 缓存；老版本脚本可先 `chown -R blog:blog /srv/blog/.npm` |
| 备份报 `EACCES ... /srv/blog/themes.blog-lock` | 旧版 `backup.mjs` 会锁只读的主题目录；更新后备份只锁 DB / 内容 / 上传，发布脚本会把 `themes` 交还 `blog` |
| 后台上传主题失败 | `ls -ld /srv/blog/themes` 应为 `blog:blog`；重新发布或手动 `chown -R blog:blog /srv/blog/themes` |
| 磁盘不足 | 备份保留份数、`/srv/blog-releases` 旧版本、`npm run cleanup:trash` |

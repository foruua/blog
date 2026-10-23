#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")/.."
# 发布到腾讯云。仅更新源码与依赖，保留 app_root/.env 与 state/{data,content}，启动后跑恢复演练。
# 主机、密钥、域名、目录、服务名、Node 路径全部从环境变量取，代码里不写死生产信息。
# 例：DEPLOY_REMOTE=ubuntu@203.0.113.10 DEPLOY_KEY=~/.ssh/blog-deploy.pem DEPLOY_DOMAIN=example.com ./scripts/deploy-tencent.sh
: "${DEPLOY_REMOTE:?请设置 DEPLOY_REMOTE（user@host）}"
: "${DEPLOY_KEY:?请设置 DEPLOY_KEY（SSH 私钥路径）}"
: "${DEPLOY_DOMAIN:?请设置 DEPLOY_DOMAIN（用于 HTTPS 健康检查）}"
remote="$DEPLOY_REMOTE"
key="$DEPLOY_KEY"
port="${DEPLOY_PORT:-22}"
domain="$DEPLOY_DOMAIN"
target="${DEPLOY_TARGET_HOST:-${remote##*@}}"
app_root="${BLOG_DEPLOY_APP_ROOT:-/srv/blog}"
release_root="${BLOG_DEPLOY_RELEASE_ROOT:-/srv/blog-releases}"
service="${BLOG_DEPLOY_SERVICE:-blog}"
health="${BLOG_DEPLOY_HEALTH:-http://127.0.0.1:8787/healthz}"
node_bin="${BLOG_DEPLOY_NODE:-/usr/bin/node}"
run_user="${BLOG_DEPLOY_USER:-blog}"
keep_releases="${BLOG_DEPLOY_KEEP_RELEASES:-5}"
case "$key" in "~/"*) key="$HOME/${key#~/}" ;; esac
if [[ "$key" == *"'"* ]]; then echo "DEPLOY_KEY 不能包含单引号（会破坏 rsync -e 的引号）" >&2; exit 1; fi
if ! [[ "$port" =~ ^[0-9]+$ ]] || (( port < 1 || port > 65535 )); then
  echo 'DEPLOY_PORT 必须是 1–65535 的整数' >&2; exit 1
fi
if ! [[ "$keep_releases" =~ ^[0-9]+$ ]]; then
  echo 'BLOG_DEPLOY_KEEP_RELEASES 必须是非负整数' >&2; exit 1
fi
if ! test -f "$key"; then echo "找不到部署密钥：$key" >&2; exit 1; fi
chmod 600 "$key"

# 远端命令统一带这套 env：否则 deploy-release.sh 的 BLOG_DEPLOY_* 默认值会悄悄覆盖本地配置。
q() { printf '%q' "$1"; }
remote_env="BLOG_DEPLOY_APP_ROOT=$(q "$app_root") BLOG_DEPLOY_SERVICE=$(q "$service") BLOG_DEPLOY_HEALTH=$(q "$health") BLOG_DEPLOY_NODE=$(q "$node_bin") BLOG_DEPLOY_USER=$(q "$run_user")"
ssh_opts=(-i "$key" -p "$port" -o BatchMode=yes -o ConnectTimeout=15 -o StrictHostKeyChecking=accept-new)
ssh "${ssh_opts[@]}" "$remote" "sudo -n env $remote_env test -d $(q "$app_root/state/data") && sudo -n env $remote_env test -f $(q "$app_root/.env")"
# 先准备独立版本，依赖安装失败不会影响正在运行的网站。
release="${release_root}/$(date -u +%Y%m%dT%H%M%SZ)-$$"
rollback_ready=0
recover_release() {
  local status=$?
  trap - EXIT
  if (( status != 0 && rollback_ready )); then
    ssh "${ssh_opts[@]}" "$remote" "sudo -n env $remote_env bash $(q "$release/next/scripts/deploy-release.sh") rollback $(q "$release")" || echo '自动回滚失败，请检查远端服务' >&2
  fi
  exit "$status"
}
trap recover_release EXIT
ssh "${ssh_opts[@]}" "$remote" "sudo -n install -d -m 755 $(q "$release_root") $(q "$release/next")"
rsync -az \
  --rsync-path='sudo -n rsync' \
  -e "ssh -i '$key' -p '$port' -o BatchMode=yes -o ConnectTimeout=15 -o StrictHostKeyChecking=accept-new" \
  --exclude='/node_modules/' --exclude='/data/' \
  --exclude='/state/' --exclude='/content/' --exclude='*.blog-lock/' \
  --exclude='/.env' --exclude='.env.*' --exclude='*.pem' \
  --exclude='/.git/' --exclude='/.github/' \
  --exclude='/output/' --exclude='/.workbuddy/' --exclude='.DS_Store' \
  ./ "$remote:$release/next/"
ssh "${ssh_opts[@]}" "$remote" "sudo -n env $remote_env bash -s -- $(q "$release")" <<'REMOTE'
set -euo pipefail
release="$1"
cd "$release/next"
# 依赖安装不用 root 跑：第三方包 postinstall 不该拥有生产机 root 权限。
chown -R "$BLOG_DEPLOY_USER:$BLOG_DEPLOY_USER" "$release/next"
user_home="$(getent passwd "$BLOG_DEPLOY_USER" | cut -d: -f6)"
user_home="${user_home:-/home/$BLOG_DEPLOY_USER}"
# npm 默认把缓存放在 $HOME/.npm。远端服务用户的家目录可能是 root 拥有的 /srv/blog，
# 直接在下面建缓存会 EACCES；用发布目录里的独立缓存，装完即删，也不污染应用根目录。
npm_cache="$release/.npm-cache"
install -d -m 700 -o "$BLOG_DEPLOY_USER" -g "$BLOG_DEPLOY_USER" "$npm_cache"
# npm 的 shebang 走 PATH 里的 node。Node 装在 /opt 这类非标准路径时，
# 必须让 npm 与运行时用同一个 Node，否则 sharp 等原生模块会按错误的 ABI 安装。
node_dir="$(dirname "$BLOG_DEPLOY_NODE")"
run_npm() {
  runuser -u "$BLOG_DEPLOY_USER" -- env HOME="$user_home" \
    PATH="$node_dir:/usr/local/bin:/usr/bin:/bin" npm_config_cache="$npm_cache" "$@"
}
run_npm npm ci --include=dev --registry=https://registry.npmmirror.com
# 静态资源在构建期精简并预压成 .br/.gz；构建完再裁掉 devDependencies，生产进程不需要 css-tree/acorn。
run_npm npm run build:assets
run_npm npm prune --omit=dev
rm -rf "$npm_cache"
# 只做语法检查，不启动应用、不执行迁移、不接触持久化数据。
find . -path ./node_modules -prune -o \( -name '*.js' -o -name '*.mjs' \) -type f -print0 | xargs -0 -r -n 1 "$BLOG_DEPLOY_NODE" --check
chown -R root:root "$release/next"
chmod -R a+rX "$release/next"
REMOTE
rollback_ready=1
ssh "${ssh_opts[@]}" "$remote" "sudo -n env $remote_env bash $(q "$release/next/scripts/deploy-release.sh") activate $(q "$release")"
# 保留域名的 TLS/SNI，但直连部署主机，避免 DNS 指向旧服务器时误判成功。
curl -fsS --connect-timeout 10 --max-time 30 --retry 3 \
  --connect-to "$domain:443:$target:443" "https://$domain/healthz"
ssh "${ssh_opts[@]}" "$remote" "sudo -n env $remote_env bash $(q "$release/next/scripts/deploy-release.sh") commit $(q "$release")"

# 发布目录按数量保留：每次 next + previous 都是完整源码和 node_modules，不清理会吃满磁盘。
if (( keep_releases > 0 )); then
  ssh "${ssh_opts[@]}" "$remote" "sudo -n bash -s -- $(q "$release_root") $(q "$keep_releases") $(q "$release")" <<'REMOTE'
set -euo pipefail
root="$1"; keep="$2"; current="${3##*/}"
mapfile -t releases < <(find "$root" -mindepth 1 -maxdepth 1 -type d -printf '%f\n' \
  | grep -E '^[0-9]{8}T[0-9]{6}Z-[0-9]+$' | sort -r)
for ((i=keep; i<${#releases[@]}; i++)); do
  name="${releases[i]}"
  [ "$name" = "$current" ] && continue
  rm -rf -- "${root:?}/${name:?}"
done
REMOTE
fi
echo "已部署并验证腾讯云主机 ${target}；域名 DNS 切换需单独确认。"
trap - EXIT

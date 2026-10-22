#!/usr/bin/env bash
# 由 deploy-tencent.sh 在远端调用；数据与配置始终留在运行目录。
set -euo pipefail
mode="${1:?需要 activate、commit 或 rollback}"
release="${2:?需要版本目录}"
app_root="${BLOG_DEPLOY_APP_ROOT:-/srv/blog}"
service="${BLOG_DEPLOY_SERVICE:-blog}"
health="${BLOG_DEPLOY_HEALTH:-http://127.0.0.1:8787/healthz}"
node_bin="${BLOG_DEPLOY_NODE:-/usr/bin/node}"
run_user="${BLOG_DEPLOY_USER:-blog}"
[[ "$release" = /* && "$app_root" = /* && "$release" != "$app_root" ]] || exit 2
# 防止同时切换两个版本。准备/依赖安装在独立目录进行，不占此锁。
exec 9>"${app_root}.deploy-lock"
flock -x 9
sync_code() {
  # themes/ 同时存放代码自带主题与后台上传的主题。同步新文件，但 protect 住远端已有主题，
  # 避免 --delete 把线上安装的主题删掉。
  rsync -a --checksum --delete --filter='protect /themes/***' \
    --exclude='/state/' --exclude='/data' --exclude='/content' --exclude='/.env' "$1/" "$app_root/"
}
active="${app_root}.deploy-active"
rollback() {
  if test -f "$active" && test "$(cat "$active")" != "$release"; then
    echo '另一个版本正在验证，拒绝回滚其代码' >&2; return 1
  fi
  if test -f "$release/switched"; then
    test -f "$release/previous.complete" || return 1
    systemctl stop "$service" || return 1
    sync_code "$release/previous" || return 1
    rm -f "$release/switched"
  fi
  if test -f "$release/stopped"; then
    systemctl start "$service" || return 1
    curl -fsS --max-time 10 --retry 10 --retry-delay 1 --retry-connrefused "$health" || return 1
    rm -f "$release/stopped"
  fi
  if test -f "$active" && test "$(cat "$active")" = "$release"; then rm -f "$active"; fi
}
case "$mode" in
  rollback) rollback; exit ;;
  commit)
    test -f "$active" && test "$(cat "$active")" = "$release"
    rm -f "$release/stopped" "$release/switched" "$active"
    exit ;;
  activate)
    if test -f "$active"; then echo '另一个版本尚在验证，请等待或恢复该版本' >&2; exit 1; fi
    ;;
  *) exit 2 ;;
esac
trap 'status=$?; trap - EXIT; if (( status != 0 )); then rollback || echo "版本回滚失败，需要检查服务" >&2; fi; exit "$status"' EXIT
printf '%s\n' "$release" > "$active"
mkdir -p "$release/previous"
touch "$release/stopped"
systemctl stop "$service"
cd "$app_root"
runuser -u "$run_user" -- "$node_bin" --env-file="$app_root/.env" scripts/backup.mjs --label pre-deploy
# 保留完整可运行源码与依赖；不把可变数据复制进代码快照。
rsync -a --exclude='/state/' --exclude='/data' --exclude='/content' --exclude='/.env' "$app_root/" "$release/previous/"
touch "$release/previous.complete"
# 在覆盖前标记，复制中途失败也能恢复。
touch "$release/switched"
sync_code "$release/next"
runuser -u "$run_user" -- "$node_bin" --env-file="$app_root/.env" scripts/backfill-media.mjs --apply
systemctl start "$service"
curl -fsS --max-time 10 --retry 20 --retry-delay 1 --retry-connrefused "$health"
runuser -u "$run_user" -- "$node_bin" --env-file="$app_root/.env" scripts/restore-drill.mjs
# stopped 标记保留至外层公网验证成功，失败时仍能回切并启动旧版。

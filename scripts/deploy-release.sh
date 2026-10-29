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
    --exclude='/state/' --exclude='/data' --exclude='/content' --exclude='/.env' \
    --exclude='*.blog-lock*' "$1/" "$app_root/"
  # themes 同时是后台上传/删除主题的可写目录；代码同步是 root 做的，交还所有权给服务用户。
  if [ "$(id -u)" = 0 ] && [ -d "$app_root/themes" ]; then
    chown -R "$run_user:$run_user" "$app_root/themes"
  fi
}
active="${app_root}.deploy-active"

# 数据库结构版本：迁移是在 systemctl start 里跑的，所以「结构变了没有」只能在部署前记一次、
# 回滚时再读一次来比较。读不出来就回 unknown，调用方跳过自动回滚而不是瞎猜。
# 在子 shell 里 cd 到应用根：回滚时脚本的工作目录不一定是 $app_root，相对路径会找不到脚本。
schema_version() {
  ( cd "$app_root" && runuser -u "$run_user" -- "$node_bin" --env-file="$app_root/.env" scripts/schema-version.mjs 2>/dev/null ) || echo unknown
}

# 回滚只换代码是不够的：040/041 这类删列迁移一旦跑过，旧代码一写入就报错。
# 结构版本变了就先把 pre-deploy 备份里的数据库恢复回来，再启动旧版本。
restore_schema_if_needed() {
  local before after
  if ! test -f "$release/pre-schema"; then
    echo '  跳过数据库回滚：没有记录部署前的结构版本' >&2
    return 0
  fi
  before="$(cat "$release/pre-schema")"
  after="$(schema_version)"
  if ! [[ "$before" =~ ^[0-9]+$ && "$after" =~ ^[0-9]+$ ]]; then
    echo "  跳过数据库回滚：结构版本无法确定（部署前 $before / 现在 $after）" >&2
    return 0
  fi
  if [ "$before" = "$after" ]; then
    echo "  数据库结构未变（schema $after），无需回滚数据库"
    return 0
  fi
  if ! test -f "$release/pre-backup"; then
    echo "  ✗ 结构已从 $before 变为 $after，但没记下 pre-deploy 备份名；旧代码可能无法启动" >&2
    return 1
  fi
  local name
  name="$(cat "$release/pre-backup")"
  echo "  结构已从 $before 变为 $after：从 pre-deploy 备份 $name 恢复数据库"
  ( cd "$app_root" && runuser -u "$run_user" -- "$node_bin" --env-file="$app_root/.env" scripts/restore.mjs --from "$name" --yes ) \
    || { echo "  ✗ 数据库回滚失败（备份 $name），请人工处理" >&2; return 1; }
}

rollback() {
  if test -f "$active" && test "$(cat "$active")" != "$release"; then
    echo '另一个版本正在验证，拒绝回滚其代码' >&2; return 1
  fi
  if test -f "$release/switched"; then
    test -f "$release/previous.complete" || { echo '回滚中止：previous.complete 不存在，没有可回滚的上一版' >&2; return 1; }
    systemctl stop "$service" || { echo "回滚中止：systemctl stop $service 失败" >&2; return 1; }
    sync_code "$release/previous" || { echo '回滚中止：同步 previous 代码失败' >&2; return 1; }
    # 代码先回退，数据库在启动旧版本之前回退：旧代码配新结构是必然报错的组合。
    restore_schema_if_needed || { echo '回滚中止：数据库结构未能回退到旧版本' >&2; return 1; }
    rm -f "$release/switched"
  fi
  if test -f "$release/stopped"; then
    systemctl start "$service" || { echo "回滚中止：systemctl start $service 失败" >&2; return 1; }
    curl -fsS --max-time 10 --retry 10 --retry-delay 1 --retry-connrefused "$health" || { echo "回滚中止：健康检查未通过（$health）" >&2; return 1; }
    rm -f "$release/stopped"
  fi
  if test -f "$active" && test "$(cat "$active")" = "$release"; then rm -f "$active"; fi
}
case "$mode" in
  rollback) rollback; exit ;;
  commit)
    # 校验失败必须说明原因：test && test 静默返回 1 时，操作者面对的是「commit 失败但一个字都没有」。
    if ! test -f "$active" || ! test "$(cat "$active")" = "$release"; then
      echo "commit 拒绝：$active 不存在或不是当前版本 $release（未 activate / 已过期 / 被别的版本占用）" >&2
      exit 1
    fi
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
# 先记结构版本，再打 pre-deploy 备份：备份完成时库里还是旧结构，这份快照就是「旧代码能用的状态」。
schema_version > "$release/pre-schema"
backup_out="$(runuser -u "$run_user" -- "$node_bin" --env-file="$app_root/.env" scripts/backup.mjs --label pre-deploy)"
printf '%s\n' "$backup_out"
# 备份名用于回滚时恢复数据库（restore.mjs --from <name>）。取「✓ 文件 …/<name>.db.gz」那一行。
pre_gz="$(printf '%s\n' "$backup_out" | awk '/✓ 文件/ {print $NF}' | tail -1)"
if [ -n "$pre_gz" ]; then basename "$pre_gz" .db.gz > "$release/pre-backup"
else echo '  · 未能从备份输出里取到备份名，回滚时将无法自动恢复数据库' >&2; fi
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

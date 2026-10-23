#!/usr/bin/env bash
# 从腾讯云生产机拉取备份到本机，作为异地副本。
# 生产机不再主动推备份（生产机推自己等于没备份），改由家里这台 Mac 定时 pull。
# 由 launchd 定时运行；手动跑：./scripts/pull-offsite.sh
set -euo pipefail
cd "$(dirname "$0")/.."

source="${BLOG_OFFSITE_SOURCE:-ubuntu@122.51.72.43}"
remote_path="${BLOG_OFFSITE_REMOTE_PATH:-/srv/blog/state/data/backups/}"
dest="${BLOG_OFFSITE_DIR:-$HOME/.local/share/blog-hosting/offsite-backups}"
key="${BLOG_OFFSITE_KEY:-$HOME/.ssh/uua-blog-deploy.pem}"
max_age_sec="${BLOG_OFFSITE_MAX_AGE_SEC:-172800}" # 48h，超过说明生产备份或拉取已经坏了

case "$key" in "~/"*) key="$HOME/${key#~/}" ;; esac
mkdir -p "$dest"

# macOS 没有 flock：用目录锁防止两个 launchd 周期重叠。超过 2 小时的锁视为残留。
lock="$dest/.pull-lock"
if ! mkdir "$lock" 2>/dev/null; then
  if [[ -n "$(find "$lock" -maxdepth 0 -mmin +120 2>/dev/null)" ]]; then
    rmdir "$lock" 2>/dev/null || true
    mkdir "$lock" 2>/dev/null || { echo '另一个拉取任务正在运行，跳过'; exit 0; }
  else
    echo '另一个拉取任务正在运行，跳过'
    exit 0
  fi
fi
trap 'rmdir "$lock" 2>/dev/null || true' EXIT

ssh_opts=(-o BatchMode=yes -o ConnectTimeout=15 -o StrictHostKeyChecking=accept-new)
if [[ -f "$key" ]]; then ssh_opts=(-i "$key" "${ssh_opts[@]}"); fi

echo "[$(date '+%F %T')] 从 $source:$remote_path 拉取到 $dest"
# --delete 让异地目录与生产保留策略保持一致；共享资产包内容哈希命名，未变时不会重传。
rsync -az --delete --exclude='.pull-lock/' \
  --rsync-path='sudo -n rsync' \
  -e "ssh ${ssh_opts[*]}" \
  "$source:$remote_path" "$dest/"

latest="$(ls -1t "$dest"/*.json 2>/dev/null | head -1 || true)"
if [[ -z "$latest" ]]; then
  echo '拉取完成，但没有找到备份清单（*.json）' >&2
  exit 1
fi
if mtime="$(stat -c %Y "$latest" 2>/dev/null)"; then
  :                                   # GNU stat（Linux）
else
  mtime="$(stat -f %m "$latest")"     # BSD stat（macOS）
fi
age=$(( $(date +%s) - mtime ))
echo "[$(date '+%F %T')] 最新备份 $(basename "$latest")，年龄 $((age / 3600)) 小时"
if (( age > max_age_sec )); then
  echo "最新备份已超过 $((max_age_sec / 3600)) 小时，检查生产备份任务" >&2
  exit 1
fi

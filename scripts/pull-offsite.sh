#!/usr/bin/env bash
# 从腾讯云生产机拉取备份到本机，作为异地副本。
# 生产机不再主动推备份（生产机推自己等于没备份），改由家里这台 Mac 定时 pull。
# 由 launchd 定时运行；手动跑：./scripts/pull-offsite.sh
#
# 生产机地址与私钥路径**只从环境变量取**，脚本里不写死：这类脚本会进仓库，硬编码的主机名 +
# 密钥文件名等于把生产入口和登录方式一起公开。
#   BLOG_OFFSITE_SOURCE      必填，user@host
#   BLOG_OFFSITE_REMOTE_PATH 可选，默认 /srv/blog/state/data/backups/
#   BLOG_OFFSITE_DIR         可选，默认 ~/.local/share/blog-hosting/offsite-backups
#   BLOG_OFFSITE_KEY         可选，SSH 私钥路径；留空则走 ssh-agent / ~/.ssh/config
set -euo pipefail
cd "$(dirname "$0")/.."

source="${BLOG_OFFSITE_SOURCE:-}"
remote_path="${BLOG_OFFSITE_REMOTE_PATH:-/srv/blog/state/data/backups/}"
dest="${BLOG_OFFSITE_DIR:-$HOME/.local/share/blog-hosting/offsite-backups}"
key="${BLOG_OFFSITE_KEY:-}"
max_age_sec="${BLOG_OFFSITE_MAX_AGE_SEC:-172800}" # 48h，超过说明生产备份或拉取已经坏了

if [[ -z "$source" ]]; then
  echo '未设置 BLOG_OFFSITE_SOURCE（形如 user@host），已中止：脚本不再内置生产机地址。' >&2
  exit 2
fi

case "$key" in "~/"*) key="$HOME/${key#~/}" ;; esac
if [[ -n "$key" && ! -f "$key" ]]; then
  echo "BLOG_OFFSITE_KEY 指向的私钥不存在：$key" >&2
  exit 2
fi
mkdir -p "$dest"

# macOS 没有 flock：用目录锁防止两个 launchd 周期重叠。超过 2 小时的锁视为残留。
lock="$dest/.pull-lock"
if ! mkdir "$lock" 2>/dev/null; then
  # mkdir 失败有两种可能：锁已存在（另一轮在跑），或目录不可写/磁盘满。后者以前也被当成
  # 「已有任务」并 exit 0，备份停了很久也没人知道——只有确认锁目录真的存在才按「跳过」处理。
  if [[ ! -d "$lock" ]]; then
    echo "无法创建锁目录 ${lock}（权限或磁盘错误），本次拉取失败" >&2
    exit 1
  fi
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
if [[ -n "$key" ]]; then ssh_opts=(-i "$key" "${ssh_opts[@]}"); fi

# 拉取前先确认远端真的有备份清单。生产备份目录一旦被清空、权限配错或路径写错，
# 下面那轮 rsync 就会把这里唯一的异地副本一起删掉，而「没有清单」的检查在同步之后才做，为时已晚。
echo "[$(date '+%F %T')] 检查 $source:$remote_path 的备份清单"
remote_manifests="$(ssh "${ssh_opts[@]}" "$source" "sudo -n ls -1 '$remote_path' 2>/dev/null | grep -c '\\.json$' || true" 2>/dev/null || true)"
if [[ ! "$remote_manifests" =~ ^[0-9]+$ ]] || (( remote_manifests < 1 )); then
  echo "远端没有找到任何备份清单（*.json），已中止：不同步，也不动本地异地副本" >&2
  exit 1
fi

echo "[$(date '+%F %T')] 从 $source:$remote_path 拉取到 $dest"
# 刻意不加 --delete：生产端一次误删或误配，就会把这份唯一的异地副本同步清空，
# 「异地备份」反而变成「同步删除」。多出来的旧备份由下面的 prune_local 按份数在本地清理，
# 删什么、留什么由本地决定。共享资产包按内容哈希命名，内容未变时 rsync 照样不会重传。
# 超时必须有：网络半死时 rsync 会一直挂着，launchd 下一轮又被锁挡住，备份就静默停摆了。
rsync -az --exclude='.pull-lock/' \
  --timeout=600 --contimeout=30 \
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

# 本地保留策略：去掉 --delete 之后，生产端 prune 掉的旧备份不会自动从这里消失，得自己清。
# 按清单 mtime 留最新 BLOG_OFFSITE_KEEP 份（默认 7），资产包按内容哈希共享，只回收没人引用的。
prune_local() {
  local keep="${BLOG_OFFSITE_KEEP:-7}" n=0 f base
  while IFS= read -r f; do
    if [[ -z "$f" ]]; then continue; fi
    n=$((n + 1))
    if (( n <= keep )); then continue; fi
    base="${f%.json}"
    rm -f -- "$f" "$base.db.gz" "${base}.assets.json.gz"
  done < <(ls -1t "$dest"/*.json 2>/dev/null || true)

  local assets name m referenced
  for assets in "$dest"/*.assets.json.gz; do
    if [[ ! -e "$assets" ]]; then continue; fi
    name="$(basename "$assets")"
    referenced=0
    for m in "$dest"/*.json; do
      if [[ ! -e "$m" ]]; then continue; fi
      if grep -qF -- "$name" "$m"; then referenced=1; break; fi
    done
    if (( referenced == 0 )); then rm -f -- "$assets"; fi
  done
}
prune_local

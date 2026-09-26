#!/usr/bin/env bash
# 发布到 GitHub 公开仓库：把 master 的新提交剔除 docs/superpowers 后同步到 public 分支并推送。
#
# 两个远端的分工（2026-09-26 拍板）：
#   origin (GitHub, 公开) —— 只收净化历史，绝不出现 docs/superpowers（内部设计文档）
#   gitea (Gitea, 私有)   —— 收全量 master，日常 git push gitea master
#
# 用法：
#   bash scripts/publish-github.sh            # 增量同步 + 推送
#   bash scripts/publish-github.sh --no-push  # 只同步不推送（首次初始化/检修用）
#
# 首次初始化：.git/publish-github-base 不存在时全量重放 master 历史建 public 分支，
# 此时与远端旧历史无亲缘，首推需人工：git push --force-with-lease origin public:master。
# 注意：origin/master 与本地 master 无共同祖先（远端历史已净化改写），
#       git status 显示两者「分叉」是预期，不是要合并的冲突；
#       勿直接 git push origin master（pre-push 钩子也会拦）。
set -euo pipefail

SRC=master
PUB=public
HIDE=docs/superpowers
REMOTE=origin
PUSH=1
if [ "${1:-}" = "--no-push" ]; then PUSH=0; fi

cd "$(git rev-parse --show-toplevel)"

src_tip=$(git rev-parse "$SRC")
base=""
if [ -f "$(git rev-parse --git-dir)/publish-github-base" ]; then
  base=$(cat "$(git rev-parse --git-dir)/publish-github-base")
fi

if [ -z "$base" ]; then
  if git show-ref --verify --quiet "refs/heads/$PUB"; then
    echo "✗ 已有 $PUB 分支但没有 base 记录，状态不一致，先人工确认再跑。" >&2
    exit 1
  fi
  echo "（首次：全量重放 $SRC 全历史，剔除 $HIDE）"
  range=("$src_tip")
else
  if ! git merge-base --is-ancestor "$base" "$src_tip"; then
    echo "✗ base($base) 不是 $SRC 的祖先——master 历史被改写，增量映射会断链。" >&2
    echo "  确认后：删 $(git rev-parse --git-dir)/publish-github-base 并删 $PUB 分支重来（远端需再强推一次）。" >&2
    exit 1
  fi
  range=("$base..$src_tip")
fi

mapfile -t commits < <(git rev-list --reverse --topo-order "${range[@]}")
if [ "${#commits[@]}" -eq 0 ]; then
  echo "没有新提交，无需发布。"
  exit 0
fi

# sha → 净化后 sha 的映射表；父提交不在表里就中止——宁死不把旧历史链回来
declare -A mapped=()
tip=""
kept=0
total=${#commits[@]}

for sha in "${commits[@]}"; do
  idx="$(git rev-parse --git-dir)/publish-idx"
  GIT_INDEX_FILE=$idx git read-tree "$sha"
  # -f 必带：临时索引与工作区天然不一致，rm 的安全检查必拦；--cached 保证绝不碰工作区文件
  GIT_INDEX_FILE=$idx git rm -rqf --cached --ignore-unmatch "$HIDE"
  tree=$(GIT_INDEX_FILE=$idx git write-tree)
  rm -f "$idx"

  parr=()
  while IFS= read -r p; do
    if [ -n "$p" ]; then
      if [ -z "${mapped[$p]:-}" ]; then
        echo "✗ 内部错误：$sha 的父提交 $p 不在映射表（范围不完整），中止。" >&2
        exit 1
      fi
      parr+=("${mapped[$p]}")
    fi
  done < <(git rev-parse "$sha^@" 2>/dev/null || true)

  # 剪枝：剔除后变空的非合并提交跳过（原本就是空的故意提交保留）
  if [ ${#parr[@]} -eq 1 ]; then
    if [ "$tree" = "$(git rev-parse "${parr[0]}^{tree}")" ] \
       && [ "$(git rev-parse "$sha^{tree}")" != "$(git rev-parse "$sha^1^{tree}")" ]; then
      mapped[$sha]="${parr[0]}"
      continue
    fi
  fi

  IFS=$'\x1f' read -r an ae ad cn ce cd < <(git log -1 --format='%an%x1f%ae%x1f%aD%x1f%cn%x1f%ce%x1f%cD' "$sha")
  msg=$(git log -1 --format=%B "$sha")

  pargs=()
  for p in "${parr[@]}"; do pargs+=(-p "$p"); done
  new=$(GIT_AUTHOR_NAME="$an" GIT_AUTHOR_EMAIL="$ae" GIT_AUTHOR_DATE="$ad" \
        GIT_COMMITTER_NAME="$cn" GIT_COMMITTER_EMAIL="$ce" GIT_COMMITTER_DATE="$cd" \
        git commit-tree "$tree" ${pargs[@]+"${pargs[@]}"} -m "$msg")

  mapped[$sha]="$new"
  tip="$new"
  kept=$((kept+1))
  echo "  [$kept/$total 保留] $(git log -1 --format=%h "$sha") → ${new:0:7}"
done

git update-ref "refs/heads/$PUB" "$tip"
echo "$src_tip" > "$(git rev-parse --git-dir)/publish-github-base"
echo "✓ $PUB 分支已更新：本轮重放 $total 个提交，保留 $kept 个（只改 $HIDE 的提交被剪枝）。"

if [ "$PUSH" -eq 1 ]; then
  git push "$REMOTE" "refs/heads/$PUB:refs/heads/master"
  echo "✓ 已推送到 $REMOTE/master。"
else
  echo "（--no-push：本轮未推送。首推需人工：git push --force-with-lease origin public:master）"
fi

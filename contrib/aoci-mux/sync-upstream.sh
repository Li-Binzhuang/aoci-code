#!/usr/bin/env bash
# 合并上游更新，并立刻检查「aoci 的 MCP 工具表面」是否还能被 aoci-mux 适配。
#
# 用法：
#   ./sync-upstream.sh              # fetch + merge upstream/main + 兼容性检查
#   ./sync-upstream.sh --check      # 只检查（fetch + 对比，不 merge）
#
# 前提：在 fork 里 `git remote add upstream https://github.com/aoci-spec/aoci-code.git`
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
cd "$ROOT"

if ! git remote get-url upstream >/dev/null 2>&1; then
  echo "→ 未配置 upstream，自动添加"
  git remote add upstream https://github.com/aoci-spec/aoci-code.git
fi

echo "→ fetch upstream"
git fetch upstream --prune

BRANCH="$(git rev-parse --abbrev-ref HEAD)"
echo "→ 当前分支：$BRANCH"

if [ "${1:-}" = "--check" ]; then
  BEHIND="$(git rev-list --count "HEAD..upstream/main")"
  echo "→ 落后 upstream/main $BEHIND 个提交"
  [ "$BEHIND" = "0" ] && echo "✓ 已是最新" || git log --oneline "HEAD..upstream/main" | head -20
else
  echo "→ merge upstream/main"
  git merge --no-edit upstream/main
fi

echo "→ 兼容性检查（contrib/aoci-mux）"
cd "$ROOT/contrib/aoci-mux"
if [ ! -d node_modules ]; then
  echo "  · 首次运行，安装依赖"
  npm install --silent --no-audit --no-fund
fi
node test/compat.mjs

echo
echo "✓ 完成：上游已合并，aoci-mux 的工具表面仍然适配"
echo "  如果 compat 报出差异，说明 aoci 改了 MCP 表面 —— 先改 src/index.js 的注入逻辑，再 --update 快照。"

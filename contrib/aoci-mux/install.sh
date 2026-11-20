#!/usr/bin/env bash
# 把 contrib/aoci-mux 安装到本地（默认 ~/.local/share/aoci-mux）并装依赖。
# 安装后把宿主（DSH / Claude Code / Codex …）指向 <dest>/src/index.js 即可。
set -euo pipefail

SRC="$(cd "$(dirname "$0")" && pwd)"
DEST="${AOCI_MUX_HOME:-$HOME/.local/share/aoci-mux}"

mkdir -p "$DEST"
# 只同步运行需要的文件，别把 node_modules 也 rsync 来 rsync 去
rsync -a --delete \
  --exclude node_modules \
  --exclude '.git' \
  "$SRC"/ "$DEST"/

cd "$DEST"
if command -v npm >/dev/null 2>&1; then
  npm install --silent --no-audit --no-fund
else
  echo "✗ 找不到 npm：aoci-mux 需要 Node 20+ 的 npm 安装 @modelcontextprotocol/sdk" >&2
  exit 1
fi

echo "✓ 已安装：$DEST"
echo "  入口：$DEST/src/index.js"
echo "  配置：${AOCI_MUX_CONFIG:-$HOME/.aoci-mux.json}"
echo "  自检：node $DEST/src/index.js --selftest"

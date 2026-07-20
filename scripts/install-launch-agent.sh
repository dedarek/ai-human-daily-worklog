#!/bin/zsh
set -euo pipefail

PROJECT_DIR="$(cd "$(dirname "$0")/.." && pwd)"
NODE_BIN="$(command -v node)"
PLIST="$HOME/Library/LaunchAgents/com.local.mac-worklog-feishu.plist"

mkdir -p "$HOME/Library/LaunchAgents"
sed -e "s|__PROJECT_DIR__|$PROJECT_DIR|g" -e "s|__NODE_BIN__|$NODE_BIN|g" "$PROJECT_DIR/scripts/com.local.mac-worklog-feishu.plist.template" > "$PLIST"
launchctl bootout "gui/$(id -u)" "$PLIST" 2>/dev/null || true
launchctl bootstrap "gui/$(id -u)" "$PLIST"
echo "已安装。登录后会自动启动，日志位于 $PROJECT_DIR/data/launchd.log"

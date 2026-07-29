#!/bin/zsh
set -euo pipefail

PROJECT_DIR="$(cd "$(dirname "$0")/.." && pwd)"
DATA_DIR="${WORKLOG_DATA_DIR:-$HOME/Library/Application Support/Worklog}"
mkdir -p "$DATA_DIR/bin"
/usr/bin/swiftc "$PROJECT_DIR/native/TeamsAudioStatus.swift" -o "$DATA_DIR/bin/teams-audio-status"
/usr/bin/swiftc -parse-as-library \
  -framework AVFoundation \
  -framework CoreGraphics \
  -framework CoreMedia \
  -framework ScreenCaptureKit \
  "$PROJECT_DIR/native/SystemAudioCapture.swift" \
  -o "$DATA_DIR/bin/system-audio-capture"
echo "Teams 通话检测器和系统音频采集器已生成。"

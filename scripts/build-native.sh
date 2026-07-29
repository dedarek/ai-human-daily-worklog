#!/bin/zsh
set -euo pipefail

PROJECT_DIR="$(cd "$(dirname "$0")/.." && pwd)"
mkdir -p "$PROJECT_DIR/data/bin"
/usr/bin/swiftc "$PROJECT_DIR/native/TeamsAudioStatus.swift" -o "$PROJECT_DIR/data/bin/teams-audio-status"
/usr/bin/swiftc -parse-as-library \
  -framework AVFoundation \
  -framework CoreGraphics \
  -framework CoreMedia \
  -framework ScreenCaptureKit \
  "$PROJECT_DIR/native/SystemAudioCapture.swift" \
  -o "$PROJECT_DIR/data/bin/system-audio-capture"
echo "Teams 通话检测器和系统音频采集器已生成。"

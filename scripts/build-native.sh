#!/bin/zsh
set -euo pipefail

PROJECT_DIR="$(cd "$(dirname "$0")/.." && pwd)"
mkdir -p "$PROJECT_DIR/data/bin"
/usr/bin/swiftc "$PROJECT_DIR/native/TeamsAudioStatus.swift" -o "$PROJECT_DIR/data/bin/teams-audio-status"
echo "Teams 音频检测器已生成。"

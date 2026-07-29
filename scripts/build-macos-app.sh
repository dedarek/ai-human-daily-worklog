#!/bin/zsh
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
BUILD_ROOT="${WORKLOG_BUILD_DIR:-$ROOT/build}"
APP="$BUILD_ROOT/Worklog.app"
CONTENTS="$APP/Contents"
RESOURCES="$CONTENTS/Resources"
MACOS="$CONTENTS/MacOS"
SDK="$(xcrun --show-sdk-path)"
VERSION="${WORKLOG_VERSION:-$(node -p "require('./package.json').version")}"
BUILD_NUMBER="${WORKLOG_BUILD_NUMBER:-$(git rev-list --count HEAD 2>/dev/null || echo 1)}"
NODE_VERSION="${WORKLOG_NODE_VERSION:-24.16.0}"
NODE_BASE_URL="${WORKLOG_NODE_BASE_URL:-https://nodejs.org/dist}"
CACHE="$BUILD_ROOT/cache"

mkdir -p "$BUILD_ROOT" "$CACHE"
npm run build
rm -rf "$APP"
mkdir -p "$MACOS" "$RESOURCES/bin" "$RESOURCES/runtime" "$RESOURCES/server" "$RESOURCES/licenses"

compile_swift() {
  local arch="$1" source="$2" output="$3"; shift 3
  /usr/bin/swiftc -target "$arch-apple-macos13.0" -sdk "$SDK" "$source" "$@" -o "$output.$arch"
}

compile_swift arm64 "$ROOT/macos/WorklogApp.swift" "$BUILD_ROOT/Worklog" -parse-as-library -framework AppKit -framework WebKit -framework ServiceManagement -framework ApplicationServices
compile_swift x86_64 "$ROOT/macos/WorklogApp.swift" "$BUILD_ROOT/Worklog" -parse-as-library -framework AppKit -framework WebKit -framework ServiceManagement -framework ApplicationServices
lipo -create "$BUILD_ROOT/Worklog.arm64" "$BUILD_ROOT/Worklog.x86_64" -output "$MACOS/Worklog"

for helper_spec in "TeamsAudioStatus:teams-audio-status" "PermissionStatus:permission-status"; do
  helper="${helper_spec%%:*}"
  name="${helper_spec#*:}"
  frameworks=()
  [[ "$helper" == "PermissionStatus" ]] && frameworks=(-framework ApplicationServices -framework AppKit)
  compile_swift arm64 "$ROOT/native/$helper.swift" "$BUILD_ROOT/$name" "${frameworks[@]}"
  compile_swift x86_64 "$ROOT/native/$helper.swift" "$BUILD_ROOT/$name" "${frameworks[@]}"
  lipo -create "$BUILD_ROOT/$name.arm64" "$BUILD_ROOT/$name.x86_64" -output "$RESOURCES/bin/$name"
done

for arch in arm64 x86_64; do
  /usr/bin/swiftc -target "$arch-apple-macos13.0" -sdk "$SDK" -parse-as-library \
    -framework AVFoundation -framework CoreGraphics -framework CoreMedia -framework ScreenCaptureKit \
    "$ROOT/native/SystemAudioCapture.swift" -o "$BUILD_ROOT/system-audio-capture.$arch"
done
lipo -create "$BUILD_ROOT/system-audio-capture.arm64" "$BUILD_ROOT/system-audio-capture.x86_64" -output "$RESOURCES/bin/system-audio-capture"

SHASUMS="$CACHE/node-v$NODE_VERSION-SHASUMS256.txt"
if [[ ! -s "$SHASUMS" ]]; then
  curl --http1.1 -fsSL --retry 6 --retry-all-errors \
    "https://nodejs.org/dist/v$NODE_VERSION/SHASUMS256.txt" -o "$SHASUMS.download"
  mv "$SHASUMS.download" "$SHASUMS"
fi

for arch in arm64 x64; do
  archive="$CACHE/node-v$NODE_VERSION-darwin-$arch.tar.gz"
  directory="$CACHE/node-v$NODE_VERSION-darwin-$arch"
  filename="${archive:t}"
  expected="$(awk -v file="$filename" '$2 == file { print $1 }' "$SHASUMS")"
  [[ -n "$expected" ]] || { echo "Node 官方校验表中没有 $filename" >&2; exit 1; }
  actual="$(shasum -a 256 "$archive" 2>/dev/null | awk '{ print $1 }' || true)"
  if [[ "$actual" != "$expected" ]]; then
    partial="$archive.download"
    rm -f "$archive"
    if ! curl --http1.1 -fL -C - --retry 10 --retry-delay 2 --retry-all-errors \
      "$NODE_BASE_URL/v$NODE_VERSION/$filename" -o "$partial"; then
      rm -f "$partial"
      curl --http1.1 -fL --retry 10 --retry-delay 2 --retry-all-errors \
        "$NODE_BASE_URL/v$NODE_VERSION/$filename" -o "$partial"
    fi
    actual="$(shasum -a 256 "$partial" | awk '{ print $1 }')"
    [[ "$actual" == "$expected" ]] || { echo "$filename 的 SHA-256 校验失败" >&2; exit 1; }
    tar -tzf "$partial" >/dev/null
    mv "$partial" "$archive"
  fi
  [[ -d "$directory" ]] || tar -xzf "$archive" -C "$CACHE"
done
lipo -create "$CACHE/node-v$NODE_VERSION-darwin-arm64/bin/node" "$CACHE/node-v$NODE_VERSION-darwin-x64/bin/node" -output "$RESOURCES/runtime/node"
/usr/bin/strip -S "$RESOURCES/runtime/node"

cp -R "$ROOT/dist" "$ROOT/public" "$ROOT/package.json" "$ROOT/package-lock.json" "$RESOURCES/server/"
(cd "$RESOURCES/server" && npm ci --omit=dev --ignore-scripts --no-audit --no-fund)
cp "$CACHE/node-v$NODE_VERSION-darwin-arm64/LICENSE" "$RESOURCES/licenses/Node.js-LICENSE"
cp "$RESOURCES/server/node_modules/@larksuite/cli/LICENSE" "$RESOURCES/licenses/Feishu-CLI-LICENSE"

if [[ "${WORKLOG_SKIP_WHISPER:-0}" != "1" ]]; then
  "$ROOT/scripts/build-whisper-universal.sh" "$RESOURCES/bin/whisper-cli"
  cp "$BUILD_ROOT/whisper/source/LICENSE" "$RESOURCES/licenses/whisper.cpp-LICENSE"
fi

sed -e "s/__VERSION__/$VERSION/g" -e "s/__BUILD__/$BUILD_NUMBER/g" "$ROOT/macos/Info.plist" > "$CONTENTS/Info.plist"
if command -v qlmanage >/dev/null; then
  icon_tmp="$BUILD_ROOT/icon"
  rm -rf "$icon_tmp"; mkdir -p "$icon_tmp/AppIcon.iconset"
  qlmanage -t -s 1024 -o "$icon_tmp" "$ROOT/macos/AppIcon.svg" >/dev/null 2>&1
  source_icon="$icon_tmp/AppIcon.svg.png"
  for spec in "16 icon_16x16" "32 icon_16x16@2x" "32 icon_32x32" "64 icon_32x32@2x" "128 icon_128x128" "256 icon_128x128@2x" "256 icon_256x256" "512 icon_256x256@2x" "512 icon_512x512" "1024 icon_512x512@2x"; do
    size="${spec%% *}"; name="${spec#* }"; sips -z "$size" "$size" "$source_icon" --out "$icon_tmp/AppIcon.iconset/$name.png" >/dev/null
  done
  if ! iconutil -c icns "$icon_tmp/AppIcon.iconset" -o "$RESOURCES/AppIcon.icns"; then
    sleep 1
    iconutil -c icns "$icon_tmp/AppIcon.iconset" -o "$RESOURCES/AppIcon.icns"
  fi
fi

chmod +x "$MACOS/Worklog" "$RESOURCES/runtime/node" "$RESOURCES/bin/"*
if [[ "${WORKLOG_SKIP_ADHOC_SIGN:-0}" != "1" ]]; then
  codesign --force --options runtime --timestamp=none --sign - --entitlements "$ROOT/macos/Node.entitlements" "$RESOURCES/runtime/node"
  for binary in "$RESOURCES/bin/"*; do codesign --force --options runtime --timestamp=none --sign - "$binary"; done
  codesign --force --options runtime --timestamp=none --sign - --entitlements "$ROOT/macos/Worklog.entitlements" "$APP"
  codesign --verify --deep --strict "$APP"
fi
echo "$APP"
lipo -archs "$MACOS/Worklog"
lipo -archs "$RESOURCES/runtime/node"
for binary in "$RESOURCES/bin/"*; do echo "$(basename "$binary"): $(lipo -archs "$binary")"; done

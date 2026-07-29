#!/bin/zsh
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
BUILD_ROOT="${WORKLOG_BUILD_DIR:-$ROOT/build}"
RELEASE_ROOT="${WORKLOG_RELEASE_DIR:-$ROOT/release}"
IDENTITY="${SIGN_IDENTITY:--}"
VERSION="${WORKLOG_VERSION:-$(node -p "require('./package.json').version")}"
APP="$BUILD_ROOT/Worklog.app"
if [[ "$IDENTITY" == "-" ]]; then
  DMG="$RELEASE_ROOT/Worklog-$VERSION-universal-unsigned.dmg"
else
  DMG="$RELEASE_ROOT/Worklog-$VERSION-universal.dmg"
fi

"$ROOT/scripts/build-macos-app.sh"
sign_args=(--force --options runtime)
if [[ "$IDENTITY" != "-" ]]; then sign_args+=(--timestamp); else sign_args+=(--timestamp=none); fi

codesign "${sign_args[@]}" --sign "$IDENTITY" --entitlements "$ROOT/macos/Node.entitlements" "$APP/Contents/Resources/runtime/node"
for binary in "$APP/Contents/Resources/bin/"*; do codesign "${sign_args[@]}" --sign "$IDENTITY" "$binary"; done
codesign "${sign_args[@]}" --sign "$IDENTITY" --entitlements "$ROOT/macos/Worklog.entitlements" "$APP"
codesign --verify --deep --strict --verbose=2 "$APP"

mkdir -p "$RELEASE_ROOT"
staging="$BUILD_ROOT/dmg"
rm -rf "$staging" "$DMG"
mkdir -p "$staging"
cp -R "$APP" "$staging/"
ln -s /Applications "$staging/Applications"
for attempt in 1 2 3; do
  if hdiutil create -volname "Worklog" -srcfolder "$staging" -ov -format UDZO "$DMG" >/dev/null; then break; fi
  rm -f "$DMG"
  [[ "$attempt" == 3 ]] && { echo "DMG creation failed after $attempt attempts" >&2; exit 1; }
  sleep $((attempt * 3))
done
dmg_sign_args=(--force)
if [[ "$IDENTITY" != "-" ]]; then dmg_sign_args+=(--timestamp); else dmg_sign_args+=(--timestamp=none); fi
codesign "${dmg_sign_args[@]}" --sign "$IDENTITY" "$DMG"
echo "$DMG"

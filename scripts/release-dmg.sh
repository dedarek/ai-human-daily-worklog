#!/bin/zsh
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
: "${SIGN_IDENTITY:?请设置 SIGN_IDENTITY，例如 Developer ID Application: Your Name (TEAMID)}"
: "${NOTARY_PROFILE:?请设置 NOTARY_PROFILE，并先用 notarytool store-credentials 保存凭据}"

"$ROOT/scripts/build-dmg.sh"
VERSION="${WORKLOG_VERSION:-$(node -p "require('./package.json').version")}"
DMG="${WORKLOG_RELEASE_DIR:-$ROOT/release}/Worklog-$VERSION-universal.dmg"
xcrun notarytool submit "$DMG" --keychain-profile "$NOTARY_PROFILE" --wait
xcrun stapler staple "$DMG"
xcrun stapler validate "$DMG"
spctl --assess --type open --context context:primary-signature --verbose=4 "$DMG"
echo "已签名并公证：$DMG"

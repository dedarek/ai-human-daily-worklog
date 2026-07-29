#!/bin/zsh
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
BUILD_ROOT="${WORKLOG_BUILD_DIR:-$ROOT/build}/whisper"
SOURCE="$BUILD_ROOT/source"
OUTPUT="${1:-$BUILD_ROOT/whisper-cli}"
VERSION="${WHISPER_CPP_VERSION:-v1.9.1}"

command -v cmake >/dev/null || { echo "需要 CMake：brew install cmake" >&2; exit 1; }
mkdir -p "$BUILD_ROOT" "$(dirname "$OUTPUT")"
if [[ ! -d "$SOURCE/.git" ]]; then
  git clone --depth 1 --branch "$VERSION" https://github.com/ggml-org/whisper.cpp.git "$SOURCE"
fi

for arch in arm64 x86_64; do
  cmake -S "$SOURCE" -B "$BUILD_ROOT/$arch" \
    -DCMAKE_BUILD_TYPE=Release \
    -DCMAKE_OSX_ARCHITECTURES="$arch" \
    -DCMAKE_OSX_DEPLOYMENT_TARGET=13.0 \
    -DBUILD_SHARED_LIBS=OFF \
    -DGGML_BLAS=OFF \
    -DGGML_NATIVE=OFF \
    -DWHISPER_BUILD_TESTS=OFF \
    -DWHISPER_BUILD_EXAMPLES=ON
  cmake --build "$BUILD_ROOT/$arch" --config Release --target whisper-cli -j "$(sysctl -n hw.logicalcpu)"
done

ARM_BINARY="$(find "$BUILD_ROOT/arm64" -type f -name whisper-cli -perm +111 | head -1)"
INTEL_BINARY="$(find "$BUILD_ROOT/x86_64" -type f -name whisper-cli -perm +111 | head -1)"
[[ -n "$ARM_BINARY" && -n "$INTEL_BINARY" ]] || { echo "未找到 Whisper CLI 构建产物" >&2; exit 1; }
lipo -create "$ARM_BINARY" "$INTEL_BINARY" -output "$OUTPUT"
chmod +x "$OUTPUT"
lipo -archs "$OUTPUT"

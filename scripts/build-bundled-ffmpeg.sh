#!/bin/bash
set -euo pipefail

# Build the LGPL-only ffmpeg sidecar used by Beatboard. The build intentionally
# excludes GPL/nonfree components and uses Apple's VideoToolbox encoder.

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
FFMPEG_TAG="n8.1.2"
FFMPEG_COMMIT="38b88335f99e76ed89ff3c93f877fdefce736c13"

case "$(uname -m)" in
  arm64) TARGET="aarch64-apple-darwin" ;;
  x86_64) TARGET="x86_64-apple-darwin" ;;
  *) echo "Unsupported macOS architecture: $(uname -m)" >&2; exit 1 ;;
esac

OUT="$ROOT/src-tauri/binaries/ffmpeg-$TARGET"

validate_ffmpeg() {
  local encoders buildconf
  [ -x "$OUT" ] || return 1
  file "$OUT" | grep -q 'Mach-O' || return 1
  encoders="$("$OUT" -hide_banner -encoders 2>/dev/null)"
  buildconf="$("$OUT" -buildconf 2>&1)"
  [[ "$encoders" == *h264_videotoolbox* ]] || return 1
  [[ "$encoders" == *" mpeg4 "* ]] || return 1
  [[ "$buildconf" != *--enable-gpl* ]] || return 1
  [[ "$buildconf" != *--enable-nonfree* ]] || return 1
}

if [ "${1:-}" != "--force" ] && validate_ffmpeg; then
  echo "Beatboard ffmpeg sidecar already exists: $OUT"
  exit 0
fi

if ! xcode-select -p >/dev/null 2>&1; then
  echo "Xcode Command Line Tools are required to build the release sidecar." >&2
  exit 1
fi

WORK="$(mktemp -d "${TMPDIR:-/tmp}/beatboard-ffmpeg.XXXXXX")"
trap 'rm -rf "$WORK"' EXIT

git clone --quiet --depth 1 --branch "$FFMPEG_TAG" https://git.ffmpeg.org/ffmpeg.git "$WORK/ffmpeg"
ACTUAL_COMMIT="$(git -C "$WORK/ffmpeg" rev-parse HEAD)"
if [ "$ACTUAL_COMMIT" != "$FFMPEG_COMMIT" ]; then
  echo "FFmpeg source verification failed: expected $FFMPEG_COMMIT, got $ACTUAL_COMMIT" >&2
  exit 1
fi

cd "$WORK/ffmpeg"
CONFIGURE_ARGS=(
  --disable-gpl
  --disable-nonfree
  --disable-doc
  --disable-debug
  --disable-ffplay
  --disable-ffprobe
  --disable-shared
  --enable-static
  --enable-videotoolbox
  --enable-audiotoolbox
  --cc=clang
)
if [ "$TARGET" = "x86_64-apple-darwin" ]; then
  CONFIGURE_ARGS+=(--disable-x86asm)
fi

./configure "${CONFIGURE_ARGS[@]}"
make -j"$(sysctl -n hw.logicalcpu)" ffmpeg

mkdir -p "$(dirname "$OUT")"
cp ffmpeg "$OUT"
chmod 755 "$OUT"
strip -x "$OUT"

if ! validate_ffmpeg; then
  echo "Built ffmpeg failed the Mach-O, encoder, or LGPL-only validation" >&2
  exit 1
fi

echo "Built Beatboard ffmpeg sidecar: $OUT"

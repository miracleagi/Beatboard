#!/bin/bash
export PATH="$HOME/.cargo/bin:/opt/homebrew/bin:/usr/local/bin:$PATH"
cd "$(dirname "$0")"

# Sync src/ → web/src/ so Tauri's dev server can serve the files directly.
# (A symlink doesn't work because Tauri's static server won't follow links
#  that cross the web-root boundary.)
rm -rf web/src && cp -r src web/src

cd src-tauri
cargo tauri dev

#!/bin/bash
export PATH="$HOME/.cargo/bin:/opt/homebrew/bin:/usr/local/bin:$PATH"
cd "$(dirname "$0")"

# Homebrew rustup can have an active toolchain without installing ~/.cargo/bin
# shims. Add that toolchain's bin directory so cargo/rustc are still available.
if ! command -v cargo >/dev/null 2>&1 && command -v rustup >/dev/null 2>&1; then
  RUST_TOOLCHAIN_BIN="$(dirname "$(rustup which cargo)")"
  export PATH="$RUST_TOOLCHAIN_BIN:$PATH"
fi

# Sync src/ → web/src/ so Tauri's dev server can serve the files directly.
# (A symlink doesn't work because Tauri's static server won't follow links
#  that cross the web-root boundary.)
rm -rf web/src && cp -r src web/src

cd src-tauri
cargo tauri dev

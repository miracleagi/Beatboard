#!/bin/zsh
set -euo pipefail

cd "$(dirname "$0")"

if ! command -v node >/dev/null 2>&1; then
  echo "Node.js 20+ is required. Install Node, then run this again."
  read -r "?Press Return to close."
  exit 1
fi

port="${ATLAS_PORT:-4173}"
while lsof -nP -iTCP:"$port" -sTCP:LISTEN >/dev/null 2>&1; do
  port=$((port + 1))
done

ATLAS_PORT="$port" node atlas-helper.mjs &
server_pid=$!

cleanup() {
  kill "$server_pid" >/dev/null 2>&1 || true
}
trap cleanup EXIT INT TERM

open "http://127.0.0.1:$port/Atlas.html"
wait "$server_pid"

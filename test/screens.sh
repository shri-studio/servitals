#!/usr/bin/env bash
# SPDX-License-Identifier: AGPL-3.0-or-later
# Screenshot the page in every style and mode (spec 16) with a demo hub of
# three servers, in the Playwright image. Fails on any page or console error.
# Look at build/screens/sheet-*.png (CI uploads them as an artifact).
set -euo pipefail
SRC="$(cd "$(dirname "$0")/.." && pwd)"
IMAGE="${PLAYWRIGHT_IMAGE:-mcr.microsoft.com/playwright:v1.55.0-noble}"
PORT="${SCREENS_PORT:-20090}"
OUT="$SRC/build/screens"
rm -rf "$OUT"
mkdir -p "$OUT"
log=$(mktemp)
node "$SRC/test/screens/demo-hub.js" "$PORT" > "$log" 2>&1 &
hub=$!
trap 'kill "$hub" 2>/dev/null; rm -f "$log"' EXIT
for _ in $(seq 1 60); do grep -q READY "$log" && break; kill -0 "$hub" 2>/dev/null || break; sleep 1; done
grep -q READY "$log" || { cat "$log"; echo "demo hub did not start"; exit 1; }
docker run --rm --network host -u "$(id -u):$(id -g)" -e HOME=/tmp -v "$SRC/test/screens:/screens:ro" -v "$OUT:/out" "$IMAGE" \
  bash -c 'cd /tmp && npm init -y >/dev/null && npm install --silent --no-audit --no-fund playwright@1.55.0 >/dev/null && cp /screens/shoot.js . && node shoot.js "$0" /out' \
  "http://127.0.0.1:$PORT"

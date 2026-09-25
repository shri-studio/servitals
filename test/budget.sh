#!/usr/bin/env bash
# SPDX-License-Identifier: AGPL-3.0-or-later
# Lightness budget (spec section 18). One line per check; exits 1 on any breach.
set -euo pipefail
cd "$(dirname "$0")/.."

fail=0
check() {  # name value limit unit
  if [ "$2" -le "$3" ]; then
    printf 'ok    %-40s %8s <= %s %s\n' "$1" "$2" "$3" "$4"
  else
    printf 'FAIL  %-40s %8s >  %s %s\n' "$1" "$2" "$3" "$4"
    fail=1
  fi
}

# 1. runtime dependencies: no package.json may declare dependencies
deps=0
while IFS= read -r f; do
  [ -n "$f" ] || continue
  n=$(jq '(.dependencies // {}) | length' "$f")
  deps=$((deps + n))
done < <(git ls-files '*package.json')
check "runtime dependencies" "$deps" 0 "packages"

# 2. first page load, gzipped, fonts excluded
page=$(gzip -9 -c www/index.html | wc -c)
check "first page load (gzip, no fonts)" "$page" 61440 "bytes"

# 3. gateway steady-state anonymous memory
data=$(mktemp -d)
port=$(node -e 'const s=require("net").createServer().listen(0,()=>{console.log(s.address().port);s.close()})')
PORT=$port DATA_DIR=$data AUTH_PASS=budget-check-pass UPSTREAM=http://127.0.0.1:9 LOG_LEVEL=error \
  node hub/server.js >/dev/null 2>&1 &
pid=$!
for _ in $(seq 1 50); do
  curl -fsS "http://127.0.0.1:$port/__auth/health" >/dev/null 2>&1 && break
  sleep 0.1
done
sleep 2
anon=$(awk '/^RssAnon:/ {print $2}' "/proc/$pid/status")
kill "$pid"; wait "$pid" 2>/dev/null || true
rm -rf "$data"
check "gateway RssAnon (idle)" "$anon" 40960 "kB"

# 4. agent tick CPU and peak memory, Docker off. A stub `docker` first in PATH
# makes the agent behave as on a host without Docker access. (With Docker on,
# the Docker CLI briefly adds ~29 MB; sub-project 2 replaces it with
# `curl --unix-socket`.)
out=$(mktemp)
state=$(mktemp -d)
export STATE_DIR="$state"
stub=$(mktemp -d)
printf '#!/bin/sh\nexit 1\n' > "$stub/docker"; chmod +x "$stub/docker"
export PATH="$stub:$PATH"
TIMEFORMAT='%U %S'
cpu=$( { time HOST_ROOT=/ OUT_FILE="$out" ONCE=1 DISKS=/ DOCKER_HOST=unix:///nonexistent \
          bash agent/collect.sh >/dev/null 2>&1; } 2>&1 | awk '{printf "%d", ($1 + $2) * 1000}')
check "agent tick CPU (user+sys)" "$cpu" 400 "ms"
if [ -x /usr/bin/time ]; then
  tfile=$(mktemp)
  /usr/bin/time -f '%M' -o "$tfile" env HOST_ROOT=/ OUT_FILE="$out" ONCE=1 DISKS=/ \
    DOCKER_HOST=unix:///nonexistent bash agent/collect.sh >/dev/null 2>&1
  peak=$(tail -n 1 "$tfile"); rm -f "$tfile"
  check "agent peak RSS (whole process tree)" "$peak" 10240 "kB"
else
  echo "FAIL  agent peak RSS: /usr/bin/time not installed (apt install time)"
  fail=1
fi
rm -rf "$out" "$stub" "$state"

exit "$fail"

#!/usr/bin/env bash
# SPDX-License-Identifier: AGPL-3.0-or-later
# Build and start the Docker install from a throwaway copy of the working tree
# (never the checkout itself: a live instance may use its data/ and www/),
# then check login, Origin enforcement and proxy trust. Cleans up after itself.
set -euo pipefail

SRC="$(cd "$(dirname "$0")/.." && pwd)"
PORT="${SMOKE_PORT:-20099}"
PASS="smoke-password-123"
BASE="http://127.0.0.1:$PORT"
WORK="$(mktemp -d)"
PROJECT="servitals-smoke"

cleanup() {
  if [ "${SMOKE_KEEP:-0}" = "1" ]; then
    echo "SMOKE_KEEP=1: stack left running on $BASE (user admin, password $PASS)"
    echo "tear down with: (cd $WORK && docker compose -p $PROJECT down -v) &&" \
         "docker run --rm -v $WORK:/w alpine:3.20 rm -rf /w/data /w/www && rm -rf $WORK"
    return
  fi
  (cd "$WORK" && docker compose -p "$PROJECT" down -v --remove-orphans >/dev/null 2>&1) || true
  # the containers write data/ and www/ as root; delete those through a container
  docker run --rm -v "$WORK:/w" alpine:3.20 rm -rf /w/data /w/www >/dev/null 2>&1 || true
  rm -rf "$WORK"
}
trap cleanup EXIT

# copy the working tree: tracked and untracked files, minus git-ignored ones
# (so a checkout's data/, .env and docker-compose.yml never leak in)
(cd "$SRC" && git ls-files -z --cached --others --exclude-standard) |
  while IFS= read -r -d '' f; do
    [ -e "$SRC/$f" ] && (cd "$SRC" && cp --parents -- "$f" "$WORK/")
  done
cd "$WORK"
cp docker-compose.example.yml docker-compose.yml
cp www/config.example.json www/config.json
cat > .env <<EOF
PORT=$PORT
BIND_ADDR=127.0.0.1
AUTH_USER=admin
AUTH_PASS=$PASS
DISKS=/
EOF
# unique container names and subnet, so a running install on this host is
# never touched and its pinned network (172.31.250.0/24) does not collide
sed -i -e 's/container_name: servitals-/container_name: servitals-smoke-/' \
       -e 's#172\.31\.250\.#172.31.251.#g' docker-compose.yml

docker compose -p "$PROJECT" up -d --build

for _ in $(seq 1 60); do
  curl -fsS "$BASE/__auth/health" >/dev/null 2>&1 && break
  sleep 1
done
[ "$(curl -fsS "$BASE/__auth/health")" = "ok" ] || { echo "gateway not healthy"; exit 1; }

fail() { echo "FAIL: $*"; docker compose -p "$PROJECT" logs gateway | tail -40; exit 1; }

code=$(curl -s -o /dev/null -w '%{http_code}' -X POST --data "username=admin&password=$PASS" "$BASE/__auth/login")
[ "$code" = 403 ] || fail "login without Origin: expected 403, got $code"

jar="$WORK/cookies"
code=$(curl -s -o /dev/null -w '%{http_code}' -c "$jar" -H "Origin: $BASE" -X POST \
  --data "username=admin&password=$PASS" "$BASE/__auth/login")
[ "$code" = 302 ] || fail "login: expected 302, got $code"
grep -q sv_session "$jar" || fail "no sv_session cookie"

# capture first: `curl | grep -q` fails under pipefail when grep exits early
page=$(curl -fsS -b "$jar" "$BASE/")
grep -q '<title>servitals</title>' <<<"$page" || fail "page not served through nginx"

# host connections arrive from the network gateway 172.31.251.1, a trusted proxy:
# without a header the client is proxy-only (not LAN), with one it is the header's address
who=$(curl -fsS -b "$jar" "$BASE/__ctl/whoami")
[ "$(echo "$who" | jq -r .lan)" = false ] || fail "proxy-only request treated as LAN: $who"
[ "$(echo "$who" | jq -r .version)" = "$(cat VERSION)" ] || fail "image reports the wrong version: $who"
who=$(curl -fsS -b "$jar" -H 'X-Forwarded-For: 203.0.113.50' "$BASE/__ctl/whoami")
[ "$(echo "$who" | jq -r .ip)" = 203.0.113.50 ] || fail "forwarded address not used: $who"

# the agent produced a snapshot
for _ in $(seq 1 30); do
  curl -fsS -b "$jar" "$BASE/data.json" 2>/dev/null | jq -e '.host.name' >/dev/null && break
  sleep 1
done
curl -fsS -b "$jar" "$BASE/data.json" | jq -e '.host.name' >/dev/null || fail "no data.json from the agent"

echo "compose smoke test passed"

#!/usr/bin/env bash
# SPDX-License-Identifier: AGPL-3.0-or-later
# Run packaging/install-local.sh in a throwaway Ubuntu container (systemctl is
# replaced by test/helpers/fake-systemctl): a fresh install picks the sudo user
# as the admin name, and --import-docker reproduces an old Docker install's
# login, settings and disks without asking anything.
set -euo pipefail
SRC="$(cd "$(dirname "$0")/.." && pwd)"
IMAGE="${INSTALL_SMOKE_IMAGE:-ubuntu:26.04}"

docker run --rm -i -v "$SRC:/src:ro" -v "$SRC/test/helpers/fake-systemctl:/usr/local/bin/systemctl:ro" \
  "$IMAGE" bash -s <<'IN_CONTAINER'
set -euo pipefail
apt-get -qq update >/dev/null && apt-get -qq install -y nodejs jq curl systemd procps util-linux >/dev/null 2>&1
fail() { echo "FAIL: $*"; tail -20 /tmp/hub.log /tmp/agent.log 2>/dev/null; exit 1; }
login() {  # user pass -> HTTP status of the login POST
  curl -s -o /dev/null -w '%{http_code}' -c /tmp/jar -H "Origin: http://127.0.0.1:$PORT" \
    --data-urlencode "username=$1" --data-urlencode "password=$2" "http://127.0.0.1:$PORT/__auth/login"
}

# 1. fresh install: the admin name defaults to the user who ran sudo
PORT=20012
SUDO_USER=alice ADMIN_PASSWORD=fresh-pass-123 HUB_PORT=$PORT bash /src/packaging/install-local.sh > /tmp/install1.log 2>&1 \
  || { cat /tmp/install1.log; fail "fresh install"; }
grep -q '^AUTH_USER=alice$' /etc/servitals/hub.env || fail "admin name is not the sudo user"
grep -q 'log in as: alice' /tmp/install1.log || fail "installer does not say which user to log in as"
[ "$(login alice fresh-pass-123)" = 302 ] || fail "fresh login"
SUDO_USER='bad name;' ADMIN_PASSWORD=fresh-pass-123 HUB_PORT=$PORT bash /src/packaging/install-local.sh --uninstall >/dev/null
rm -rf /etc/servitals /var/lib/servitals /var/lib/servitals-agent
if ADMIN_USER='bad name;' ADMIN_PASSWORD=fresh-pass-123 bash /src/packaging/install-local.sh > /tmp/install2.log 2>&1; then
  fail "a username with spaces and ; was accepted"
fi
rm -rf /etc/servitals

# 2. --import-docker: no questions, same login, same settings and disks
mkdir -p /tmp/old/www /tmp/old/data
printf 'AUTH_USER=rishabha\nAUTH_PASS="old pass"\nDISKS=/\nNET_IFACE=eth9\nSITE_NAME=lab\n' > /tmp/old/.env
echo '{"title":"from docker","disks":{"/":{"label":"root disk"}}}' > /tmp/old/www/config.json
printf '10.9.9.9\n' > /tmp/old/data/whitelist.txt
HUB_PORT=$PORT bash /src/packaging/install-local.sh --import-docker /tmp/old < /dev/null > /tmp/install3.log 2>&1 \
  || { cat /tmp/install3.log; fail "install with --import-docker"; }
grep -q 'log in as: rishabha' /tmp/install3.log || fail "imported user not reported"
[ "$(login rishabha 'old pass')" = 302 ] || fail "imported login"
[ "$(curl -s -b /tmp/jar "http://127.0.0.1:$PORT/config.json" | jq -r .title)" = "from docker" ] || fail "imported config.json"
grep -q '^DISKS=/$' /etc/servitals/agent.env || fail "imported DISKS"
grep -q '^10\.9\.9\.9$' /var/lib/servitals/whitelist.txt || fail "imported whitelist"
[ "$(stat -c %U /var/lib/servitals/config.json)" = _servitals ] || fail "imported files not owned by the hub user"
echo "install smoke test passed"
IN_CONTAINER

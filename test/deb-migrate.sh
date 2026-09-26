#!/usr/bin/env bash
# SPDX-License-Identifier: AGPL-3.0-or-later
# Moving a host from packaging/install-local.sh to the Ubuntu packages keeps
# the login, the local node and the agent's credentials. Runs in an Ubuntu
# container with test/helpers/fake-systemctl, on packages from build-deb.sh.
#   test/deb-migrate.sh [series]              default: resolute
set -euo pipefail
SRC="$(cd "$(dirname "$0")/.." && pwd)"
# shellcheck source=packaging/series.sh
. "$SRC/packaging/series.sh"
series=${1:-resolute}
debs="${OUT_DIR:-$SRC/build/deb}/$series"
ls "$debs"/servitals_*.deb >/dev/null || { echo "build the packages first: packaging/build-deb.sh $series"; exit 1; }

docker run --rm -i -v "$SRC:/src:ro" -v "$debs:/debs:ro" \
  -v "$SRC/test/helpers/fake-systemctl:/usr/local/bin/systemctl:ro" "$(series_image "$series")" bash -s <<'IN_CONTAINER'
set -euo pipefail
export DEBIAN_FRONTEND=noninteractive
apt-get -qq update >/dev/null && apt-get -qq install -y nodejs jq curl systemd procps util-linux >/dev/null 2>&1
fail() { echo "FAIL: $*"; tail -20 /tmp/hub.log 2>/dev/null; exit 1; }
B=http://127.0.0.1:20002
login() {
  curl -s -o /dev/null -w '%{http_code}' -H "Origin: $B" \
    --data-urlencode "username=$1" --data-urlencode "password=$2" "$B/__auth/login"
}
wait_health() { for _ in $(seq 1 50); do curl -fsS "$B/__auth/health" >/dev/null 2>&1 && return 0; sleep 0.2; done; return 1; }

ADMIN_USER=rishabha ADMIN_PASSWORD=migrate-pass-1 bash /src/packaging/install-local.sh >/tmp/install.log 2>&1 \
  || { cat /tmp/install.log; fail "install-local"; }
[ "$(login rishabha migrate-pass-1)" = 302 ] || fail "login before the move"
node_id=$(sed -n 's/^NODE_ID=//p' /etc/servitals/agent-credentials.env)

bash /src/packaging/install-local.sh --uninstall >/dev/null
apt-get install -y -o Dpkg::Options::=--force-confold /debs/*.deb >/tmp/apt.log 2>&1 || { tail -30 /tmp/apt.log; fail "apt install"; }
systemctl restart servitals.service
wait_health || fail "hub after the move"

[ "$(login rishabha migrate-pass-1)" = 302 ] || fail "login after the move"
[ ! -e /var/lib/servitals/admin.json ] || fail "postinst created a second login"
[ ! -e /var/lib/servitals/initial-password ] || fail "postinst wrote an initial password"
[ "$(sed -n 's/^NODE_ID=//p' /etc/servitals/agent-credentials.env)" = "$node_id" ] || fail "agent credentials changed"
dpkg -S /usr/share/servitals/hub/server.js >/dev/null || fail "hub files not owned by the package"
[ ! -e /etc/systemd/system/servitals.service ] || fail "old unit left in /etc/systemd/system"
echo "deb migration test passed"
IN_CONTAINER

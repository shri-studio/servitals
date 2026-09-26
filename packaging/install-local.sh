#!/usr/bin/env bash
# SPDX-License-Identifier: AGPL-3.0-or-later
# Install servitals from this checkout as native systemd services, in the
# layout the Ubuntu packages use. For development, and for hosts that run
# from a checkout until the PPA exists.
#   sudo packaging/install-local.sh                     install or upgrade
#   sudo packaging/install-local.sh --import-docker DIR also copy login, settings and
#                                                       disks from a Docker install in DIR
#   sudo packaging/install-local.sh --uninstall         remove programs and units;
#                                                       keeps /etc/servitals, state and users
# First install only: HUB_PORT (default 20002) goes into /etc/servitals/hub.env,
# and the admin name and password are asked for (the name defaults to the user
# who ran sudo). ADMIN_USER and ADMIN_PASSWORD answer those questions for
# scripts. With --import-docker the Docker install's login is used instead.
# Later runs only change /etc/servitals through --import-docker.
set -euo pipefail

SRC="$(cd "$(dirname "$(readlink -f "$0")")/.." && pwd)"
SHARE=/usr/share/servitals
AGENT_LIB=/usr/lib/servitals-agent
ETC=/etc/servitals
UNITS=/etc/systemd/system

die() { echo "install-local: $*" >&2; exit 1; }
[ "$(id -u)" = 0 ] || die "run as root: sudo $0"

IMPORT=""
case "${1:-}" in
  --import-docker) IMPORT=${2:-}; [ -d "$IMPORT" ] || die "usage: $0 --import-docker <docker-install-dir>" ;;
  --uninstall|"") ;;
  *) die "unknown option $1" ;;
esac

if [ "${1:-}" = --uninstall ]; then
  systemctl disable --now servitals-agent.service servitals.service 2>/dev/null || true
  rm -rf "$SHARE" "$AGENT_LIB" "$UNITS/servitals.service.d" "$UNITS/servitals-agent.service.d"
  rm -f "$UNITS/servitals.service" "$UNITS/servitals-agent.service" \
        /usr/bin/servitals-ctl /usr/bin/servitals-agent \
        /usr/lib/sysusers.d/servitals.conf /usr/lib/sysusers.d/servitals-agent.conf
  systemctl daemon-reload
  echo "removed. kept: $ETC, /var/lib/servitals, /var/lib/servitals-agent and the system users"
  exit 0
fi

# 1. requirements
[ -x /usr/bin/node ] || die "needs Node.js 18 or newer at /usr/bin/node: apt install nodejs"
major=$(/usr/bin/node -p 'process.versions.node.split(".")[0]')
[ "$major" -ge 18 ] || die "Node.js $major is too old, need 18 or newer"
for t in jq curl timeout sha256sum systemd-sysusers; do
  command -v "$t" >/dev/null || die "missing $t (apt install jq curl coreutils systemd)"
done

# 2. programs (replaced whole, so files removed upstream do not linger)
rm -rf "$SHARE/hub" "$SHARE/www" "$AGENT_LIB"
install -d -m 755 "$SHARE/hub/lib" "$SHARE/www" "$AGENT_LIB/lib"
install -m 644 "$SRC/hub/server.js" "$SHARE/hub/"
install -m 644 "$SRC"/hub/lib/*.js "$SHARE/hub/lib/"
install -m 644 "$SRC/VERSION" "$SHARE/VERSION"
# shipped web files only, never a Docker install's config.json or data.json
install -m 644 "$SRC/www/index.html" "$SRC/www/config.example.json" "$SHARE/www/"
cp -r "$SRC/www/fonts" "$SHARE/www/fonts"
chmod -R u=rwX,go=rX "$SHARE/www/fonts"
install -m 755 "$SRC/agent/collect.sh" "$AGENT_LIB/"
install -m 644 "$SRC"/agent/lib/*.sh "$AGENT_LIB/lib/"
install -m 644 "$SRC/VERSION" "$AGENT_LIB/VERSION"
install -m 755 "$SRC/bin/servitals-ctl" "$SRC/bin/servitals-agent" /usr/bin/

# 3. system users
install -m 644 "$SRC/debian/servitals.sysusers" /usr/lib/sysusers.d/servitals.conf
install -m 644 "$SRC/debian/servitals-agent.sysusers" /usr/lib/sysusers.d/servitals-agent.conf
systemd-sysusers /usr/lib/sysusers.d/servitals.conf /usr/lib/sysusers.d/servitals-agent.conf

# 4. configuration, first install only
install -d -m 755 "$ETC"
if [ ! -e "$ETC/hub.env" ]; then
  port=${HUB_PORT:-20002}
  [[ $port =~ ^[0-9]{1,5}$ ]] || die "HUB_PORT must be a port number"
  if [ -n "$IMPORT" ] && grep -qE '^AUTH_PASS(_HASH)?=.' "$IMPORT/.env" 2>/dev/null; then
    user="admin"; hash=""   # the Docker install's login is imported below
  else
    user=${ADMIN_USER:-}
    if [ -z "$user" ]; then
      user=${SUDO_USER:-admin}
      [ "$user" != root ] || user="admin"
      if [ -z "${ADMIN_PASSWORD:-}" ]; then
        read -rp "admin username [$user]: " answer < /dev/tty
        user=${answer:-$user}
      fi
    fi
    [[ $user =~ ^[A-Za-z0-9._-]{1,64}$ ]] || die "admin username: use 1-64 letters, digits, dot, dash or underscore"
    echo "admin password for $user (at least 8 characters):"
    if [ -n "${ADMIN_PASSWORD:-}" ]; then
      hash=$(printf '%s\n' "$ADMIN_PASSWORD" | /usr/bin/servitals-ctl hash-password)
    else
      hash=$(/usr/bin/servitals-ctl hash-password < /dev/tty)
    fi
    [[ $hash == scrypt:* ]] || die "could not hash the password"
  fi
  sed -e "s/^PORT=.*/PORT=$port/" -e "s/^AUTH_USER=.*/AUTH_USER=$user/" \
      "$SRC/packaging/etc/hub.env" > "$ETC/hub.env"
  if [ -n "$hash" ]; then
    sed -i "s|^# AUTH_PASS_HASH=.*|AUTH_PASS_HASH=$hash|" "$ETC/hub.env"
  fi
  chmod 600 "$ETC/hub.env"
fi
[ -e "$ETC/agent.env" ] || install -m 644 "$SRC/packaging/etc/agent.env" "$ETC/agent.env"

# 5. settings, login and disks from a Docker install (before the hub starts)
if [ -n "$IMPORT" ]; then
  install -d -o _servitals -g _servitals -m 750 /var/lib/servitals
  STATE_DIR=/var/lib/servitals ETC_DIR="$ETC" /usr/bin/servitals-ctl import-docker "$IMPORT"
fi

# 6. units
# the same units the package ships (debian/ is their only copy)
install -m 644 "$SRC/debian/servitals.service" "$SRC/debian/servitals-agent.service" "$UNITS/"
systemctl daemon-reload
systemctl enable servitals.service servitals-agent.service
systemctl restart servitals.service

# 7. pair the local agent, first install only: the hub wrote its credentials on start
port=$(sed -n 's/^PORT=//p' "$ETC/hub.env" | tail -n 1)
port=${port:-20002}
for _ in $(seq 1 50); do
  curl -fsS "http://127.0.0.1:$port/__auth/health" >/dev/null 2>&1 && break
  sleep 0.2
done
curl -fsS "http://127.0.0.1:$port/__auth/health" >/dev/null || die "hub not healthy: journalctl -u servitals"
if [ ! -e "$ETC/agent-credentials.env" ]; then
  install -m 600 -o _servitals-agent -g _servitals-agent /var/lib/servitals/local-agent.env "$ETC/agent-credentials.env"
fi
systemctl restart servitals-agent.service

echo "servitals is running: http://$(hostname):$port/"
echo "log in as: $(sed -n 's/^AUTH_USER=//p' "$ETC/hub.env" | tail -n 1)"
echo "container list in the dashboard: sudo servitals-agent docker enable   (root-equivalent, see README)"
echo "container controls:              sudo servitals-ctl docker enable"

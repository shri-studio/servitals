#!/usr/bin/env bash
# SPDX-License-Identifier: AGPL-3.0-or-later
# servitals agent: samples this host every INTERVAL seconds, or at once when
# the hub asks, and pushes the snapshot to the hub over the signed agent API
# (docs/protocol.md). One file per metric group in lib/. HOST_ROOT is / on a
# normal install; the Docker agent reads the host through /host.
#   OUT_FILE=<path>  write snapshots to this file instead of pushing (debugging)
#   ONCE=1           one tick, then exit
# shellcheck disable=SC2034
# (IFACE_ENV, VNSTAT_DB, AGENT_NAME and others are read by the lib/*.sh files)
set -uo pipefail

HERE="$(cd "$(dirname "$(readlink -f "$0")")" && pwd)"
HOST="${HOST_ROOT:-/}"
INTERVAL="${INTERVAL:-60}"    # heartbeat; the hub wakes the agent for fresh samples on demand
[[ $INTERVAL =~ ^[0-9]+$ ]] && [ "$INTERVAL" -ge 5 ] && [ "$INTERVAL" -le 3600 ] || INTERVAL=60
IFACE_ENV="${NET_IFACE:-}"
DISKS="${DISKS:-/}"
VNSTAT_DB="$HOST/var/lib/vnstat"
NCPU=$(grep -c '^processor' "$HOST/proc/cpuinfo" 2>/dev/null || echo 1)
[ "${NCPU:-0}" -gt 0 ] 2>/dev/null || NCPU=1
# delta counters, trend, wake trigger; systemd's StateDirectory= sets STATE_DIRECTORY
STATE="${STATE_DIR:-${STATE_DIRECTORY:-/var/lib/servitals-agent}}"
mkdir -p "$STATE"
CREDENTIALS_FILE="${CREDENTIALS_FILE:-/etc/servitals/agent-credentials.env}"
AGENT_VERSION=$(cat "$HERE/VERSION" "$HERE/../VERSION" 2>/dev/null | head -n 1)
AGENT_NAME="bash/${AGENT_VERSION:-unknown}"
SNAP="${OUT_FILE:-$STATE/snapshot.json}"
TREND_FILE="$STATE/trend"   # sparkline history (last 60 samples)
TRIGGER="$STATE/wake"       # the wait loop touches it when the hub asks for a sample
touch "$TREND_FILE" 2>/dev/null || true
# the hub host's own agent must never go through a proxy
export NO_PROXY="${NO_PROXY:+$NO_PROXY,}localhost,127.0.0.1,::1"
export no_proxy="$NO_PROXY"

for f in "$HERE"/lib/*.sh; do
  # shellcheck source=/dev/null
  . "$f"
done

on() { [ "${1:-1}" != 0 ]; }   # COLLECT_<GROUP>=0 turns a group off; it becomes null

collect() {  # $1 = destination file
  local host mem=null cpu=null temp=null disks=null net=null docker=null
  host=$(host_json)
  if on "${COLLECT_MEM:-1}"; then mem=$(mem_json); fi
  if on "${COLLECT_CPU:-1}"; then cpu=$(cpu_json); fi
  if on "${COLLECT_TEMP:-1}"; then temp=$(temp_json); fi
  if on "${COLLECT_DISKS:-1}"; then disks=$(disks_json); fi
  if on "${COLLECT_NET:-1}"; then
    [ -n "$IFACE" ] || IFACE=$(pick_iface)   # resolve once; retry only if still unknown
    net=$(net_json "$IFACE")
  fi
  if on "${COLLECT_DOCKER:-1}"; then docker=$(docker_json); fi
  trend_row "$cpu" "$mem" "$temp"

  jq -cn \
    --argjson host "$host" --argjson mem "$mem" --argjson cpu "$cpu" \
    --argjson temp "$temp" --argjson disks "$disks" --argjson net "${net:-null}" \
    --argjson docker "$docker" --rawfile trend "$TREND_FILE" \
    --argjson interval "$INTERVAL" \
    '{ts:(now|floor), interval:$interval, host:$host, mem:$mem, cpu:$cpu, temp:$temp,
      disks:$disks, net:$net, docker:$docker,
      trend: ($trend / "\n" | map(select(length > 0) | fromjson?))}' \
    > "$1.tmp" 2>/dev/null && mv "$1.tmp" "$1"
}

tick() {
  collect "$SNAP" || { agent_log warn agent.tick_failed; return 1; }
  [ -n "${OUT_FILE:-}" ] || push "$SNAP"
}

agent_log info agent.start version="${AGENT_VERSION:-unknown}" interval="$INTERVAL" \
  host_root="$HOST" mode="$([ -n "${OUT_FILE:-}" ] && echo file || echo push)"
if [ -z "${OUT_FILE:-}" ]; then
  until load_credentials "$CREDENTIALS_FILE"; do
    if [ "${CRED_WAIT:-0}" != 1 ]; then
      agent_log error agent.no_credentials file="$CREDENTIALS_FILE"
      exit 1
    fi
    sleep 2   # Docker: the gateway writes the file on its first start
  done
  hmac_init "$NODE_SECRET"
  agent_log info agent.hub url="$HUB_URL" node="$NODE_ID"
fi
IFACE=$(pick_iface)

if [ "${ONCE:-0}" = 1 ]; then
  tick
  exit $?
fi

if [ -z "${OUT_FILE:-}" ]; then
  wait_loop &
  WAIT_PID=$!
  trap 'kill "$WAIT_PID" 2>/dev/null; exit 0' TERM INT
fi
while true; do
  tick
  # sleep INTERVAL, but sample at once when the wait loop touches the trigger
  i=0
  while [ "$i" -lt "$INTERVAL" ]; do
    if [ -e "$TRIGGER" ]; then rm -f "$TRIGGER"; break; fi
    sleep 1
    i=$((i + 1))
  done
done

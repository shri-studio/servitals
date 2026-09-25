#!/usr/bin/env bash
# SPDX-License-Identifier: AGPL-3.0-or-later
# servitals agent: metrics collector. One file per metric group in lib/.
# Reads host metrics under $HOST_ROOT (/ natively, /host in the Docker agent)
# and writes a JSON snapshot to $OUT_FILE on every tick.
# shellcheck disable=SC2034
# (IFACE_ENV, VNSTAT_DB, AGENT_NAME and others are read by the lib/*.sh files)
set -uo pipefail

HERE="$(cd "$(dirname "$(readlink -f "$0")")" && pwd)"
HOST="${HOST_ROOT:-/}"
OUT="${OUT_FILE:-/www/data.json}"
OUTDIR="$(dirname "$OUT")"
INTERVAL="${INTERVAL:-300}"   # slow heartbeat; the UI triggers fresh samples on demand
IFACE_ENV="${NET_IFACE:-}"
DISKS="${DISKS:-/}"
VNSTAT_DB="$HOST/var/lib/vnstat"
NCPU=$(grep -c '^processor' "$HOST/proc/cpuinfo" 2>/dev/null || echo 1)
[ "${NCPU:-0}" -gt 0 ] 2>/dev/null || NCPU=1
# delta counters (cpu, network); systemd's StateDirectory= sets STATE_DIRECTORY
STATE="${STATE_DIR:-${STATE_DIRECTORY:-/var/lib/servitals-agent}}"
mkdir -p "$STATE"
# sparkline history + refresh trigger live next to data.json (the .trend history
# survives container rebuilds; the web server refuses dotfiles)
TREND_FILE="$OUTDIR/.trend"
TRIGGER="$OUTDIR/.refresh"
touch "$TREND_FILE" 2>/dev/null || true   # so collect()'s --rawfile read never misses it

for f in "$HERE"/lib/*.sh; do
  # shellcheck source=/dev/null
  . "$f"
done

on() { [ "${1:-1}" != 0 ]; }   # COLLECT_<GROUP>=0 turns a group off; it becomes null

collect() {
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
    --argjson interval "${INTERVAL:-300}" \
    '{ts:(now|floor), interval:$interval, host:$host, mem:$mem, cpu:$cpu, temp:$temp,
      disks:$disks, net:$net, docker:$docker,
      trend: ($trend / "\n" | map(select(length > 0) | fromjson?))}' \
    > "$OUT.tmp" 2>/dev/null && mv "$OUT.tmp" "$OUT"
}

echo "servitals agent: HOST=$HOST OUT=$OUT INTERVAL=${INTERVAL}s DISKS=$DISKS STATE=$STATE"
IFACE=$(pick_iface)
# single tick for tests and budget checks: sample once, write, exit
if [ "${ONCE:-0}" = "1" ]; then
  collect
  exit $?
fi
while true; do
  collect || echo "tick failed: $(date -Is)"
  # sleep INTERVAL, but wake early if something touches the trigger file
  i=0
  while [ "$i" -lt "$INTERVAL" ]; do
    if [ -e "$TRIGGER" ]; then rm -f "$TRIGGER"; break; fi
    sleep 1
    i=$((i + 1))
  done
done

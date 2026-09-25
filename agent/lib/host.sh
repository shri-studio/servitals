# SPDX-License-Identifier: AGPL-3.0-or-later
# shellcheck shell=bash
# shellcheck disable=SC2154
# (globals such as HOST, STATE and NCPU are set by collect.sh)
# host: name, distro, kernel, uptime

host_json() {
  local hn distro kernel up
  # /proc/sys/kernel/hostname is UTS-namespaced (would show the container id),
  # so read the host's hostname file instead.
  hn=$(cat "$HOST/etc/hostname" 2>/dev/null | xargs)
  [ -n "$hn" ] || hn=$(cat "$HOST/proc/sys/kernel/hostname" 2>/dev/null || echo unknown)
  distro=$( (. "$HOST/etc/os-release" 2>/dev/null; echo "${PRETTY_NAME:-Linux}") )
  kernel=$(cat "$HOST/proc/sys/kernel/osrelease" 2>/dev/null || echo "?")
  up=$(awk '{printf "%d", $1}' "$HOST/proc/uptime" 2>/dev/null || echo 0)
  jq -cn --arg hn "$hn" --arg d "$distro" --arg k "$kernel" --argjson up "${up:-0}" \
    '{name:$hn, distro:$d, kernel:$k, uptime:$up}'
}

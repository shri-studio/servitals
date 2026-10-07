# SPDX-License-Identifier: AGPL-3.0-or-later
# shellcheck shell=bash
# shellcheck disable=SC2154
# (globals such as HOST are set by collect.sh)
# ubuntu: pending updates and security updates as update-notifier last counted them
# (apt's hook rewrites the file; the agent never runs apt), a reboot the system asks
# for and the packages behind it, and systemd's failed units. Only files the system
# keeps, and one systemctl call on a native install. null on a host with neither dpkg
# nor this host's systemd.

# the names of systemd's failed units, one per line, at most 32
failed_units() {
  systemctl --failed --no-legend --plain 2>/dev/null | awk 'NF { print $1 }' | head -n 32
}

ubuntu_json() {
  local units="" native=""
  # systemctl speaks for the system it runs on: only a native install (HOST_ROOT=/)
  if [ "${HOST%/}" = "" ] && [ -d /run/systemd/system ] && command -v systemctl >/dev/null; then
    native=1; units=$(failed_units)
  fi
  [ -d "$HOST/var/lib/dpkg" ] || [ -n "$native" ] || { echo null; return; }
  # update-notifier writes English when apt's hook runs: "12 updates can be applied
  # immediately." / "5 of these updates are standard security updates." (Ubuntu 20.04
  # and older: "7 packages can be updated." / "2 updates are security updates."); a
  # wording it does not know gives no counts rather than a guess
  local counts=""
  if [ -r "$HOST/var/lib/update-notifier/updates-available" ]; then
    counts=$(LC_ALL=C awk '
      /^[0-9]+ updates? can be applied immediately/ || /^[0-9]+ packages? can be updated/ { u = $1 }
      /^[0-9]+ of these updates (are|is a) (standard )?security updates?/ || /^[0-9]+ updates? (are|is a) security updates?/ { s = $1 }
      END { if (u != "") print u, (s == "" ? 0 : s) }' "$HOST/var/lib/update-notifier/updates-available" 2>/dev/null)
  fi
  local pkgs=""
  [ -r "$HOST/run/reboot-required.pkgs" ] && pkgs=$(awk 'NF && !seen[$0]++' "$HOST/run/reboot-required.pkgs" 2>/dev/null | head -n 32)
  jq -cn --arg counts "$counts" --arg pkgs "$pkgs" --arg units "$units" --arg native "$native" \
     --argjson reboot "$([ -e "$HOST/run/reboot-required" ] && echo true || echo false)" '
    ($counts | split(" ")) as $c
    | (if ($c | length) == 2 then {updates: ($c[0] | tonumber), security: ($c[1] | tonumber)} else {} end)
      + {rebootRequired: $reboot, rebootPkgs: ($pkgs | split("\n") | map(select(length > 0)))}
      + (if $native == "1" then {failedUnits: ($units | split("\n") | map(select(length > 0)))} else {} end)'
}

# SPDX-License-Identifier: AGPL-3.0-or-later
# shellcheck shell=bash
# shellcheck disable=SC2154
# (globals such as HOST are set by collect.sh)
# ubuntu: pending updates and security updates as update-notifier last counted them
# (apt's hook rewrites the file; the agent never runs apt), a reboot the system asks
# for and the packages behind it, and systemd's failed units. Only files the system
# keeps, and one systemctl call on a native install. null on a host with neither dpkg
# nor this host's systemd.

# systemctl speaks for the system it runs on: only a native install (HOST_ROOT=/)
systemd_here() { [ "${HOST%/}" = "" ] && [ -d /run/systemd/system ] && command -v systemctl >/dev/null; }

# the names of systemd's failed units, one per line, at most 32; fails when systemd
# cannot be asked (no bus, or no answer within 5 s: a stuck bus never stalls the tick)
failed_units() {
  local out
  out=$(timeout 5 systemctl --failed --no-legend --plain 2>/dev/null) || return 1
  awk 'NF && n < 32 { print $1; n++ }' <<< "$out"
}

ubuntu_json() {
  local units="" systemd="" asked="" dpkg=""
  if systemd_here; then systemd=1; units=$(failed_units) && asked=1; fi
  [ -d "$HOST/var/lib/dpkg" ] && dpkg=1
  [ -n "$dpkg" ] || [ -n "$systemd" ] || { echo null; return; }
  # update-notifier writes the counts in the system's language. In English: "12 updates
  # can be applied immediately." / "5 of these updates are standard security updates."
  # (Ubuntu Pro adds "2 of these updates are ESM Infra security updates."; Ubuntu 20.04
  # and older: "7 packages can be updated." / "2 updates are security updates."). Another
  # language, or a wording it does not know, gives no counts rather than a guess. "N
  # additional security updates can be applied with ESM Apps" need a subscription: not counted.
  local counts=""
  if [ -r "$HOST/var/lib/update-notifier/updates-available" ]; then
    counts=$(LC_ALL=C awk '
      /^[0-9]+ updates? can be applied immediately/ || /^[0-9]+ packages? can be updated/ { u = $1 }
      /^[0-9]+ of these updates (are|is an?) (standard |ESM (Apps|Infra) )?security updates?/ { s += $1 }
      /^[0-9]+ updates? (are|is a) security updates?/ { s += $1 }
      END { if (u != "") print u, (s == "" ? 0 : s) }' "$HOST/var/lib/update-notifier/updates-available" 2>/dev/null)
  fi
  # the reboot flag is Debian's (update-notifier and unattended-upgrades write it): a host
  # without dpkg never writes it, so it says nothing there rather than "not needed"
  local pkgs=""
  [ -n "$dpkg" ] && [ -r "$HOST/run/reboot-required.pkgs" ] &&
    pkgs=$(awk 'NF && !seen[$0]++ && n < 32 { print; n++ }' "$HOST/run/reboot-required.pkgs" 2>/dev/null)
  jq -cn --arg counts "$counts" --arg pkgs "$pkgs" --arg units "$units" --arg asked "$asked" --arg dpkg "$dpkg" \
     --argjson reboot "$([ -e "$HOST/run/reboot-required" ] && echo true || echo false)" '
    ($counts | split(" ")) as $c
    | (if ($c | length) == 2 then {updates: ($c[0] | tonumber), security: ($c[1] | tonumber)} else {} end)
      + (if $dpkg == "1" then {rebootRequired: $reboot, rebootPkgs: ($pkgs | split("\n") | map(select(length > 0)))} else {} end)
      + (if $asked == "1" then {failedUnits: ($units | split("\n") | map(select(length > 0)))} else {} end)'
}

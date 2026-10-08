# SPDX-License-Identifier: AGPL-3.0-or-later
# shellcheck shell=bash
# shellcheck disable=SC2154
# (globals such as HOST are set by collect.sh)
# hardware: fan speeds and voltages from every hwmon chip, and the battery. One
# grep over the chips' files (a file that cannot be read is skipped) and one awk.
# A fan is reported when it spins or has a name: boards list empty headers at 0 rpm.
# Each part is null when the host has none (most servers have no battery; many
# chips need a driver that sensors-detect loads).

hardware_json() {
  local hw=$HOST/sys/class/hwmon rows bat="" b cap="" st=""
  rows=$(grep -sH '' "$hw"/hwmon*/name "$hw"/hwmon*/fan*_input "$hw"/hwmon*/fan*_label \
           "$hw"/hwmon*/in*_input "$hw"/hwmon*/in*_label 2>/dev/null | LC_ALL=C awk '
    {
      i = index($0, ":"); path = substr($0, 1, i - 1); val = substr($0, i + 1)
      n = split(path, part, "/"); file = part[n]; dir = substr(path, 1, length(path) - length(file) - 1)
      if (!(dir in seen)) { seen[dir] = 1; dirs[++nd] = dir }
      if (file == "name") { name[dir] = val; next }
      if (match(file, /^(fan|in)[0-9]+_(input|label)$/)) {
        kind = (substr(file, 1, 3) == "fan") ? "fan" : "in"
        num = substr(file, length(kind) + 1) + 0
        if (num > top[dir, kind]) top[dir, kind] = num
        if (file ~ /_label$/) label[dir, kind, num] = val; else value[dir, kind, num] = val
      }
    }
    END {
      for (d = 1; d <= nd; d++) {
        dir = dirs[d]
        for (kind_i = 1; kind_i <= 2; kind_i++) {
          kind = kind_i == 1 ? "fan" : "in"
          for (k = 0; k <= top[dir, kind]; k++) {
            if (!((dir, kind, k) in value) || value[dir, kind, k] !~ /^-?[0-9]+$/) continue
            l = ((dir, kind, k) in label) ? label[dir, kind, k] : name[dir] " " kind k
            gsub(/\t/, " ", l)
            if (kind == "fan") { if (value[dir, kind, k] > 0 || ((dir, kind, k) in label)) print "fan\t" l "\t" value[dir, kind, k] + 0 }
            else printf "volt\t%s\t%.3f\n", l, value[dir, kind, k] / 1000
          }
        }
      }
    }')
  # the battery: the first power supply that is one (type Battery, or named BAT*)
  for b in "$HOST"/sys/class/power_supply/*; do
    [ -r "$b/capacity" ] || continue
    line_of "$b/type"   # line_of: agent/lib/temp.sh
    case ${b##*/} in BAT*) ;; *) [ "$REPLY" = Battery ] || continue ;; esac
    line_of "$b/capacity"; cap=$REPLY; line_of "$b/status"; st=$REPLY
    [[ $cap =~ ^[0-9]+$ ]] && { bat=1; break; }
  done
  jq -R -s -c --arg bat "$bat" --arg cap "$cap" --arg st "$st" '
    [split("\n")[] | select(length > 0) | split("\t")] as $r
    | ([$r[] | select(.[0] == "fan") | {label: .[1], rpm: (.[2] | tonumber)}]) as $fans
    | ([$r[] | select(.[0] == "volt") | {label: .[1], value: (.[2] | tonumber)}]) as $volts
    | {fans: (if $fans == [] then null else $fans[:32] end),
       voltages: (if $volts == [] then null else $volts[:32] end),
       battery: (if $bat == "1" then {capacity: ([($cap | tonumber), 100] | min), status: $st[:16]} else null end)}' <<< "$rows"
}

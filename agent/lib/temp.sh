# SPDX-License-Identifier: AGPL-3.0-or-later
# shellcheck shell=bash
# shellcheck disable=SC2154
# (globals such as HOST, STATE and NCPU are set by collect.sh)
# temp: hwmon sensors, thermal zones as fallback

temp_json() {
  # collect "label<TAB>value" lines, then one jq pass (labels never contain tabs)
  local lines="" hw nm f base lbl val z
  for hw in "$HOST"/sys/class/hwmon/hwmon*; do
    [ -r "$hw/name" ] || continue
    nm=$(cat "$hw/name" 2>/dev/null)
    case "$nm" in
      coretemp|k10temp|zenpower|cpu_thermal|*thermal*|nct*|it87*) ;;
      *) continue ;;
    esac
    for f in "$hw"/temp*_input; do
      [ -r "$f" ] || continue
      base=${f%_input}
      lbl=$(cat "${base}_label" 2>/dev/null || echo "$nm")
      val=$(awk '{printf "%.0f", $1/1000}' "$f" 2>/dev/null)
      [ -n "$val" ] && lines+="$lbl"$'\t'"$val"$'\n'
    done
  done
  if [ -z "$lines" ]; then
    for z in "$HOST"/sys/class/thermal/thermal_zone*; do
      [ -r "$z/temp" ] || continue
      lbl=$(cat "$z/type" 2>/dev/null || echo zone)
      val=$(awk '{printf "%.0f", $1/1000}' "$z/temp" 2>/dev/null)
      [ -n "$val" ] && lines+="$lbl"$'\t'"$val"$'\n'
    done
  fi
  printf '%s' "$lines" | jq -R -s '
    [ splits("\n") | select(length > 0) | split("\t") | { label: .[0], value: (.[1] | tonumber) } ] as $s |
    {
      sensors: $s,
      package: ( ($s | map(select(.label | test("package|pkg|composite|tctl|tdie"; "i"))) | .[0].value)
                 // ($s | map(.value) | max) ),
      max: ( $s | map(.value) | max // null )
    }'
}

# SPDX-License-Identifier: AGPL-3.0-or-later
# shellcheck shell=bash
# shellcheck disable=SC2154
# (globals such as HOST, STATE and NCPU are set by collect.sh)
# temp: hwmon sensors, thermal zones as fallback

# an unconnected sensor input reads -128 or 255 °C: leave those out
in_range() { [[ $1 =~ ^-?[0-9]+$ ]] && [ "$1" -ge -50 ] && [ "$1" -le 150 ]; }

temp_json() {
  # every sensor chip the kernel exposes, as "chip<TAB>label<TAB>value" lines
  # (labels never contain tabs), then one jq pass. lm-sensors' sensors-detect
  # loads drivers for motherboard chips the kernel does not know yet.
  local lines="" hw nm f base lbl val z
  for hw in "$HOST"/sys/class/hwmon/hwmon*; do
    [ -r "$hw/name" ] || continue
    nm=$(cat "$hw/name" 2>/dev/null)
    for f in "$hw"/temp*_input; do
      [ -r "$f" ] || continue
      base=${f%_input}
      lbl=$(cat "${base}_label" 2>/dev/null || echo "$nm")
      val=$(awk '{printf "%.0f", $1/1000}' "$f" 2>/dev/null)
      in_range "$val" && lines+="$nm"$'\t'"$lbl"$'\t'"$val"$'\n'
    done
  done
  if [ -z "$lines" ]; then
    for z in "$HOST"/sys/class/thermal/thermal_zone*; do
      [ -r "$z/temp" ] || continue
      lbl=$(cat "$z/type" 2>/dev/null || echo zone)
      val=$(awk '{printf "%.0f", $1/1000}' "$z/temp" 2>/dev/null)
      in_range "$val" && lines+="thermal"$'\t'"$lbl"$'\t'"$val"$'\n'
    done
  fi
  # the headline is the CPU: a CPU chip's package sensor, else its hottest
  # reading, else the hottest of all (an NVMe "Composite" is not the CPU)
  printf '%s' "$lines" | jq -R -s '
    [ splits("\n") | select(length > 0) | split("\t") | { chip: .[0], label: .[1], value: (.[2] | tonumber) } ] as $all |
    ( $all | map(select(.chip | test("^(coretemp|k10temp|zenpower|cpu_thermal|soc_thermal|acpitz)$|thermal"))) ) as $cpu |
    {
      sensors: ( $all | map({ label: (if .label == .chip or (.chip | test("^(coretemp|k10temp|zenpower)$")) then .label
                                      else "\(.chip) \(.label)" end), value }) ),
      package: ( ( $cpu | map(select(.label | test("package|pkg|tctl|tdie"; "i"))) | .[0].value )
                 // ( $cpu | map(.value) | max ) // ( $all | map(.value) | max ) ),
      max: ( $all | map(.value) | max // null )
    }'
}

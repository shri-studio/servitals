# SPDX-License-Identifier: AGPL-3.0-or-later
# shellcheck shell=bash
# shellcheck disable=SC2154
# (globals such as HOST, STATE and NCPU are set by collect.sh)
# temp: hwmon sensors, thermal zones as fallback

# an unconnected sensor input reads -128 or 255 °C: leave those out
in_range() { [[ $1 =~ ^-?[0-9]+$ ]] && [ "$1" -ge -50 ] && [ "$1" -le 150 ]; }

# the first line of a file into REPLY, as it is (no fork: no cat per sensor)
line_of() { REPLY=""; { IFS= read -r REPLY < "$1"; } 2>/dev/null; }

# millidegrees in file $1 -> whole degrees in REPLY, rounded as printf "%.0f" does
# (half to even); empty when the file holds no integer. No awk per sensor.
deg_of() {
  local v s=1 q r
  line_of "$1"; v=$REPLY; REPLY=""
  [[ $v =~ ^-?[0-9]+$ ]] || return 0
  if [ "${v:0:1}" = - ]; then s=-1; v=${v#-}; fi
  v=$((10#$v)); q=$((v / 1000)); r=$((v % 1000))
  if [ "$r" -gt 500 ] || { [ "$r" -eq 500 ] && [ $((q % 2)) -eq 1 ]; }; then q=$((q + 1)); fi
  REPLY=$((s * q))
}

temp_json() {
  # every sensor chip the kernel exposes, as "chip<TAB>label<TAB>value" lines
  # (labels never contain tabs), then one jq pass. lm-sensors' sensors-detect
  # loads drivers for motherboard chips the kernel does not know yet.
  local lines="" hw nm f base lbl val z
  for hw in "$HOST"/sys/class/hwmon/hwmon*; do
    [ -r "$hw/name" ] || continue
    line_of "$hw/name"; nm=$REPLY
    for f in "$hw"/temp*_input; do
      [ -r "$f" ] || continue
      base=${f%_input}
      # a label that is missing, unreadable or empty: the chip's name
      line_of "${base}_label"; lbl=${REPLY:-$nm}
      deg_of "$f"; val=$REPLY
      in_range "$val" && lines+="$nm"$'\t'"$lbl"$'\t'"$val"$'\n'
    done
  done
  if [ -z "$lines" ]; then
    for z in "$HOST"/sys/class/thermal/thermal_zone*; do
      [ -r "$z/temp" ] || continue
      line_of "$z/type"; lbl=${REPLY:-zone}
      deg_of "$z/temp"; val=$REPLY
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

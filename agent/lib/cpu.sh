# SPDX-License-Identifier: AGPL-3.0-or-later
# shellcheck shell=bash
# shellcheck disable=SC2154
# (globals such as HOST, STATE and NCPU are set by collect.sh)
# cpu: total and per-core usage from /proc/stat deltas, the share spent waiting on
# disk (iowait) and taken by the hypervisor (steal), load averages

# a share of dt in whole percent, 0..100
share() { local p=0; [ "$2" -gt 0 ] && p=$(( (100 * $1) / $2 )); [ "$p" -lt 0 ] && p=0; [ "$p" -gt 100 ] && p=100; echo "$p"; }

cpu_json() {
  local line idle total wait steal v pct=0 iowait=0 stolen=0 dt pt pi pw ps
  line=$(grep '^cpu ' "$HOST/proc/stat")
  # cpu user nice system idle iowait irq softirq steal guest guest_nice
  set -- $line
  idle=$(( $5 + $6 )); wait=$6; steal=${9:-0}
  total=0; shift
  for v in "$@"; do total=$((total + v)); done
  if [ -f "$STATE/cpu" ]; then
    # the older agent wrote only "total idle": then iowait and steal start next tick
    read -r pt pi pw ps < "$STATE/cpu"
    dt=$((total - pt))
    pct=$(share $((dt - (idle - pi))) "$dt")
    if [ -n "$ps" ]; then iowait=$(share $((wait - pw)) "$dt"); stolen=$(share $((steal - ps)) "$dt"); fi
  fi
  echo "$total $idle $wait $steal" > "$STATE/cpu"

  # per-core usage from cpuN lines, delta vs previous tick
  local cn rest ct ci ppt ppi cp
  local per_vals=()
  while read -r cn rest; do
    case "$cn" in cpu[0-9]*) ;; *) continue ;; esac
    set -- $rest
    ci=$(( $4 + $5 )); ct=0
    for v in "$@"; do ct=$((ct + v)); done
    cp=0
    if [ -f "$STATE/$cn" ]; then
      read -r ppt ppi < "$STATE/$cn"
      local cdt cdi
      cdt=$((ct - ppt)); cdi=$((ci - ppi))
      [ "$cdt" -gt 0 ] && cp=$(( (100 * (cdt - cdi)) / cdt ))
    fi
    echo "$ct $ci" > "$STATE/$cn"
    [ "$cp" -lt 0 ] && cp=0; [ "$cp" -gt 100 ] && cp=100
    per_vals+=("$cp")
  done < "$HOST/proc/stat"
  local per
  per="[$(IFS=,; echo "${per_vals[*]-}")]"   # integers -> JSON array, no jq per core

  local load
  load=$(cut -d' ' -f1-3 "$HOST/proc/loadavg" 2>/dev/null || echo "0 0 0")
  set -- $load
  jq -cn --argjson pct "$pct" --argjson iowait "$iowait" --argjson steal "$stolen" --argjson n "$NCPU" \
     --argjson per "$per" --argjson l1 "${1:-0}" --argjson l5 "${2:-0}" --argjson l15 "${3:-0}" \
     '{usage:$pct, iowait:$iowait, steal:$steal, cores:$n, per:$per, load:[$l1,$l5,$l15]}'
}

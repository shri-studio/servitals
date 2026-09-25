# SPDX-License-Identifier: AGPL-3.0-or-later
# shellcheck shell=bash
# shellcheck disable=SC2154
# (globals such as HOST, STATE and NCPU are set by collect.sh)
# docker: the container list from the Docker API over its unix socket (curl,
# not the docker CLI, which briefly takes ~29 MB per call), memory and CPU
# from each container's cgroup. CPU % is the usage_usec delta since the last
# tick over the host's whole capacity, so it compares with cpu.usage.

cgroup_dir() {  # $1 = container id -> its cgroup v2 directory, if there is one
  local d
  for d in "$HOST/sys/fs/cgroup/system.slice/docker-$1.scope" "$HOST/sys/fs/cgroup/docker/$1"; do
    if [ -f "$d/cpu.stat" ]; then echo "$d"; return; fi
  done
}

docker_json() {
  local sock="${DOCKER_SOCK:-/var/run/docker.sock}" list now rows="" cid name state status d k v usage mem cpu v1
  [ -S "$sock" ] || { echo '[]'; return; }   # no Docker here: do not start curl at all
  list=$(curl -sf --max-time 5 --unix-socket "$sock" 'http://d/containers/json?all=1' 2>/dev/null) \
    || { echo '[]'; return; }
  now=$(date +%s%N)
  local -A prev_u=() prev_t=()
  if [ -f "$STATE/docker-cpu" ]; then
    while read -r cid v k; do prev_u[$cid]=$v; prev_t[$cid]=$k; done < "$STATE/docker-cpu"
  fi
  : > "$STATE/docker-cpu.t"
  while IFS=$'\t' read -r cid name state status; do
    [ -n "$cid" ] || continue
    usage=""; mem=""; cpu=""
    d=$(cgroup_dir "$cid")
    if [ -n "$d" ]; then
      while read -r k v; do [ "$k" = usage_usec ] && usage=$v; done < "$d/cpu.stat"
      [ -f "$d/memory.stat" ] && while read -r k v; do [ "$k" = anon ] && mem=$v; done < "$d/memory.stat"
    else
      v1="$HOST/sys/fs/cgroup/memory/docker/$cid/memory.stat"   # cgroup v1
      if [ -f "$v1" ]; then
        while read -r k v; do [ "$k" = total_rss ] && mem=$v; done < "$v1"
        v=$(cat "$HOST/sys/fs/cgroup/cpuacct/docker/$cid/cpuacct.usage" 2>/dev/null) && usage=$((v / 1000))
      fi
    fi
    if [ -n "$usage" ]; then
      echo "$cid $usage $now" >> "$STATE/docker-cpu.t"
      if [ -n "${prev_u[$cid]:-}" ] && [ "$usage" -ge "${prev_u[$cid]}" ]; then
        cpu=$(awk -v du=$((usage - ${prev_u[$cid]})) -v dt=$(( (now - ${prev_t[$cid]}) / 1000 )) -v n="$NCPU" \
          'BEGIN { if (dt > 0) { c = 100 * du / (dt * n); if (c > 100) c = 100; printf "%.1f", c } }')
      fi
    fi
    rows+="$cid"$'\t'"$name"$'\t'"$state"$'\t'"$status"$'\t'"$cpu"$'\t'"$mem"$'\n'
  done < <(jq -r '.[] | [.Id, ((.Names[0] // "") | ltrimstr("/")), .State, .Status] | @tsv' <<< "$list" 2>/dev/null)
  mv "$STATE/docker-cpu.t" "$STATE/docker-cpu"
  printf '%s' "$rows" | jq -R -s -c '
    [ split("\n")[] | select(length > 0) | split("\t") | {
        name: .[1], id: .[0], state: .[2], status: .[3],
        health: ( .[3] | capture("\\((?<h>healthy|unhealthy|health: starting|starting)\\)").h // null ),
        cpu: ( if .[4] == "" then null else (.[4] | tonumber) end ),
        mem: ( if .[5] == "" then null else (.[5] | tonumber) end ) } ]
    | sort_by( (if .state == "running" then 0 else 1 end), -( .mem // -1 ) )'
}

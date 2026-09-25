# SPDX-License-Identifier: AGPL-3.0-or-later
# shellcheck shell=bash
# shellcheck disable=SC2154
# (globals such as HOST, STATE and NCPU are set by collect.sh)
# docker: containers with cpu and memory

docker_json() {
  local ps stats anon
  ps=$(docker ps -a --no-trunc --format '{{json .}}' 2>/dev/null | jq -s '
    [ .[] | {
        name:   .Names,
        id:     ( .ID // .Id // "" ),
        state:  .State,
        status: .Status,
        health: ( .Status | capture("\\((?<h>healthy|unhealthy|health: starting|starting)\\)").h // null )
      } ]' 2>/dev/null)
  [ -n "$ps" ] || ps='[]'

  # per-container cpu (one sample; ~1-2s, fine at this interval). MemUsage from
  # docker stats includes active page cache (cgroup v2) so we don't use it for
  # memory — see `anon` below. docker's own CPUPerc is normalized to one core
  # (100% = 1 core saturated); we rescale to the host's total capacity so it's
  # directly comparable to the host-wide cpu.usage in cpu_json.
  stats=$(docker stats --no-stream --format '{{json .}}' 2>/dev/null | jq -s --argjson n "$NCPU" '
    [ .[] | { name: .Name, cpu: ( (.CPUPerc | rtrimstr("%") | tonumber? // 0) / $n ) } ]' 2>/dev/null)
  [ -n "$stats" ] || stats='[]'

  # real memory = anonymous pages from each container's cgroup memory.stat
  # (excludes reclaimable page cache). Container id/name come from $ps, not a
  # second `docker ps`; each memory.stat is read with the shell, not awk.
  anon=$(printf '%s' "$ps" | jq -r '.[] | "\(.id)\t\(.name)"' | while IFS=$'\t' read -r cid cname; do
    [ -n "$cid" ] || continue
    for p in "$HOST/sys/fs/cgroup/system.slice/docker-$cid.scope/memory.stat" \
             "$HOST/sys/fs/cgroup/docker/$cid/memory.stat" \
             "$HOST/sys/fs/cgroup/memory/docker/$cid/memory.stat"; do
      [ -f "$p" ] || continue
      while read -r k v _; do
        case "$k" in anon|total_rss) printf '%s\t%s\n' "$cname" "$v" ;; esac
      done < "$p"
      break
    done
  done | jq -R -s 'split("\n") | map(select(length>0) | split("\t") | {(.[0]): (.[1]|tonumber)}) | add // {}')
  [ -n "$anon" ] || anon='{}'

  jq -cn --argjson ps "$ps" --argjson stats "$stats" --argjson anon "$anon" '
    ( $stats | map({ (.name): . }) | add // {} ) as $s |
    $ps
    | map( .cpu = ( $s[.name].cpu // null ) | .mem = ( $anon[.name] // null ) )
    | sort_by( (if .state == "running" then 0 else 1 end), -( .mem // -1 ) )
  ' 2>/dev/null || echo "${ps:-[]}"
}

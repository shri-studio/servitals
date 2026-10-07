# SPDX-License-Identifier: AGPL-3.0-or-later
# shellcheck shell=bash
# shellcheck disable=SC2154
# (globals such as HOST, STATE, CLK_TCK and PAGE_SIZE are set by collect.sh)
# processes: the five busiest by cpu and the five largest by memory, from
# /proc/[pid]/stat in one pass. cpuPct is the share of one core since the last
# tick (as top shows it); pid and start time together name a process, so a
# reused pid is never compared with the process it replaced. Only processes the
# agent may read count (Android shows an app its own); null without /proc/uptime.

processes_json() {
  local now _
  read -r now _ < "$HOST/proc/uptime" 2>/dev/null || { echo null; return; }
  # cat, not awk's own file list: a process that exits (or may not be read) after
  # the glob is skipped by cat, where mawk, Ubuntu's default awk, would stop
  cat "$HOST"/proc/[0-9]*/stat 2>/dev/null | awk -v now="$now" -v hz="${CLK_TCK:-100}" \
      -v page="${PAGE_SIZE:-4096}" -v prev="$STATE/procs" -v out="$STATE/procs.new" '
    BEGIN {
      # the last tick: its uptime, then "pid start ticks" per process
      if ((getline line < prev) > 0) {
        before = line + 0
        while ((getline line < prev) > 0) { split(line, p, " "); seen[p[1] " " p[2]] = p[3] }
      }
      close(prev)
      print now > out
    }
    /^[0-9]+ \(/ {
      # the name ends at the last ") ": a name may hold ") " itself
      e = 0
      for (j = length($0) - 1; j > 0; j--) if (substr($0, j, 2) == ") ") { e = j; break }
      if (!e) next
      s = index($0, "(")
      name = substr($0, s + 1, e - s - 1); gsub(/\t/, " ", name)
      if (split(substr($0, e + 2), f, " ") < 22) next
      ticks = f[12] + f[13]; key = ($1 + 0) " " f[20]
      print key, ticks > out
      cpu = ""
      if (before > 0 && now > before && (key in seen) && ticks >= seen[key])
        cpu = sprintf("%.1f", 100 * (ticks - seen[key]) / ((now - before) * hz))
      printf "%d\t%s\t%s\t%.0f\n", $1, name, cpu, f[22] * page
    }' | jq -R -s -c '
      [split("\n")[] | select(length > 0) | split("\t")
        | {pid: (.[0] | tonumber), name: .[1], cpuPct: (if .[2] == "" then null else (.[2] | tonumber) end),
           rss: (.[3] | tonumber)}] as $all
      | {cpu: ([$all[] | select(.cpuPct != null and .cpuPct > 0)] | sort_by(-.cpuPct, .pid) | .[:5]),
         mem: ([$all[] | select(.rss > 0)] | sort_by(-.rss, .pid) | .[:5])}'
  mv -f "$STATE/procs.new" "$STATE/procs" 2>/dev/null
}

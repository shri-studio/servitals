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
  # grep -sH, not awk's own file list: a process that exits (or may not be read) after
  # the glob is skipped, where mawk, Ubuntu's default awk, would stop; and every line,
  # also the rest of a name holding a newline, carries its file, so a process cannot
  # pose as another pid. LC_ALL=C: mawk would print "50,0" in a comma locale.
  grep -sH '' "$HOST"/proc/[0-9]*/stat | LC_ALL=C awk -v now="$now" -v hz="${CLK_TCK:-100}" \
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
    # one record per file: the lines of a name with a newline are joined with a space
    {
      i = index($0, "/stat:"); if (!i) next
      path = substr($0, 1, i + 4); line = substr($0, i + 6)
      if (path == file) { rec = rec " " line; next }
      emit(); file = path; rec = line
    }
    END { emit() }
    function emit(   pid, s, e, name, f, ticks, key, cpu) {
      if (rec == "") return
      pid = file; sub(/\/stat$/, "", pid); sub(/.*\//, "", pid)
      # the name runs from the first "(" to the last ") " (a name may hold ") " itself)
      s = index(rec, "(")
      if (pid !~ /^[0-9]+$/ || !s || !match(rec, /.*\) /)) return
      e = RSTART + RLENGTH - 2
      name = substr(rec, s + 1, e - s - 1); gsub(/\t/, " ", name)
      if (split(substr(rec, e + 2), f, " ") < 22) return
      ticks = f[12] + f[13]; key = pid " " f[20]
      print key, ticks > out
      cpu = ""
      if (before > 0 && now > before && (key in seen) && ticks >= seen[key])
        cpu = sprintf("%.1f", 100 * (ticks - seen[key]) / ((now - before) * hz))
      printf "%s\t%s\t%s\t%.0f\n", pid, name, cpu, f[22] * page
    }' | jq -R -s -c '
      [split("\n")[] | select(length > 0) | split("\t")
        | {pid: (.[0] | tonumber), name: .[1], cpuPct: (if .[2] == "" then null else (.[2] | tonumber) end),
           rss: (.[3] | tonumber)}] as $all
      | {cpu: ([$all[] | select(.cpuPct != null and .cpuPct > 0)] | sort_by(-.cpuPct, .pid) | .[:5]),
         mem: ([$all[] | select(.rss > 0)] | sort_by(-.rss, .pid) | .[:5])}'
  mv -f "$STATE/procs.new" "$STATE/procs" 2>/dev/null
}

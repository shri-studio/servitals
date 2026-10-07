# SPDX-License-Identifier: AGPL-3.0-or-later
# shellcheck shell=bash
# shellcheck disable=SC2154
# (globals such as HOST are set by collect.sh)
# pressure: the kernel's pressure stall information (PSI, /proc/pressure). For cpu,
# memory and io: the share of the last 10 seconds in which some tasks ("some") or
# all of them ("full") waited for that resource. A busy disk shows here even when
# the cpu looks idle. null without PSI (kernels before 4.20, or booted with psi=0).

pressure_json() {
  local dir="$HOST/proc/pressure"
  [ -d "$dir" ] || { echo null; return; }
  # one "kind line" per file: "cpu some 0.43", "cpu full 0.00", ...
  local f
  for f in cpu memory io; do
    [ -r "$dir/$f" ] || continue
    awk -v r="$f" '$1 == "some" || $1 == "full" { sub("avg10=", "", $2); print r, $1, $2 }' "$dir/$f" 2>/dev/null
  done | jq -cRn '
    [inputs | split(" ") | select(length == 3 and (.[2] | test("^[0-9]+(\\.[0-9]+)?$")))] as $l
    | def one($r): ([$l[] | select(.[0] == $r)] | if length == 0 then null
        else (map({(.[1]): (.[2] | tonumber)}) | add) as $v | {some: ($v.some // null), full: ($v.full // null)} end);
      {cpu: one("cpu"), mem: one("memory"), io: one("io")}'
}

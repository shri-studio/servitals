# SPDX-License-Identifier: AGPL-3.0-or-later
# shellcheck shell=bash
# shellcheck disable=SC2154
# (globals such as HOST, STATE and NCPU are set by collect.sh)
# mem: /proc/meminfo in bytes

mem_json() {
  # kB values * 1024 overflow busybox awk's 32-bit int printf("%d"); use %.0f
  # (awk math is double precision, exact well past terabytes).
  awk '
    /^MemTotal:/     {t=$2*1024.0}
    /^MemAvailable:/ {a=$2*1024.0}
    /^MemFree:/      {f=$2*1024.0}
    /^Buffers:/      {b=$2*1024.0}
    /^Cached:/       {c=$2*1024.0}
    /^SReclaimable:/ {sr=$2*1024.0}
    /^SwapTotal:/    {st=$2*1024.0}
    /^SwapFree:/     {sf=$2*1024.0}
    END {
      cache=c+b+sr; used=t-a; if (used<0) used=0
      printf "{\"total\":%.0f,\"used\":%.0f,\"available\":%.0f,\"free\":%.0f,\"cache\":%.0f,\"swapTotal\":%.0f,\"swapUsed\":%.0f}",
             t, used, a, f, cache, st, st-sf
    }' "$HOST/proc/meminfo"
}

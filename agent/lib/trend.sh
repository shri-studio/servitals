# SPDX-License-Identifier: AGPL-3.0-or-later
# shellcheck shell=bash
# shellcheck disable=SC2154
# (globals such as HOST, STATE and NCPU are set by collect.sh)
# trend: rolling sparkline history (last 60 samples)

# append one {cpu%,mem%,temp} sample to the rolling history (last 60), for the
# UI sparklines. collect() reads the file back inline via --rawfile.
trend_row() {
  jq -cn --argjson c "$1" --argjson m "$2" --argjson t "$3" '{
    cpu:  ($c.usage // 0),
    mem:  (if ($m.total // 0) > 0 then ($m.used * 100 / $m.total) else 0 end),
    temp: ($t.package // null)
  }' 2>/dev/null >> "$TREND_FILE" || return
  tail -n 60 "$TREND_FILE" > "$TREND_FILE.t" 2>/dev/null && mv "$TREND_FILE.t" "$TREND_FILE"
}

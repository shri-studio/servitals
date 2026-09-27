# SPDX-License-Identifier: AGPL-3.0-or-later
# shellcheck shell=bash
# shellcheck disable=SC2154
# (globals such as HOST, STATE and NCPU are set by collect.sh)
# net: live rate from interface counters, history from vnStat

pick_iface() {
  if [ -n "$IFACE_ENV" ]; then echo "$IFACE_ENV"; return; fi
  vnstat --json --dbdir "$VNSTAT_DB" 2>/dev/null \
    | jq -r '.interfaces[].name' 2>/dev/null \
    | grep -Ev '^(lo|docker|veth|br-|virbr|tap|tun)' | head -n1
}

net_json() {
  local iface="$1" rx tx vn
  [ -n "$iface" ] || { echo 'null'; return; }
  # counters only: the hub derives the live rate from two snapshots
  rx=$(cat "$HOST/sys/class/net/$iface/statistics/rx_bytes" 2>/dev/null || echo 0)
  tx=$(cat "$HOST/sys/class/net/$iface/statistics/tx_bytes" 2>/dev/null || echo 0)
  [[ $rx =~ ^[0-9]+$ ]] || rx=0
  [[ $tx =~ ^[0-9]+$ ]] || tx=0

  # vnStat reads its DB in the reading process's timezone, so the agent's TZ
  # must match the host's: then day/month buckets roll over at local midnight.
  vn=$(vnstat --json --dbdir "$VNSTAT_DB" -i "$iface" 2>/dev/null | jq -c --argjson now "$(date +%s)" '
    .interfaces[0] as $if | ($if.traffic) as $t |
    ( $if.created.timestamp // 0 ) as $created |

    # average rate = bytes / seconds the bucket actually spans, from its own
    # start (or the vnstat tracking start, whichever is later) to now.
    def summary(bucket):
      ( bucket | last // {rx:0, tx:0, timestamp:$now} ) as $b |
      ( [ $now - ([ ($b.timestamp // 0), $created ] | max), 1 ] | max ) as $secs |
      { rx: $b.rx, tx: $b.tx, avgRx: ($b.rx / $secs), avgTx: ($b.tx / $secs) };

    # recent buckets as chart bars, labelled in local time
    def bars(bucket; n; short; long):
      ( bucket // [] | .[-n:] | map({
          label: ( .timestamp | strflocaltime(short) ),
          title: ( .timestamp | strflocaltime(long) ),
          rx, tx }) );

    {
      today:  summary($t.day),
      month:  summary($t.month),
      total:  ( $t.total // {rx:0, tx:0} | {rx, tx} ),
      days:   bars($t.day;  30; "%m-%d";    "%Y-%m-%d"),
      hours:  bars($t.hour; 24; "%H:00";    "%m-%d %H:00")
    }' 2>/dev/null)
  [ -n "$vn" ] || vn=null
  jq -cn --arg iface "$iface" --argjson rx "$rx" --argjson tx "$tx" --argjson vn "$vn" \
    '{iface: $iface, rxBytes: $rx, txBytes: $tx, vnstat: $vn}'
}

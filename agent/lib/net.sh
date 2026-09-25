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
  local iface="$1"
  [ -n "$iface" ] || { echo 'null'; return; }

  # live throughput: bytes/sec, from rx/tx byte counters between ticks
  local rx tx now prev_rx prev_tx prev_t rx_Bps=0 tx_Bps=0
  rx=$(cat "$HOST/sys/class/net/$iface/statistics/rx_bytes" 2>/dev/null || echo 0)
  tx=$(cat "$HOST/sys/class/net/$iface/statistics/tx_bytes" 2>/dev/null || echo 0)
  now=$(date +%s.%N)
  if [ -f "$STATE/net" ]; then
    read -r prev_rx prev_tx prev_t < "$STATE/net"
    local dt
    dt=$(awk -v a="$now" -v b="$prev_t" 'BEGIN{printf "%.3f", a-b}')
    if awk -v d="$dt" 'BEGIN{exit !(d>0.1)}'; then
      rx_Bps=$(awk -v c="$rx" -v p="$prev_rx" -v d="$dt" 'BEGIN{v=(c-p)/d; printf "%.0f", (v<0?0:v)}')
      tx_Bps=$(awk -v c="$tx" -v p="$prev_tx" -v d="$dt" 'BEGIN{v=(c-p)/d; printf "%.0f", (v<0?0:v)}')
    fi
  fi
  echo "$rx $tx $now" > "$STATE/net"

  local ep
  ep=$(date +%s)

  # vnStat reads its DB in the reading process's timezone, so the agent's TZ
  # (from .env) MUST match the host's system timezone — then vnStat's own
  # day/month buckets roll over at the right local midnight and its `timestamp`
  # fields are correct epochs. (If .env TZ and the host differ, today/month
  # boundaries will be off by the offset between them.)
  vnstat --json --dbdir "$VNSTAT_DB" -i "$iface" 2>/dev/null | jq -c \
    --argjson rxBps "${rx_Bps:-0}" --argjson txBps "${tx_Bps:-0}" --arg iface "$iface" \
    --argjson now "$ep" '
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
      iface:  $iface,
      rateRx: $rxBps,
      rateTx: $txBps,
      today:  summary($t.day),
      month:  summary($t.month),
      total:  ( $t.total // {rx:0, tx:0} ),
      days:   bars($t.day;  30; "%m-%d";    "%Y-%m-%d"),
      hours:  bars($t.hour; 24; "%H:00";    "%m-%d %H:00")
    }' || echo 'null'
}

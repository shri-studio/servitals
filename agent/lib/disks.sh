# SPDX-License-Identifier: AGPL-3.0-or-later
# shellcheck shell=bash
# shellcheck disable=SC2154
# (globals such as HOST, STATE and NCPU are set by collect.sh)
# disks: usage per DISKS entry, source and model from mountinfo and sysfs

mount_source() {  # $1 = host mountpoint -> device / remote
  awk -v m="$1" '{
    if ($5 == m) { for (i = 6; i <= NF; i++) if ($i == "-") { print $(i+2); exit } }
  }' "$HOST/proc/1/mountinfo"
}

disks_json() {
  local out="[]" m p src base parent model rota
  local bs blocks bfree bavail size used avail pct
  IFS=',' read -ra MS <<< "$DISKS"
  for m in "${MS[@]}"; do
    m=$(echo "$m" | xargs)
    [ -n "$m" ] || continue
    if [ "$m" = "/" ]; then p="$HOST"; else p="$HOST$m"; fi
    [ -d "$p" ] || continue

    # statvfs via busybox stat -f: %S block size, %b total, %f free, %a avail
    read -r bs blocks bfree bavail < <(stat -f -c '%S %b %f %a' "$p" 2>/dev/null || echo "0 0 0 0")
    [ "${blocks:-0}" -gt 0 ] || continue
    size=$(( bs * blocks ))
    avail=$(( bs * bavail ))
    used=$(( bs * (blocks - bfree) ))
    if [ $(( used + avail )) -gt 0 ]; then
      pct=$(( 100 * used / (used + avail) ))
    else
      pct=0
    fi

    src=$(mount_source "$m"); [ -n "$src" ] || src="?"
    model=""; rota=""
    if [ "${src#/dev/}" != "$src" ]; then
      base=${src#/dev/}
      if [ -e "$HOST/sys/class/block/$base/partition" ]; then
        parent=$(basename "$(readlink -f "$HOST/sys/class/block/$base/.." 2>/dev/null)")
      else
        parent=$base
      fi
      model=$(cat "$HOST/sys/class/block/$parent/device/model" 2>/dev/null | xargs || true)
      rota=$(cat "$HOST/sys/class/block/$parent/queue/rotational" 2>/dev/null || echo "")
    fi
    local fstype
    fstype=$(awk -v mp="$m" '{ if ($5==mp) { for(i=6;i<=NF;i++) if($i=="-"){print $(i+1); exit} } }' "$HOST/proc/1/mountinfo")

    out=$(echo "$out" | jq -c \
      --arg mount "$m" --arg src "$src" --arg model "$model" --arg fs "${fstype:-}" \
      --argjson size "$size" --argjson used "$used" --argjson avail "$avail" --argjson pct "$pct" \
      --arg rota "$rota" \
      '. + [{mount:$mount, source:$src, model:$model, fstype:$fs,
             rotational:($rota=="1"), size:$size, used:$used, avail:$avail, pct:$pct}]')
  done
  echo "$out"
}

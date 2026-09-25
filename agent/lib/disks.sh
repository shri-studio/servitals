# SPDX-License-Identifier: AGPL-3.0-or-later
# shellcheck shell=bash
# shellcheck disable=SC2154
# (globals such as HOST, STATE and NCPU are set by collect.sh)
# disks: usage per DISKS entry, source and model from mountinfo and sysfs

mount_info() {  # $1 = mountpoint -> "fstype source" of its LAST mountinfo line
  # A mountpoint can appear several times (cifs stacked on autofs); the last
  # line is the mount on top, the one a path lookup reaches.
  awk -v m="$1" '$5 == m { for (i = 7; i <= NF; i++) if ($i == "-") { v = $(i+1) " " $(i+2); break } }
    END { if (v != "") print v }' "$HOST/proc/1/mountinfo" 2>/dev/null
}

auto_disks() {  # real filesystems from mountinfo, comma separated: DISKS=auto
  # Whole mounts only ($4 == "/"; bind mounts of a subdirectory are skipped), a
  # disk or network filesystem type, and not under system paths. For a stacked
  # mountpoint the top line wins, so cifs over autofs is kept.
  awk '
    $4 != "/" { next }
    { for (i = 7; i <= NF; i++) if ($i == "-") { fs = $(i+1); break } }
    fs !~ /^(ext[234]|xfs|btrfs|zfs|f2fs|fuseblk|ntfs3?|exfat|cifs|smb3|nfs4?)$/ { next }
    $5 ~ /^\/(boot|snap|proc|sys|dev|run|tmp|var\/lib\/docker|var\/snap)(\/|$)/ { next }
    !seen[$5]++ { order[++n] = $5 }
    END { for (i = 1; i <= n; i++) printf "%s%s", (i > 1 ? "," : ""), order[i] }
  ' "$HOST/proc/1/mountinfo" 2>/dev/null
}

disks_json() {
  local lines="" m p info fstype src base parent model rota
  local bs blocks bfree bavail size used avail pct t="${STAT_TIMEOUT:-5}"
  [[ $t =~ ^[0-9]+$ ]] && [ "$t" -ge 1 ] || t=5
  local list=$DISKS
  if [ "$list" = auto ]; then list=$(auto_disks); fi
  IFS=',' read -ra MS <<< "$list"
  for m in "${MS[@]}"; do
    m=$(echo "$m" | xargs)
    [ -n "$m" ] || continue
    if [ "$m" = "/" ]; then p="$HOST"; else p="$HOST$m"; fi
    info=$(mount_info "$m")
    if [ -z "$info" ]; then
      # not a mountpoint: say so instead of reporting the parent filesystem
      lines+="$m"$'\t0\n'
      continue
    fi
    read -r fstype src <<< "$info"
    [ -n "$src" ] || src="?"

    # statvfs: %S block size, %b total, %f free, %a avail. A dead network share
    # can block here forever, so bound it; a share that does not answer is left out.
    # -k 1: KILL a stat that ignores TERM; read -t: never wait on the pipe longer than that
    read -r -t $((t + 2)) bs blocks bfree bavail < <(timeout -k 1 "$t" stat -f -c '%S %b %f %a' "$p" 2>/dev/null || echo "0 0 0 0")
    [ "${blocks:-0}" -gt 0 ] || continue
    size=$(( bs * blocks ))
    avail=$(( bs * bavail ))
    used=$(( bs * (blocks - bfree) ))
    if [ $(( used + avail )) -gt 0 ]; then
      pct=$(( 100 * used / (used + avail) ))
    else
      pct=0
    fi

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
    lines+="$m"$'\t1\t'"$src"$'\t'"$model"$'\t'"$fstype"$'\t'"$rota"$'\t'"$size"$'\t'"$used"$'\t'"$avail"$'\t'"$pct"$'\n'
  done
  # one jq for all disks
  printf '%s' "$lines" | jq -R -s -c '[ split("\n")[] | select(length > 0) | split("\t") |
    if .[1] == "0" then { mount: .[0], mounted: false }
    else { mount: .[0], mounted: true, source: .[2], model: .[3], fstype: .[4],
           rotational: (.[5] == "1"), size: (.[6] | tonumber), used: (.[7] | tonumber),
           avail: (.[8] | tonumber), pct: (.[9] | tonumber) } end ]'
}

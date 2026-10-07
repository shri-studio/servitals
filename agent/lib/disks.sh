# SPDX-License-Identifier: AGPL-3.0-or-later
# shellcheck shell=bash
# shellcheck disable=SC2154
# (globals such as HOST, STATE and NCPU are set by collect.sh)
# disks: usage per DISKS entry, source and model from mountinfo and sysfs; io: bytes
# read and written by the block devices behind them, from /proc/diskstats

mount_infos() {  # $1 = mountpoints, one per line -> "mountpoint<TAB>fstype source maj:min" each
  # One pass for all of them. A mountpoint can appear several times (cifs stacked
  # on autofs); its LAST line is the mount on top, the one a path lookup reaches.
  awk -v list="$1" '
    BEGIN { n = split(list, ms, "\n"); for (i = 1; i <= n; i++) want[ms[i]] = 1 }
    $5 in want { for (i = 7; i <= NF; i++) if ($i == "-") { v[$5] = $(i+1) " " $(i+2) " " $3; break } }
    END { for (m in v) print m "\t" v[m] }' "$HOST/proc/1/mountinfo" 2>/dev/null
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
  local lines="" m p info fstype src majmin link dev base parent model rota k v
  local bs blocks bfree bavail size used avail pct t="${STAT_TIMEOUT:-5}"
  [[ $t =~ ^[0-9]+$ ]] && [ "$t" -ge 1 ] || t=5
  local list=$DISKS
  if [ "$list" = auto ]; then list=$(auto_disks); fi
  # each entry trimmed in bash (no fork per disk), then one mountinfo pass for all
  local -a MS=() words=()
  local -A info_of=()
  IFS=',' read -ra words <<< "$list"
  for m in "${words[@]}"; do
    m="${m#"${m%%[![:space:]]*}"}"; m="${m%"${m##*[![:space:]]}"}"
    [ -n "$m" ] && MS+=("$m")
  done
  while IFS=$'\t' read -r k v; do info_of[$k]=$v; done < <(mount_infos "$(printf '%s\n' "${MS[@]}")")
  for m in "${MS[@]}"; do
    if [ "$m" = "/" ]; then p="$HOST"; else p="$HOST$m"; fi
    info=${info_of[$m]-}
    if [ -z "$info" ]; then
      # not a mountpoint: say so instead of reporting the parent filesystem
      lines+="$m"$'\t0\n'
      continue
    fi
    read -r fstype src majmin <<< "$info"
    [ -n "$src" ] || src="?"
    # the block device behind it, by device number (works for LVM and dm-crypt too);
    # network shares, btrfs and zfs have major 0 and no block device
    dev=""
    case $majmin in 0:*|"") ;; *) link=$(readlink "$HOST/sys/dev/block/$majmin" 2>/dev/null); dev=${link##*/} ;; esac

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
        link=$(readlink -f "$HOST/sys/class/block/$base/.." 2>/dev/null); parent=${link##*/}
      else
        parent=$base
      fi
      # read, not cat: no fork; the words joined with one space, as xargs did
      words=(); { read -ra words < "$HOST/sys/class/block/$parent/device/model"; } 2>/dev/null; model="${words[*]}"
      { read -r rota < "$HOST/sys/class/block/$parent/queue/rotational"; } 2>/dev/null || rota=""
    fi
    lines+="$m"$'\t1\t'"$src"$'\t'"$model"$'\t'"$fstype"$'\t'"$rota"$'\t'"$size"$'\t'"$used"$'\t'"$avail"$'\t'"$pct"$'\t'"$dev"$'\n'
  done
  # one jq for all disks
  printf '%s' "$lines" | jq -R -s -c '[ split("\n")[] | select(length > 0) | split("\t") |
    if .[1] == "0" then { mount: .[0], mounted: false }
    else { mount: .[0], mounted: true, source: .[2], model: .[3], fstype: .[4],
           rotational: (.[5] == "1"), size: (.[6] | tonumber), used: (.[7] | tonumber),
           avail: (.[8] | tonumber), pct: (.[9] | tonumber) }
         + (if (.[10] // "") != "" then { device: .[10] } else {} end) end ]'
}

io_json() {  # bytes read and written by the devices behind the DISKS entries, each device once
  [ -r "$HOST/proc/diskstats" ] || { echo null; return; }
  [ -r "$HOST/proc/1/mountinfo" ] || { echo "[]"; return; }
  local list=$DISKS
  if [ "$list" = auto ]; then list=$(auto_disks); fi
  # one pass: the device number of each wanted mountpoint (the last line wins, as in
  # mount_info), then the counters of those devices; diskstats counts 512-byte sectors
  awk -v list="$list" '
    BEGIN { n = split(list, ms, ","); for (i = 1; i <= n; i++) { gsub(/^[ \t]+|[ \t]+$/, "", ms[i]); want[ms[i]] = 1 } }
    FNR == NR { if ($5 in want) num[$5] = $3; next }
    FNR == 1 { for (m in num) if (num[m] !~ /^0:/) dev[num[m]] = 1 }
    ($1 ":" $2) in dev { printf "%s\t%.0f\t%.0f\n", $3, $6 * 512, $10 * 512 }
  ' "$HOST/proc/1/mountinfo" "$HOST/proc/diskstats" 2>/dev/null |
    jq -R -s -c '[split("\n")[] | select(length > 0) | split("\t")
      | {device: .[0], readBytes: (.[1] | tonumber), writeBytes: (.[2] | tonumber)}]'
}

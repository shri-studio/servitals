#!/usr/bin/env bash
# SPDX-License-Identifier: AGPL-3.0-or-later
# Build the servitals and servitals-agent packages from this checkout in
# Ubuntu containers, run lintian, and enforce the checks from the spec:
# no lintian errors or warnings (section 13.5), each .deb at most 500 KB
# (section 18). Results land in build/deb/<series>/.
#   packaging/build-deb.sh [series...]        default: noble resolute
set -euo pipefail
SRC="$(cd "$(dirname "$(readlink -f "$0")")/.." && pwd)"
# shellcheck source=packaging/series.sh
. "$SRC/packaging/series.sh"
OUT="${OUT_DIR:-$SRC/build/deb}"
mkdir -p "$OUT"
stage=$(mktemp -d)
trap 'rm -rf "$stage"' EXIT
stage_source "$SRC" "$stage"
fail=0
pick_series "$@"
for series in "${SERIES[@]}"; do
  image=$(series_image "$series")
  echo "== $series ($image)"
  docker run --rm -e HOST_UID="$(id -u)" -e HOST_GID="$(id -g)" \
    -v "$stage:/src:ro" -v "$OUT:/out" -v "$SRC/packaging/docker/build-in.sh:/build-in.sh:ro" \
    "$image" bash /build-in.sh
  if grep -E '^[EW]: ' "$OUT/lintian-$series.txt"; then
    echo "FAIL  lintian errors or warnings on $series (see $OUT/lintian-$series.txt)"
    fail=1
  fi
  for deb in "$OUT/$series"/*.deb; do
    size=$(stat -c %s "$deb")
    if [ "$size" -gt 512000 ]; then echo "FAIL  $(basename "$deb") is $size bytes (> 500 KB)"; fail=1
    else echo "ok    $(basename "$deb") $size bytes"; fi
  done
done
exit "$fail"

#!/usr/bin/env bash
# SPDX-License-Identifier: AGPL-3.0-or-later
# Run debian/tests on a booted Ubuntu testbed (systemd in Docker) for each
# series, with the packages from build/deb/<series>/ (run build-deb.sh first).
#   packaging/autopkgtest.sh [series...]      default: noble resolute
# PPA_SETUP="ppa:prabzo/servitals" tests the packages from that PPA instead.
set -euo pipefail
SRC="$(cd "$(dirname "$(readlink -f "$0")")/.." && pwd)"
# shellcheck source=packaging/series.sh
. "$SRC/packaging/series.sh"
OUT="${OUT_DIR:-$SRC/build/deb}"
stage=$(mktemp -d)
trap 'rm -rf "$stage"' EXIT
stage_source "$SRC" "$stage"
extra=()
if [ -n "${PPA_SETUP:-}" ]; then
  extra=(--setup-commands "apt-get install -y software-properties-common && add-apt-repository -y $PPA_SETUP && apt-get update")
  OUT=$(mktemp -d)   # no local packages: install from the PPA
fi
pick_series "$@"
for series in "${SERIES[@]}"; do
  echo "== autopkgtest $series"
  docker run --rm -v /var/run/docker.sock:/var/run/docker.sock \
    -v "$stage:/src:ro" -v "$OUT:/out:ro" -v "$SRC/packaging/docker/autopkgtest-in.sh:/run.sh:ro" \
    "$(series_image resolute)" bash /run.sh "$series" "$(series_image "$series")" "${extra[@]}"
done

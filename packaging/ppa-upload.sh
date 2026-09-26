#!/usr/bin/env bash
# SPDX-License-Identifier: AGPL-3.0-or-later
# Build source packages of the committed HEAD for a Launchpad PPA, one per
# series, versioned <debian version>~ppa<N>~<series>1 (spec section 16), and
# upload them when asked.
#   packaging/ppa-upload.sh <ppa> [series...]         build only (a dry run)
#   UPLOAD=1 DEBSIGN_KEYID=<key id> packaging/ppa-upload.sh ppa:prabzo/servitals
# PPA_REV (default 1) raises ~ppaN to rebuild the same version. The upload
# needs devscripts and dput on this host and a GPG key known to Launchpad;
# the key never leaves this host.
set -euo pipefail
SRC="$(cd "$(dirname "$(readlink -f "$0")")/.." && pwd)"
# shellcheck source=packaging/series.sh
. "$SRC/packaging/series.sh"
die() { echo "ppa-upload: $*" >&2; exit 1; }
ppa=${1:-}
[[ $ppa == ppa:*/* ]] || die "usage: $0 ppa:<owner>/<name> [series...]"
shift
[ -z "$(git -C "$SRC" status --porcelain --untracked-files=no)" ] || die "commit first: uploads are built from HEAD"
version=$(sed -n '1s/^servitals (\([^)]*\)).*/\1/p' "$SRC/debian/changelog")
[ -n "$version" ] || die "cannot read the version from debian/changelog"
upstream=${version%-*}
OUT="${OUT_DIR:-$SRC/build/ppa}"
in=$(mktemp -d)
trap 'rm -rf "$in"' EXIT
mkdir -p "$OUT"
# one orig tarball for every series: Launchpad refuses a second, different one
orig="$OUT/servitals_$upstream.orig.tar.gz"
if [ ! -e "$orig" ]; then
  git -C "$SRC" archive --format=tar --prefix="servitals-$upstream/" HEAD -- . ':(exclude)debian' | gzip -n -9 > "$orig"
fi
cp "$orig" "$in/"
git -C "$SRC" archive --format=tar HEAD debian > "$in/debian.tar"
pick_series "$@"
for series in "${SERIES[@]}"; do
  pv="$version~ppa${PPA_REV:-1}~${series}1"
  echo "== $series: servitals $pv"
  rm -rf "${OUT:?}/$series"
  docker run --rm -e HOST_UID="$(id -u)" -e HOST_GID="$(id -g)" \
    -v "$in:/in:ro" -v "$OUT:/out" -v "$SRC/packaging/docker/source-in.sh:/source-in.sh:ro" \
    "$(series_image "$series")" bash /source-in.sh "$series" "$pv"
  if [ "${UPLOAD:-0}" = 1 ]; then
    [ -n "${DEBSIGN_KEYID:-}" ] || die "set DEBSIGN_KEYID to the key Launchpad knows"
    debsign -k"$DEBSIGN_KEYID" "$OUT/$series"/*_source.changes
    dput "$ppa" "$OUT/$series"/*_source.changes
  fi
done
[ "${UPLOAD:-0}" = 1 ] || echo "dry run: source packages in $OUT/<series>/; UPLOAD=1 to sign and upload"

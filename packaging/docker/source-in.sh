#!/bin/bash
# SPDX-License-Identifier: AGPL-3.0-or-later
# Inside an Ubuntu container: build an unsigned source package for one PPA
# series from /in/servitals_<upstream>.orig.tar.gz and /in/debian.tar.
#   source-in.sh <series> <ppa-version>
set -euo pipefail
export DEBIAN_FRONTEND=noninteractive
series=$1 ppa_version=$2
apt-get -qq update >/dev/null
apt-get -qq install -y --no-install-recommends dpkg-dev debhelper devscripts >/dev/null
work=$(mktemp -d)
cd "$work"
orig=$(basename /in/servitals_*.orig.tar.gz)
cp "/in/$orig" .
tar -xzf "$orig"
dir=$(find . -maxdepth 1 -type d -name 'servitals-*' | head -n 1)
tar -C "$dir" -xf /in/debian.tar
sed -i "1s/^servitals ([^)]*) [a-z]*;/servitals ($ppa_version) $series;/" "$dir/debian/changelog"
(cd "$dir" && dpkg-buildpackage -S -sa -us -uc -d) > "/out/source-$series.log" 2>&1 \
  || { tail -30 "/out/source-$series.log"; exit 1; }
mkdir -p "/out/$series"
cp ./*.dsc ./*.debian.tar.* ./*_source.changes ./*.orig.tar.gz "/out/$series/"
chown -R "${HOST_UID:-0}:${HOST_GID:-0}" /out

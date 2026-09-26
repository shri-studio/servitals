#!/bin/bash
# SPDX-License-Identifier: AGPL-3.0-or-later
# Inside an Ubuntu container: build the binary packages from /src (a staged
# source tree) into /out/<series>/ and run lintian. Called by build-deb.sh.
set -euo pipefail
export DEBIAN_FRONTEND=noninteractive
apt-get -qq update >/dev/null
apt-get -qq install -y --no-install-recommends build-essential debhelper devscripts lintian fakeroot >/dev/null
. /etc/os-release
series=$VERSION_CODENAME
version=$(dpkg-parsechangelog -l /src/debian/changelog -S Version)
upstream=${version%-*}
work=$(mktemp -d)
cd "$work"
tar -C /src --exclude=./debian -czf "servitals_$upstream.orig.tar.gz" --transform "s,^\.,servitals-$upstream," .
tar -xzf "servitals_$upstream.orig.tar.gz"
cp -r /src/debian "servitals-$upstream/"
sed -i "1s/) [a-z]*;/) $series;/" "servitals-$upstream/debian/changelog"
(cd "servitals-$upstream" && dpkg-buildpackage -us -uc -b) > "/out/build-$series.log" 2>&1 \
  || { tail -40 "/out/build-$series.log"; exit 1; }
mkdir -p "/out/$series"
rm -f "/out/$series"/*.deb
cp ./*.deb "/out/$series/"
lintian -EvIL +pedantic ./*.changes > "/out/lintian-$series.txt" 2>&1 || true
chown -R "${HOST_UID:-0}:${HOST_GID:-0}" /out

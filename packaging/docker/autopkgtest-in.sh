#!/bin/bash
# SPDX-License-Identifier: AGPL-3.0-or-later
# Inside a helper container that can reach the Docker socket: build a booted
# (systemd) test image for the series and run the package's autopkgtests on it.
#   autopkgtest-in.sh <series> <base-image> [extra autopkgtest args...]
set -euo pipefail
export DEBIAN_FRONTEND=noninteractive
series=$1 image=$2
shift 2
apt-get -qq update >/dev/null
apt-get -qq install -y --no-install-recommends autopkgtest docker.io python3 iproute2 >/dev/null
autopkgtest-build-docker --docker --init systemd -i "$image" --release "$series" \
  -t "servitals-autopkgtest/$series" >/dev/null
cp -r /src /tmp/src
debs=()
for d in /out/"$series"/*.deb; do [ -e "$d" ] && debs+=("$d"); done
autopkgtest "${debs[@]}" /tmp/src "$@" -- docker --init --remote "servitals-autopkgtest/$series" --privileged

# SPDX-License-Identifier: AGPL-3.0-or-later
# shellcheck shell=bash
# Ubuntu series this project builds for, and the container image for each.
# IMAGE_PREFIX lets a host without Docker Hub use a mirror, for example
# IMAGE_PREFIX=mirror.gcr.io/library/
# SERIES: the series named on the command line, or every supported one
pick_series() {
  # shellcheck disable=SC2034  # read by the scripts that source this file
  if [ $# -gt 0 ]; then SERIES=("$@"); else SERIES=(noble resolute); fi
}
series_image() {
  case "$1" in
    noble) echo "${IMAGE_PREFIX:-}ubuntu:24.04" ;;
    resolute) echo "${IMAGE_PREFIX:-}ubuntu:26.04" ;;
    *) echo "unknown series: $1" >&2; return 1 ;;
  esac
}
# the working tree without git-ignored files (never .env, data/ or build/)
stage_source() {  # src dst
  (cd "$1" && git ls-files -z --cached --others --exclude-standard) |
    while IFS= read -r -d '' f; do
      [ -e "$1/$f" ] && (cd "$1" && cp --parents -- "$f" "$2/")
    done
}

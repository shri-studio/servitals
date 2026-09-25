# SPDX-License-Identifier: AGPL-3.0-or-later
# shellcheck shell=bash
# log: logfmt lines on stdout; under systemd each line starts with an
# sd-daemon priority prefix so `journalctl -p warning` filters by level.
# Callers pass values without spaces; secrets are never passed.

agent_log() {  # level event [key=value ...]
  local level=$1 event=$2 p=""
  shift 2
  case "${LOG_LEVEL:-info}:$level" in
    error:warn|error:info|error:debug|warn:info|warn:debug|info:debug) return 0 ;;
  esac
  if [ -n "${JOURNAL_STREAM:-}" ]; then
    case "$level" in error) p="<3>" ;; warn) p="<4>" ;; info) p="<6>" ;; *) p="<7>" ;; esac
  fi
  printf '%slevel=%s event=%s%s\n' "$p" "$level" "$event" "${*:+ $*}"
}

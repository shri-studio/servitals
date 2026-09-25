# SPDX-License-Identifier: AGPL-3.0-or-later
# shellcheck shell=bash
# hmac: HMAC-SHA256 with bash and sha256sum only (no openssl dependency).
# HMAC(K, m) = H((K ^ opad) || H((K ^ ipad) || m)), block size 64 bytes.
# The pads are printf escape strings, so NUL bytes survive the pipe.

hmac_init() {  # $1 = key as 64 hex characters; sets HMAC_IPAD and HMAC_OPAD
  local k=$1 i b
  while [ "${#k}" -lt 128 ]; do k+="0"; done
  HMAC_IPAD=""
  HMAC_OPAD=""
  for ((i = 0; i < 128; i += 2)); do
    b=$((16#${k:i:2}))
    printf -v HMAC_IPAD '%s\\x%02x' "$HMAC_IPAD" $((b ^ 0x36))
    printf -v HMAC_OPAD '%s\\x%02x' "$HMAC_OPAD" $((b ^ 0x5c))
  done
}

hmac_hex() {  # $1 = message; prints the lowercase hex HMAC
  local inner
  inner=$( { printf '%b' "$HMAC_IPAD"; printf '%s' "$1"; } | sha256sum)
  inner=${inner%% *}
  { printf '%b' "$HMAC_OPAD"; printf '%b' "$(printf '%s' "$inner" | sed 's/../\\x&/g')"; } \
    | sha256sum | cut -d' ' -f1
}

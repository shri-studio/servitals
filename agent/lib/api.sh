# SPDX-License-Identifier: AGPL-3.0-or-later
# shellcheck shell=bash
# shellcheck disable=SC2154
# (globals such as STATE, INTERVAL and TRIGGER are set by collect.sh)
# api: the agent side of docs/protocol.md. Signed POST /api/v1/agent/push,
# the GET /api/v1/agent/wait long poll, and reply-signature checks.

load_credentials() {  # $1 = file with HUB_URL, NODE_ID, NODE_SECRET; parsed, never sourced
  local k v
  HUB_URL=""; NODE_ID=""; NODE_SECRET=""
  [ -r "$1" ] || return 1
  while IFS='=' read -r k v || [ -n "$k" ]; do
    v=${v%$'\r'}
    case "$k" in
      HUB_URL) HUB_URL=${v%/} ;;
      NODE_ID) NODE_ID=$v ;;
      NODE_SECRET) NODE_SECRET=$v ;;
    esac
  done < "$1"
  [[ $HUB_URL =~ ^https?://[^[:space:]]+$ && $NODE_ID =~ ^[a-z2-7]{12}$ && $NODE_SECRET =~ ^[0-9a-f]{64}$ ]]
}

now_ms() { local t; t=$(date +%s%N); echo "${t:0:13}"; }

api_error() { jq -r '.error // empty' "$1" 2>/dev/null | head -c 40; }

# api_call METHOD PATH BODY_FILE OUT_FILE [curl args...]
# Sets API_STATUS. Returns 0 only for a 2xx whose reply signature is valid.
api_call() {
  local method=$1 path=$2 body=$3 out=$4 ts bh sig got
  shift 4
  : > "$out"; : > "$out.h"   # never read a previous reply if this request fails early
  ts=$(now_ms)
  bh=$(sha256sum < "$body"); bh=${bh%% *}
  sig=$(hmac_hex "$method"$'\n'"$path"$'\n'"$ts"$'\n'"$bh")
  API_STATUS=$(curl -sS -o "$out" -D "$out.h" -w '%{http_code}' -X "$method" --max-time 20 \
    -H "X-Servitals-Proto: 1" -H "X-Servitals-Agent: $AGENT_NAME" -H "X-Servitals-Node: $NODE_ID" \
    -H "X-Servitals-Ts: $ts" -H "X-Servitals-Sig: $sig" \
    -H "Content-Type: application/json" -H "Expect:" \
    --data-binary @"$body" "$@" "$HUB_URL$path" 2>/dev/null) || API_STATUS=000
  case "$API_STATUS" in 2??) ;; *) return 1 ;; esac
  got=$(awk 'tolower($1) == "x-servitals-sig:" { v = $2 } END { print v }' "$out.h" | tr -d '\r')
  bh=$(sha256sum < "$out"); bh=${bh%% *}
  if [ "$got" != "$(hmac_hex "reply"$'\n'"$ts"$'\n'"$bh")" ]; then
    API_STATUS=bad_reply_signature   # an impostor or a proxy rewrote the reply
    return 1
  fi
}

push() {  # $1 = snapshot file; 0 when the hub stored it
  local out="$STATE/push.out"
  api_call POST /api/v1/agent/push "$1" "$out" && return 0
  if [ "$API_STATUS" = 401 ] && [ "$(api_error "$out")" = replay ]; then
    api_call POST /api/v1/agent/push "$1" "$out" && return 0   # a fresh timestamp, once
  elif [ "$API_STATUS" = 429 ]; then
    # inside the hub's 5 s push limit (a restart, a wake right after a push): wait it out once
    local wait_s
    wait_s=$(awk 'tolower($1) == "retry-after:" { v = $2 + 0 } END { print (v >= 1 && v <= 5) ? v : 5 }' "$out.h" 2>/dev/null)
    sleep "${wait_s:-5}"
    api_call POST /api/v1/agent/push "$1" "$out" && return 0
  fi
  agent_log warn agent.push_failed status="$API_STATUS" error="$(api_error "$out")"
  return 1
}

wait_loop() {  # background: touch $TRIGGER whenever the hub asks for a sample
  local empty="$STATE/wait.empty" out="$STATE/wait.out" hold="${WAIT_SECONDS:-55}" backoff=5
  : > "$empty"
  [[ $hold =~ ^[0-9]+$ ]] || hold=55
  [ "$hold" -lt 5 ] && hold=5
  [ "$hold" -gt 55 ] && hold=55
  while true; do
    if api_call GET /api/v1/agent/wait "$empty" "$out" -H "X-Servitals-Wait: $hold" --max-time $((hold + 15)); then
      backoff=5
      if [ "$API_STATUS" = 200 ] && grep -q '"sample":true' "$out"; then touch "$TRIGGER"; fi
    else
      agent_log warn agent.wait_failed status="$API_STATUS" error="$(api_error "$out")" retry_in="$backoff"
      sleep "$backoff"
      backoff=$((backoff * 2))
      [ "$backoff" -gt "$INTERVAL" ] && backoff=$INTERVAL
      [ "$backoff" -lt 5 ] && backoff=5
    fi
  done
}

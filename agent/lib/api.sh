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
  # no user:password@ in the URL: it would end up in the log
  [[ $HUB_URL =~ ^https?://[^[:space:]/@]+(/[^[:space:]@]*)?$ && $NODE_ID =~ ^[a-z2-7]{12}$ && $NODE_SECRET =~ ^[0-9a-f]{64}$ ]]
}

# extra request headers, e.g. a Cloudflare Access service token:
#   HUB_HEADERS="CF-Access-Client-Id: <id>; CF-Access-Client-Secret: <secret>"
# Values are sent, never logged. HUB_CA_FILE trusts a private CA for an HTTPS hub.
hub_args() {
  HUB_ARGS=()
  local part name value parts file="$STATE/hub-headers"
  if [ -n "${HUB_HEADERS:-}" ]; then
    # written to a private file and passed as -H @file: values on curl's
    # command line would be visible to every local user in ps
    (umask 077; : > "$file")
    IFS=';' read -ra parts <<< "$HUB_HEADERS"
    for part in "${parts[@]}"; do
      name=$(printf '%s' "${part%%:*}" | xargs)
      value=$(printf '%s' "${part#*:}" | sed 's/^ *//; s/ *$//')
      [[ $name =~ ^[A-Za-z0-9-]{1,64}$ && $part == *:* ]] || { agent_log error agent.bad_hub_headers; continue; }
      printf '%s: %s\n' "$name" "$value" >> "$file"
    done
    HUB_ARGS+=(-H @"$file")
  fi
  if [ -n "${HUB_CA_FILE:-}" ]; then HUB_ARGS+=(--cacert "$HUB_CA_FILE"); fi
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
    -H "Content-Type: application/json" -H "Expect:" "${HUB_ARGS[@]}" \
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
  local out="$STATE/push.out" err small
  api_call POST /api/v1/agent/push "$1" "$out"
  err=$(api_error "$out")
  if [ "$API_STATUS" = 401 ] && [ "$err" = replay ]; then
    api_call POST /api/v1/agent/push "$1" "$out"   # a fresh timestamp, once
  elif [ "$API_STATUS" = 429 ]; then
    # inside the hub's 5 s push limit (a restart, a wake right after a push): wait it out once
    local wait_s
    wait_s=$(awk 'tolower($1) == "retry-after:" { v = $2 + 0 } END { print (v >= 1 && v <= 5) ? v : 5 }' "$out.h" 2>/dev/null)
    sleep "${wait_s:-5}"
    api_call POST /api/v1/agent/push "$1" "$out"
  elif [ "$API_STATUS" = 413 ]; then
    # too large: send it again without the optional lists (protocol 5.5)
    small="$STATE/snapshot.small.json"
    jq -c 'del(.docker, .processes)' "$1" > "$small" 2>/dev/null && api_call POST /api/v1/agent/push "$small" "$out"
  fi
  err=$(api_error "$out")
  printf '%s %s %s\n' "$(date +%s)" "$API_STATUS" "${err:--}" > "$STATE/last-push"
  case "$API_STATUS" in 2??) rm -f "$STATE/push-hold" "$STATE/push-backoff"; return 0 ;; esac
  agent_log warn agent.push_failed status="$API_STATUS" error="$err"
  # protocol 5.5: stop for a revoked node or another protocol; back off on
  # errors that repeat until someone fixes the secret or the clock
  local hold=0 backoff
  case "$API_STATUS:$err" in
    401:unknown_node|426:*) hold=600 ;;
    401:bad_signature|401:clock_skew|422:*|bad_reply_signature:*)
      backoff=$(cat "$STATE/push-backoff" 2>/dev/null || echo 30)
      [[ $backoff =~ ^[0-9]+$ ]] || backoff=30
      backoff=$((backoff * 2)); [ "$backoff" -gt 3600 ] && backoff=3600
      echo "$backoff" > "$STATE/push-backoff"
      hold=$backoff ;;
  esac
  if [ "$hold" -gt 0 ]; then echo $(( $(date +%s) + hold )) > "$STATE/push-hold"; fi
  return 1
}

push_held() {  # 0 while an earlier error says to wait
  local until
  [ -r "$STATE/push-hold" ] || return 1   # the usual case: nothing to wait for
  read -r until < "$STATE/push-hold" || return 1
  [[ $until =~ ^[0-9]+$ ]] && [ "$(date +%s)" -lt "$until" ]
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
      # a revoked or unknown node, or a protocol this hub does not speak: stop
      # asking until someone changes the credentials (protocol 5.5)
      case "$API_STATUS:$(api_error "$out")" in
        401:unknown_node|426:*) sleep 600; continue ;;
      esac
      sleep "$backoff"
      backoff=$((backoff * 2))
      [ "$backoff" -gt "$INTERVAL" ] && backoff=$INTERVAL
      [ "$backoff" -lt 5 ] && backoff=5
    fi
  done
}

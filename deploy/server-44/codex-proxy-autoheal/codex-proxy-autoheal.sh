#!/usr/bin/env bash
set -Eeuo pipefail

PROXY_URL="${CODEX_PROXY_AUTOHEAL_PROXY_URL:-http://127.0.0.1:3128}"
CANARY_URL="${CODEX_PROXY_AUTOHEAL_CANARY_URL:-https://api.openai.com/v1/models}"
STATE_DIR="${CODEX_PROXY_AUTOHEAL_STATE_DIR:-/var/lib/vpn-panel/codex-proxy-autoheal}"
STATE_FILE="${CODEX_PROXY_AUTOHEAL_STATE_FILE:-$STATE_DIR/state}"
LOCK_FILE="${CODEX_PROXY_AUTOHEAL_LOCK_FILE:-$STATE_DIR/lock}"
CURL="${CODEX_PROXY_AUTOHEAL_CURL:-curl}"
SYSTEMCTL="${CODEX_PROXY_AUTOHEAL_SYSTEMCTL:-systemctl}"
LOGGER="${CODEX_PROXY_AUTOHEAL_LOGGER:-logger}"
SLEEP="${CODEX_PROXY_AUTOHEAL_SLEEP:-sleep}"
PROBE_ATTEMPTS="${CODEX_PROXY_AUTOHEAL_PROBE_ATTEMPTS:-2}"
RETRY_DELAY_SECONDS="${CODEX_PROXY_AUTOHEAL_RETRY_DELAY_SECONDS:-3}"
REPAIR_COOLDOWN_SECONDS="${CODEX_PROXY_AUTOHEAL_REPAIR_COOLDOWN_SECONDS:-900}"
SERVICE="${CODEX_PROXY_AUTOHEAL_SERVICE:-sing-box}"

for numeric in "$PROBE_ATTEMPTS" "$RETRY_DELAY_SECONDS" "$REPAIR_COOLDOWN_SECONDS"; do
  [[ "$numeric" =~ ^[0-9]+$ ]] || {
    printf 'Codex proxy autoheal requires non-negative numeric settings\n' >&2
    exit 2
  }
done
(( PROBE_ATTEMPTS >= 1 )) || {
  printf 'CODEX_PROXY_AUTOHEAL_PROBE_ATTEMPTS must be at least one\n' >&2
  exit 2
}
[[ "$SERVICE" =~ ^[A-Za-z0-9@_.:-]+$ ]] || {
  printf 'CODEX_PROXY_AUTOHEAL_SERVICE has unsupported characters\n' >&2
  exit 2
}

umask 077
mkdir -p "$STATE_DIR"
exec 9>"$LOCK_FILE"
flock -n 9 || exit 0

read_last_repair() {
  local value=0
  if [[ -r "$STATE_FILE" ]]; then
    value="$(sed -n 's/^last_repair=//p' "$STATE_FILE" | head -1)"
  fi
  [[ "$value" =~ ^[0-9]+$ ]] || value=0
  printf '%s\n' "$value"
}

write_state() {
  local status="$1" last_repair="$2" temporary
  temporary="$STATE_FILE.tmp.$$"
  printf 'status=%s\nlast_repair=%s\nchecked_at=%s\n' \
    "$status" "$last_repair" "$(date --iso-8601=seconds)" > "$temporary"
  mv "$temporary" "$STATE_FILE"
}

probe_once() {
  local code rc
  set +e
  code="$(env -u HTTP_PROXY -u HTTPS_PROXY -u ALL_PROXY -u NO_PROXY \
    "$CURL" --noproxy '' --proxy "$PROXY_URL" \
      --silent --show-error --output /dev/null --write-out '%{http_code}' \
      --connect-timeout 10 --max-time 25 "$CANARY_URL")"
  rc=$?
  set -e
  case "$rc:$code" in
    0:200|0:401|0:403|0:404|0:405|0:429) return 0 ;;
    *) return 1 ;;
  esac
}

probe() {
  local attempt=1
  while (( attempt <= PROBE_ATTEMPTS )); do
    if probe_once; then
      return 0
    fi
    if (( attempt < PROBE_ATTEMPTS && RETRY_DELAY_SECONDS > 0 )); then
      "$SLEEP" "$RETRY_DELAY_SECONDS"
    fi
    ((attempt++))
  done
  return 1
}

log() {
  "$LOGGER" -t vpn-panel-codex-proxy "$1" || true
}

last_repair="$(read_last_repair)"
now="$(date +%s)"
if probe; then
  write_state healthy "$last_repair"
  exit 0
fi

if (( now - last_repair < REPAIR_COOLDOWN_SECONDS )); then
  write_state degraded "$last_repair"
  log "OpenAI proxy canary failed; repair is in cooldown"
  exit 1
fi

log "OpenAI proxy canary failed twice; restarting $SERVICE"
if ! "$SYSTEMCTL" restart "$SERVICE"; then
  write_state failed "$now"
  log "$SERVICE restart command failed"
  exit 1
fi
"$SLEEP" 2
if "$SYSTEMCTL" is-active --quiet "$SERVICE" && probe; then
  write_state repaired "$now"
  log "$SERVICE recovered; OpenAI proxy canary passed"
  exit 0
fi

write_state failed "$now"
log "sing-box restart did not restore the OpenAI proxy canary"
exit 1

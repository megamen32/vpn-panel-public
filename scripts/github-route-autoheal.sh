#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"
CANARY_RESOLVE="${GITHUB_ROUTE_CANARY_RESOLVE:-github.com:443:192.168.2.1}"
OAUTH_CANARY_URL="${GITHUB_ROUTE_OAUTH_CANARY_URL:-https://github.com/login/oauth/authorize}"
OAUTH_EXPECTED_TEXT="${GITHUB_ROUTE_OAUTH_EXPECTED_TEXT:-Sign in to GitHub}"
PROFILE_CANARY_URL="${GITHUB_ROUTE_PROFILE_CANARY_URL:-https://github.com/meanwebuser}"
PROFILE_EXPECTED_TEXT="${GITHUB_ROUTE_PROFILE_EXPECTED_TEXT:-meanwebuser}"
REPO_CANARY_URL="${GITHUB_ROUTE_CANARY_URL:-https://github.com/meanwebuser/whitetransport-public}"
REPO_EXPECTED_TEXT="${GITHUB_ROUTE_EXPECTED_TEXT:-whitetransport-public}"
STATE_FILE="${GITHUB_ROUTE_STATE_FILE:-$REPO_DIR/data/github-route-autoheal.state}"
LOCK_FILE="${GITHUB_ROUTE_LOCK_FILE:-$REPO_DIR/data/github-route-autoheal.lock}"
FAILURES_BEFORE_REPAIR="${GITHUB_ROUTE_FAILURES_BEFORE_REPAIR:-2}"
CURL="${GITHUB_ROUTE_CURL:-curl}"
LOGGER="${GITHUB_ROUTE_LOGGER:-logger}"
DEPLOY="${GITHUB_ROUTE_DEPLOY:-$REPO_DIR/scripts/deploy-all.sh}"

write_state() {
  local failures="$1" status="$2" tmp
  mkdir -p "$(dirname "$STATE_FILE")"
  tmp="${STATE_FILE}.tmp.$$"
  printf 'failures=%s\nstatus=%s\nchecked_at=%s\n' \
    "$failures" "$status" "$(date --iso-8601=seconds)" > "$tmp"
  mv "$tmp" "$STATE_FILE"
}

read_failures() {
  local value=0
  if [[ -r "$STATE_FILE" ]]; then
    value="$(sed -n 's/^failures=//p' "$STATE_FILE" | head -1)"
  fi
  [[ "$value" =~ ^[0-9]+$ ]] || value=0
  printf '%s\n' "$value"
}

probe_url() {
  local url="$1" expected_text="$2" body code
  body="$(mktemp)"
  if ! code="$($CURL --resolve "$CANARY_RESOLVE" --location --silent --show-error \
      --max-time 20 --output "$body" --write-out '%{http_code}' "$url")"; then
    rm -f "$body"
    return 1
  fi
  if [[ "$code" != "200" ]] \
      || ! grep -Fq "$expected_text" "$body" \
      || grep -Eq 'Whoa there!|invalid request|Fastly error|Gateway Time-out' "$body"; then
    rm -f "$body"
    return 1
  fi
  rm -f "$body"
}

probe() {
  probe_url "$OAUTH_CANARY_URL" "$OAUTH_EXPECTED_TEXT" \
    && probe_url "$PROFILE_CANARY_URL" "$PROFILE_EXPECTED_TEXT" \
    && probe_url "$REPO_CANARY_URL" "$REPO_EXPECTED_TEXT"
}

once() {
  local failures
  failures="$(read_failures)"
  if probe; then
    write_state 0 healthy
    return 0
  fi

  failures=$((failures + 1))
  if [[ "$failures" -lt "$FAILURES_BEFORE_REPAIR" ]]; then
    write_state "$failures" degraded
    "$LOGGER" -t vpn-panel-github-route "semantic canary failed ($failures/$FAILURES_BEFORE_REPAIR)"
    return 1
  fi

  "$LOGGER" -t vpn-panel-github-route "semantic canary failed twice; redeploying canonical server-88 route"
  if flock -n "$LOCK_FILE" "$DEPLOY" server-88 && probe; then
    write_state 0 repaired
    "$LOGGER" -t vpn-panel-github-route "canonical server-88 route repaired"
    return 0
  fi

  write_state "$failures" failed
  "$LOGGER" -t vpn-panel-github-route "canonical server-88 redeploy did not restore GitHub route"
  return 1
}

case "${1:---once}" in
  --check)
    bash -n "$0"
    test -x "$DEPLOY"
    command -v "$CURL" >/dev/null
    command -v flock >/dev/null
    echo "GitHub route auto-heal syntax OK"
    ;;
  --once) once ;;
  *) echo "usage: $0 [--check|--once]" >&2; exit 2 ;;
esac

#!/usr/bin/env bash
# Run one shared benchmark profile across all requested network classes.
set -euo pipefail
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"
PROFILE="${PROFILE:-benchmark}"
CHECKS="${CHECKS-__PLAN_DEFAULTS__}"
ENDPOINTS="${ENDPOINTS:-}"

if [[ -f "$REPO_DIR/.env" ]]; then
  set -a
  source "$REPO_DIR/.env"
  set +a
fi
if [[ -z "${VPN_TOKEN:-}" ]]; then
  : "${DATABASE_URL:?DATABASE_URL is required to select the benchmark subscription}"
  VPN_TOKEN="$(psql "$DATABASE_URL" -At -c "select st.token from subscription_tokens st join vpn_clients vc on vc.id=st.client_id join accounts a on a.id=vc.account_id where a.login in ('geier25','Nikita') and st.enabled=true order by a.login limit 1")"
fi
: "${VPN_TOKEN:?No enabled VPN subscription token is available for benchmarks}"
export VPN_TOKEN
export TELEMETRY_URL="${TELEMETRY_URL:-${VPN_PANEL_PUBLIC_BASE_URL:-https://vpn.bezrabotnyi.com}/api/telemetry/vpn-tests/events}"
export TELEMETRY_API_KEY="${TELEMETRY_API_KEY:-${HEALTH_API_KEY:-${VPN_PANEL_HEALTH_API_KEY:-}}}"
: "${TELEMETRY_API_KEY:?VPN benchmark telemetry key is required}"

if [[ -n "${TARGETS:-}" ]]; then
  targets="$TARGETS"
else
  targets=""
  for host in ${HOSTS:-s44 s44-singbox-http s44-singbox-socks mac android}; do
    case "$host" in
      s44|lan-server44) targets+=" lan-server44" ;;
      s44-singbox-http|lan-server44-singbox-http) targets+=" lan-server44-singbox-http" ;;
      s44-singbox-socks|lan-server44-singbox-socks) targets+=" lan-server44-singbox-socks" ;;
      mac|external-mac) targets+=" external-mac" ;;
      android|external-wireless-android) targets+=" external-wireless-android" ;;
      *) echo "Unknown HOSTS/TARGETS entry: $host" >&2; exit 2 ;;
    esac
  done
fi

targets="$(python3 - "$REPO_DIR/vpn-testing/test-plan.json" $targets <<'PY'
import json
import sys

plan_path, *requested = sys.argv[1:]
plan = json.load(open(plan_path, encoding="utf-8"))
enabled = {target["id"] for target in plan["testTargets"] if target.get("enabled", True)}
print(" ".join(target for target in requested if target in enabled))
PY
)"
if [[ -z "$targets" ]]; then
  echo "No enabled test targets selected; nothing to run."
  exit 0
fi

pids=()
for target in $targets; do
  target_args=("$SCRIPT_DIR/run-network-test.sh" "--profile=$PROFILE" "--target=$target")
  if [[ -n "$ENDPOINTS" ]]; then target_args+=("--endpoints=$ENDPOINTS"); fi
  if [[ "$CHECKS" != "__PLAN_DEFAULTS__" ]]; then target_args+=("--checks=$CHECKS"); fi
  "${target_args[@]}" &
  pids+=("$!")
done
status=0
for pid in "${pids[@]}"; do
  wait "$pid" || status=1
done
exit "$status"

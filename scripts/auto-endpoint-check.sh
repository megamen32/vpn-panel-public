#!/usr/bin/env bash
# Scheduled target measurements plus policy application for the canonical LAN target.
set -euo pipefail
SCRIPT_DIR="${VPN_PANEL_SCRIPT_DIR:-$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)}"
REPO_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"
set -a
source "$REPO_DIR/.env"
set +a
requested_targets="${TARGETS:-}"
if [[ -z "${VPN_TOKEN:-}" ]]; then
  account_logins="'geier25','Nikita'"
  # The Mac probe verifies the same owner subscription used on the phone, so
  # its Helsinki result contributes to the user-visible endpoint telemetry.
  if [[ " $requested_targets " == *" external-mac "* ]]; then
    account_logins="'Nikita'"
  fi
  VPN_TOKEN="$(psql "$DATABASE_URL" -At -c "select st.token from subscription_tokens st join vpn_clients vc on vc.id=st.client_id join accounts a on a.id=vc.account_id where a.login in ($account_logins) and st.enabled=true order by a.login limit 1")"
  export VPN_TOKEN
fi
export TELEMETRY_URL="${TELEMETRY_URL:-${VPN_PANEL_PUBLIC_BASE_URL:-https://vpn.bezrabotnyi.com}/api/telemetry/vpn-tests/events}"
export TELEMETRY_API_KEY="${TELEMETRY_API_KEY:-${VPN_PANEL_HEALTH_API_KEY:-}}"
mkdir -p "$REPO_DIR/.tmp"
export TMPDIR="$REPO_DIR/.tmp"
result_marker="$(mktemp "$REPO_DIR/.tmp/endpoint-check.XXXXXX")"
cleanup_marker() { rm -f "$result_marker"; }
trap cleanup_marker EXIT

# Publishing a verdict is measurement, not policy: it refreshes what the admin
# view and the endpoint grant read, and never reassigns a client or restarts
# the panel. It therefore has to run even when profile application is off,
# otherwise the scheduled run measures the fleet and stores nothing, leaving
# every row to age until it is contradicted by real client traffic.
# Publication stays ahead of any profile application that can restart the
# panel, so the POST never races the listener coming back up.
publish_health() {
  local result_file="$1"
  local health_file="${result_file%.json}-health.json"
  python3 "$SCRIPT_DIR/apply-endpoint-health.py" "$result_file" --health-output "$health_file"
  if [[ -n "${VPN_PANEL_HEALTH_API_KEY:-}" ]]; then
    curl -sfL --retry 5 --retry-delay 1 --retry-connrefused --retry-all-errors -X POST "${VPN_PANEL_PUBLIC_BASE_URL:-https://vpn.bezrabotnyi.com}/api/admin/endpoint-health" \
      -H "Authorization: Bearer $VPN_PANEL_HEALTH_API_KEY" -H "Content-Type: application/json" --data-binary "@$health_file"
  else
    echo "VPN_PANEL_HEALTH_API_KEY is unset; health verdicts were not published" >&2
    return 1
  fi
}

latest_lan_result() {
  # The results directory is chosen per run so a wide exploration pass and the
  # recurring subscription pass cannot adopt each other's artifact: both share
  # one profile name, and picking up the newest file in a shared directory means
  # publishing the other run's measurements under this run's verdict.
  find "${RESULTS_DIR:-$REPO_DIR/vpn-testing/results}" -type f -name 'unified-lan-server44-health-*.json' \
    ! -name '*-health.json' -newer "$result_marker" -print | sort | tail -n 1
}

if [[ "${HEALTH_APPLY_PROFILES:-1}" == 0 ]]; then
  # Scope is chosen by the caller, not hardcoded here. The recurring run measures
  # what is actually sold, so a sold endpoint can never go unmeasured between
  # runs; the exploration run widens to every configured endpoint so the ones
  # outside the subscription still accumulate evidence and can be judged.
  for target in ${requested_targets:-lan-server44}; do
    DIAGNOSTIC_SUBSCRIPTION="${DIAGNOSTIC_SUBSCRIPTION:-1}" "${VPN_NETWORK_TEST_SCRIPT:-$SCRIPT_DIR/run-network-test.sh}" \
      "--profile=${PROFILE:-health}" "--target=$target"
  done
  result_file="$(latest_lan_result)"
  if [[ -z "$result_file" ]]; then
    echo "No Xray health result was produced by the measurement run" >&2
    exit 1
  fi
  publish_health "$result_file"
  exit 0
fi

set +e
DIAGNOSTIC_SUBSCRIPTION=1 PROFILE="${PROFILE:-health}" HOSTS="${HEALTH_TEST_HOSTS:-s44 s44-singbox-http s44-singbox-socks mac android}" TARGETS="$requested_targets" \
  "$SCRIPT_DIR/run-bench-everywhere.sh"
matrix_status=$?
set -e
if [[ "$matrix_status" -ne 0 ]]; then
  echo "Health matrix completed with sidecar failures; continuing with server-44 policy result" >&2
fi

if [[ -n "$requested_targets" ]] && [[ " $requested_targets " != *" lan-server44 "* ]]; then
  exit "$matrix_status"
fi

RESULT_FILE="$(latest_lan_result)"
if [[ -z "$RESULT_FILE" ]]; then
  echo "No server-44 Xray health result was produced by the test matrix" >&2
  exit 1
fi
publish_health "$RESULT_FILE"
python3 "$SCRIPT_DIR/apply-endpoint-health.py" "$RESULT_FILE" --apply-profiles --require-canonical-relays >/dev/null
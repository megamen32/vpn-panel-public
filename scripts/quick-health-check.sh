#!/usr/bin/env bash
# Compatibility entrypoint: quick is now a profile of the shared staged plan.
set -euo pipefail
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
RESULT_FILE="$(PROFILE=quick TARGET=lan-server44 "$SCRIPT_DIR/run-network-test.sh" --profile=quick --target=lan-server44)"
HEALTH_FILE="${RESULT_FILE%.json}-health.json"
python3 "$SCRIPT_DIR/apply-endpoint-health.py" "$RESULT_FILE" --health-output "$HEALTH_FILE"
python3 - "$RESULT_FILE" <<'PY'
import json, sys
run=json.load(open(sys.argv[1]))
for ep in run['endpoints']:
    gate=next((c for c in ep.get('checks',[]) if c['id']=='telegram'), {})
    print(f"EP:{ep['endpoint']} TG:{gate.get('code',0)} MS:{gate.get('latencyMs',0)} SPEED:{ep.get('throughput',{}).get('mbps',0) or 0} EXIT:{ep.get('exitIp') or '?'}")
PY
if [[ -n "${HEALTH_API_KEY:-${VPN_PANEL_HEALTH_API_KEY:-}}" ]]; then
  curl -sfL -X POST "${PANEL_URL:-https://vpn.bezrabotnyi.com}/api/admin/endpoint-health" \
    -H "Authorization: Bearer ${HEALTH_API_KEY:-${VPN_PANEL_HEALTH_API_KEY}}" \
    -H "Content-Type: application/json" --data-binary "@$HEALTH_FILE" >/dev/null
fi

#!/usr/bin/env bash
# Telegram DC transparent-lane health check (server-100 LAN client view).
# Probes Telegram DC IPs through the lane and the HAOS TPROXY edge directly;
# alerts NoticePlace on a lane-down transition and resolves on recovery.
# Intended to run every 2 minutes from telegram-lane-check.timer.
set -u

NOTIFY="${LANE_NOTIFY:-/opt/noticeplace/bin/notify-producer}"
PROJECT="${LANE_PROJECT:-telegram-lane.server-100}"
RECIPIENT="${LANE_RECIPIENT:-me}"
DEDUPE_KEY="telegram-lane-down"
STATE_FILE="/var/tmp/telegram-lane-check.state"

probe() { timeout 6 bash -c "exec 3<>/dev/tcp/$1/$2" 2>/dev/null; }

lane_ok() {
  probe 149.154.167.51 443 && probe 91.108.56.130 443
}

edge_ok() { probe 192.168.2.101 12555; }

if lane_ok; then
  state=ok
  reason=""
elif edge_ok; then
  state=down
  reason="TCP to Telegram DC IPs fails while HAOS Smart Edge :12555 is reachable — router steering or edge forwarding is broken"
else
  state=down
  reason="HAOS Smart Edge :12555 unreachable — TPROXY listener down, LAN Telegram steering leads to a dead edge"
fi

last="$(cat "$STATE_FILE" 2>/dev/null || echo ok)"
if [[ "$state" == "down" && "$last" != "down" ]]; then
  "$NOTIFY" --project "$PROJECT" --recipient "$RECIPIENT" --severity critical \
    --title "Telegram TPROXY lane down" --body "$reason" \
    --dedupe-key "$DEDUPE_KEY" \
    --idempotency-key "$DEDUPE_KEY:$(date -u +%Y%m%dT%H%M%SZ)" >/dev/null 2>&1 || true
elif [[ "$state" == "ok" && "$last" == "down" ]]; then
  "$NOTIFY" --project "$PROJECT" --dedupe-key "$DEDUPE_KEY" --resolve >/dev/null 2>&1 || true
fi
printf '%s\n' "$state" > "$STATE_FILE"
echo "telegram-lane: $state${reason:+ — $reason}"
[[ "$state" == "ok" ]]

#!/bin/sh
set -eu

TABLE="100"
MARK="0x1"
MASK="0xff"
NFT_FILE="${NFT_FILE:-/etc/xray/telegram-transparent-lane.nft}"
ENABLE_MARKER="/etc/vpn-panel-telegram-lane/telegram-transparent-lane.enable"

require_approval() {
  [ "${TELEGRAM_TPROXY_LIVE_APPROVED:-0}" = "1" ] || {
    echo "refusing Telegram TPROXY change: TELEGRAM_TPROXY_LIVE_APPROVED=1 is required" >&2
    exit 2
  }
  [ -e "$ENABLE_MARKER" ] || {
    echo "refusing Telegram TPROXY change: $ENABLE_MARKER is absent" >&2
    exit 2
  }
}

apply_policy() {
  require_approval
  # Keep the policy before mwan3 rules if this host is used as a router.
  ip rule del priority 1000 fwmark "$MARK/$MASK" table "$TABLE" 2>/dev/null || true
  ip rule add priority 1000 fwmark "$MARK/$MASK" table "$TABLE"
  # Equivalent first-install command: ip route add local 0.0.0.0/0 dev lo table 100
  ip route replace local 0.0.0.0/0 dev lo table "$TABLE"
  nft -f "$NFT_FILE"
}

rollback_policy() {
  nft delete table inet telegram_transparent 2>/dev/null || true
  ip rule del priority 1000 fwmark "$MARK/$MASK" table "$TABLE" 2>/dev/null || true
  ip rule del fwmark "$MARK/$MASK" table "$TABLE" 2>/dev/null || true
  ip route flush table "$TABLE" 2>/dev/null || true
}

case "${1:---check}" in
  --check) sh -n "$0"; nft -c -f "$NFT_FILE"; echo "Telegram TPROXY policy syntax OK (not applied)" ;;
  --apply) apply_policy ;;
  --rollback) rollback_policy ;;
  *) echo "usage: $0 [--check|--apply|--rollback]" >&2; exit 2 ;;
esac

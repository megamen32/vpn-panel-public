#!/bin/sh
set -eu

TABLE=100
MARK=0x1
MASK=0xff
NFT_FILE=/etc/vpn-panel/xray-lan-edge/telegram-transparent-lane.nft

case "${1:---apply}" in
  --check) sh -n "$0"; nft -c -f "$NFT_FILE" ;;
  --apply)
    ip rule del priority 1000 fwmark "$MARK/$MASK" table "$TABLE" 2>/dev/null || true
    ip rule add priority 1000 fwmark "$MARK/$MASK" table "$TABLE"
    ip route replace local 0.0.0.0/0 dev lo table "$TABLE"
    nft -f "$NFT_FILE"
    ;;
  --rollback)
    nft delete table inet telegram_transparent 2>/dev/null || true
    ip rule del priority 1000 fwmark "$MARK/$MASK" table "$TABLE" 2>/dev/null || true
    ip route flush table "$TABLE" 2>/dev/null || true
    ;;
  *) exit 2 ;;
esac

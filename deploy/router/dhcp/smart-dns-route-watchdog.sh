#!/bin/sh
set -eu

CANARY_DOMAIN="${CANARY_DOMAIN:-d3e54v103j8qbb.cloudfront.net}"
LAN_EDGE_IP="${LAN_EDGE_IP:-192.168.2.1}"
DNS_SERVER="${DNS_SERVER:-127.0.0.1}"
CONFIGURE="${CONFIGURE:-/usr/sbin/vpn-panel-configure-smart-dns}"
STATE_FILE="/var/run/vpn-panel-smart-dns-route.state"

route_ok() {
  nslookup -timeout=2 -retry=1 "$CANARY_DOMAIN" "$DNS_SERVER" 2>/dev/null | grep -Fq "Address: $LAN_EDGE_IP"
}

repair() {
  logger -t vpn-panel-smart-dns "route canary failed; restoring generated SmartDNS policy"
  "$CONFIGURE" --repair
  route_ok
}

watch() {
  failures=0
  while :; do
    if route_ok; then
      failures=0
    else
      failures=$((failures + 1))
      if [ "$failures" -ge 2 ]; then
        repair && printf '%s\n' repaired > "$STATE_FILE" || printf '%s\n' failed > "$STATE_FILE"
        failures=0
      fi
    fi
    sleep 30
  done
}

case "${1:---check}" in
  --check) sh -n "$0"; "$CONFIGURE" --check >/dev/null; echo "SmartDNS route watchdog syntax OK" ;;
  --once) route_ok ;;
  --watch) watch ;;
  *) echo "usage: $0 [--check|--once|--watch]" >&2; exit 2 ;;
esac

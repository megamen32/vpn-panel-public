#!/bin/sh
set -eu

SMART_DNS_IP="${SMART_DNS_IP:-192.168.2.100}"
FALLBACK_DNS_IP="${FALLBACK_DNS_IP:-77.88.8.8}"
PROBE_NAME="${PROBE_NAME:-ya.ru}"
STATE_FILE="/var/run/vpn-panel-smart-dns-upstream.state"

probe_smartdns() {
  nslookup -timeout=2 -retry=1 "$PROBE_NAME" "$SMART_DNS_IP" >/dev/null 2>&1
}

set_upstream() {
  upstream="$1"
  current="$(uci -q get dhcp.@dnsmasq[0].server 2>/dev/null || true)"
  [ "$current" = "$upstream" ] && return 0
  uci -q delete dhcp.@dnsmasq[0].server || true
  uci add_list "dhcp.@dnsmasq[0].server=$upstream"
  uci commit dhcp
  /etc/init.d/dnsmasq restart
  printf '%s\n' "$upstream" > "$STATE_FILE"
  logger -t vpn-panel-smart-dns "DNS upstream switched to $upstream"
}

watch() {
  failures=0
  successes=0
  while :; do
    if probe_smartdns; then
      successes=$((successes + 1))
      failures=0
      if [ "$successes" -ge 2 ]; then
        set_upstream "$SMART_DNS_IP"
        successes=0
      fi
    else
      failures=$((failures + 1))
      successes=0
      if [ "$failures" -ge 2 ]; then
        set_upstream "$FALLBACK_DNS_IP"
        failures=0
      fi
    fi
    sleep 15
  done
}

case "${1:---check}" in
  --check) sh -n "$0"; echo "SmartDNS upstream watchdog syntax OK" ;;
  --watch) watch ;;
  *) echo "usage: $0 [--check|--watch]" >&2; exit 2 ;;
esac

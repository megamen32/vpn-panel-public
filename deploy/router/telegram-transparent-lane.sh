#!/bin/sh
# Candidate only: OpenWrt marks Telegram CIDRs and policy-routes them to the
# HAOS sing-box TPROXY listener. It deliberately starts no process.

set -eu

# LIVE_APPLY=0 is the default; approval is required for --apply.
LIVE_APPLY="${TELEGRAM_TPROXY_LIVE_APPROVED:-0}"
MODE="${1:---dry-run}"
SET4="telegram_v4"
SET6="telegram_v6"
LEGACY_GITHUB_SET4="github_v4"
MARK="0x1"
MASK="0xff"
TABLE="100"
EDGE_HOST="${TELEGRAM_TPROXY_EDGE_HOST:-192.168.2.101}"
TPROXY_PORT="12555"
BACKUP_PATTERN="/etc/vpn-panel-telegram-lane/backups/telegram_<UTC>.state"

ipv4="91.108.56.0/22 91.108.4.0/22 91.108.8.0/22 91.108.16.0/22 91.108.12.0/22 149.154.160.0/20 91.105.192.0/23 91.108.20.0/22 185.76.151.0/24"
ipv6="2001:b28:f23d::/48 2001:b28:f23f::/48 2001:67c:4e8::/48 2001:b28:f23c::/48 2a0a:f280::/32"

cleanup_legacy_github() {
  iptables -t mangle -D PREROUTING -i br-lan -m set --match-set "$LEGACY_GITHUB_SET4" dst -j MARK --set-xmark 0x1/0x1 2>/dev/null || true
  ipset destroy "$LEGACY_GITHUB_SET4" 2>/dev/null || true
}

rollback() {
  iptables -t mangle -D PREROUTING -i br-lan -m set --match-set "$SET4" dst -j MARK --set-xmark 0x1/0x1 2>/dev/null || true
  ip6tables -t mangle -D PREROUTING -i br-lan -m set --match-set "$SET6" dst -j MARK --set-xmark 0x1/0x1 2>/dev/null || true
  cleanup_legacy_github
  ip rule del priority 1000 fwmark "$MARK/$MASK" table "$TABLE" 2>/dev/null || true
  ip rule del priority 10010 fwmark "$MARK/$MASK" table "$TABLE" 2>/dev/null || true
  ip rule del priority 10009 to 149.154.160.0/20 table "$TABLE" 2>/dev/null || true
  ip route flush table "$TABLE" 2>/dev/null || true
  ipset destroy "$SET4" 2>/dev/null || true
  ipset destroy "$SET6" 2>/dev/null || true
}

probe_edge() {
  # BusyBox nc on OpenWrt has no -z/-w (and there is no timeout applet):
  # connect with immediate stdin EOF — 0 when the edge accepts, nonzero otherwise.
  nc "$EDGE_HOST" "$TPROXY_PORT" </dev/null >/dev/null 2>&1
}

lane_active() {
  # Require every primitive that steers Telegram DC traffic before claiming active.
  ipset list "$SET4" >/dev/null 2>&1 &&
    iptables -t mangle -C PREROUTING -i br-lan -m set --match-set "$SET4" dst -j MARK --set-xmark 0x1/0x1 2>/dev/null &&
    ip rule show | grep -q "fwmark $MARK/$MASK.*lookup $TABLE"
}

lane_configured() {
  # Detect a partial or active policy without mutating it when HAOS is down.
  ipset list "$SET4" >/dev/null 2>&1 || ipset list "$SET6" >/dev/null 2>&1
}

apply() {
  [ "$LIVE_APPLY" = 1 ] || { echo "refusing live apply: TELEGRAM_TPROXY_LIVE_APPROVED=1 required" >&2; exit 2; }
  cleanup_legacy_github
  ipset create "$SET4" hash:net family inet -exist
  # IPv6 steering is intentionally deferred: the LAN currently has no global
  # IPv6 route, and enabling a mark without a complete v6 return path would
  # blackhole Telegram instead of failing open.
  for cidr in $ipv4; do ipset add "$SET4" "$cidr" -exist; done
  iptables -t mangle -C PREROUTING -i br-lan -m set --match-set "$SET4" dst -j MARK --set-xmark 0x1/0x1 2>/dev/null || \
    iptables -t mangle -A PREROUTING -i br-lan -m set --match-set "$SET4" dst -j MARK --set-xmark 0x1/0x1
  # Must run before mwan3's 2001/2002 rules; those preserve the low bit but
  # otherwise would send the packet to the WAN table first.
  ip rule add priority 1000 fwmark "$MARK/$MASK" table "$TABLE" 2>/dev/null || true
  # A policy table needs its own connected LAN route before using HAOS as a gateway.
  ip route replace 192.168.2.0/24 dev br-lan scope link table "$TABLE"
  ip route replace default via "$EDGE_HOST" dev br-lan table "$TABLE"
}

watchdog() {
  cleanup_legacy_github
  while :; do
    if probe_edge; then
      # A transient Xray restart must self-heal instead of leaving Telegram direct.
      if ! lane_active; then
        LIVE_APPLY=1 apply
      fi
    elif lane_configured; then
      echo "HAOS Telegram TPROXY unavailable; leaving Telegram steering unchanged" >&2
    fi
    sleep 10
  done
}

case "$MODE" in
  --dry-run|--check)
    echo "Telegram transparent lane candidate (dry-run only; LIVE_APPLY=$LIVE_APPLY)"
    echo "backup=$BACKUP_PATTERN"
    echo "ipset create $SET4 hash:net family inet"
    for cidr in $ipv4; do echo "ipset add $SET4 $cidr"; done
    echo "remove legacy GitHub interception set $LEGACY_GITHUB_SET4"
    echo "ipset create $SET6 hash:net family inet6"
    for cidr in $ipv6; do echo "ipset add $SET6 $cidr"; done
    echo "iptables -t mangle -A PREROUTING -m set --match-set $SET4 dst -j MARK --set-mark $MARK/$MASK"
    echo "ip6tables -t mangle -A PREROUTING -m set --match-set $SET6 dst -j MARK --set-mark $MARK/$MASK"
    echo "ip rule add fwmark $MARK/$MASK table $TABLE"
    echo "ip route add default via $EDGE_HOST table $TABLE"
    echo "target=haos:$EDGE_HOST:$TPROXY_PORT"
    echo "automatic_rollback=disabled"
    ;;
  --rollback)
    rollback
    ;;
  --apply)
    apply
    ;;
  --watchdog)
    watchdog
    ;;
  *)
    echo "usage: $0 [--dry-run|--check|--rollback|--apply]" >&2
    exit 2
    ;;
esac

#!/bin/sh
set -eu

mode="${1:---dry-run}"
server_ip="192.168.2.100"
server_port="5354"
rate="200/second"

configure_redirect() {
  section="$1"
  protocol="$2"
  label="$3"
  uci -q delete "firewall.$section" || true
  uci set "firewall.$section=redirect"
  uci set "firewall.$section.name=$label"
  uci set "firewall.$section.src=wan"
  uci set "firewall.$section.src_dport=53"
  uci set "firewall.$section.dest=lan"
  uci set "firewall.$section.dest_ip=$server_ip"
  uci set "firewall.$section.dest_port=$server_port"
  uci set "firewall.$section.proto=$protocol"
  uci set "firewall.$section.target=DNAT"
  uci set "firewall.$section.reflection=0"
  uci set "firewall.$section.limit=$rate"
  uci set "firewall.$section.limit_burst=400"
}

usage() {
  echo "Public SmartDNS usage channel (WAN DNS only)"
  nft list chain inet fw4 dstnat_wan 2>/dev/null | grep -E 'Public SmartDNS (UDP|TCP)' || true
}

dry_run() {
  configure_redirect public_smartdns_udp udp 'Public SmartDNS UDP'
  configure_redirect public_smartdns_tcp tcp 'Public SmartDNS TCP'
  trap 'uci revert firewall' INT TERM HUP EXIT
  fw4 check
  uci revert firewall
  trap - INT TERM HUP EXIT
  echo "Validated WAN UDP/TCP 53 -> $server_ip:$server_port with limit $rate burst 400"
  echo "Usage command: /usr/sbin/public-smartdns --usage"
}

apply() {
  timestamp="$(date -u +%Y%m%d_%H%M%S)"
  backup="/etc/config/firewall.bak_public_smartdns_$timestamp"
  cp -a /etc/config/firewall "$backup"
  rollback_on_error() {
    cp -a "$backup" /etc/config/firewall
    uci revert firewall || true
    /etc/init.d/firewall reload >/dev/null 2>&1 || true
  }
  trap rollback_on_error INT TERM HUP EXIT
  configure_redirect public_smartdns_udp udp 'Public SmartDNS UDP'
  configure_redirect public_smartdns_tcp tcp 'Public SmartDNS TCP'
  uci commit firewall
  fw4 check
  /etc/init.d/firewall reload
  trap - INT TERM HUP EXIT
  echo "Public SmartDNS enabled; rollback: cp -a $backup /etc/config/firewall && /etc/init.d/firewall reload"
  usage
}

rollback() {
  uci -q delete firewall.public_smartdns_udp || true
  uci -q delete firewall.public_smartdns_tcp || true
  uci commit firewall
  fw4 check
  /etc/init.d/firewall reload
  echo "Public SmartDNS redirects removed"
}

case "$mode" in
  --dry-run) dry_run ;;
  --apply) apply ;;
  --rollback) rollback ;;
  --usage) usage ;;
  *) echo "usage: $0 [--dry-run|--apply|--rollback|--usage]" >&2; exit 2 ;;
esac

#!/usr/bin/env bash
set -euo pipefail
port="${1:?usage: telegram-tproxy-policy.sh PORT [--apply|--rollback|--check]}"
mode="${2:---check}"
apply() {
  nft delete table inet telegram_transparent 2>/dev/null || true
  ip rule del priority 1000 fwmark 0x1/0xff table 100 2>/dev/null || true
  ip rule add priority 1000 fwmark 0x1/0xff table 100
  ip route replace local 0.0.0.0/0 dev lo table 100
  nft -f - <<EOF
table inet telegram_transparent {
  set telegram_v4 { type ipv4_addr; flags interval; elements = { 91.108.4.0/22, 91.108.8.0/22, 91.108.12.0/22, 91.108.16.0/22, 91.108.20.0/22, 91.108.56.0/22, 91.105.192.0/23, 149.154.160.0/20, 185.76.151.0/24 } }
  chain prerouting { type filter hook prerouting priority mangle; policy accept; ip daddr @telegram_v4 counter meta l4proto { tcp, udp } tproxy ip to :$port meta mark set 0x1 accept; }
}
EOF
}
rollback() { nft delete table inet telegram_transparent 2>/dev/null || true; ip rule del priority 1000 fwmark 0x1/0xff table 100 2>/dev/null || true; ip route flush table 100 2>/dev/null || true; }
case "$mode" in --apply) apply;; --rollback) rollback;; --check) nft -c -f - <<EOF
table inet telegram_transparent { chain prerouting { type filter hook prerouting priority mangle; policy accept; meta l4proto tcp tproxy to :$port meta mark set 0x1 accept } }
EOF
;; *) exit 2;; esac

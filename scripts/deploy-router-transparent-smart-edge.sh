#!/usr/bin/env bash
set -euo pipefail

panel_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
router="${LAN_SMART_EDGE_ROUTER:-root@192.168.2.1}"
haos_ip="${LAN_SMART_EDGE_HAOS_IP:-192.168.2.101}"
router_ip="${LAN_SMART_EDGE_ROUTER_IP:-192.168.2.1}"
lan_cidr="${LAN_SMART_EDGE_LAN_CIDR:-192.168.2.0/24}"
public_edge_ip="${LAN_SMART_DNS_PUBLIC_EDGE_IP:-203.0.113.1}"
router_script="$panel_dir/deploy/router/transparent-smart-edge/apply.sh"
router_dns_script="$panel_dir/deploy/router/dhcp/configure-smart-dns.sh"
action="${1:---apply}"

mkdir -p "$panel_dir/.tmp"
router_dns_rules="$(mktemp "$panel_dir/.tmp/openwrt-smart-dns.XXXXXX")"
trap 'rm -f "$router_dns_rules"' EXIT

remote_run() {
  local remote_action="$1"
  local backup="${2:-}"
  ssh -o BatchMode=yes "$router" \
    "sh -s -- '$remote_action' '$haos_ip' '$router_ip' '$lan_cidr' '$public_edge_ip' '$backup'" < "$router_script"
}

configure_router_dns() {
  sudo -n "$panel_dir/node_modules/.bin/tsx" "$panel_dir/src/cli/render-openwrt-smart-dns.ts" --output "$router_dns_rules"
  ssh -o BatchMode=yes "$router" 'mkdir -p /root/vpn-panel-smartdns-stage'
  scp -q "$router_dns_script" "$router_dns_rules" "$router:/root/vpn-panel-smartdns-stage/"
  ssh -o BatchMode=yes "$router" \
    "sh -n /root/vpn-panel-smartdns-stage/configure-smart-dns.sh && sh /root/vpn-panel-smartdns-stage/configure-smart-dns.sh --check '$haos_ip' '$router_ip' /root/vpn-panel-smartdns-stage/$(basename "$router_dns_rules") '$router_ip'"
  ssh -o BatchMode=yes "$router" \
    "sh /root/vpn-panel-smartdns-stage/configure-smart-dns.sh '$haos_ip' '$router_ip' /root/vpn-panel-smartdns-stage/$(basename "$router_dns_rules") '$router_ip'; rm -rf /root/vpn-panel-smartdns-stage"
}

client_canary() {
  nslookup ya.ru "$router_ip" >/dev/null 2>&1 || return 1
  nslookup chatgpt.com "$router_ip" 2>/dev/null | grep -Fq "Address: $router_ip" || return 1
  local code
  code="$(curl --noproxy '*' -4 -sS -o /dev/null -w '%{http_code}' \
    --connect-timeout 3 --max-time 12 \
    --resolve chatgpt.com:443:"$router_ip" https://chatgpt.com/ 2>/dev/null || true)"
  [[ -n "$code" && "$code" != "000" ]]
  [[ "$(curl -4 -sS -o /dev/null -w '%{http_code}' --connect-timeout 3 --max-time 12 --proxy "http://$router_ip:3127" https://www.gstatic.com/generate_204 2>/dev/null || true)" = 204 ]]
  [[ "$(curl -4 -sS -o /dev/null -w '%{http_code}' --connect-timeout 3 --max-time 12 --proxy "http://$router_ip:3128" https://www.gstatic.com/generate_204 2>/dev/null || true)" = 204 ]]
}

case "$action" in
  --check|--validate)
    remote_run "--public-alias-${action#--}"
    ;;
  --apply)
    remote_run --public-alias-check
    output="$(remote_run --public-alias-apply)"
    printf '%s\n' "$output"
    backup="$(sed -n 's/.* backup=\([^ ]*\)$/\1/p' <<< "$output" | tail -1)"
    if [[ -z "$backup" ]]; then
      echo "Router apply did not return a rollback path" >&2
      exit 1
    fi
    configure_router_dns
    if ! client_canary; then
      echo "LAN canary failed; restoring $backup" >&2
      remote_run --rollback "$backup" >&2 || true
      exit 1
    fi
    echo "LAN canary OK: DNS $router_ip:53, public SmartDNS alias $public_edge_ip:443, US proxy $router_ip:3127, DE proxy $router_ip:3128; rollback: $0 --rollback '$backup'"
    ;;
  --rollback)
    backup="${2:-}"
    [[ "$backup" == /root/vpn-panel-transparent-smart-edge/backups/* ]] || {
      echo "Usage: $0 --rollback /root/vpn-panel-transparent-smart-edge/backups/TIMESTAMP" >&2
      exit 2
    }
    remote_run --rollback "$backup"
    ;;
  *)
    echo "Usage: $0 [--check|--validate|--apply|--rollback BACKUP_DIR]" >&2
    exit 2
    ;;
esac

#!/usr/bin/env bash
set -euo pipefail

target_ip="${1:?usage: $0 192.168.2.1|192.168.2.5|192.168.2.75}"
case "$target_ip" in
  192.168.2.1|192.168.2.5|192.168.2.75) ;;
  *) echo "refusing unknown LAN Smart Edge: $target_ip" >&2; exit 2 ;;
esac

config=/opt/smart-dns/config.json
stamp="$(date -u +%Y%m%d_%H%M%S)"
candidate="$(mktemp)"
router_rules="$(mktemp)"
router_host="${LAN_SMART_EDGE_ROUTER:-root@192.168.2.1}"
router_script="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)/deploy/router/dhcp/configure-smart-dns.sh"
trap 'rm -f "$candidate" "$router_rules"' EXIT

"$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)/node_modules/.bin/tsx" \
  "$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)/src/cli/render-openwrt-smart-dns.ts" --output "$router_rules"
sh -n "$router_script"
scp -q "$router_script" "$router_host:/tmp/configure-smart-dns.sh"
scp -q "$router_rules" "$router_host:/tmp/vpn-panel-smart-dns.domains"
ssh -o BatchMode=yes "$router_host" \
  "sh -n /tmp/configure-smart-dns.sh && sh /tmp/configure-smart-dns.sh --check 192.168.2.100 '$target_ip' /tmp/vpn-panel-smart-dns.domains 192.168.2.1"

# The router is the DHCP-advertised resolver, so change its synthesized LAN
# answers before changing the upstream resolver's matching local profile.
ssh -o BatchMode=yes "$router_host" \
  "sh /tmp/configure-smart-dns.sh 192.168.2.100 '$target_ip' /tmp/vpn-panel-smart-dns.domains 192.168.2.1; rm -f /tmp/configure-smart-dns.sh /tmp/vpn-panel-smart-dns.domains"

sudo test -r "$config"
sudo cp -a "$config" "$config.bak_$stamp"
sudo jq --arg ip "$target_ip" '
  .httpProxy.host = $ip
  | .edgeProfiles.local.ipv4 = $ip
  | .edgeProfiles.local.ipv4s = [$ip]
' "$config" > "$candidate"
sudo install -m 0640 -o root -g roomhacker "$candidate" "$config"
sudo systemctl restart smart-dns.service
sudo systemctl is-active --quiet smart-dns.service
dig @192.168.2.100 telegram.org A +short +time=3 +tries=1 | grep -Fx "$target_ip" >/dev/null
echo "LAN SmartDNS now uses $target_ip; rollback: sudo cp -a $config.bak_$stamp $config && sudo systemctl restart smart-dns.service"

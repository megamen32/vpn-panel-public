#!/usr/bin/env bash
set -euo pipefail

if [[ "${ALLOW_LEGACY_ROUTER_HAPROXY_ROLLBACK:-0}" != 1 ]]; then
  echo "This router HAProxy deployment is retired." >&2
  echo "Use scripts/deploy-router-transparent-smart-edge.sh; set ALLOW_LEGACY_ROUTER_HAPROXY_ROLLBACK=1 only for an explicit rollback." >&2
  exit 2
fi

panel_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
remote="${LAN_SMART_EDGE_ROUTER:-root@192.168.2.1}"
source_config="$panel_dir/deploy/router/haproxy/haproxy.cfg"
stamp="$(date -u +%Y%m%d_%H%M%S)"

scp -q "$source_config" "$remote:/tmp/vpn-panel-haproxy-$stamp.cfg"
ssh -o BatchMode=yes "$remote" "haproxy -c -f /tmp/vpn-panel-haproxy-$stamp.cfg"
ssh -o BatchMode=yes "$remote" "sh -s -- '$stamp'" <<'REMOTE'
set -eu
stamp="$1"
candidate="/tmp/vpn-panel-haproxy-$stamp.cfg"
backup="/etc/haproxy.cfg.bak_lan_smart_$stamp"
cp -a /etc/haproxy.cfg "$backup"
if ! cp "$candidate" /etc/haproxy.cfg || ! haproxy -c -f /etc/haproxy.cfg || ! /etc/init.d/haproxy restart; then
  cp -a "$backup" /etc/haproxy.cfg
  /etc/init.d/haproxy restart || true
  exit 1
fi
rm -f "$candidate"
REMOTE
"$panel_dir/scripts/switch-lan-smart-edge.sh" 192.168.2.1
echo "Router LAN Smart Edge active at 192.168.2.1:80,443; rollback HAProxy: ssh $remote 'cp -a /etc/haproxy.cfg.bak_lan_smart_$stamp /etc/haproxy.cfg && /etc/init.d/haproxy reload'"

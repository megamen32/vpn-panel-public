#!/usr/bin/env bash
set -euo pipefail

script_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
panel_dir="$(cd "$script_dir/.." && pwd)"
router="${PUBLIC_SMARTDNS_ROUTER:-root@192.168.2.1}"
mode="${1:---dry-run}"
source="$panel_dir/deploy/router/public-smartdns.sh"

[[ "$mode" == --dry-run || "$mode" == --apply || "$mode" == --rollback || "$mode" == --usage ]] || {
  echo "usage: $0 [--dry-run|--apply|--rollback|--usage]" >&2
  exit 2
}

sh -n "$source"
if [[ "$mode" == --dry-run ]]; then
  ssh "$router" 'sh -s -- --dry-run' < "$source"
  echo "Public SmartDNS router dry-run OK"
  exit 0
fi
if [[ "$mode" == --usage ]]; then
  ssh "$router" '/usr/sbin/public-smartdns --usage'
  exit 0
fi
if [[ "$mode" == --rollback ]]; then
  ssh "$router" '/usr/sbin/public-smartdns --rollback'
  exit 0
fi

ssh "$router" 'test ! -e /usr/sbin/public-smartdns || cp -a /usr/sbin/public-smartdns /usr/sbin/public-smartdns.bak_$(date -u +%Y%m%d_%H%M%S)'
scp -q "$source" "$router:/usr/sbin/public-smartdns"
ssh "$router" 'chmod 0755 /usr/sbin/public-smartdns && /usr/sbin/public-smartdns --apply'

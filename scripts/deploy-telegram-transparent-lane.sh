#!/usr/bin/env bash
set -euo pipefail

# Reproducible installer for the opt-in Telegram transparent lane.
# Default is validation-only; live changes require --apply plus an explicit
# TELEGRAM_TPROXY_LIVE_APPROVED=1 environment variable.

script_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
panel_dir="$(cd "$script_dir/.." && pwd)"
mode="${1:---dry-run}"
# Portable edge contract. The default is server-88; moving the Xray edge only
# changes these paths/SSH target, not the router CIDR or watchdog logic.
edge_ssh="${TELEGRAM_EDGE_SSH:-roomhacker-server-88}"
edge_config="${TELEGRAM_EDGE_CONFIG:-/usr/local/etc/xray/config.json}"
edge_base_config="${TELEGRAM_BASE_CONFIG:-$panel_dir/deploy/server-88/xray/config.json}"
edge_policy="${TELEGRAM_EDGE_POLICY:-/usr/local/sbin/telegram-transparent-policy.sh}"
edge_nft="${TELEGRAM_EDGE_NFT:-/usr/local/etc/xray/telegram-transparent-lane.nft}"
edge_unit="${TELEGRAM_EDGE_UNIT:-/etc/systemd/system/telegram-transparent-policy.service}"
router="root@192.168.2.1"

die() { echo "ERROR: $*" >&2; exit 1; }
[[ "$mode" == --dry-run || "$mode" == --apply || "$mode" == --rollback ]] || die "usage: $0 [--dry-run|--apply|--rollback]"

sh -n "$panel_dir/deploy/server-88/telegram-transparent-policy.sh"
sh -n "$panel_dir/deploy/router/telegram-transparent-lane.sh"
sh -n "$panel_dir/deploy/router/telegram-transparent-lane.init"
python3 -m json.tool "$panel_dir/deploy/server-88/telegram-transparent-lane.json" >/dev/null

if [[ "$mode" == --dry-run ]]; then
  (cd "$panel_dir" && npm run --silent validate:telegram-lane >/dev/null)
  echo "Telegram transparent lane: validation-only; no remote changes"
  exit 0
fi

if [[ "$mode" == --rollback ]]; then
  ssh "$edge_ssh" "sudo '$edge_policy' --rollback || true; sudo rm -f /etc/vpn-panel-telegram-lane/telegram-transparent-lane.enable; sudo systemctl disable --now telegram-transparent-policy.service >/dev/null 2>&1 || true"
  ssh "$router" '/etc/init.d/telegram-transparent-lane stop || true'
  echo "Telegram transparent lane rolled back"
  exit 0
fi

[[ "${TELEGRAM_TPROXY_LIVE_APPROVED:-0}" == 1 ]] || die "--apply requires TELEGRAM_TPROXY_LIVE_APPROVED=1"

tmp_config="$(mktemp)"
trap 'rm -f "$tmp_config"' EXIT
if [[ -z "${DATABASE_URL:-}" && -f "$panel_dir/.env" ]]; then
  set -a; source "$panel_dir/.env"; set +a
fi
(cd "$panel_dir" && TELEGRAM_TPROXY_ENABLE=1 TELEGRAM_BASE_CONFIG="$edge_base_config" "$panel_dir/node_modules/.bin/tsx" src/cli/_gen-server88-config.ts >"$tmp_config")
python3 -m json.tool "$tmp_config" >/dev/null

scp "$tmp_config" "$edge_ssh:/tmp/xray.telegram.new.json"
scp "$panel_dir/deploy/server-88/telegram-transparent-policy.sh" "$edge_ssh:/tmp/telegram-transparent-policy.sh"
scp "$panel_dir/deploy/router/telegram-transparent-lane.nft" "$edge_ssh:/tmp/telegram-transparent-lane.nft"
scp "$panel_dir/deploy/server-88/systemd/telegram-transparent-policy.service" "$edge_ssh:/tmp/telegram-transparent-policy.service"
ssh "$edge_ssh" "set -e
  sudo /usr/local/bin/xray run -test -config /tmp/xray.telegram.new.json >/dev/null
  ts=\$(date -u +%Y%m%d_%H%M%S)
  sudo cp -a '$edge_config' '$edge_config'.bak_telegram_\$ts
  sudo install -m 0644 /tmp/xray.telegram.new.json '$edge_config'
  sudo install -m 0755 /tmp/telegram-transparent-policy.sh '$edge_policy'
  sudo install -m 0644 /tmp/telegram-transparent-lane.nft '$edge_nft'
  sudo install -m 0644 /tmp/telegram-transparent-policy.service '$edge_unit'
  sudo install -d /etc/vpn-panel-telegram-lane
  sudo touch /etc/vpn-panel-telegram-lane/telegram-transparent-lane.enable
  sudo systemctl daemon-reload
  sudo systemctl restart xray
  sudo systemctl enable telegram-transparent-policy.service
  sudo systemctl restart telegram-transparent-policy.service
  rm -f /tmp/xray.telegram.new.json /tmp/telegram-transparent-*.sh /tmp/telegram-transparent-*.nft /tmp/telegram-transparent-*.service"

scp "$panel_dir/deploy/router/telegram-transparent-lane.sh" "$router:/tmp/telegram-transparent-lane.sh"
scp "$panel_dir/deploy/router/telegram-transparent-lane.init" "$router:/tmp/telegram-transparent-lane"
scp "$panel_dir/deploy/router/telegram-dc-failover.init" "$router:/tmp/telegram-dc-failover.init"
ssh "$router" 'set -e
  cp /tmp/telegram-transparent-lane.sh /usr/sbin/telegram-transparent-lane
  chmod 0755 /usr/sbin/telegram-transparent-lane
  cp /tmp/telegram-transparent-lane /etc/init.d/telegram-transparent-lane
  chmod 0755 /etc/init.d/telegram-transparent-lane
  cp /tmp/telegram-dc-failover.init /etc/init.d/telegram-dc-failover
  chmod 0755 /etc/init.d/telegram-dc-failover
  /etc/init.d/telegram-dc-failover disable
  /etc/init.d/telegram-dc-failover stop
  /etc/init.d/telegram-transparent-lane enable
  /etc/init.d/telegram-transparent-lane restart
  rm -f /tmp/telegram-transparent-lane.sh /tmp/telegram-transparent-lane /tmp/telegram-dc-failover.init'

echo "Telegram transparent lane deployed from repository"

#!/usr/bin/env bash
set -euo pipefail

panel_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
remote_host="${LAN_SMART_EDGE_REMOTE:-roomhacker@192.168.2.5}"
listen_ip="${LAN_SMART_EDGE_LISTEN_IP:-192.168.2.5}"
image="teddysun/xray:26.6.1"
stamp="$(date -u +%Y%m%d_%H%M%S)"
work_dir="$(mktemp -d)"
remote_config="/etc/vpn-panel/xray-lan-edge/config.json"
remote_unit="/etc/systemd/system/xray-lan-edge.service"
remote_nft="/etc/vpn-panel/xray-lan-edge/telegram-transparent-lane.nft"
remote_policy_script="/usr/local/sbin/xray-lan-edge-telegram-policy.sh"
remote_policy_unit="/etc/systemd/system/xray-lan-edge-telegram-policy.service"
dry_run=false

if [[ "${1:-}" == "--dry-run" ]]; then
  dry_run=true
  shift
fi
if [[ $# -ne 0 ]]; then
  echo "usage: $0 [--dry-run]" >&2
  exit 2
fi

cleanup() { rm -rf "$work_dir"; }
trap cleanup EXIT

(cd "$panel_dir" && LAN_SMART_EDGE_LISTEN_IP="$listen_ip" LAN_SMART_EDGE_TPROXY=1 ./node_modules/.bin/tsx src/cli/render-lan-smart-edge.ts > "$work_dir/config.json")
docker run --rm -v "$work_dir/config.json:/etc/xray/config.json:ro" "$image" xray run -test -config /etc/xray/config.json
if $dry_run; then
  echo "server-44 LAN Smart Edge + Telegram TPROXY config validates"
  exit 0
fi
scp -q "$work_dir/config.json" "$remote_host:/tmp/xray-lan-edge-config-$stamp.json"
scp -q "$panel_dir/deploy/server-44/xray-lan-edge/xray-lan-edge.service" "$remote_host:/tmp/xray-lan-edge.service-$stamp"
scp -q "$panel_dir/deploy/server-44/xray-lan-edge/telegram-transparent-lane.nft" "$remote_host:/tmp/telegram-transparent-lane-$stamp.nft"
scp -q "$panel_dir/deploy/server-44/xray-lan-edge/telegram-transparent-policy.sh" "$remote_host:/tmp/xray-lan-edge-telegram-policy-$stamp.sh"
scp -q "$panel_dir/deploy/server-44/xray-lan-edge/telegram-transparent-policy.service" "$remote_host:/tmp/xray-lan-edge-telegram-policy.service-$stamp"

ssh -o BatchMode=yes "$remote_host" "sudo bash -s -- '$stamp'" <<'REMOTE'
set -euo pipefail
stamp="$1"
config_dir=/etc/vpn-panel/xray-lan-edge
config="$config_dir/config.json"
unit=/etc/systemd/system/xray-lan-edge.service
telegram_nft="$config_dir/telegram-transparent-lane.nft"
telegram_policy=/usr/local/sbin/xray-lan-edge-telegram-policy.sh
telegram_unit=/etc/systemd/system/xray-lan-edge-telegram-policy.service
backup_path() {
  name="$1" path="$2"
  if [ -e "$path" ]; then
    cp -a "$path" "$path.bak_$stamp"
    eval "had_$name=1"
  else
    eval "had_$name=0"
  fi
}
restore_path() {
  name="$1" path="$2"
  eval "had=\${had_$name}"
  if [ "$had" -eq 1 ]; then cp -a "$path.bak_$stamp" "$path"; else rm -f "$path"; fi
}
rollback() {
  systemctl disable --now xray-lan-edge-telegram-policy.service xray-lan-edge.service 2>/dev/null || true
  restore_path config "$config"
  restore_path unit "$unit"
  restore_path telegram_nft "$telegram_nft"
  restore_path telegram_policy "$telegram_policy"
  restore_path telegram_unit "$telegram_unit"
  systemctl daemon-reload
  if [ "${had_unit:-0}" -eq 1 ]; then systemctl enable --now xray-lan-edge.service || true; fi
  if [ "${had_telegram_unit:-0}" -eq 1 ]; then systemctl enable --now xray-lan-edge-telegram-policy.service || true; fi
}
backup_path config "$config"
backup_path unit "$unit"
backup_path telegram_nft "$telegram_nft"
backup_path telegram_policy "$telegram_policy"
backup_path telegram_unit "$telegram_unit"
trap 'status=$?; rollback; exit "$status"' ERR
install -d -m 0750 -o root -g root "$config_dir"
install -m 0600 -o root -g root "/tmp/xray-lan-edge-config-$stamp.json" "$config"
install -m 0644 -o root -g root "/tmp/xray-lan-edge.service-$stamp" "$unit"
install -m 0644 -o root -g root "/tmp/telegram-transparent-lane-$stamp.nft" "$telegram_nft"
install -m 0755 -o root -g root "/tmp/xray-lan-edge-telegram-policy-$stamp.sh" "$telegram_policy"
install -m 0644 -o root -g root "/tmp/xray-lan-edge-telegram-policy.service-$stamp" "$telegram_unit"
rm -f "/tmp/xray-lan-edge-config-$stamp.json" "/tmp/xray-lan-edge.service-$stamp" "/tmp/telegram-transparent-lane-$stamp.nft" "/tmp/xray-lan-edge-telegram-policy-$stamp.sh" "/tmp/xray-lan-edge-telegram-policy.service-$stamp"
systemctl daemon-reload
systemctl enable --now xray-lan-edge.service
systemctl is-active --quiet xray-lan-edge.service
systemctl enable --now xray-lan-edge-telegram-policy.service
systemctl is-active --quiet xray-lan-edge-telegram-policy.service
trap - ERR
REMOTE

for port in 80 443 12555; do
  ready=false
  for attempt in {1..30}; do
    if timeout 2 bash -c "</dev/tcp/192.168.2.5/$port" >/dev/null 2>&1; then
      ready=true
      break
    fi
    sleep 1
  done
  if ! $ready; then
    echo "server-44 LAN Smart Edge did not listen on $listen_ip:$port within 30 seconds" >&2
    exit 1
  fi
done
echo "server-44 LAN Smart Edge active on $listen_ip:80,443 and Telegram TPROXY :12555"
echo "Rollback: ssh $remote_host 'sudo systemctl disable --now xray-lan-edge-telegram-policy.service xray-lan-edge.service; sudo cp -a $remote_config.bak_$stamp $remote_config; sudo cp -a $remote_unit.bak_$stamp $remote_unit; sudo cp -a $remote_nft.bak_$stamp $remote_nft; sudo cp -a $remote_policy_script.bak_$stamp $remote_policy_script; sudo cp -a $remote_policy_unit.bak_$stamp $remote_policy_unit; sudo systemctl daemon-reload'"

#!/usr/bin/env bash
# Validate or deploy the server-100 primary SNI router after nginx is staged on :8444.
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"
TOPOLOGY_SOURCE="$REPO_DIR/deploy/public-ingress/topology.json"
CONFIG_SOURCE="$REPO_DIR/deploy/server-100/haproxy/public-ingress.cfg"
CONFIG_TARGET="/etc/haproxy/haproxy.cfg"
ACTION="${1:---dry-run}"
TIMESTAMP="$(date -u +%Y%m%d_%H%M%S)"

case "$ACTION" in
  --dry-run|--apply) ;;
  *)
    echo "Usage: $0 [--dry-run|--apply]" >&2
    exit 2
    ;;
esac

command -v jq >/dev/null
[[ "$(jq -er '.policy.primary' "$TOPOLOGY_SOURCE")" == "server-100" ]]
[[ "$(jq -er '.server100.defaultBackend' "$TOPOLOGY_SOURCE")" == "127.0.0.1:8444" ]]
node "$SCRIPT_DIR/render-public-ingress.mjs" --check

sudo haproxy -c -f "$CONFIG_SOURCE"

if ! sudo ss -H -ltn | awk '$4 == "127.0.0.1:8444" { found=1 } END { exit !found }'; then
  echo "cutover blocked: nginx loopback backend 127.0.0.1:8444 is not listening" >&2
  exit 4
fi

for relay_port in 23444 23445 23446 23447 23448; do
  if ! sudo ss -H -ltn | awk -v port=":${relay_port}" '$4 ~ port "$" { found=1 } END { exit !found }'; then
    echo "cutover blocked: regional relay port $relay_port is not listening" >&2
    exit 4
  fi
done

if sudo ss -ltnp '( sport = :443 )' | grep -q nginx; then
  echo "cutover blocked: nginx still owns public :443" >&2
  exit 4
fi

if [[ "$ACTION" == "--dry-run" ]]; then
  echo "server-100 public ingress dry run complete"
  exit 0
fi

backup="/etc/haproxy/haproxy.cfg.bak_${TIMESTAMP}"
sudo cp -a "$CONFIG_TARGET" "$backup"
was_active=false
sudo systemctl is-active --quiet haproxy && was_active=true
changed=false

rollback() {
  status=$?
  if [[ "$status" -ne 0 && "$changed" == true ]]; then
    set +e
    sudo cp -a "$backup" "$CONFIG_TARGET"
    if [[ "$was_active" == true ]]; then
      sudo systemctl restart haproxy
    else
      sudo systemctl stop haproxy
    fi
    echo "server-100 HAProxy rollback restored $backup" >&2
  fi
  exit "$status"
}
trap rollback EXIT

changed=true
sudo install -m 0644 "$CONFIG_SOURCE" "$CONFIG_TARGET"
sudo haproxy -c -f "$CONFIG_TARGET"
sudo systemctl enable --now haproxy
sudo systemctl restart haproxy
sudo systemctl is-active --quiet haproxy
sudo ss -ltn | grep -E '192\.168\.(1|2)\.100:443\b'

changed=false
trap - EXIT
echo "server-100 public ingress deploy complete"
echo "Rollback config: $backup"

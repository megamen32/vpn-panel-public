#!/usr/bin/env bash
# Deploy the four country-pinned relay inbounds plus the owner-managed Helsinki exit.
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"
# This config contains Reality private keys from secure.json. Keep it out of
# the checkout and generate it in a private temporary file for each deploy.
XRAY_CANONICAL="$(sudo mktemp /tmp/vpn-panel-regional-relays.XXXXXX.json)"
XRAY_LIVE="/etc/vpn-panel/xray-relay/config.json"
STAMP="$(date -u +%Y%m%d_%H%M%S)"

cleanup() {
  sudo rm -f "$XRAY_CANONICAL"
}
trap cleanup EXIT

if [[ -f "$REPO_DIR/.env" ]]; then
  set -a
  source "$REPO_DIR/.env"
  set +a
fi
: "${DATABASE_URL:?DATABASE_URL is required}"

# `.env` is allowed to carry deployment credentials, never a hidden mode switch.
# Read positional arguments only after it is sourced, so no environment key can
# shadow the requested mode. The HAOS reserve is deliberately explicit: an
# unrelated recovery-certificate defect must not block the primary VPN ingress.
DRY_RUN=false
DEPLOY_HAOS_RESERVE=true
for arg in "$@"; do
  case "$arg" in
    --dry-run) DRY_RUN=true ;;
    --primary-only) DEPLOY_HAOS_RESERVE=false ;;
    *) echo "usage: $0 [--dry-run] [--primary-only]" >&2; exit 2 ;;
  esac
done

echo "Generating regional relay config"
(cd "$REPO_DIR" && sudo env DATABASE_URL="$DATABASE_URL" "$REPO_DIR/node_modules/.bin/tsx" src/cli/write-xray-relay-config.ts "$XRAY_CANONICAL" regional-relays)
for endpoint in smart-de-relay full-de-relay smart-us-relay full-us-relay fi-helsinki-relay; do
  expected="$(psql "$DATABASE_URL" -At -c "select count(*) from client_profiles where endpoint_id='$endpoint'")"
  generated="$(sudo jq -r --arg endpoint "$endpoint" '.inbounds[] | select(.tag == $endpoint) | .settings.clients | length' "$XRAY_CANONICAL")"
  [[ -n "$generated" && "$generated" == "$expected" ]] || {
    echo "Client coverage mismatch for $endpoint: DB=$expected generated=${generated:-missing}" >&2
    exit 1
  }
done

echo "Validating Xray config"
sudo docker run --rm \
  -v "$XRAY_CANONICAL:/etc/xray/config.json:ro" \
  -v /etc/vpn-panel/xray-geo:/usr/local/share/xray:ro \
  teddysun/xray:26.6.1 xray run -test -config /etc/xray/config.json

if $DEPLOY_HAOS_RESERVE; then
  echo "Validating canonical HAOS ingress"
  "$SCRIPT_DIR/deploy-haos-recovery.sh" --dry-run
else
  echo "HAOS reserve skipped by explicit --primary-only request"
fi

if $DRY_RUN; then
  echo "Dry run complete"
  exit 0
fi

echo "Backing up live configs"
sudo cp -a "$XRAY_LIVE" "${XRAY_LIVE}.bak_${STAMP}"

if sudo ss -ltnp '( sport = :23446 )' | grep -q haproxy; then
  echo "Deprecated HAProxy :23446 passthrough is still active; remove it before deploying regional relays" >&2
  exit 1
fi

rollback() {
  local status=$?
  trap - ERR
  echo "Deploy failed; rolling back"
  sudo cp -a "${XRAY_LIVE}.bak_${STAMP}" "$XRAY_LIVE"
  sudo systemctl restart xray-ru-relays.service || true
  exit "$status"
}
trap rollback ERR

echo "Installing regional Xray inbounds without changing the primary HAProxy service"
sudo install -m 0600 "$XRAY_CANONICAL" "$XRAY_LIVE"
sudo systemctl restart xray-ru-relays.service
sudo systemctl is-active --quiet xray-ru-relays.service

if $DEPLOY_HAOS_RESERVE; then
  echo "Installing HAOS reserve :8443 SNI routing"
  "$SCRIPT_DIR/deploy-haos-recovery.sh"
fi

if $DEPLOY_HAOS_RESERVE; then
  echo "Allowing HAOS to reach all regional relay ports"
  for port in 23444 23445 23446 23447 23448; do
    sudo ufw allow from 192.168.2.101 to any port "$port" proto tcp >/dev/null
  done
fi

sleep 2
sudo ss -ltn | grep -E ':(23444|23445|23446|23447|23448)\b'
trap - ERR
echo "Regional relay deploy complete"
if ! $DEPLOY_HAOS_RESERVE; then
  echo "HAOS reserve was intentionally not updated; retry without --primary-only after recovery certificate repair"
fi
echo "Rollback: sudo cp '${XRAY_LIVE}.bak_${STAMP}' '$XRAY_LIVE' && sudo systemctl restart xray-ru-relays.service"

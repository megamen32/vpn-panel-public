#!/usr/bin/env bash
# Atomically deploy the compact RU/private geo databases with the relay config.
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"
GEO_LIVE_DIR="${XRAY_GEO_DIR:-/etc/vpn-panel/xray-geo}"
XRAY_LIVE="${XRAY_RELAY_CONFIG:-/etc/vpn-panel/xray-relay/config.json}"
XRAY_IMAGE="${XRAY_IMAGE:-teddysun/xray:26.6.1}"
DOWNLOAD_PROXY="${XRAY_GEO_DOWNLOAD_PROXY:-http://192.168.2.75:3127}"
STAMP="$(date -u +%Y%m%d_%H%M%S)"
DRY_RUN=false
[[ "${1:-}" == "--dry-run" ]] && DRY_RUN=true

WORK_DIR="$(mktemp -d /tmp/vpn-panel-compact-geo.XXXXXX)"
XRAY_CANDIDATE="$(mktemp /tmp/vpn-panel-compact-relays.XXXXXX.json)"
chmod 0755 "$WORK_DIR"
chmod 0600 "$XRAY_CANDIDATE"

cleanup() {
  rm -rf "$WORK_DIR"
  rm -f "$XRAY_CANDIDATE"
}
trap cleanup EXIT

if [[ -f "$REPO_DIR/.env" ]]; then
  set -a
  source "$REPO_DIR/.env"
  set +a
fi
: "${DATABASE_URL:?DATABASE_URL is required}"

download_url() {
  local output="$1"
  local primary_url="$2"
  local cdn_url="$3"
  local common=(--fail --location --silent --show-error --retry 2 --retry-all-errors --connect-timeout 12 --max-time 90)
  if curl "${common[@]}" -o "$output" "$primary_url"; then
    return
  fi
  if [[ -n "$DOWNLOAD_PROXY" ]]; then
    echo "Direct GitHub download failed; retrying through the LAN US proxy" >&2
    if curl "${common[@]}" --proxy "$DOWNLOAD_PROXY" -o "$output" "$primary_url"; then
      return
    fi
  fi
  echo "GitHub release download failed; retrying the repository release branch CDN" >&2
  curl "${common[@]}" -o "$output" "$cdn_url"
}

download_asset() {
  local repository="$1"
  local asset="$2"
  local release_url="https://github.com/$repository/releases/latest/download"
  local cdn_url="https://cdn.jsdelivr.net/gh/$repository@release"
  download_url "$WORK_DIR/$asset" "$release_url/$asset" "$cdn_url/$asset"
  download_url "$WORK_DIR/$asset.sha256sum" "$release_url/$asset.sha256sum" "$cdn_url/$asset.sha256sum"
  (cd "$WORK_DIR" && sha256sum -c "$asset.sha256sum")
  chmod 0644 "$WORK_DIR/$asset"
}

download_asset golukon/russia-only-geoip geoip.dat
download_asset golukon/russia-only-geosite geosite.dat

geoip_size="$(stat -c %s "$WORK_DIR/geoip.dat")"
geosite_size="$(stat -c %s "$WORK_DIR/geosite.dat")"
(( geoip_size > 1000 && geoip_size < 2097152 )) || { echo "Unexpected compact geoip.dat size: $geoip_size" >&2; exit 1; }
(( geosite_size > 1000 && geosite_size < 1048576 )) || { echo "Unexpected compact geosite.dat size: $geosite_size" >&2; exit 1; }

echo "Generating canonical regional relay config"
(cd "$REPO_DIR" && env DATABASE_URL="$DATABASE_URL" "$REPO_DIR/node_modules/.bin/tsx" src/cli/write-xray-relay-config.ts "$XRAY_CANDIDATE" regional-relays)
chmod 0600 "$XRAY_CANDIDATE"

for endpoint in smart-de-relay full-de-relay smart-us-relay full-us-relay; do
  expected="$(psql "$DATABASE_URL" -At -c "select count(*) from client_profiles where endpoint_id='$endpoint'")"
  generated="$(jq -r --arg endpoint "$endpoint" '.inbounds[] | select(.tag == $endpoint) | .settings.clients | length' "$XRAY_CANDIDATE")"
  [[ -n "$generated" && "$generated" == "$expected" ]] || {
    echo "Client coverage mismatch for $endpoint: DB=$expected generated=${generated:-missing}" >&2
    exit 1
  }
done

echo "Validating compact RU-only routing database and generated config"
sudo docker run --rm \
  -v "$XRAY_CANDIDATE:/etc/xray/config.json:ro" \
  -v "$WORK_DIR:/usr/local/share/xray:ro" \
  "$XRAY_IMAGE" xray run -test -config /etc/xray/config.json

echo "Compact assets: geoip.dat=${geoip_size} bytes geosite.dat=${geosite_size} bytes"
if $DRY_RUN; then
  echo "Dry run complete; no live files changed"
  exit 0
fi

sudo install -d -m 0755 "$GEO_LIVE_DIR"
sudo cp -a "$XRAY_LIVE" "${XRAY_LIVE}.bak_${STAMP}"
sudo cp -a "$GEO_LIVE_DIR/geoip.dat" "$GEO_LIVE_DIR/geoip.dat.bak_${STAMP}"
sudo cp -a "$GEO_LIVE_DIR/geosite.dat" "$GEO_LIVE_DIR/geosite.dat.bak_${STAMP}"

rollback() {
  local status=$?
  trap - ERR
  echo "Compact geo deploy failed; restoring config and both geo databases" >&2
  sudo cp -a "${XRAY_LIVE}.bak_${STAMP}" "$XRAY_LIVE"
  sudo cp -a "$GEO_LIVE_DIR/geoip.dat.bak_${STAMP}" "$GEO_LIVE_DIR/geoip.dat"
  sudo cp -a "$GEO_LIVE_DIR/geosite.dat.bak_${STAMP}" "$GEO_LIVE_DIR/geosite.dat"
  sudo systemctl restart xray-ru-relays.service || true
  exit "$status"
}
trap rollback ERR

sudo install -m 0644 "$WORK_DIR/geoip.dat" "$GEO_LIVE_DIR/geoip.dat.pending_${STAMP}"
sudo install -m 0644 "$WORK_DIR/geosite.dat" "$GEO_LIVE_DIR/geosite.dat.pending_${STAMP}"
sudo install -m 0600 "$XRAY_CANDIDATE" "${XRAY_LIVE}.pending_${STAMP}"
sudo mv "$GEO_LIVE_DIR/geoip.dat.pending_${STAMP}" "$GEO_LIVE_DIR/geoip.dat"
sudo mv "$GEO_LIVE_DIR/geosite.dat.pending_${STAMP}" "$GEO_LIVE_DIR/geosite.dat"
sudo mv "${XRAY_LIVE}.pending_${STAMP}" "$XRAY_LIVE"
sudo systemctl restart xray-ru-relays.service
sudo systemctl is-active --quiet xray-ru-relays.service
listeners_ready=false
for _attempt in {1..20}; do
  listener_count="$(sudo ss -H -ltn | grep -Ec ':(23444|23445|23446|23447)\b' || true)"
  if [[ "$listener_count" == "4" ]]; then
    listeners_ready=true
    break
  fi
  sleep 0.5
done
$listeners_ready || { echo "Timed out waiting for all four relay listeners" >&2; exit 1; }
sudo ss -H -ltn | grep -E ':(23444|23445|23446|23447)\b'

trap - ERR
echo "Compact RU-only geo deploy complete"
echo "Rollback: restore ${XRAY_LIVE}.bak_${STAMP} and $GEO_LIVE_DIR/*.bak_${STAMP}, then restart xray-ru-relays.service"

#!/usr/bin/env bash
set -euo pipefail

VPN_DIR="${VPN_DIR:-$HOME/apps/vpn}"
VPN_TOKEN="${VPN_TOKEN:-}"
VPN_ENDPOINT="${VPN_ENDPOINT:-smart-de-relay}"
BASE_URL="${BASE_URL:-https://vpn.bezrabotnyi.com}"
SOCKS_PORT="${SOCKS_PORT:-10808}"
HTTP_PORT="${HTTP_PORT:-10809}"
XRAY_IMAGE="${XRAY_IMAGE:-ghcr.io/xtls/xray-core:v26.6.1}"

PASS=0
FAIL=0

function pass() { PASS=$((PASS+1)); echo "  ✅ $1"; }
function fail() { FAIL=$((FAIL+1)); echo "  ❌ $1"; }

if [ -z "$VPN_TOKEN" ]; then
  echo "Error: VPN_TOKEN is required"
  echo "Usage: VPN_TOKEN=<token> $0"
  echo "       VPN_TOKEN=<token> VPN_ENDPOINT=smart-de-relay $0"
  exit 1
fi

mkdir -p "$VPN_DIR"
cd "$VPN_DIR"

# Fetch Xray JSON subscription
SUB_URL="$BASE_URL/sub/$VPN_TOKEN/xray-json"
echo "Fetching subscription: $SUB_URL"
CONFIG_JSON=$(curl -sfL "$SUB_URL") || {
  echo "Error: failed to fetch subscription"
  exit 1
}

# Rewrite inbounds to use the specified SOCKS/HTTP ports and listen on 0.0.0.0
INBOUNDS=$(echo "$CONFIG_JSON" | python3 -c "
import json,sys
c = json.load(sys.stdin)
for i in c.get('inbounds', []):
    if i.get('tag') == 'socks-in':
        i['port'] = $SOCKS_PORT
        i['listen'] = '0.0.0.0'
    if i.get('tag') == 'http-in':
        i['port'] = $HTTP_PORT
        i['listen'] = '0.0.0.0'
# Force all traffic through the specified endpoint
c['routing'] = {
    'domainStrategy': 'IPIfNonMatch',
    'rules': [{'type': 'field', 'network': 'tcp,udp', 'outboundTag': '$VPN_ENDPOINT'}]
}
print(json.dumps(c, indent=2))
")

echo "$INBOUNDS" > "$VPN_DIR/config.json"

cleanup() {
  echo ""
  echo "Stopping Xray container..."
  docker rm -f xray-mac-test 2>/dev/null || true
}
trap cleanup EXIT

echo "Starting Xray client (endpoint: $VPN_ENDPOINT)..."
docker run -d --rm --name xray-mac-test \
  -v "$VPN_DIR/config.json:/etc/xray/config.json:ro" \
  -p "$SOCKS_PORT:$SOCKS_PORT" \
  -p "$HTTP_PORT:$HTTP_PORT" \
  "$XRAY_IMAGE" run -c /etc/xray/config.json > /dev/null 2>&1

sleep 2

# Verify Xray is running
if ! docker ps --format '{{.Names}}' | grep -q xray-mac-test; then
  echo "Error: Xray container failed to start"
  docker logs xray-mac-test 2>/dev/null || true
  exit 1
fi

echo "Xray running, SOCKS proxy on 127.0.0.1:$SOCKS_PORT"
echo ""

SOCKS="--socks5-hostname 127.0.0.1:$SOCKS_PORT"
CURL="curl -fsSL --max-time 15 $SOCKS"

function test_ru_direct() {
  local label="$1" url="$2" expect_no="$3"
  echo ""
  echo "--- $label ($url) ---"
  local body
  body=$($CURL "$url" 2>&1) || {
    fail "$label — connection failed (timeout? blocked?)"
    return
  }
  if echo "$body" | grep -qiF "$expect_no"; then
    fail "$label — found '$expect_no' in response"
  else
    pass "$label — no VPN block message"
  fi
}

function test_world_proxy() {
  local label="$1" url="$2"
  echo ""
  echo "--- $label ($url) ---"
  local status
  status=$(curl -s -o /dev/null -w '%{http_code}' --max-time 15 $SOCKS "$url") || {
    fail "$label — timeout"
    return
  }
  if [ "$status" = "200" ] || [ "$status" = "301" ] || [ "$status" = "302" ] || [ "$status" = "303" ] || [ "$status" = "307" ] || [ "$status" = "308" ]; then
    pass "$label — HTTP $status"
  else
    fail "$label — HTTP $status (unexpected)"
  fi
}

echo "============================================"
echo "  RU sites — must be DIRECT (no VPN block)"
echo "============================================"

test_ru_direct "Ozon" "https://www.ozon.ru/category/korpusa-dlya-hdd-15716/" "Выключите VPN"
test_ru_direct "VK" "https://vk.com" "впн"
test_ru_direct "Wildberries" "https://www.wildberries.ru" "впн"
test_ru_direct "Yandex" "https://yandex.ru" "впн"
test_ru_direct "2ip" "https://2ip.ru" "впн"

echo ""
echo "============================================"
echo "  World sites — must be PROXY (reachable)"
echo "============================================"

test_world_proxy "Telegram" "https://telegram.org"
test_world_proxy "Instagram" "https://www.instagram.com"
test_world_proxy "YouTube" "https://www.youtube.com"
test_world_proxy "Facebook" "https://www.facebook.com"
test_world_proxy "ChatGPT" "https://chatgpt.com"
test_world_proxy "X/Twitter" "https://x.com"
test_world_proxy "Reddit" "https://www.reddit.com"
test_world_proxy "Wikipedia" "https://en.wikipedia.org"

echo ""
echo "============================================"
echo "  IP checks"
echo "============================================"

echo ""
RU_IP=$($CURL "https://api.ipify.org" 2>/dev/null || echo "timeout")
WORLD_IP=$(curl -s --max-time 15 $SOCKS "https://api.ipify.org" 2>/dev/null || echo "timeout")
DIRECT_IP=$(curl -s --max-time 10 "https://api.ipify.org" 2>/dev/null || echo "direct-timeout")

echo "  Direct IP (no proxy):     $DIRECT_IP"
echo "  Via SOCKS ($VPN_ENDPOINT): $WORLD_IP"

if [[ "$VPN_ENDPOINT" == smart-* ]]; then
  echo "  RU direct should match server IP"
  RU_COUNTRY=$(curl -s --max-time 10 "https://ipinfo.io/$RU_IP/country" 2>/dev/null || echo "?")
  WORLD_COUNTRY=$(curl -s --max-time 10 "https://ipinfo.io/$WORLD_IP/country" 2>/dev/null || echo "?")
  echo "  RU IP country:  $RU_COUNTRY"
  echo "  World IP country: $WORLD_COUNTRY"
fi

echo ""
echo "============================================"
echo "  Results: $PASS passed, $FAIL failed"
echo "============================================"

[ "$FAIL" -eq 0 ] && echo "All tests passed!" || echo "Some tests failed."
exit $FAIL

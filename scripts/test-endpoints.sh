#!/bin/bash
# Test all VPN endpoints from server-88 using Xray Docker
# Usage: bash test-endpoints.sh <subscription_token>

TOKEN="${1:-pYkHMZ-sq6GZ6ByUhUsKwY7JmETLWCuWJu5tmynH4YI}"
PANEL="http://192.168.2.100:3129"
XRAY_IMG="teddysun/xray:26.6.1"
SOCKS_PORT=10809
TIMEOUT=8

echo "=== Fetching subscription ==="
SUB=$(curl -s "$PANEL/sub/$TOKEN/xray-json")
echo "$SUB" > /tmp/full-sub.json

TAGS=$(echo "$SUB" | python3 -c "
import sys, json
c = json.load(sys.stdin)
for o in c.get('outbounds', []):
    if o.get('protocol') == 'vless':
        print(o['tag'])
")

echo "=== Found endpoints: ==="
echo "$TAGS"
echo ""

for TAG in $TAGS; do
    echo -n "Testing $TAG... "
    
    # Generate minimal Xray config with only this endpoint
    python3 -c "
import json, sys
full = json.load(open('/tmp/full-sub.json'))
outbound = None
for o in full['outbounds']:
    if o.get('tag') == '$TAG':
        outbound = o
        break
if not outbound:
    print('NOT FOUND', file=sys.stderr)
    sys.exit(1)
config = {
    'log': {'loglevel': 'warning'},
    'inbounds': [{'tag': 'socks', 'listen': '0.0.0.0', 'port': $SOCKS_PORT, 'protocol': 'socks', 'settings': {'auth': 'noauth'}}],
    'outbounds': [outbound, {'tag': 'direct', 'protocol': 'freedom'}],
    'routing': {'rules': [{'type': 'field', 'inboundTag': ['socks'], 'outboundTag': '$TAG'}]}
}
json.dump(config, open('/tmp/test-ep.json', 'w'))
" 2>/dev/null

    if [ $? -ne 0 ]; then
        echo "SKIP (config gen failed)"
        continue
    fi

    # Stop any existing test container
    docker stop vpn-ep-test >/dev/null 2>&1
    docker rm vpn-ep-test >/dev/null 2>&1

    # Start Xray
    docker run -d --name vpn-ep-test --network host \
        -v /tmp/test-ep.json:/etc/xray/config.json:ro \
        $XRAY_IMG >/dev/null 2>&1

    sleep 2

    # Test Telegram
    TG=$(curl -s --max-time $TIMEOUT --socks5-hostname 127.0.0.1:$SOCKS_PORT \
        https://api.telegram.org/ -o /dev/null -w "%{http_code} %{time_total}s" 2>&1)
    
    # Test ipify
    IP=$(curl -s --max-time $TIMEOUT --socks5-hostname 127.0.0.1:$SOCKS_PORT \
        https://api.ipify.org -w " %{http_code}" 2>&1)

    # Cleanup
    docker stop vpn-ep-test >/dev/null 2>&1
    docker rm vpn-ep-test >/dev/null 2>&1

    TG_CODE=$(echo "$TG" | awk '{print $1}')
    TG_TIME=$(echo "$TG" | awk '{print $2}')
    
    if [ "$TG_CODE" = "302" ] || [ "$TG_CODE" = "200" ]; then
        echo "OK  telegram=$TG  ipify=$IP"
    else
        echo "FAIL  telegram=$TG  ipify=$IP"
    fi
done

echo ""
echo "=== Done ==="

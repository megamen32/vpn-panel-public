#!/usr/bin/env bash
# deploy-reality-443.sh — Move de-direct Reality to port 443 via nginx stream SNI routing
#
# Usage:
#   bash scripts/deploy-reality-443.sh [target_port]
#   target_port: external port for Reality (default: auto-try 443, 4443, 8443)
#
# What it does:
#   1. Configures vpn2 nginx stream SNI routing (port 443 → Reality + HTTPS)
#   2. Moves Xray Reality inbound from public port to internal port
#   3. Tests from server-100 via Docker Xray client
#   4. If port blocked, auto-tries fallback ports
#   5. On success: updates secure.json, rebuilds VPN Panel, restarts service
#
# Rollback:
#   bash scripts/deploy-reality-443.sh rollback
#
set -euo pipefail

VPN2_HOST="vpn2.bezrabotnyi.com"
VPN2_USER="root"
REALITY_PORT_CURRENT=23443       # current public Reality port
REALITY_PORT_INTERNAL=24443      # Xray listens here (behind nginx stream)
NGINX_HTTPS_INTERNAL=8444        # nginx HTTPS blocks moved here (port=443 mode)
REALITY_FALLBACK_PORT=8443       # fallback ya.ru proxy stays here (unchanged)
XRAY_CONFIG="/usr/local/etc/xray/config.json"
NGINX_CONF="/etc/nginx/nginx.conf"
NGINX_SITES_DIR="/etc/nginx/sites-enabled"
SECURE_JSON="/etc/vpn-panel/secure.json"
PANEL_DIR="/home/roomhacker/apps/vpn-panel"
XRAY_IMAGE="teddysun/xray:26.6.1"
TEST_UUID=""
TEST_PUBKEY=""
TEST_SHORTID=""
TEST_SNI="ya.ru"
TEST_CONTAINER="vpn-reality-port-test"
TIMEOUT=12
SOCKS_PORT=10899
STREAM_CONF="/etc/nginx/stream-reality.conf"

TRY_PORTS=(443 4443 8443)

log()  { echo "[$(date +%H:%M:%S)] $*"; }
err()  { echo "[$(date +%H:%M:%S)] ERROR: $*" >&2; }
die()  { err "$@"; exit 1; }

ssh_vpn2() { ssh -o ConnectTimeout=10 -o BatchMode=yes "${VPN2_USER}@${VPN2_HOST}" "$@"; }

# ─── Read test credentials ──────────────────────────────────────────────────

read_credentials() {
  log "Reading credentials..."
  TEST_PUBKEY=$(python3 -c "import json; d=json.load(open('$SECURE_JSON')); [print(n['public_key']) for n in d['nodes'] if n['id']=='de-direct'][0]" 2>/dev/null) || die "cannot read public_key"
  TEST_SHORTID=$(python3 -c "import json; d=json.load(open('$SECURE_JSON')); [print(n['short_id']) for n in d['nodes'] if n['id']=='de-direct'][0]" 2>/dev/null) || die "cannot read short_id"
  TEST_UUID=$(ssh_vpn2 "python3 -c \"import json; d=json.load(open('$XRAY_CONFIG')); b=[i for i in d['inbounds'] if i['tag']=='de-reality'][0]; print(b['settings']['clients'][0]['id'])\"" 2>/dev/null) || die "cannot read test UUID from vpn2"
  log "  UUID: ${TEST_UUID:0:8}...  pubkey: ${TEST_PUBKEY:0:12}...  shortId: $TEST_SHORTID"
}

# ─── vpn2: backup configs ───────────────────────────────────────────────────

BACKUP_DIR="/root/.vpn-panel-backups"

vpn2_backup() {
  log "Backing up vpn2 configs to $BACKUP_DIR..."
  ssh_vpn2 "
    TS=\$(date +%Y%m%d_%H%M%S)
    mkdir -p $BACKUP_DIR
    cp $XRAY_CONFIG $BACKUP_DIR/xray-config.bak_reality443_\$TS
    cp $NGINX_CONF $BACKUP_DIR/nginx.conf.bak_reality443_\$TS
    for f in $NGINX_SITES_DIR/vpn2-front $NGINX_SITES_DIR/v-gptadmin-frp $NGINX_SITES_DIR/fallback; do
      [ -f \"\$f\" ] && cp \"\$f\" \"$BACKUP_DIR/\$(basename \$f).bak_reality443_\$TS\"
    done
    echo 'backups created in $BACKUP_DIR'
  "
}

# ─── vpn2: modify Xray (port 23443 → 24443) ─────────────────────────────────

vpn2_modify_xray() {
  log "Modifying Xray: Reality inbound port $REALITY_PORT_CURRENT → $REALITY_PORT_INTERNAL"
  ssh_vpn2 "python3 << 'PYEOF'
import json
with open('$XRAY_CONFIG') as f:
    cfg = json.load(f)
for b in cfg['inbounds']:
    if b.get('tag') == 'de-reality':
        old_port = b['port']
        b['port'] = $REALITY_PORT_INTERNAL
        print(f'  de-reality: port {old_port} -> {$REALITY_PORT_INTERNAL}')
        break
with open('$XRAY_CONFIG', 'w') as f:
    json.dump(cfg, f, indent=2)
print('Xray config updated')
PYEOF"
}

# ─── vpn2: setup nginx for port 443 (SNI routing) ───────────────────────────

vpn2_setup_nginx_443() {
  log "Setting up nginx stream SNI routing on port 443..."

  # Use Python on vpn2 for reliable config modification
  ssh_vpn2 "python3 << 'PYEOF'
import re, os

sites_dir = '$NGINX_SITES_DIR'
internal_port = $NGINX_HTTPS_INTERNAL

# 1. Modify HTTPS server blocks: replace 'listen 443 ssl http2;' with internal port
for name in ['vpn2-front', 'v-gptadmin-frp']:
    path = os.path.join(sites_dir, name)
    if not os.path.isfile(path):
        # try symlink target
        real = os.path.realpath(path)
        if os.path.isfile(real):
            path = real
        else:
            continue
    with open(path) as f:
        content = f.read()
    # Replace 'listen 443 ssl http2;' with internal listen only
    new_content = re.sub(
        r'listen 443 ssl http2;',
        f'listen 127.0.0.1:{internal_port} ssl http2;',
        content
    )
    if new_content != content:
        with open(path, 'w') as f:
            f.write(new_content)
        print(f'  {name}: replaced listen 443 -> 127.0.0.1:{internal_port}')
    else:
        # Maybe already modified
        if f'listen 127.0.0.1:{internal_port}' in content:
            print(f'  {name}: already has internal listen')
        else:
            print(f'  {name}: WARNING - no listen 443 found')

print('HTTPS blocks updated')
PYEOF"

  # 2. Write stream config file (wrapped in stream { } block)
  ssh_vpn2 "cat > $STREAM_CONF << 'STREAMEOF'
# Auto-generated by deploy-reality-443.sh
# SNI routing: ya.ru -> Reality, everything else -> nginx HTTPS
stream {
    map \$ssl_preread_server_name \$reality_backend {
        ya.ru                           reality_backend;
        default                         https_backend;
    }

    upstream reality_backend {
        server 127.0.0.1:$REALITY_PORT_INTERNAL;
    }

    upstream https_backend {
        server 127.0.0.1:$NGINX_HTTPS_INTERNAL;
    }

    server {
        listen 443;
        proxy_pass \$reality_backend;
        ssl_preread on;
        proxy_timeout 600s;
        proxy_connect_timeout 5s;
    }
}
STREAMEOF
echo 'stream config written to $STREAM_CONF'
"

  # 3. Add include to nginx.conf at top level
  ssh_vpn2 "
if ! grep -q 'stream-reality.conf' $NGINX_CONF; then
    # Clean any previous attempt
    sed -i '/# deploy-reality-443/d' $NGINX_CONF
    sed -i '/stream-reality\.conf/d' $NGINX_CONF
    echo '' >> $NGINX_CONF
    echo '# deploy-reality-443 stream routing' >> $NGINX_CONF
    echo 'include $STREAM_CONF;' >> $NGINX_CONF
    echo '  stream include added to nginx.conf'
else
    echo '  stream include already present'
fi
"
}

# ─── vpn2: setup nginx for non-443 port (simple proxy) ──────────────────────

vpn2_setup_nginx_alt() {
  local port=$1
  log "Setting up nginx stream proxy: port $port → Xray $REALITY_PORT_INTERNAL..."

  # Make sure HTTPS blocks are back on 443 (in case we're retrying after 443 failed)
  ssh_vpn2 "python3 << 'PYEOF'
import re, os

sites_dir = '$NGINX_SITES_DIR'
internal_port = $NGINX_HTTPS_INTERNAL

for name in ['vpn2-front', 'v-gptadmin-frp']:
    path = os.path.join(sites_dir, name)
    if not os.path.isfile(path):
        real = os.path.realpath(path)
        if os.path.isfile(real):
            path = real
        else:
            continue
    with open(path) as f:
        content = f.read()
    # Restore 'listen 443 ssl http2;' if it was changed to internal
    new_content = re.sub(
        f'listen 127.0.0.1:{internal_port} ssl http2;',
        'listen 443 ssl http2;',
        content
    )
    if new_content != content:
        with open(path, 'w') as f:
            f.write(new_content)
        print(f'  {name}: restored listen 443')
    else:
        print(f'  {name}: already on 443')
PYEOF"

  # Write stream config for alt port (simple proxy, no SNI routing)
  ssh_vpn2 "cat > $STREAM_CONF << 'STREAMEOF'
# Auto-generated by deploy-reality-443.sh — Reality on port $port
stream {
    server {
        listen $port;
        proxy_pass 127.0.0.1:$REALITY_PORT_INTERNAL;
        proxy_timeout 600s;
        proxy_connect_timeout 5s;
    }
}
STREAMEOF
echo 'stream config written for port $port'
"

  # Ensure include in nginx.conf
  ssh_vpn2 "
if ! grep -q 'stream-reality.conf' $NGINX_CONF; then
    sed -i '/# deploy-reality-443/d' $NGINX_CONF
    sed -i '/stream-reality\.conf/d' $NGINX_CONF
    echo '' >> $NGINX_CONF
    echo '# deploy-reality-443 stream routing' >> $NGINX_CONF
    echo 'include $STREAM_CONF;' >> $NGINX_CONF
    echo '  stream include added'
else
    echo '  stream include already present'
fi
"
}

# ─── vpn2: restart services ─────────────────────────────────────────────────

TEST_HOST="192.168.2.5"    # server-44 (LAN, known working for Docker+sudo)
TEST_USER="roomhacker"

ssh_test() { ssh -o ConnectTimeout=10 -o BatchMode=yes "${TEST_USER}@${TEST_HOST}" "$@"; }

vpn2_restart() {
  local port=$1
  log "Validating configs on vpn2..."

  local xray_test
  xray_test=$(ssh_vpn2 "/usr/local/bin/xray -test -config $XRAY_CONFIG 2>&1 | tail -1") || {
    err "Xray config invalid: $xray_test"
    return 1
  }
  log "  Xray: $xray_test"

  local nginx_test
  nginx_test=$(ssh_vpn2 "nginx -t 2>&1") || {
    err "nginx config invalid"
    err "$nginx_test"
    return 1
  }
  log "  nginx: OK"

  log "Restarting Xray + nginx on vpn2..."
  # Use stop+sleep+start to avoid race condition on port 443
  ssh_vpn2 "systemctl restart xray; systemctl stop nginx; sleep 1; systemctl start nginx"

  sleep 2
  log "  Listening ports:"
  ssh_vpn2 "ss -tlnp | grep -E ':($REALITY_PORT_INTERNAL|$port|$NGINX_HTTPS_INTERNAL) '" || log "  WARNING: some expected ports not found"
}

# ─── Test from server-44 via Docker (LAN path, reliable) ───────────────────

test_port() {
  local port=$1
  log "Testing Reality on vpn2:$port from server-44 (LAN)..."

  # Generate client config locally
  local config_file="/tmp/xray-reality-test-${port}.json"
  cat > "$config_file" << CFGEOF
{
  "log": {"loglevel": "warning"},
  "inbounds": [{
    "tag": "socks",
    "listen": "0.0.0.0",
    "port": $SOCKS_PORT,
    "protocol": "socks",
    "settings": {"auth": "noauth", "udp": true}
  }],
  "outbounds": [{
    "tag": "proxy",
    "protocol": "vless",
    "settings": {
      "vnext": [{
        "address": "$VPN2_HOST",
        "port": $port,
        "users": [{
          "id": "$TEST_UUID",
          "encryption": "none",
          "flow": "xtls-rprx-vision"
        }]
      }]
    },
    "streamSettings": {
      "network": "tcp",
      "security": "reality",
      "realitySettings": {
        "serverName": "$TEST_SNI",
        "publicKey": "$TEST_PUBKEY",
        "shortId": "$TEST_SHORTID",
        "fingerprint": "safari"
      }
    }
  },{
    "tag": "direct",
    "protocol": "freedom"
  }],
  "routing": {
    "rules": [{"type":"field","inboundTag":["socks"],"outboundTag":"proxy"}]
  }
}
CFGEOF

  # SCP config to server-44
  scp "$config_file" "${TEST_USER}@${TEST_HOST}:/tmp/xray-test-${port}.json" >/dev/null 2>&1 || {
    log "  SCP to server-44 failed"
    rm -f "$config_file"
    return 1
  }
  rm -f "$config_file"

  # Run entire test in a SINGLE SSH session on server-44
  local test_output
  test_output=$(ssh_test bash << REMOTEOF
    echo "START"
    sudo docker rm -f $TEST_CONTAINER 2>/dev/null || true
    sudo docker run -d --name $TEST_CONTAINER --network host -v /tmp/xray-test-${port}.json:/etc/xray/config.json:ro $XRAY_IMAGE >/dev/null 2>&1 || { echo "DOCKER_FAIL"; exit 0; }

    # Wait for SOCKS port with polling (use telegram.org as probe for real proxy readiness)
    sleep 2
    SOCKS_OK=0
    for i in 1 2 3 4 5 6 7 8 9 10 11 12; do
      TG_RESP=\$(curl -s --max-time 3 --socks5-hostname 127.0.0.1:$SOCKS_PORT -o /dev/null -w '%{http_code}' 'https://telegram.org' 2>/dev/null) || TG_RESP="000"
      if [ "\$TG_RESP" != "000" ]; then
        echo "SOCKS_READY=\$i (HTTP \$TG_RESP)"
        SOCKS_OK=1
        break
      fi
      sleep 1
    done

    if [ "\$SOCKS_OK" != "1" ]; then
      echo "SOCKS_READY=FAIL"
      sudo docker logs --tail 10 $TEST_CONTAINER 2>&1
      sudo docker rm -f $TEST_CONTAINER >/dev/null 2>&1 || true
      exit 0
    fi

    # Test telegram.org (reuse the successful probe)
    echo "TELEGRAM=\$TG_RESP"

    # Test IP
    IP=\$(curl -s --max-time $TIMEOUT --socks5-hostname 127.0.0.1:$SOCKS_PORT 'https://api.ipify.org' 2>/dev/null) || IP="FAIL"
    echo "IP=\$IP"
    sudo docker rm -f $TEST_CONTAINER >/dev/null 2>&1 || true
    echo "END"
REMOTEOF
  ) 2>&1

  log "  Debug: $test_output" | head -8

  # Parse results
  local http_code time_total ip
  local telegram_result
  telegram_result=$(echo "$test_output" | grep '^TELEGRAM=' | head -1 | cut -d= -f2)
  http_code=$(echo "$telegram_result" | awk '{print $1}')
  time_total=$(echo "$telegram_result" | awk '{print $2}')
  ip=$(echo "$test_output" | grep '^IP=' | head -1 | cut -d= -f2)

  log "  telegram.org: HTTP $http_code"
  log "  ipify.org:    $ip"

  [[ "$http_code" =~ ^(200|301|302|307|308)$ ]]
}

# ─── Rollback ───────────────────────────────────────────────────────────────

do_rollback() {
  log "Rolling back vpn2 to pre-deploy state..."

  ssh_vpn2 "
    # Clean up any leftover backup files in sites-enabled (from old runs)
    rm -f $NGINX_SITES_DIR/*.bak_reality443_*

    BAK_XRAY=\$(ls -t $BACKUP_DIR/xray-config.bak_reality443_* 2>/dev/null | head -1)
    BAK_NGINX=\$(ls -t $BACKUP_DIR/nginx.conf.bak_reality443_* 2>/dev/null | head -1)
    BAK_FRONT=\$(ls -t $BACKUP_DIR/vpn2-front.bak_reality443_* 2>/dev/null | head -1)
    BAK_GPT=\$(ls -t $BACKUP_DIR/v-gptadmin-frp.bak_reality443_* 2>/dev/null | head -1)
    BAK_FB=\$(ls -t $BACKUP_DIR/fallback.bak_reality443_* 2>/dev/null | head -1)

    [ -n \"\$BAK_XRAY\" ] && cp \"\$BAK_XRAY\" $XRAY_CONFIG && echo '  Xray restored'
    [ -n \"\$BAK_NGINX\" ] && cp \"\$BAK_NGINX\" $NGINX_CONF && echo '  nginx.conf restored'
    [ -n \"\$BAK_FRONT\" ] && cp \"\$BAK_FRONT\" $NGINX_SITES_DIR/vpn2-front && echo '  vpn2-front restored'
    [ -n \"\$BAK_GPT\" ] && cp \"\$BAK_GPT\" $NGINX_SITES_DIR/v-gptadmin-frp && echo '  v-gptadmin-frp restored'
    [ -n \"\$BAK_FB\" ] && cp \"\$BAK_FB\" $NGINX_SITES_DIR/fallback && echo '  fallback restored'

    rm -f $STREAM_CONF
    # Remove stream include lines from nginx.conf
    sed -i '/deploy-reality-443/d' $NGINX_CONF
    sed -i '/stream-reality/d' $NGINX_CONF

    /usr/local/bin/xray -test -config $XRAY_CONFIG 2>&1 | tail -1
    nginx -t 2>&1

    systemctl restart xray && systemctl restart nginx
    echo 'rollback complete on vpn2'
  "

  # Rollback secure.json if changed
  local current_port
  current_port=$(python3 -c "import json; d=json.load(open('$SECURE_JSON')); [print(n['port']) for n in d['nodes'] if n['id']=='de-direct'][0]" 2>/dev/null) || current_port=""
  if [ -n "$current_port" ] && [ "$current_port" != "$REALITY_PORT_CURRENT" ]; then
    log "Rolling back secure.json de-direct port: $current_port → $REALITY_PORT_CURRENT"
    python3 -c "
import json
with open('$SECURE_JSON') as f:
    d = json.load(f)
for n in d['nodes']:
    if n['id'] == 'de-direct':
        n['port'] = $REALITY_PORT_CURRENT
with open('$SECURE_JSON', 'w') as f:
    json.dump(d, f, indent=2)
print('secure.json restored')
"
    log "Rebuilding VPN Panel..."
    cd "$PANEL_DIR" && npm run build 2>&1 | tail -3
    sudo systemctl restart autovpnallowip.service 2>/dev/null || log "  restart service manually"
  fi

  log "Rollback complete."
}

# ─── Apply success ──────────────────────────────────────────────────────────

apply_success() {
  local port=$1
  log ""
  log "============================================"
  log "  SUCCESS! Reality works on port $port"
  log "============================================"
  log ""

  log "Updating secure.json: de-direct port → $port"
  python3 -c "
import json
with open('$SECURE_JSON') as f:
    d = json.load(f)
for n in d['nodes']:
    if n['id'] == 'de-direct':
        n['port'] = $port
        print(f'  de-direct: port -> $port')
with open('$SECURE_JSON', 'w') as f:
    json.dump(d, f, indent=2)
print('secure.json updated')
"

  log "Rebuilding VPN Panel..."
  cd "$PANEL_DIR"
  npm run build 2>&1 | tail -5

  log "Restarting VPN Panel service..."
  if sudo systemctl restart autovpnallowip.service 2>/dev/null; then
    log "  service restarted OK"
  else
    log "  WARNING: could not restart. Run: sudo systemctl restart autovpnallowip.service"
  fi

  log ""
  log "Done! Subscriptions now use vpn2:$port for de-direct."
  log "Rollback: bash scripts/deploy-reality-443.sh rollback"
}

# ─── Main ───────────────────────────────────────────────────────────────────

main() {
  local target_port="${1:-auto}"

  if [ "$target_port" = "rollback" ]; then
    do_rollback
    exit 0
  fi

  log "========================================================"
  log "  Deploy Reality on port 443 (with auto-fallback)"
  log "========================================================"

  read_credentials

  local ports_to_try
  if [ "$target_port" = "auto" ]; then
    ports_to_try=("${TRY_PORTS[@]}")
    log "Auto mode: will try ports ${ports_to_try[*]}"
  else
    ports_to_try=("$target_port")
    log "Manual mode: testing port $target_port only"
  fi

  vpn2_backup
  vpn2_modify_xray

  for port in "${ports_to_try[@]}"; do
    log ""
    log "────────── Trying port $port ──────────"

    if [ "$port" -eq 443 ]; then
      vpn2_setup_nginx_443
    else
      vpn2_setup_nginx_alt "$port"
    fi

    if ! vpn2_restart "$port"; then
      log "  Service restart failed for port $port, trying next..."
      continue
    fi

    if test_port "$port"; then
      apply_success "$port"
      exit 0
    fi

    log "  Port $port FAILED. Trying next..."
  done

  log ""
  log "============================================"
  log "  ALL PORTS FAILED: ${ports_to_try[*]}"
  log "============================================"
  log "Rolling back..."
  do_rollback
  exit 1
}

main "$@"

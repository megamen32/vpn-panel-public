#!/usr/bin/env bash
# scripts/deploy-all.sh
# Regenerate canonical configs and push to remote hosts.
#
# Targets (default: all):
#   vpn2       Xray on vpn2.bezrabotnyi.com (Germany VPS)
#   vusa       Xray on vusa.bezrabotnyi.com (US VPS)
#   server-44  sing-box on 192.168.2.5
#   server-88  Xray LAN edge; DNS is centralized on server-100
#   smartdns   unified local/public resolver on server-100
#   router     HAProxy + SmartDNS DHCP on 192.168.2.1 (OpenWrt)
#
# Flow per target:
#   1. Generate canonical config from panel + extras
#   2. Validate config locally (sing-box check, xray run -test, haproxy -c)
#   3. Push to remote via SSH (base64 + python3 write)
#   4. Validate on remote
#   5. Replace + restart (or reload haproxy)
#   6. Smoke test
#   7. Rollback on failure
#
# Usage:
#   scripts/deploy-all.sh                # all targets
#   scripts/deploy-all.sh vpn2           # specific
#   scripts/deploy-all.sh vpn2 server-44 # multiple
#   scripts/deploy-all.sh router-dns     # OpenWrt DNS/DHCP only (no HAProxy)
#   scripts/deploy-all.sh --dry-run     # validate only, no push

set -euo pipefail
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
PANEL_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"
DEPLOY_DIR="$PANEL_DIR/deploy"
LOG_DIR="$PANEL_DIR/logs/deploy"
LAN_SMART_EDGE_IP="${LAN_SMART_EDGE_IP:-192.168.2.1}"
mkdir -p "$LOG_DIR"

DRY_RUN=false
FROZEN=false
while [[ $# -gt 0 ]]; do
  case "$1" in
    --dry-run) DRY_RUN=true; shift ;;
    --frozen) FROZEN=true; shift ;;
    *) break ;;
  esac
done
TARGETS=("$@")
if [ ${#TARGETS[@]} -eq 0 ]; then
  TARGETS=(all)
fi
for target in "${TARGETS[@]}"; do
  case "$target" in
    all|smartdns|router-dns|router)
      echo "Target '$target' is retired because it reinstalls the server-100 SmartDNS/router-HAProxy LAN path." >&2
      echo "Use scripts/deploy-haos-transparent-smart-edge.sh and scripts/deploy-router-transparent-smart-edge.sh instead." >&2
      exit 2
      ;;
  esac
done
if $FROZEN && [[ "${#TARGETS[@]}" -ne 1 || "${TARGETS[0]}" != "vusa" ]]; then
  echo "--frozen is restricted to the single vusa target" >&2
  exit 2
fi

log() {
  echo "[$(date -Iseconds)] $*" | tee -a "$LOG_DIR/deploy.log"
}
log "=== deploy-all.sh START === targets=${TARGETS[*]} dry_run=$DRY_RUN frozen=$FROZEN"

# Source .env for DATABASE_URL
if [ -f "$PANEL_DIR/.env" ]; then
  set -a; source "$PANEL_DIR/.env"; set +a
fi

VPN2_PROXY_CREDENTIALS_FILE="${VPN2_PROXY_CREDENTIALS_FILE:-/etc/vpn-panel/vpn2-auth-proxy.env}"

load_vpn2_proxy_credentials() {
  if sudo -n test -r "$VPN2_PROXY_CREDENTIALS_FILE"; then
    set -a; source <(sudo -n cat "$VPN2_PROXY_CREDENTIALS_FILE"); set +a
  fi
  : "${VPN2_PROXY_PASSWORD:?VPN2_PROXY_PASSWORD must be set in $VPN2_PROXY_CREDENTIALS_FILE or the environment}"
  VPN2_PROXY_USER="${VPN2_PROXY_USER:-root}"
  export VPN2_PROXY_USER VPN2_PROXY_PASSWORD
}

# ─── Step 1: Regenerate canonical configs ───────────────────────────────
regenerate_canonical() {
  log "Regenerating canonical configs from panel + extras..."

  # Telegram transparent lane is intentionally validation-only in this stage.
  # The candidate describes the IP-set and TPROXY/rollback prerequisites but
  # never edits server-88, router, kernel policy, or any live dataplane.
  log "  Telegram transparent lane: validating dry-run contract..."
  (cd "$PANEL_DIR" && npm run validate:telegram-lane > /tmp/telegram-transparent-lane-validation.json 2>>"$LOG_DIR/gen.err")
  (cd "$PANEL_DIR" && npm run render:telegram-lane-candidate > /tmp/telegram-transparent-lane-xray-candidate.json 2>>"$LOG_DIR/gen.err")
  log "  Telegram transparent lane: validation-only (no live target)"

  log "  test plan: rendering enabled endpoint catalog..."
  (cd "$PANEL_DIR" && sudo env DATABASE_URL="$DATABASE_URL" "$PANEL_DIR/node_modules/.bin/tsx" src/cli/render-vpn-test-plan.ts > /tmp/test-plan-render.log 2>>"$LOG_DIR/gen.err")
  if [ $? -ne 0 ]; then
    log "  ERROR: VPN test plan generation failed:"
    cat "$LOG_DIR/gen.err" | tail -10 | tee -a "$LOG_DIR/deploy.log"
    return 1
  fi

  # vpn2 Xray: de-server config from panel + auth proxy inbounds
  log "  vpn2: generating de-server config from panel..."
  (cd "$PANEL_DIR" && sudo env DATABASE_URL="$DATABASE_URL" "$PANEL_DIR/node_modules/.bin/tsx" src/cli/_gen-de-config.ts > /tmp/de-config-new.json 2>"$LOG_DIR/gen.err")
  if [ $? -ne 0 ]; then
    log "  ERROR: panel de-server config generation failed:"
    cat "$LOG_DIR/gen.err" | head -10 | tee -a "$LOG_DIR/deploy.log"
    return 1
  fi

  # Inject auth proxy inbounds
  load_vpn2_proxy_credentials
  python3 - <<PYEOF
import json, os
with open('/tmp/de-config-new.json') as f:
    c = json.load(f)
proxy_user = os.environ['VPN2_PROXY_USER']
proxy_password = os.environ['VPN2_PROXY_PASSWORD']
c['inbounds'].extend([
    {
        "tag": "auth-http",
        "listen": "0.0.0.0",
        "port": 3128,
        "protocol": "http",
        "settings": {
            "accounts": [{"user": proxy_user, "pass": proxy_password}],
            "allowTransparent": False,
        },
        "streamSettings": {
            "security": "tls",
            "tlsSettings": {
                "certificates": [{
                    "certificateFile": "/etc/letsencrypt/live/vpn2.bezrabotnyi.com/fullchain.pem",
                    "keyFile": "/etc/letsencrypt/live/vpn2.bezrabotnyi.com/privkey.pem",
                }],
                "alpn": ["http/1.1"],
            },
        },
    },
    {
        "tag": "auth-socks",
        "listen": "212.192.31.128",
        "port": 1080,
        "protocol": "socks",
        "settings": {
            "auth": "password",
            "accounts": [{"user": proxy_user, "pass": proxy_password}],
            "udp": True,
        },
        "streamSettings": {
            "security": "tls",
            "tlsSettings": {
                "certificates": [{
                    "certificateFile": "/etc/letsencrypt/live/vpn2.bezrabotnyi.com/fullchain.pem",
                    "keyFile": "/etc/letsencrypt/live/vpn2.bezrabotnyi.com/privkey.pem",
                }],
                "alpn": ["http/1.1"],
            },
        },
    },
])
c['routing']['rules'].insert(0, {
    "type": "field",
    "inboundTag": ["auth-http", "auth-socks"],
    "outboundTag": "direct",
})
with open("$DEPLOY_DIR/vpn2/xray/config.json", "w") as f:
    json.dump(c, f, indent=2)
print("vpn2 xray config: regenerated with auth proxy inbounds")
PYEOF

  # vusa Xray: us-server config from panel
  log "  vusa: generating us-server config from panel..."
  (cd "$PANEL_DIR" && sudo env DATABASE_URL="$DATABASE_URL" "$PANEL_DIR/node_modules/.bin/tsx" src/cli/_gen-us-config.ts > /tmp/us-config-new.json 2>>"$LOG_DIR/gen.err")
  if [ $? -ne 0 ]; then
    log "  ERROR: panel us-server config generation failed:"
    cat "$LOG_DIR/gen.err" | tail -10 | tee -a "$LOG_DIR/deploy.log"
    return 1
  fi
  cp /tmp/us-config-new.json "$DEPLOY_DIR/vusa/xray/config.json"
  log "  vusa xray config: regenerated from panel"

  # server-88 keeps its LAN inbounds/static DE routes, but receives the same
  # secret-backed US transport pool as the regional relay on every deploy.
  log "  server-88: generating US leastPing lane from regional relay config..."
  (cd "$PANEL_DIR" && sudo env DATABASE_URL="$DATABASE_URL" "$PANEL_DIR/node_modules/.bin/tsx" src/cli/_gen-server88-config.ts > /tmp/server88-config-new.json 2>>"$LOG_DIR/gen.err")
  if [ $? -ne 0 ]; then
    log "  ERROR: server-88 config generation failed:"
    cat "$LOG_DIR/gen.err" | tail -10 | tee -a "$LOG_DIR/deploy.log"
    return 1
  fi
  cp /tmp/server88-config-new.json "$DEPLOY_DIR/server-88/xray/config.json"
  log "  server-88 xray config: regenerated with US leastPing pool"

  # server-44 sing-box must consume the same enabled endpoint catalog.
  log "  server-44: generating sing-box regional LAN config from panel..."
  (cd "$PANEL_DIR" && sudo env DATABASE_URL="$DATABASE_URL" "$PANEL_DIR/node_modules/.bin/tsx" src/cli/_gen-server44-config.ts > /tmp/server44-config-new.json 2>>"$LOG_DIR/gen.err")
  if [ $? -ne 0 ]; then
    log "  ERROR: server-44 config generation failed:"
    cat "$LOG_DIR/gen.err" | tail -10 | tee -a "$LOG_DIR/deploy.log"
    return 1
  fi
  cp /tmp/server44-config-new.json "$DEPLOY_DIR/server-44/sing-box/config.json"
  log "  server-44 sing-box config: regenerated from enabled endpoint catalog"

  log "  router: using committed config"
}

if $FROZEN; then
  log "FROZEN: skipping all canonical regeneration"
elif [[ "${#TARGETS[@]}" -eq 1 && "${TARGETS[0]}" == "router-dns" ]]; then
  log "router-dns: skipping unrelated Xray/HAProxy regeneration"
else
  regenerate_canonical
fi

# ─── Step 2-6: Deploy each target ────────────────────────────────────────
deploy_vpn2() {
  log "=== vpn2: deploying Xray config ==="
  local CFG="$DEPLOY_DIR/vpn2/xray/config.json"
  local REMOTE="root@vpn2.bezrabotnyi.com"
  local REMOTE_CFG="/usr/local/etc/xray/config.json"

  log "  Validating JSON syntax locally..."
  python3 -c "import json; json.load(open('$CFG'))" || { log "  ERROR: invalid JSON"; return 1; }

  if $DRY_RUN; then
    log "  DRY-RUN: skipping remote push"
    return 0
  fi

  log "  Backing up current config on remote..."
  ssh -i /home/roomhacker/.ssh/id_rsa "$REMOTE" "cp -a $REMOTE_CFG ${REMOTE_CFG}.bak_\$(date -u +%Y%m%d_%H%M%S)"

  log "  Pushing to vpn2..."
  local B64=$(base64 -w 0 "$CFG")
  ssh -i /home/roomhacker/.ssh/id_rsa "$REMOTE" "python3 -c \"
import base64
data = base64.b64decode('$B64')
with open('${REMOTE_CFG}.pending.json', 'wb') as f:
    f.write(data)
print(len(data))
\""

  log "  Validating on remote..."
  if ! ssh -i /home/roomhacker/.ssh/id_rsa "$REMOTE" "/usr/local/bin/xray run -test -config ${REMOTE_CFG}.pending.json" 2>&1 | grep -q "Configuration OK"; then
    log "  ERROR: remote validation failed, rolling back..."
    ssh -i /home/roomhacker/.ssh/id_rsa "$REMOTE" "rm -f ${REMOTE_CFG}.pending.json"
    return 1
  fi

  log "  Replacing + restarting..."
  ssh -i /home/roomhacker/.ssh/id_rsa "$REMOTE" "bash -c '
set -e
mv -f ${REMOTE_CFG}.pending.json ${REMOTE_CFG}
systemctl restart xray
sleep 2
systemctl is-active xray
'"

  log "  Smoke test (auth HTTP via vpn2:3128)..."
  curl -s --max-time 5 --insecure --proxy-user "$VPN2_PROXY_USER:$VPN2_PROXY_PASSWORD" -x https://vpn2.bezrabotnyi.com:3128 https://api.ipify.org | head -1
  echo ""

  log "  vpn2: ✓ done"
}

deploy_vusa() {
  log "=== vusa: deploying Xray + nginx transport mirror ==="
  local CFG="$DEPLOY_DIR/vusa/xray/config.json"
  local NGINX_CFG="$DEPLOY_DIR/vusa/nginx/edge-https.conf"
  local REMOTE="root@185.240.120.152"
  local VUSA_RECEIPT_ID="${VUSA_RECEIPT_ID:-$(date -u +%Y%m%dT%H%M%SZ)-$$}"
  local FROZEN_SNAPSHOT=""

  cleanup_vusa_snapshot() {
    if [[ -n "$FROZEN_SNAPSHOT" && "$FROZEN_SNAPSHOT" == /tmp/vusa-frozen.* ]]; then
      rm -rf -- "$FROZEN_SNAPSHOT"
    fi
  }
  trap cleanup_vusa_snapshot ERR

  [[ "$VUSA_RECEIPT_ID" =~ ^[A-Za-z0-9._-]+$ ]] || { log "  ERROR: invalid VUSA receipt id"; return 2; }

  if $FROZEN; then
    local FROZEN_MANIFEST="${VUSA_FROZEN_MANIFEST:?VUSA_FROZEN_MANIFEST is required with --frozen}"
    local EXPECTED_XRAY_SHA EXPECTED_NGINX_SHA
    [[ "$(wc -l < "$FROZEN_MANIFEST")" -eq 2 ]] || { log "  ERROR: frozen manifest must contain exactly two files"; return 2; }
    grep -Eq '^[0-9a-f]{64}  deploy/vusa/xray/config\.json$' "$FROZEN_MANIFEST" || { log "  ERROR: frozen manifest is missing VUSA Xray"; return 2; }
    grep -Eq '^[0-9a-f]{64}  deploy/vusa/nginx/edge-https\.conf$' "$FROZEN_MANIFEST" || { log "  ERROR: frozen manifest is missing VUSA nginx"; return 2; }
    EXPECTED_XRAY_SHA="$(awk '$2 == "deploy/vusa/xray/config.json" { print $1 }' "$FROZEN_MANIFEST")"
    EXPECTED_NGINX_SHA="$(awk '$2 == "deploy/vusa/nginx/edge-https.conf" { print $1 }' "$FROZEN_MANIFEST")"
    FROZEN_SNAPSHOT="$(mktemp -d /tmp/vusa-frozen.XXXXXX)"
    chmod 0700 "$FROZEN_SNAPSHOT"
    install -m 0600 "$CFG" "$FROZEN_SNAPSHOT/xray-config.json"
    install -m 0600 "$NGINX_CFG" "$FROZEN_SNAPSHOT/edge-https.conf"
    printf '%s  %s\n%s  %s\n' \
      "$EXPECTED_XRAY_SHA" "$FROZEN_SNAPSHOT/xray-config.json" \
      "$EXPECTED_NGINX_SHA" "$FROZEN_SNAPSHOT/edge-https.conf" \
      | sha256sum -c -
    CFG="$FROZEN_SNAPSHOT/xray-config.json"
    NGINX_CFG="$FROZEN_SNAPSHOT/edge-https.conf"
    log "  FROZEN: snapshotted and verified VUSA Xray/nginx candidates"
  fi

  log "  Validating JSON syntax locally..."
  python3 -c "import json; json.load(open('$CFG'))" || { cleanup_vusa_snapshot; trap - ERR; log "  ERROR: invalid JSON"; return 1; }
  test -s "$NGINX_CFG" || { cleanup_vusa_snapshot; trap - ERR; log "  ERROR: missing canonical nginx config: $NGINX_CFG"; return 1; }

  local XRAY_B64
  local NGINX_B64
  XRAY_B64=$(base64 -w 0 "$CFG")
  NGINX_B64=$(base64 -w 0 "$NGINX_CFG")
  log "  Staging and validating both VUSA candidates remotely (dry_run=$DRY_RUN)..."
  ssh -i /home/roomhacker/.ssh/id_rsa -o ConnectTimeout=15 "$REMOTE" \
    "XRAY_B64='$XRAY_B64' NGINX_B64='$NGINX_B64' DRY_RUN='$DRY_RUN' VUSA_RECEIPT_ID='$VUSA_RECEIPT_ID' bash -s" <<'REMOTE_VUSA'
set -Eeuo pipefail

remote_xray=/usr/local/etc/xray/config.json
remote_nginx=/etc/nginx/sites-available/edge-https
remote_nginx_link=/etc/nginx/sites-enabled/edge-https
receipt_root=/var/backups/vpn-panel/vusa
[[ "$VUSA_RECEIPT_ID" =~ ^[A-Za-z0-9._-]+$ ]] || { echo "invalid VUSA receipt id" >&2; exit 2; }
work_dir="$(mktemp -d /tmp/vusa-deploy.XXXXXX)"
xray_candidate="$work_dir/xray.candidate.json"
nginx_candidate="$work_dir/edge-https.candidate.conf"
nginx_preflight="$work_dir/nginx-preflight.conf"
cleanup() { rm -rf "$work_dir"; }
trap cleanup EXIT

printf '%s' "$XRAY_B64" | base64 -d > "$xray_candidate"
printf '%s' "$NGINX_B64" | base64 -d > "$nginx_candidate"

/usr/local/bin/xray run -test -config "$xray_candidate"
cat > "$nginx_preflight" <<EOF
pid $work_dir/nginx.pid;
error_log stderr;
events {}
http {
    include /etc/nginx/mime.types;
    include $nginx_candidate;
}
EOF
nginx -t -c "$nginx_preflight" -p /

if [[ "$DRY_RUN" == "true" ]]; then
  echo "VUSA remote dry-run passed: Xray and nginx candidates validated; active state unchanged"
  exit 0
fi

receipt_dir="$receipt_root/$VUSA_RECEIPT_ID"
[[ ! -e "$receipt_dir" ]] || { echo "refusing to reuse VUSA receipt: $receipt_dir" >&2; exit 2; }
install -d -m 0700 "$receipt_dir"
if [[ -e "$remote_xray" ]]; then
  cp -a "$remote_xray" "$receipt_dir/config.json.before"
else
  touch "$receipt_dir/config.json.missing"
fi
if [[ -e "$remote_nginx" ]]; then
  cp -a "$remote_nginx" "$receipt_dir/edge-https.before"
else
  touch "$receipt_dir/edge-https.missing"
fi
if [[ -L "$remote_nginx_link" ]]; then
  readlink "$remote_nginx_link" > "$receipt_dir/edge-https.link.before"
elif [[ -e "$remote_nginx_link" ]]; then
  cp -a "$remote_nginx_link" "$receipt_dir/edge-https.link-file.before"
else
  touch "$receipt_dir/edge-https.link.missing"
fi

restore_transaction() {
  set +e
  if [[ -e "$receipt_dir/config.json.before" ]]; then
    cp -a "$receipt_dir/config.json.before" "$remote_xray"
  else
    rm -f "$remote_xray"
  fi
  if [[ -e "$receipt_dir/edge-https.before" ]]; then
    cp -a "$receipt_dir/edge-https.before" "$remote_nginx"
  else
    rm -f "$remote_nginx"
  fi
  if [[ -e "$receipt_dir/edge-https.link.before" ]]; then
    ln -sfn "$(cat "$receipt_dir/edge-https.link.before")" "$remote_nginx_link"
  elif [[ -e "$receipt_dir/edge-https.link-file.before" ]]; then
    rm -f "$remote_nginx_link"
    cp -a "$receipt_dir/edge-https.link-file.before" "$remote_nginx_link"
  else
    rm -f "$remote_nginx_link"
  fi
  nginx -t
  systemctl restart xray
  systemctl reload nginx || systemctl restart nginx
  systemctl is-active --quiet xray
  systemctl is-active --quiet nginx
}

activated=0
rollback_on_error() {
  status=$?
  trap - ERR
  if [[ "$activated" -eq 1 ]]; then
    restore_transaction || true
    echo "VUSA transaction failed; restored both components from $receipt_dir" >&2
  fi
  exit "$status"
}
trap rollback_on_error ERR

activated=1
install -m 0644 -o root -g root "$xray_candidate" "$remote_xray"
install -m 0644 -o root -g root "$nginx_candidate" "$remote_nginx"
ln -sfn ../sites-available/edge-https "$remote_nginx_link"
nginx -t
systemctl restart xray
systemctl is-active --quiet xray
systemctl reload nginx
systemctl is-active --quiet nginx
for required_port in 443 8444 20080 20081 20082 20083 20084 20085 20087 23443 28443; do
  ready=false
  for attempt in {1..30}; do
    if ss -H -ltn "sport = :$required_port" | grep -q .; then
      ready=true
      break
    fi
    sleep 1
  done
  if ! $ready; then
    echo "required VUSA listener is missing after 30s: tcp/$required_port" >&2
    false
  fi
done

trap - ERR
echo "VUSA transaction applied; rollback receipt: $receipt_dir"
REMOTE_VUSA

  cleanup_vusa_snapshot
  trap - ERR

  log "  vusa: ✓ transaction complete (dry_run=$DRY_RUN)"
}

deploy_server_44() {
  log "=== server-44: deploying sing-box config ==="
  local CFG="$DEPLOY_DIR/server-44/sing-box/config.json"
  local REMOTE="server-44"
  local REMOTE_CFG="/etc/sing-box/config.json"

  log "  Validating locally..."
  python3 -m json.tool "$CFG" >/dev/null
  scp -o StrictHostKeyChecking=accept-new "$CFG" "$REMOTE:/tmp/sing-box.new.json"
  ssh -o StrictHostKeyChecking=accept-new "$REMOTE" "sudo /usr/local/bin/sing-box check -c /tmp/sing-box.new.json && sudo rm -f /tmp/sing-box.new.json" 2>&1 | head -4

  if $DRY_RUN; then
    log "  DRY-RUN: skipping push"
    return 0
  fi

  log "  Backing up on remote..."
  ssh -o StrictHostKeyChecking=accept-new "$REMOTE" "sudo cp -a $REMOTE_CFG ${REMOTE_CFG}.bak_\$(date -u +%Y%m%d_%H%M%S)"

  log "  Pushing to server-44..."
  scp -o StrictHostKeyChecking=accept-new "$CFG" "$REMOTE:/tmp/sing-box.new.json"
  ssh -o StrictHostKeyChecking=accept-new "$REMOTE" "sudo install -m 0644 -o root -g root /tmp/sing-box.new.json $REMOTE_CFG && rm /tmp/sing-box.new.json"

  log "  Restarting sing-box..."
  ssh -o StrictHostKeyChecking=accept-new "$REMOTE" "sudo systemctl restart sing-box && sleep 2 && sudo systemctl is-active sing-box"

  log "  Smoke test (HTTP via 192.168.2.5:3128)..."
  curl -s --max-time 5 -x http://192.168.2.5:3128 https://api.ipify.org | head -1
  echo ""

  log "  Deploying server-44 Xray LAN Smart Edge + Telegram TPROXY policy..."
  if $DRY_RUN; then
    "$PANEL_DIR/scripts/deploy-server44-lan-smart-edge.sh" --dry-run
  else
    "$PANEL_DIR/scripts/deploy-server44-lan-smart-edge.sh"
  fi

  log "  server-44: ✓ done"
}

deploy_server_88() {
  log "=== server-88: deploying Xray LAN edge ==="
  local CFG="$DEPLOY_DIR/server-88/xray/config.json"
  local REMOTE="roomhacker-server-88"
  local REMOTE_CFG="/usr/local/etc/xray/config.json"

  log "  Uploading and validating candidates..."
  python3 -m json.tool "$CFG" >/dev/null
  scp -o StrictHostKeyChecking=accept-new "$CFG" "$REMOTE:/tmp/xray.new.json"
  ssh -o StrictHostKeyChecking=accept-new "$REMOTE" \
    "sudo /usr/local/bin/xray run -test -config /tmp/xray.new.json >/dev/null"

  if $DRY_RUN; then
    ssh -o StrictHostKeyChecking=accept-new "$REMOTE" "rm -f /tmp/xray.new.json"
    log "  DRY-RUN: skipping push"
    return 0
  fi

  log "  Backing up on remote..."
  ssh -o StrictHostKeyChecking=accept-new "$REMOTE" "ts=\$(date -u +%Y%m%d_%H%M%S); sudo cp -a $REMOTE_CFG ${REMOTE_CFG}.bak_\$ts"

  log "  Pushing to server-88..."
  ssh -o StrictHostKeyChecking=accept-new "$REMOTE" "sudo install -m 0644 -o root -g root /tmp/xray.new.json $REMOTE_CFG && rm -f /tmp/xray.new.json"

  log "  Restarting Xray and retiring the deprecated LAN dnsmasq..."
  ssh -o StrictHostKeyChecking=accept-new "$REMOTE" "sudo systemctl restart xray && sudo systemctl disable --now lan-smart-dns.service >/dev/null 2>&1 || true; sleep 2; test \"\$(systemctl is-active xray)\" = active"

  log "  Smoke tests (SOCKS + centralized SmartDNS)..."
  curl --socks5-hostname 192.168.2.75:1080 --max-time 5 https://api.ipify.org | head -1
  dig @192.168.2.100 chatgpt.com A +short | grep -Fx "$LAN_SMART_EDGE_IP"
  curl --connect-to chatgpt.com:443:$LAN_SMART_EDGE_IP:443 --max-time 10 -sS -o /dev/null https://chatgpt.com/
  echo ""

  log "  server-88: ✓ done"
}

deploy_smartdns() {
  log "=== server-100: deploying unified SmartDNS ==="
  if $DRY_RUN; then
    LAN_SMART_EDGE_IP="$LAN_SMART_EDGE_IP" "$PANEL_DIR/scripts/deploy-smartdns-unified.sh" --dry-run
  else
    LAN_SMART_EDGE_IP="$LAN_SMART_EDGE_IP" "$PANEL_DIR/scripts/deploy-smartdns-unified.sh"
  fi
  log "  unified SmartDNS: ✓ done"
}

deploy_router_dns() {
  log "=== router-dns: deploying LAN SmartDNS DNS/DHCP only ==="
  local SMART_DNS_SCRIPT="$DEPLOY_DIR/router/dhcp/configure-smart-dns.sh"
  local SMART_DNS_WATCHDOG="$DEPLOY_DIR/router/dhcp/smart-dns-upstream-watchdog.sh"
  local SMART_DNS_WATCHDOG_INIT="$DEPLOY_DIR/router/dhcp/smart-dns-upstream.init"
  local SMART_DNS_ROUTE_WATCHDOG="$DEPLOY_DIR/router/dhcp/smart-dns-route-watchdog.sh"
  local SMART_DNS_ROUTE_INIT="$DEPLOY_DIR/router/dhcp/smart-dns-route.init"
  local REMOTE="root@192.168.2.1"
  local RULES_FILE
  RULES_FILE="$(mktemp)"

  log "  Rendering canonical policy into OpenWrt address/local rules..."
  (cd "$PANEL_DIR" && "$PANEL_DIR/node_modules/.bin/tsx" src/cli/render-openwrt-smart-dns.ts --output "$RULES_FILE")
  log "  Uploading and validating DNS/DHCP candidate..."
  sh -n "$SMART_DNS_SCRIPT"
  sh -n "$SMART_DNS_WATCHDOG"
  sh -n "$SMART_DNS_WATCHDOG_INIT"
  sh -n "$SMART_DNS_ROUTE_WATCHDOG"
  sh -n "$SMART_DNS_ROUTE_INIT"
  scp -o StrictHostKeyChecking=accept-new "$SMART_DNS_SCRIPT" "$REMOTE:/tmp/configure-smart-dns.sh"
  scp -o StrictHostKeyChecking=accept-new "$SMART_DNS_WATCHDOG" "$REMOTE:/tmp/smart-dns-upstream-watchdog.sh"
  scp -o StrictHostKeyChecking=accept-new "$SMART_DNS_WATCHDOG_INIT" "$REMOTE:/tmp/smart-dns-upstream.init"
  scp -o StrictHostKeyChecking=accept-new "$SMART_DNS_ROUTE_WATCHDOG" "$REMOTE:/tmp/smart-dns-route-watchdog.sh"
  scp -o StrictHostKeyChecking=accept-new "$SMART_DNS_ROUTE_INIT" "$REMOTE:/tmp/smart-dns-route.init"
  scp -o StrictHostKeyChecking=accept-new "$RULES_FILE" "$REMOTE:/tmp/vpn-panel-smart-dns.domains"
  rm -f "$RULES_FILE"
  ssh -o StrictHostKeyChecking=accept-new "$REMOTE" \
    "sh -n /tmp/configure-smart-dns.sh && sh /tmp/configure-smart-dns.sh --check 192.168.2.100 $LAN_SMART_EDGE_IP /tmp/vpn-panel-smart-dns.domains 192.168.2.1"

  if $DRY_RUN; then
    "$PANEL_DIR/scripts/deploy-server88-dns-compat.sh" --dry-run
    ssh -o StrictHostKeyChecking=accept-new "$REMOTE" "rm -f /tmp/configure-smart-dns.sh /tmp/smart-dns-upstream-watchdog.sh /tmp/smart-dns-upstream.init /tmp/vpn-panel-smart-dns.domains"
    log "  DRY-RUN: skipping DNS/DHCP apply"
    return 0
  fi

  log "  Making the server-88 stale-lease forwarder durable..."
  "$PANEL_DIR/scripts/deploy-server88-dns-compat.sh"

  log "  Configuring generated DNS rules + stable router DHCP option 6..."
  ssh -o StrictHostKeyChecking=accept-new "$REMOTE" \
    "sh /tmp/configure-smart-dns.sh 192.168.2.100 $LAN_SMART_EDGE_IP /tmp/vpn-panel-smart-dns.domains 192.168.2.1 && cp /tmp/configure-smart-dns.sh /usr/sbin/vpn-panel-configure-smart-dns && cp /tmp/smart-dns-upstream-watchdog.sh /usr/sbin/vpn-panel-smart-dns-upstream && cp /tmp/smart-dns-upstream.init /etc/init.d/smart-dns-upstream && cp /tmp/smart-dns-route-watchdog.sh /usr/sbin/vpn-panel-smart-dns-route && cp /tmp/smart-dns-route.init /etc/init.d/smart-dns-route && chmod 0755 /usr/sbin/vpn-panel-configure-smart-dns /usr/sbin/vpn-panel-smart-dns-upstream /etc/init.d/smart-dns-upstream /usr/sbin/vpn-panel-smart-dns-route /etc/init.d/smart-dns-route && /etc/init.d/smart-dns-upstream enable && /etc/init.d/smart-dns-upstream restart && /etc/init.d/smart-dns-route enable && /etc/init.d/smart-dns-route restart && rm /tmp/configure-smart-dns.sh /tmp/smart-dns-upstream-watchdog.sh /tmp/smart-dns-upstream.init /tmp/smart-dns-route-watchdog.sh /tmp/smart-dns-route.init /tmp/vpn-panel-smart-dns.domains"

  log "  Smoke tests (router DNS path)..."
  ssh -o StrictHostKeyChecking=accept-new "$REMOTE" \
    "uci -q show dhcp.lan | grep -F '6,192.168.2.1' >/dev/null && nslookup chatgpt.com 127.0.0.1 2>/dev/null | grep -F 'Address: $LAN_SMART_EDGE_IP' >/dev/null && nslookup instagram.com 127.0.0.1 2>/dev/null | grep -F 'Address: $LAN_SMART_EDGE_IP' >/dev/null"
  dig @192.168.2.1 instagram.com A +short +time=3 +tries=1 | grep -Fx "$LAN_SMART_EDGE_IP" >/dev/null
  log "  router-dns: ✓ done"
}

deploy_router() {
  log "=== router: deploying HAProxy + LAN SmartDNS DHCP ==="
  local CFG="$DEPLOY_DIR/router/haproxy/haproxy.cfg"
  local SMART_DNS_SCRIPT="$DEPLOY_DIR/router/dhcp/configure-smart-dns.sh"
  local SMART_DNS_WATCHDOG="$DEPLOY_DIR/router/dhcp/smart-dns-upstream-watchdog.sh"
  local SMART_DNS_WATCHDOG_INIT="$DEPLOY_DIR/router/dhcp/smart-dns-upstream.init"
  local SMART_DNS_ROUTE_WATCHDOG="$DEPLOY_DIR/router/dhcp/smart-dns-route-watchdog.sh"
  local SMART_DNS_ROUTE_INIT="$DEPLOY_DIR/router/dhcp/smart-dns-route.init"
  local REMOTE="root@192.168.2.1"
  local REMOTE_CFG="/etc/haproxy.cfg"
  local RULES_FILE
  RULES_FILE="$(mktemp)"

  log "  Uploading and validating candidates..."
  (cd "$PANEL_DIR" && "$PANEL_DIR/node_modules/.bin/tsx" src/cli/render-openwrt-smart-dns.ts --output "$RULES_FILE")
  sh -n "$SMART_DNS_SCRIPT"
  sh -n "$SMART_DNS_WATCHDOG"
  sh -n "$SMART_DNS_WATCHDOG_INIT"
  sh -n "$SMART_DNS_ROUTE_WATCHDOG"
  sh -n "$SMART_DNS_ROUTE_INIT"
  scp -o StrictHostKeyChecking=accept-new "$CFG" "$REMOTE:/tmp/haproxy.new.cfg"
  scp -o StrictHostKeyChecking=accept-new "$SMART_DNS_SCRIPT" "$REMOTE:/tmp/configure-smart-dns.sh"
  scp -o StrictHostKeyChecking=accept-new "$SMART_DNS_WATCHDOG" "$REMOTE:/tmp/smart-dns-upstream-watchdog.sh"
  scp -o StrictHostKeyChecking=accept-new "$SMART_DNS_WATCHDOG_INIT" "$REMOTE:/tmp/smart-dns-upstream.init"
  scp -o StrictHostKeyChecking=accept-new "$SMART_DNS_ROUTE_WATCHDOG" "$REMOTE:/tmp/smart-dns-route-watchdog.sh"
  scp -o StrictHostKeyChecking=accept-new "$SMART_DNS_ROUTE_INIT" "$REMOTE:/tmp/smart-dns-route.init"
  scp -o StrictHostKeyChecking=accept-new "$RULES_FILE" "$REMOTE:/tmp/vpn-panel-smart-dns.domains"
  rm -f "$RULES_FILE"
  ssh -o StrictHostKeyChecking=accept-new "$REMOTE" "haproxy -c -f /tmp/haproxy.new.cfg && sh -n /tmp/configure-smart-dns.sh && sh /tmp/configure-smart-dns.sh --check 192.168.2.100 $LAN_SMART_EDGE_IP /tmp/vpn-panel-smart-dns.domains 192.168.2.1" 2>&1 | tail -3

  if $DRY_RUN; then
    "$PANEL_DIR/scripts/deploy-server88-dns-compat.sh" --dry-run
    ssh -o StrictHostKeyChecking=accept-new "$REMOTE" "rm -f /tmp/haproxy.new.cfg /tmp/configure-smart-dns.sh /tmp/smart-dns-upstream-watchdog.sh /tmp/smart-dns-upstream.init /tmp/vpn-panel-smart-dns.domains"
    log "  DRY-RUN: skipping push"
    return 0
  fi

  log "  Backing up on remote..."
  ssh -o StrictHostKeyChecking=accept-new "$REMOTE" "cp -a $REMOTE_CFG ${REMOTE_CFG}.bak_\$(date -u +%Y%m%d_%H%M%S)"

  log "  Pushing to router..."
  ssh -o StrictHostKeyChecking=accept-new "$REMOTE" "cp /tmp/haproxy.new.cfg $REMOTE_CFG && chmod 0600 $REMOTE_CFG && rm /tmp/haproxy.new.cfg"

  log "  Validating + reloading (USR2 = soft reload)..."
  ssh -o StrictHostKeyChecking=accept-new "$REMOTE" "haproxy -c -f $REMOTE_CFG && (/etc/init.d/haproxy reload || /etc/init.d/haproxy restart)"

  log "  Making the server-88 stale-lease forwarder durable..."
  "$PANEL_DIR/scripts/deploy-server88-dns-compat.sh"

  log "  Configuring generated DNS rules + stable router DHCP option 6..."
  ssh -o StrictHostKeyChecking=accept-new "$REMOTE" "sh /tmp/configure-smart-dns.sh 192.168.2.100 $LAN_SMART_EDGE_IP /tmp/vpn-panel-smart-dns.domains 192.168.2.1 && cp /tmp/configure-smart-dns.sh /usr/sbin/vpn-panel-configure-smart-dns && cp /tmp/smart-dns-upstream-watchdog.sh /usr/sbin/vpn-panel-smart-dns-upstream && cp /tmp/smart-dns-upstream.init /etc/init.d/smart-dns-upstream && cp /tmp/smart-dns-route-watchdog.sh /usr/sbin/vpn-panel-smart-dns-route && cp /tmp/smart-dns-route.init /etc/init.d/smart-dns-route && chmod 0755 /usr/sbin/vpn-panel-configure-smart-dns /usr/sbin/vpn-panel-smart-dns-upstream /etc/init.d/smart-dns-upstream /usr/sbin/vpn-panel-smart-dns-route /etc/init.d/smart-dns-route && /etc/init.d/smart-dns-upstream enable && /etc/init.d/smart-dns-upstream restart && /etc/init.d/smart-dns-route enable && /etc/init.d/smart-dns-route restart && rm /tmp/configure-smart-dns.sh /tmp/smart-dns-upstream-watchdog.sh /tmp/smart-dns-upstream.init /tmp/smart-dns-route-watchdog.sh /tmp/smart-dns-route.init /tmp/vpn-panel-smart-dns.domains"

  log "  Smoke test (HTTP via 192.168.2.1:3128)..."
  curl -s --max-time 5 -x http://192.168.2.1:3128 https://api.ipify.org | head -1
  echo ""
  log "  Smoke test (SOCKS via 192.168.2.1:1080)..."
  curl --socks5-hostname 192.168.2.1:1080 --max-time 5 https://api.ipify.org | head -1
  ssh -o StrictHostKeyChecking=accept-new "$REMOTE" "nslookup chatgpt.com 127.0.0.1 2>/dev/null | grep -F 'Address: $LAN_SMART_EDGE_IP'"
  echo ""

  log "  router: ✓ done"
}

# ─── Dispatch ──────────────────────────────────────────────────────────
for t in "${TARGETS[@]}"; do
  case "$t" in
    vpn2) deploy_vpn2 ;;
    vusa) deploy_vusa ;;
    server-44) deploy_server_44 ;;
    server-88) deploy_server_88 ;;
    smartdns) deploy_smartdns ;;
    router-dns) deploy_router_dns ;;
    router) deploy_router ;;
    all) deploy_vpn2; deploy_vusa; deploy_server_44; deploy_smartdns; deploy_router; deploy_server_88 ;;
    *) log "Unknown target: $t (use: vpn2|vusa|server-44|server-88|smartdns|router-dns|router|all)" ;;
  esac
done

log "=== deploy-all.sh DONE ==="

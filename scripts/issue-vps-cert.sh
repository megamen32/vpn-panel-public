#!/usr/bin/env bash
# scripts/issue-vps-cert.sh
# Issue / renew Let's Encrypt cert for VPN servers (DNS-01 or HTTP-01).
#
# Methods per VPS (in VPS_REGISTRY):
#   dns-01  — uses reg.ru API to set _acme-challenge TXT. Works when reg.ru
#            serves the specific A record (not just wildcard). No port 80
#            needed, works behind firewalls.
#   http-01 — uses nginx on the VPS + certbot --nginx plugin. Requires port
#            80 open from the internet. Fallback when DNS-01 is unavailable
#            (e.g., reg.ru NS returns wildcard for all subdomains).
#
# LE certs are valid 90 days, but certbot.timer auto-renews 30 days before
# expiry, so they're effectively "long-period" (always valid).
#
# Architecture (DNS-01):
#   - Certbot runs ON the VPS (writes /etc/letsencrypt/)
#   - DNS-01 hook calls vpn.bezrabotnyi.com/api/admin/cert/regru with the
#     health API key. That endpoint is publicly reachable (nginx on server-100),
#     runs regru_api.py which is whitelisted by reg.ru, and updates the
#     _acme-challenge TXT record. Works for VPSes on any network.
#
# Architecture (HTTP-01):
#   - Certbot runs ON the VPS, talking to itself on port 80 (no callback)
#   - LE sees the nginx vhost, validates, issues cert
#   - Script then fixes cert perms so Xray (nobody:proxy group) can read
#
# Usage (on server-100):
#   scripts/issue-vps-cert.sh vpn2          # issue/renew cert on vpn2
#   scripts/issue-vps-cert.sh vusa          # issue/renew cert on vusa
#   scripts/issue-vps-cert.sh vpn2 --dry-run  # test mode (certbot --dry-run)
#   scripts/issue-vps-cert.sh --list        # list known VPSes
#
# Idempotent: re-running for an existing cert triggers certbot renew.

set -euo pipefail
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
PANEL_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"
LOG_DIR="$PANEL_DIR/logs/cert-issuance"
mkdir -p "$LOG_DIR"

# Panel health API key (used by certbot hooks to call /api/admin/cert/regru)
if [ -f "$PANEL_DIR/.env" ]; then
  set -a; source "$PANEL_DIR/.env"; set +a
fi
if [ -z "${VPN_PANEL_HEALTH_API_KEY:-}" ]; then
  echo "ERROR: VPN_PANEL_HEALTH_API_KEY not set (load from .env)" >&2
  exit 1
fi

# Panel base URL (used by hooks to call /api/admin/cert/regru)
PANEL_BASE_URL="${PANEL_BASE_URL:-https://vpn.bezrabotnyi.com}"

# ─── VPS registry ────────────────────────────────────────────────────
# vps_name|host|user|ssh_key|domain|method
# method: dns-01 (reg.ru API, requires ports 80/443 to NOT be needed) or
#         http-01 (requires nginx on VPS + port 80 open from LE)
VPS_REGISTRY=(
  "vpn2|vpn2.bezrabotnyi.com|root|/home/roomhacker/.ssh/id_rsa|vpn2.bezrabotnyi.com|dns-01"
  "vusa|185.240.120.152|root|/home/roomhacker/.ssh/id_rsa|vusa.bezrabotnyi.com|http-01"
)

usage() {
  cat <<EOF
Usage: $(basename "$0") [--list] [--dry-run] <vps_name>

Known VPSes:
EOF
  for v in "${VPS_REGISTRY[@]}"; do
    IFS='|' read -r name host _ _ <<< "$v"
    echo "  $name  -> $host"
  done
  echo ""
  echo "Options:"
  echo "  --list     List known VPSes"
  echo "  --dry-run  Run certbot in test mode"
}

list_mode=false
dry_run=false
target=""
for arg in "$@"; do
  case "$arg" in
    --list|-l) list_mode=true ;;
    --dry-run) dry_run=true ;;
    --help|-h) usage; exit 0 ;;
    -*) echo "Unknown option: $arg" >&2; usage; exit 1 ;;
    *) target="$arg" ;;
  esac
done

$list_mode && { usage; exit 0; }
[ -z "$target" ] && { usage; exit 1; }

# Find VPS
vps_entry=""
for v in "${VPS_REGISTRY[@]}"; do
  name="${v%%|*}"
  [ "$name" = "$target" ] && { vps_entry="$v"; break; }
done
[ -z "$vps_entry" ] && { echo "ERROR: unknown VPS '$target'" >&2; usage; exit 1; }

IFS='|' read -r VPS_NAME VPS_HOST VPS_USER VPS_KEY DOMAIN METHOD <<< "$vps_entry"
LOG="$LOG_DIR/${VPS_NAME}.log"

log() { echo "[$(date -Iseconds)] $*" | tee -a "$LOG"; }

log "=========================================="
log "issue-vps-cert.sh: $VPS_NAME ($VPS_HOST) -> $DOMAIN"
log "Mode: $([ "$dry_run" = true ] && echo 'DRY-RUN' || echo 'REAL')"
log "Method: ${METHOD:-dns-01}"
log "=========================================="

# ─── Build hook bodies ──────────────────────────────────────────────
# Each hook is a separate script. Certbot calls --manual-auth-hook to add
# the record, --manual-cleanup-hook to remove it. Both call the panel
# endpoint /api/admin/cert/regru with the appropriate action.

VPS_HOOKS_DIR="/opt/cert-hooks"
REMOTE_AUTH_HOOK="$VPS_HOOKS_DIR/regru-auth-hook.sh"
REMOTE_CLEANUP_HOOK="$VPS_HOOKS_DIR/regru-cleanup-hook.sh"

make_hook() {
  local action="$1"
  cat <<HOOK
#!/bin/bash
# Certbot DNS-01 ${action} hook for reg.ru (via vpn-panel API)
# Uses python3 for safe JSON construction (avoids shell quoting issues).
set -euo pipefail

DOM="\$CERTBOT_DOMAIN"
VAL="\$CERTBOT_VALIDATION"
ACTION="${action}"
API_URL="${PANEL_BASE_URL}/api/admin/cert/regru"
API_KEY="${VPN_PANEL_HEALTH_API_KEY}"

# Strip last 2 labels (e.g. ".bezrabotnyi.com") to get subdomain relative to zone
SUBDOMAIN=\$(echo "\$DOM" | awk -F. '{ for (i=1; i<=NF-2; i++) printf "%s%s", \$i, (i<NF-2?".":"") }')
ZONE=\$(echo "\$DOM" | awk -F. '{ for (i=NF-1; i<=NF; i++) printf "%s%s", \$i, (i<NF?".":"") }')

echo "DNS-01 \${ACTION} hook: subdomain=\${SUBDOMAIN} zone=\${ZONE}"

# Export env vars for the python heredoc
export API_URL API_KEY ACTION SUBDOMAIN VAL ZONE

python3 - <<'PYEOF'
import json, os, ssl, urllib.request, urllib.error, sys

api_url = os.environ['API_URL']
api_key = os.environ['API_KEY']
action = os.environ['ACTION']
subdomain = os.environ['SUBDOMAIN']
value = os.environ['VAL']
zone = os.environ['ZONE']

payload = json.dumps({
    "action": action,
    "subdomain": subdomain,
    "value": value,
    "zone": zone,
}).encode()

ctx = ssl.create_default_context()
ctx.check_hostname = False
ctx.verify_mode = ssl.CERT_NONE

req = urllib.request.Request(
    api_url,
    data=payload,
    headers={
        "Content-Type": "application/json",
        "Authorization": f"Bearer {api_key}",
    },
    method="POST",
)
try:
    with urllib.request.urlopen(req, timeout=30, context=ctx) as resp:
        body = resp.read().decode()
        print(f"HTTP {resp.status}: {body}")
        sys.exit(0 if resp.status == 200 else 1)
except urllib.error.HTTPError as e:
    print(f"HTTP {e.code}: {e.read().decode()}", file=sys.stderr)
    sys.exit(1)
PYEOF
HOOK
}

AUTH_HOOK_BODY=$(make_hook auth)
CLEANUP_HOOK_BODY=$(make_hook cleanup)

log "Pushing hooks + certbot to $VPS_HOST..."

# Push hooks (cat heredoc via stdin avoids quoting issues)
echo "$AUTH_HOOK_BODY" | ssh -i "$VPS_KEY" -o StrictHostKeyChecking=accept-new "$VPS_USER@$VPS_HOST" \
  "mkdir -p $VPS_HOOKS_DIR && cat > $REMOTE_AUTH_HOOK && chmod +x $REMOTE_AUTH_HOOK"

echo "$CLEANUP_HOOK_BODY" | ssh -i "$VPS_KEY" -o StrictHostKeyChecking=accept-new "$VPS_USER@$VPS_HOST" \
  "cat > $REMOTE_CLEANUP_HOOK && chmod +x $REMOTE_CLEANUP_HOOK"

# Verify
ssh -i "$VPS_KEY" "$VPS_USER@$VPS_HOST" "ls -la $VPS_HOOKS_DIR/ && echo '--- auth hook ---' && head -5 $REMOTE_AUTH_HOOK"

# For DNS-01, push the hooks
if [ "$METHOD" = "dns-01" ]; then
  log "DNS-01 method: hooks already pushed above"
fi

# Install certbot + plugins
log "Ensuring certbot (+ plugins) installed on $VPS_HOST..."
case "$METHOD" in
  dns-01) PKGS="certbot" ;;
  http-01) PKGS="certbot python3-certbot-nginx nginx" ;;
  *) log "ERROR: unknown method '$METHOD' for $VPS_NAME"; exit 1 ;;
esac
ssh -i "$VPS_KEY" "$VPS_USER@$VPS_HOST" bash -s <<REMOTEOF
set -e
DEBIAN_FRONTEND=noninteractive apt-get install -y $PKGS
certbot --version
REMOTEOF

# For HTTP-01, set up nginx vhost
if [ "$METHOD" = "http-01" ]; then
  log "Setting up nginx vhost for $DOMAIN on $VPS_HOST..."
  ssh -i "$VPS_KEY" "$VPS_USER@$VPS_HOST" bash -s <<REMOTEOF
set -e
mkdir -p /etc/nginx/sites-enabled
cat > /etc/nginx/sites-enabled/$DOMAIN <<'NGINX'
server {
    listen 80;
    server_name $DOMAIN;
    location / { return 200 'ok'; add_header Content-Type text/plain; }
}
NGINX
rm -f /etc/nginx/sites-enabled/default
nginx -t 2>&1 | head -3
systemctl reload nginx || systemctl restart nginx
REMOTEOF
fi

# Build certbot command based on method
CERTBOT_FLAGS="certonly --non-interactive --agree-tos --no-eff-email"
CERTBOT_FLAGS+=" --email admin@$DOMAIN"
case "$METHOD" in
  dns-01)
    CERTBOT_FLAGS+=" --manual --preferred-challenges dns"
    CERTBOT_FLAGS+=" --manual-auth-hook $REMOTE_AUTH_HOOK"
    CERTBOT_FLAGS+=" --manual-cleanup-hook $REMOTE_CLEANUP_HOOK"
    ;;
  http-01)
    CERTBOT_FLAGS+=" --nginx"
    ;;
esac
$dry_run && CERTBOT_FLAGS+=" --dry-run"
CERTBOT_FLAGS+=" -d $DOMAIN"

log "Running certbot on $VPS_HOST..."
log "  certbot $CERTBOT_FLAGS"
if ssh -i "$VPS_KEY" "$VPS_USER@$VPS_HOST" "certbot $CERTBOT_FLAGS" 2>&1 | tee -a "$LOG" | tail -25; then
  log "certbot: OK"
else
  log "certbot: FAILED (see $LOG)"
  exit 1
fi

# For HTTP-01, fix cert perms so Xray (nobody) can read
if [ "$METHOD" = "http-01" ]; then
  log "Fixing cert perms (root:proxy, mode 0644/0640) for Xray (nobody)..."
  ssh -i "$VPS_KEY" "$VPS_USER@$VPS_HOST" bash -s <<'REMOTEOF'
set -e
chown -R root:proxy /etc/letsencrypt/live /etc/letsencrypt/archive
chmod 0755 /etc/letsencrypt/live /etc/letsencrypt/archive
chmod 0644 /etc/letsencrypt/live/*/fullchain.pem /etc/letsencrypt/live/*/chain.pem
chmod 0640 /etc/letsencrypt/live/*/privkey.pem
usermod -aG proxy nobody 2>/dev/null || true
mkdir -p /etc/systemd/system/xray.service.d
cat > /etc/systemd/system/xray.service.d/20-supplementary-proxy.conf <<'CONF'
[Service]
SupplementaryGroups=proxy
CONF
systemctl daemon-reload
systemctl restart xray || true
REMOTEOF
fi

# Verify
log "Verifying cert on $VPS_HOST..."
ssh -i "$VPS_KEY" "$VPS_USER@$VPS_HOST" "certbot certificates 2>&1" | tee -a "$LOG" | head -20

# Auto-renewal via certbot.timer
log "Ensuring certbot.timer for auto-renewal..."
ssh -i "$VPS_KEY" "$VPS_USER@$VPS_HOST" <<'REMOTEOF'
set -e
systemctl enable certbot.timer 2>/dev/null || true
systemctl start certbot.timer 2>/dev/null || true
systemctl list-timers certbot.timer
REMOTEOF

log "=========================================="
log "Done: $VPS_NAME cert for $DOMAIN (method=$METHOD)"
log "=========================================="

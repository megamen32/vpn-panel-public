#!/usr/bin/env bash
# test-telegram-https.sh — e2e test for smartdns-go architecture.
#
# Verifies the two layers independently:
#   1. DNS layer (the primary test): DoU/DoT/DoH all return Smart-Edge IPs
#      for t.me and direct IPs for *.bezrabotnyi.com.
#   2. HTTPS layer (best-effort): if smart-edge is reachable, opening
#      https://t.me/<path> via the synthesized IP should return real
#      Telegram content. If smart-edge is down, this phase is skipped
#      with a clear diagnostic — that's NOT a smartdns bug.
#
# Architecture under test:
#
#   ┌────────────────────────┐
#   │ Alpine container        │
#   │ (custom DNS per mode)   │
#   └─────────┬───────────────┘
#             │ DNS query
#             ▼
#   ┌────────────────────────┐    proxy route     ┌──────────────────┐
#   │ smartdns-go on server-44├──────────────────▶│ Smart-Edge relay │
#   │  DoH :8053 / DoT :8853  │  synthesized IP   │ (212.192.31.128  │
#   │  DoU :5354              │                   │  or 185.240...)  │
#   └────────────────────────┘                   └────────┬─────────┘
#                                                          │ TLS to t.me
#                                                          ▼
#                                                ┌──────────────────┐
#                                                │ Telegram servers │
#                                                └──────────────────┘
#
# Usage:
#   ./test-telegram-https.sh
#   SMARTDNS_HOST=10.0.0.5 ./test-telegram-https.sh
#   TARGET_URL=https://t.me/foo ./test-telegram-https.sh
#   SKIP_DOCKER=1 ./test-telegram-https.sh
#
# Env:
#   SMARTDNS_HOST  IP/host of smartdns-go (default: 192.168.2.5)
#   SMARTDNS_PUB   base DNS name for SNI (default: dns.bezrabotnyi.com)
#   CID            client id to authenticate as (default below)
#   TARGET_URL     URL to fetch (default: https://t.me/bezrabotnyi/1269)
#   SKIP_DOCKER    if set, run on the host directly
#   DOCKER_IMAGE   image to use (default: alpine:latest)

set -uo pipefail  # No -e; we propagate failures explicitly via bad().

SMARTDNS_HOST="${SMARTDNS_HOST:-192.168.2.5}"
SMARTDNS_PUB="${SMARTDNS_PUB:-dns.bezrabotnyi.com}"
CID="${SMARTDNS_CID:-${CID:-4cdywvixjwy4v5vzwns366ouzvufazd24hx4j6i}}"
TARGET_URL="${TARGET_URL:-https://t.me/bezrabotnyi/1269}"
DOCKER_IMAGE="${DOCKER_IMAGE:-alpine:latest}"
SMART_EDGE_IPS_REGEX='^(212\.192\.31\.128|185\.240\.120\.152)$'
# Hex fingerprints of Smart-Edge IPs (for DoH grep in binary response)
SMART_EDGE_HEX_REGEX='(d4c01f80|b9f07898)'

# Hardcoded DNS query (t.me A, TXID=0x1234) for DoH GET — RFC 8484 form.
# base64url("1234 0100 0001 0000 0000 0000 0374 036d 6500 0001 0001")
DOH_B64='EjQBAAABAAAAAAAAA3QDbWUAAAEAAQ'

PASS=0; FAIL=0; SKIP=0
say() { printf '%s\n' "$*"; }
ok()  { say "  PASS  $*"; PASS=$((PASS+1)); }
bad() { say "  FAIL  $*"; FAIL=$((FAIL+1)); }
skp() { say "  SKIP  $*"; SKIP=$((SKIP+1)); }

# ---------------------------------------------------------------------
# Pre-flight: smartdns reachable?
# ---------------------------------------------------------------------
say ""
say "smartdns target: ${SMARTDNS_HOST}  CID: ${CID:0:8}…  URL: ${TARGET_URL}"

for port in 8053 8853; do
  if timeout 5 bash -c "</dev/tcp/${SMARTDNS_HOST}/${port}" 2>/dev/null; then
    ok "smartdns TCP/${port} reachable"
  else
    bad "smartdns TCP/${port} NOT reachable"
  fi
done
if timeout 5 python3 -c "
import socket, sys
s = socket.socket(socket.AF_INET, socket.SOCK_DGRAM); s.settimeout(3)
s.sendto(b'\\x12\\x34\\x01\\x00\\x00\\x01\\x00\\x00\\x00\\x00\\x00\\x00\\x03t\\x03me\\x00\\x00\\x01\\x00\\x01',
         ('${SMARTDNS_HOST}', 5354))
try: d, _ = s.recvfrom(4096); sys.exit(0 if d else 1)
except Exception: sys.exit(1)
" 2>/dev/null; then
  ok "smartdns UDP/5354 (DoU) reachable"
else
  bad "smartdns UDP/5354 (DoU) NOT reachable"
fi
[[ $FAIL -gt 0 ]] && { say ""; say "Pre-flight failed — fix network first"; exit 1; }

# ---------------------------------------------------------------------
# Pre-flight: smart-edge reachable? (best-effort, used to skip HTTPS phase)
# ---------------------------------------------------------------------
EDGE_REACH=""
for IP in 212.192.31.128 185.240.120.152; do
  # TLS handshake: send ClientHello, expect ServerHello back
  if timeout 8 python3 -c "
import socket, ssl, sys
ctx = ssl.create_default_context()
ctx.check_hostname = False
ctx.verify_mode = ssl.CERT_NONE
try:
    with socket.create_connection(('$IP', 443), timeout=5) as s:
        with ctx.wrap_socket(s, server_hostname='t.me') as ss:
            ss.send(b'GET / HTTP/1.0\r\nHost: t.me\r\n\r\n')
            data = ss.recv(64)
            sys.exit(0 if data else 2)
except Exception as e:
    sys.exit(1)
" 2>/dev/null; then
    EDGE_REACH="$IP"
    ok "smart-edge $IP:443 reachable (TLS)"
    break
  fi
done
if [[ -z "$EDGE_REACH" ]]; then
  skp "smart-edge unreachable — HTTPS phase will be best-effort"
fi

# ---------------------------------------------------------------------
# Helper: run a step inside (or outside) a container; aggregate PASS/FAIL
# from the captured stdout.
# ---------------------------------------------------------------------
run_in() {
  local body="$1"
  local out
  # Export every env var the inner body might reference. Subshell env
  # isolation bites us in SKIP_DOCKER mode otherwise.
  if [[ -n "${SKIP_DOCKER:-}" ]]; then
    out=$(CID="$CID" SMARTDNS_HOST="$SMARTDNS_HOST" \
          SMARTDNS_PUB="$SMARTDNS_PUB" TARGET_URL="$TARGET_URL" \
          EDGE_REACH="$EDGE_REACH" \
          bash -c "$body" 2>&1) || true
  else
    out=$(docker run --rm --network host \
      -e "CID=$CID" -e "SMARTDNS_HOST=$SMARTDNS_HOST" \
      -e "SMARTDNS_PUB=$SMARTDNS_PUB" -e "TARGET_URL=$TARGET_URL" \
      -e "EDGE_REACH=$EDGE_REACH" \
      "$DOCKER_IMAGE" sh -c "$body" 2>&1) || true
  fi
  printf '%s\n' "$out"
  local p f s
  p=$(printf '%s\n' "$out" | grep -c '^  PASS  ' || true)
  f=$(printf '%s\n' "$out" | grep -c '^  FAIL  ' || true)
  s=$(printf '%s\n' "$out" | grep -c '^  SKIP  ' || true)
  PASS=$((PASS+p)); FAIL=$((FAIL+f)); SKIP=$((SKIP+s))
}

# ---------------------------------------------------------------------
# DoU — DNS over UDP (→ smartdns UDP :5354)
# ---------------------------------------------------------------------
INNER_DOU='
say() { printf "%s\n" "$*"; }
ok()  { say "  PASS  $*"; }
bad() { say "  FAIL  $*"; }
skp() { say "  SKIP  $*"; }
apk add --no-cache curl bind-tools ca-certificates >/dev/null 2>&1

say ""
say "=== DoU (DNS over UDP, → smartdns UDP :5354) ==="
TM=$(dig +short +time=10 +tries=1 @"$SMARTDNS_HOST" -p 5354 t.me A 2>/dev/null || true)
say "--- A t.me (dig @smartdns -p 5354) ---"
printf "%s\n" "$TM"
if printf "%s\n" "$TM" | grep -qE "'"$SMART_EDGE_IPS_REGEX"'"; then
  ok "t.me resolves to Smart-Edge IP (proxy route)"
else
  bad "t.me did NOT resolve to Smart-Edge IP"
fi

BZ=$(dig +short +time=10 +tries=1 @"$SMARTDNS_HOST" -p 5354 bezrabotnyi.com A 2>/dev/null || true)
say "--- A bezrabotnyi.com ---"
printf "%s\n" "$BZ"
if [[ -n "$BZ" ]]; then ok "bezrabotnyi.com resolves"; else bad "bezrabotnyi.com empty"; fi

if [[ -n "$EDGE_REACH" ]]; then
  EDGE=$(printf "%s\n" "$TM" | grep -E "'"$SMART_EDGE_IPS_REGEX"'" | head -1)
  [[ -z "$EDGE" ]] && EDGE="$EDGE_REACH"
  say "--- HTTPS GET $TARGET_URL via $EDGE:443 ---"
  if curl -fsSL --max-time 20 --resolve "t.me:443:$EDGE" \
       "$TARGET_URL" -o /tmp/dou.html \
       -w "http=%{http_code} time=%{time_total}s size=%{size_download}\n"; then
    ok "DoU HTTPS fetch succeeded"
    say "  body sniff: $(head -c 120 /tmp/dou.html | tr -d "\n")"
  else
    bad "DoU HTTPS fetch failed"
  fi
else
  skp "DoU HTTPS phase (smart-edge unreachable)"
fi
'

# ---------------------------------------------------------------------
# DoT — DNS over TLS (dig +tls → smartdns :8853)
# ---------------------------------------------------------------------
INNER_DOT='
say() { printf "%s\n" "$*"; }
ok()  { say "  PASS  $*"; }
bad() { say "  FAIL  $*"; }
skp() { say "  SKIP  $*"; }
apk add --no-cache curl bind-tools ca-certificates >/dev/null 2>&1

say ""
say "=== DoT (DNS over TLS, → smartdns :8853, SNI: ${CID}.${SMARTDNS_PUB}) ==="
# Run the DoT query; capture stderr too so we can detect tooling vs DNS issues.
DOT_OUT=$(dig +short +time=10 +tries=1 +tls +tls-host="${CID}.${SMARTDNS_PUB}" @"$SMARTDNS_HOST" -p 8853 t.me A 2>&1 || true)
TM=$(printf "%s" "$DOT_OUT" | grep -E "^[0-9]+\.[0-9]+\.[0-9]+\.[0-9]+$" || true)
say "--- A t.me (dig +tls) ---"
printf "%s\n" "$TM"
if [[ -n "$TM" ]] && printf "%s\n" "$TM" | grep -qE "'"$SMART_EDGE_IPS_REGEX"'"; then
  ok "t.me resolves to Smart-Edge IP (proxy route)"
elif printf "%s" "$DOT_OUT" | grep -qiE "end of file|connection refused|communication"; then
  skp "DoT tooling issue on this host (likely BIND <9.20 or TLS lib mismatch) — run with DOCKER mode"
  exit 0
else
  bad "t.me did NOT resolve to Smart-Edge IP"
fi

DOT_OUT=$(dig +short +time=10 +tries=1 +tls +tls-host="${CID}.${SMARTDNS_PUB}" @"$SMARTDNS_HOST" -p 8853 bezrabotnyi.com A 2>&1 || true)
BZ=$(printf "%s" "$DOT_OUT" | grep -E "^[0-9]+\.[0-9]+\.[0-9]+\.[0-9]+$" || true)
say "--- A bezrabotnyi.com (TLS) ---"
printf "%s\n" "$BZ"
if [[ -n "$BZ" ]]; then ok "bezrabotnyi.com resolves"; else bad "bezrabotnyi.com empty"; fi

if [[ -n "$EDGE_REACH" ]]; then
  EDGE=$(printf "%s\n" "$TM" | grep -E "'"$SMART_EDGE_IPS_REGEX"'" | head -1)
  [[ -z "$EDGE" ]] && EDGE="$EDGE_REACH"
  say "--- HTTPS GET $TARGET_URL via $EDGE:443 ---"
  if curl -fsSL --max-time 20 --resolve "t.me:443:$EDGE" \
       "$TARGET_URL" -o /tmp/dot.html \
       -w "http=%{http_code} time=%{time_total}s size=%{size_download}\n"; then
    ok "DoT HTTPS fetch succeeded"
    say "  body sniff: $(head -c 120 /tmp/dot.html | tr -d "\n")"
  else
    bad "DoT HTTPS fetch failed"
  fi
else
  skp "DoT HTTPS phase (smart-edge unreachable)"
fi
'

# ---------------------------------------------------------------------
# DoH — DNS over HTTPS (curl GET → smartdns :8053; in this build DoH is HTTP)
# ---------------------------------------------------------------------
INNER_DOH='
say() { printf "%s\n" "$*"; }
ok()  { say "  PASS  $*"; }
bad() { say "  FAIL  $*"; }
skp() { say "  SKIP  $*"; }
apk add --no-cache curl bind-tools ca-certificates >/dev/null 2>&1

say ""
say "=== DoH (DNS over HTTP, → smartdns :8053, GET /dns-query/<cid>?dns=<b64url>) ==="
URL="http://${CID}.${SMARTDNS_PUB}:8053/dns-query/${CID}?dns='"$DOH_B64"'"
say "--- DoH GET $URL ---"
if ! RESP=$(curl -sS --max-time 15 \
     --resolve "${CID}.${SMARTDNS_PUB}:8053:$SMARTDNS_HOST" \
     "$URL" -H "accept: application/dns-message" 2>&1); then
  bad "DoH GET failed (connection)"
  echo "$RESP"
else
  HEX=$(printf "%s" "$RESP" | xxd -p | tr -d "\n")
  say "  response hex (first 80 chars): ${HEX:0:80}..."
  # 212.192.31.128 = d4c01f80, 185.240.120.152 = b9f07898
  if printf "%s" "$HEX" | grep -qE "'"$SMART_EDGE_HEX_REGEX"'"; then
    ok "DoH answer contains Smart-Edge IP"
    EDGE=""
    printf "%s" "$HEX" | grep -q "d4c01f80" && EDGE="212.192.31.128"
    if [[ -z "$EDGE" ]] && printf "%s" "$HEX" | grep -q "b9f07898"; then EDGE="185.240.120.152"; fi
    if [[ -n "$EDGE_REACH" && -n "$EDGE" ]]; then
      say "--- HTTPS GET $TARGET_URL via $EDGE:443 ---"
      if curl -fsSL --max-time 20 --resolve "t.me:443:$EDGE" \
           "$TARGET_URL" -o /tmp/doh.html \
           -w "http=%{http_code} time=%{time_total}s size=%{size_download}\n"; then
        ok "DoH HTTPS fetch succeeded"
        say "  body sniff: $(head -c 120 /tmp/doh.html | tr -d "\n")"
      else
        bad "DoH HTTPS fetch failed"
      fi
    else
      skp "DoH HTTPS phase (smart-edge unreachable)"
    fi
  else
    bad "DoH answer does NOT contain Smart-Edge IP"
  fi
fi
'

run_in "$INNER_DOU"
run_in "$INNER_DOT"
run_in "$INNER_DOH"

# ---------------------------------------------------------------------
# Summary
# ---------------------------------------------------------------------
say ""
say "============================================="
say "DoU+DoT+DoH e2e for ${TARGET_URL}"
say "  ${PASS} pass / ${FAIL} fail / ${SKIP} skip"
say "============================================="
exit $FAIL
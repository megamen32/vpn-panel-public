#!/bin/bash
# fleet-deploy.sh — one script to deploy, configure and verify every VPN VPS.
#
# Why: the three nodes were configured by different one-off paths, so they
# drifted into three shapes (different xray config paths, Reality on a public
# port on one node and loopback on another, nginx missing on one). This script
# takes the declarative spec in deploy/vpn-fleet.json and converges every node
# onto the same shape, then proves it with real traffic.
#
#   node scripts/fleet-deploy.sh                  # report only, changes nothing
#   node scripts/fleet-deploy.sh --apply          # converge + verify
#   node scripts/fleet-deploy.sh --apply --host=vpn2
#   node scripts/fleet-deploy.sh --verify         # verify only, no changes
#
# Identity that MUST differ per host stays in the spec, never in code:
# the Reality keypair, the certificate domain, the mask SNI and sysctl tuning.
#
# Reality binds 0.0.0.0 on purpose. A socket on 0.0.0.0 also accepts loopback
# connections, so nginx can reach it at 127.0.0.1:23443 while the same inbound
# stays usable on a high port as an emergency exit. Earlier this was bound to
# loopback only, which removed that option; the fallback is now an advertised
# endpoint instead of a stray bind address.

set -uo pipefail
cd "$(dirname "$0")/.." || exit 1
set -a; . ./.env; set +a

APPLY=0
VERIFY_ONLY=0
HOST=""
for a in "$@"; do
  case "$a" in
    --apply) APPLY=1 ;;
    --verify) VERIFY_ONLY=1 ;;
    --host=*) HOST="${a#--host=}" ;;
  esac
done

BIND="${FLEET_REALITY_BIND:-0.0.0.0}"
REALITY_PORT="${FLEET_REALITY_PORT:-23443}"

green() { printf '\033[32m%s\033[0m\n' "$*"; }
red()   { printf '\033[31m%s\033[0m\n' "$*"; }
yellow(){ printf '\033[33m%s\033[0m\n' "$*"; }

# ── host transport ─────────────────────────────────────────────────────────
# Passwords only ever travel through the environment, never in argv.
host_ssh() {
  local alias="$1" spec="$2" cmd="$3"
  local pw_env
  pw_env=$(python3 -c "import json,sys;print(json.load(open('deploy/vpn-fleet.json'))[sys.argv[1]].get('sshPasswordEnv',''))" "$alias")
  if [ -n "$pw_env" ] && [ -n "${!pw_env:-}" ]; then
    SSHPASS="${!pw_env}" sshpass -e ssh -o StrictHostKeyChecking=no \
      -o ConnectTimeout=10 -o PreferredAuthentications=password "$spec" "$cmd"
  else
    ssh -o BatchMode=yes -o StrictHostKeyChecking=no -o ConnectTimeout=10 "$spec" "$cmd"
  fi
}

# ── step 1: configure ──────────────────────────────────────────────────────
configure_host() {
  local alias="$1" spec="$2" cfgpath="$3"
  echo "  [configure] $alias"
  host_ssh "$alias" "$spec" "bash -s" <<REMOTE
set -uo pipefail
CFG="$cfgpath"
BIND="$BIND"
PORT="$REALITY_PORT"

# nginx + stream module. Ubuntu ships nginx without ngx_stream_module, so a
# missing module shows up as 'unknown directive stream'. Probe for the module
# file: nginx -V always prints --with-stream_ssl_module, so grepping the
# version banner for 'with-stream' is a false positive that skips the install.
if ! command -v nginx >/dev/null 2>&1; then
  DEBIAN_FRONTEND=noninteractive apt-get install -y -qq nginx >/dev/null 2>&1
fi
if ! ls /usr/lib/nginx/modules/*stream* >/dev/null 2>&1; then
  DEBIAN_FRONTEND=noninteractive apt-get install -y -qq libnginx-mod-stream >/dev/null 2>&1
fi
command -v nginx >/dev/null 2>&1 && echo "    nginx: $(nginx -v 2>&1)"

# Reality bind
python3 - "\$CFG" "\$PORT" "\$BIND" <<'PY'
import json, sys
path, port, bind = sys.argv[1], int(sys.argv[2]), sys.argv[3]
cfg = json.load(open(path))
n = 0
for i in cfg.get("inbounds", []):
    st = i.get("streamSettings") or {}
    if st.get("security") == "reality" and i.get("port") == port:
        if i.get("listen", "0.0.0.0") != bind:
            i["listen"] = bind
            n += 1
json.dump(cfg, open(path, "w"), ensure_ascii=False, indent=2)
print(f"    reality bind -> {bind} ({n} changed)")
PY

XRAY_LOCATION_ASSET=/etc/vpn-panel/xray-geo /usr/local/bin/xray run -test -c "\$CFG" >/dev/null 2>&1 \
  || { echo "    xray -test FAILED"; exit 1; }
systemctl enable xray.service >/dev/null 2>&1
systemctl restart xray.service
sleep 3
systemctl is-active xray.service >/dev/null || { echo "    xray not active"; exit 1; }

# Advertised ports must be reachable. ufw is inactive on most nodes; add the
# rules only where it is actually enabled, and never disable it wholesale:
# doing so would expose the LAN proxy and the internal 2008x inbounds too.
if command -v ufw >/dev/null 2>&1 && ufw status 2>/dev/null | head -1 | grep -q "Status: active"; then
  for rule in "443/tcp" "28443/tcp" "24443/udp" "\${PORT}/tcp"; do
    ufw allow "\$rule" >/dev/null 2>&1
  done
  echo "    ufw: active, allowed advertised ports"
else
  echo "    ufw: inactive, nothing to open"
fi
REMOTE
}

# ── step 2: deploy clients ─────────────────────────────────────────────────
deploy_clients() {
  local alias="$1" spec="$2" cfgpath="$3"
  local wanted n
  wanted=$(python3 scripts/fleet-wanted-clients.py "$alias")
  n=$(printf '%s' "$wanted" | python3 -c 'import json,sys;print(len(json.load(sys.stdin)))')
  echo "  [deploy] $alias: $n client(s) wanted"
  WANTED_B64=$(printf '%s' "$wanted" | base64) host_ssh "$alias" "$spec" \
    "bash -s -- '$cfgpath'" <<'REMOTE'
set -uo pipefail
CFG="$1"
BACKUP="${CFG}.fleetdeploy-$(date -u +%Y%m%dT%H%M%SZ)"
cp "$CFG" "$BACKUP"
export WANTED_B64
python3 - "$CFG" <<'PY'
import base64, json, os, subprocess, sys
path = sys.argv[1]
wanted = set(json.loads(base64.b64decode(os.environ["WANTED_B64"])))
cfg = json.load(open(path))
targets = [i for i in cfg.get("inbounds", [])
           if (i.get("streamSettings") or {}).get("security") == "reality"]
if not targets:
    print("    no Reality inbound"); raise SystemExit(1)
t = targets[0]
clients = ((t.get("settings") or {}).get("clients")) or []
have = {c.get("id") for c in clients}
if have == wanted:
    print("    clients already match")
    raise SystemExit(0)
flow = next((c.get("flow") for c in clients if c.get("flow")), "xtls-rprx-vision")
t["settings"]["clients"] = [{"id": u, "email": u[:8], "flow": flow} for u in sorted(wanted)]
json.dump(cfg, open(path, "w"), ensure_ascii=False, indent=2)
print(f"    clients {len(have)} -> {len(wanted)}")
PY
XRAY_LOCATION_ASSET=/etc/vpn-panel/xray-geo /usr/local/bin/xray run -test -c "$CFG" >/dev/null 2>&1 \
  || { cp "$BACKUP" "$CFG"; echo "    xray -test failed, rolled back"; exit 1; }
systemctl restart xray.service
sleep 3
systemctl is-active xray.service >/dev/null || { cp "$BACKUP" "$CFG"; systemctl restart xray.service; echo "    xray down, rolled back"; exit 1; }
echo "    deployed + xray active"
REMOTE
}

# ── step 3: verify ─────────────────────────────────────────────────────────
verify_host() {
  local alias="$1" spec="$2" cfgpath="$3"
  echo "  [verify] $alias"
  host_ssh "$alias" "$spec" "bash -s -- '$cfgpath' '$REALITY_PORT'" <<'REMOTE'
set -uo pipefail
CFG="$1"; PORT="$2"
XRAY_LOCATION_ASSET=/etc/vpn-panel/xray-geo /usr/local/bin/xray run -test -c "$CFG" >/dev/null 2>&1 \
  && echo "    xray -test: valid" || echo "    xray -test: INVALID"
systemctl is-active xray.service >/dev/null 2>&1 \
  && echo "    xray: active" || echo "    xray: DOWN"
ss -lnt 2>/dev/null | grep -q ":${PORT} " \
  && echo "    reality :${PORT} listening" || echo "    reality :${PORT} MISSING"
ss -lnu 2>/dev/null | grep -q ":24443 " \
  && echo "    hysteria2 :24443/udp listening" || echo "    hysteria2 MISSING"
if command -v nginx >/dev/null 2>&1; then
  ss -lnt 2>/dev/null | grep -q ":443 " \
    && echo "    nginx :443 owning" || echo "    nginx :443 MISSING"
fi
python3 - "$CFG" <<'PY'
import json, sys
cfg = json.load(open(sys.argv[1]))
for i in cfg.get("inbounds", []):
    st = i.get("streamSettings") or {}
    if st.get("security") == "reality":
        cl = ((i.get("settings") or {}).get("clients")) or []
        print(f"    reality clients: {len(cl)} (listen={i.get('listen','0.0.0.0')})")
PY
REMOTE
}

# ── main ───────────────────────────────────────────────────────────────────
mapfile -t ALIASES < <(python3 -c "
import json
f = json.load(open('deploy/vpn-fleet.json'))
names = [k for k in f if not k.startswith('_')]
print('\n'.join([n for n in names if not '$HOST' or n == '$HOST']))
")

echo "fleet targets: ${ALIASES[*]}"
echo "mode: $([ "$APPLY" = 1 ] && echo apply || ([ "$VERIFY_ONLY" = 1 ] && echo verify-only || echo report))"
echo

FAIL=0
for alias in "${ALIASES[@]}"; do
  spec=$(python3 -c "import json;print(json.load(open('deploy/vpn-fleet.json'))['$alias']['ssh'])")
  cfgpath=$(python3 -c "import json;print(json.load(open('deploy/vpn-fleet.json'))['$alias']['xrayConfigPath'])")
  echo "===== $alias ====="
  if [ "$APPLY" = 1 ]; then
    configure_host "$alias" "$spec" "$cfgpath" \
      || { red "  CONFIGURE FAILED"; FAIL=1; }
    deploy_clients "$alias" "$spec" "$cfgpath" \
      || { red "  DEPLOY FAILED"; FAIL=1; }
  fi
  verify_host "$alias" "$spec" "$cfgpath" \
    || { red "  VERIFY FAILED"; FAIL=1; }
  echo
done

echo "============================================================"
if [ "$FAIL" = 0 ]; then
  green "fleet deploy/verify: OK"
else
  red "fleet deploy/verify: FAILURES PRESENT — see the lines above"
fi
exit "$FAIL"
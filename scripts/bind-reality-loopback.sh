#!/bin/bash
# Bind a node's Reality inbound to loopback.
#
# Usage: bash bind-reality-loopback.sh <xray-config-path>
#
# nginx already owns public 443 and routes the mask SNI to 127.0.0.1:23443,
# so a Reality inbound listening on 0.0.0.0 is a second entry point that adds
# exposure without adding reachability (DPI blocks every port but 443).
set -uo pipefail

CFG="${1:?usage: bind-reality-loopback.sh <xray-config-path>}"
REALITY_PORT="${2:-23443}"

BACKUP="${CFG}.preloopback-$(date -u +%Y%m%dT%H%M%SZ)"
cp "$CFG" "$BACKUP"
echo "backup: $BACKUP"

rollback() {
  echo "!!! ROLLBACK !!!"
  cp "$BACKUP" "$CFG"
  systemctl restart xray.service
  sleep 2
  ss -lntp 2>/dev/null | grep ":$REALITY_PORT " | sed 's/^/  restored: /'
  exit 1
}
trap rollback ERR

python3 - "$CFG" "$REALITY_PORT" <<'PY'
import json, sys
path, port = sys.argv[1], int(sys.argv[2])
cfg = json.load(open(path))
n = 0
for i in cfg.get("inbounds", []):
    st = i.get("streamSettings") or {}
    if st.get("security") == "reality" and i.get("port") == port:
        if i.get("listen", "0.0.0.0") != "127.0.0.1":
            i["listen"] = "127.0.0.1"
            n += 1
json.dump(cfg, open(path, "w"), ensure_ascii=False, indent=2)
print(f"rebound {n} Reality inbound(s) on :{port} to 127.0.0.1")
PY

XRAY_LOCATION_ASSET=/etc/vpn-panel/xray-geo /usr/local/bin/xray run -test -c "$CFG" >/dev/null 2>&1 \
  || { echo "xray -test FAILED"; rollback; }
echo "xray -test: valid"

systemctl restart xray.service
sleep 3
systemctl is-active xray.service >/dev/null || { echo "xray not active"; rollback; }

ss -lntp 2>/dev/null | grep ":$REALITY_PORT " | sed 's/^/  now: /'
trap - ERR
echo "DONE — Reality on :$REALITY_PORT is loopback-only"
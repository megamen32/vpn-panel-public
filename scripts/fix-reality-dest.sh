#!/bin/bash
# Point the Germany Reality inbound's `dest` at a live camouflage backend.
#
# Found on 2026-10-09: DE's Reality inbound declares dest=127.0.0.1:8443, but
# nothing listens there — nginx is on 8444. An unauthenticated probe therefore
# gets a connection failure instead of a real-looking site, which is itself a
# signal, and no client fingerprint reaches the endpoint at all.
set -uo pipefail
CFG=/usr/local/etc/xray/config.json
OLD=127.0.0.1:8443
NEW=127.0.0.1:8444

BACKUP="${CFG}.destfix-$(date -u +%Y%m%dT%H%M%SZ)"
cp "$CFG" "$BACKUP"
echo "backup: $BACKUP"

python3 - "$CFG" "$OLD" "$NEW" <<'PY'
import json, sys
path, old, new = sys.argv[1], sys.argv[2], sys.argv[3]
cfg = json.load(open(path))
n = 0
for i in cfg.get("inbounds", []):
    st = i.get("streamSettings") or {}
    rs = st.get("realitySettings") or {}
    if st.get("security") == "reality" and (rs.get("dest") or rs.get("target")) == old:
        if "dest" in rs:
            rs["dest"] = new
        else:
            rs["target"] = new
        n += 1
json.dump(cfg, open(path, "w"), ensure_ascii=False, indent=2)
print(f"dest rewritten on {n} Reality inbound(s): {old} -> {new}")
PY

XRAY_LOCATION_ASSET=/etc/vpn-panel/xray-geo /usr/local/bin/xray run -test -c "$CFG" >/dev/null 2>&1 \
  || { echo "xray -test FAILED, rolling back"; cp "$BACKUP" "$CFG"; exit 1; }
systemctl restart xray.service
sleep 3
systemctl is-active xray.service >/dev/null || { echo "xray down, rolling back"; cp "$BACKUP" "$CFG"; systemctl restart xray.service; exit 1; }
ss -lnt 2>/dev/null | grep ":23443 " | sed 's/^/  /'
echo "DONE"
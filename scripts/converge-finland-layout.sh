#!/bin/bash
# Migrate the Finland node onto the fleet-canonical shape:
#   nginx owns public 443 and rotates by SNI to a loopback Reality port.
#
# Why: DPI blocks every public port except 443, so the only externally
# reachable surface is 443. Keeping Reality on a public bind adds a second
# entry point that is blocked anyway, so it is exposure without redundancy.
# Redundancy comes from several SNI names on the one 443 plus the separate
# Reality / WS / gRPC / XHTTP / Hysteria2 transports.
#
# SAFETY: server-100's relay reaches this host at 31.76.43.193:443 with SNI
# www.google.com (outbound `to-fi-reality`). That is the live Finnish exit,
# so this script cuts over only after nginx's config validates, and restores
# the previous state on any failure.
set -uo pipefail

REALITY_NEW_PORT=23443
REALITY_NEW_BIND=127.0.0.1
REALITY_MASKS="www.google.com google.com"
XRAY_CFG=/etc/xray/config.json
NGINX_STREAM=/etc/nginx/nginx.conf
BACKUP_DIR=/root/fi-converge-backup
STAMP=$(date -u +%Y%m%dT%H%M%SZ)

mkdir -p "$BACKUP_DIR"
cp "$XRAY_CFG" "$BACKUP_DIR/xray-$STAMP.json"
[ -f "$NGINX_STREAM" ] && cp "$NGINX_STREAM" "$BACKUP_DIR/nginx-$STAMP.conf"
echo "backup dir: $BACKUP_DIR (stamp $STAMP)"

rollback() {
  echo "!!! ROLLBACK !!!"
  cp "$BACKUP_DIR/xray-$STAMP.json" "$XRAY_CFG"
  systemctl restart xray.service
  systemctl stop nginx 2>/dev/null
  echo "xray Reality restored to 0.0.0.0:443; nginx stopped"
  exit 1
}
trap rollback ERR

echo "=== 1/5 install nginx + stream module ==="
# Ubuntu's nginx is built without ngx_stream_module, so `stream {}` is an
# unknown directive until libnginx-mod-stream is installed. Installing only
# nginx and then writing the router fails with a confusing emerg.
#
# Probe for the actual module file, not for "with-stream" in nginx -V:
# Ubuntu's build always advertises --with-stream_ssl_module, so a substring
# grep is a false positive and silently skips the install.
if ! command -v nginx >/dev/null 2>&1; then
  DEBIAN_FRONTEND=noninteractive apt-get install -y -qq nginx >/dev/null 2>&1 \
    || { echo "apt install nginx failed"; exit 1; }
fi
if ! ls /usr/lib/nginx/modules/*stream* >/dev/null 2>&1; then
  DEBIAN_FRONTEND=noninteractive apt-get install -y -qq libnginx-mod-stream >/dev/null 2>&1 \
    || { echo "apt install libnginx-mod-stream failed"; exit 1; }
  nginx -t >/dev/null 2>&1 || true   # reload the module set after install
fi
nginx -v 2>&1
ls /usr/lib/nginx/modules/ 2>/dev/null | sed 's/^/  module: /'
ls /etc/nginx/modules-enabled/ 2>/dev/null | sed 's/^/  enabled: /'

echo "=== 2/5 write nginx stream SNI router ==="
# stream{} lives in the main context of nginx.conf, http{} is provided by
# /etc/nginx/nginx.conf on install; keep them in the same file so there is a
# single include chain to reason about.
python3 - <<'PY'
import re
path = "/etc/nginx/nginx.conf"
conf = open(path).read()
# drop any previously generated block so the script is idempotent
conf = re.sub(r"\n# BEGIN fleet-smart-edge\n.*?# END fleet-smart-edge\n", "\n", conf, flags=re.S)
conf = re.sub(r"^\s*stream\s*\{.*?\}\s*$", "", conf, flags=re.S | re.M)
masks = "www.google.com google.com".split()
block = [
    "",
    "# BEGIN fleet-smart-edge",
    "# Managed by vpn-panel fleet-converge: public 443 -> loopback Reality.",
    "# DPI blocks every public port except 443, so 443 is the only externally",
    "# reachable surface and nginx must own it and rotate by SNI.",
    "stream {",
    "    map $ssl_preread_server_name $fleet_backend {",
    "        hostnames;",
]
for i, m in enumerate(masks):
    block.append(f"        {m:<24} reality_{i};")
block += [
    "        default                     drop;",
    "    }",
]
for i in range(len(masks)):
    block.append(f"    upstream reality_{i} {{ server 127.0.0.1:23443; }}")
block += [
    "    server {",
    "        listen 443;",
    "        proxy_pass $fleet_backend;",
    "        ssl_preread on;",
    "        proxy_timeout 600s;",
    "        proxy_connect_timeout 5s;",
    "    }",
    "}",
    "# END fleet-smart-edge",
    "",
]
open(path, "w").write(conf.rstrip() + "\n" + "\n".join(block))
print("nginx.conf written")
PY

echo "=== 3/5 move Reality to loopback ==="
python3 - <<'PY'
import json
p = "/etc/xray/config.json"
cfg = json.load(open(p))
changed = []
for i in cfg.get("inbounds", []):
    st = i.get("streamSettings") or {}
    if st.get("security") == "reality" and i.get("port") == 443:
        i["port"] = 23443
        i["listen"] = "127.0.0.1"
        changed.append(i.get("port"))
json.dump(cfg, open(p, "w"), ensure_ascii=False, indent=2)
print("reality inbounds moved to loopback:23443 ->", changed)
PY

XRAY_LOCATION_ASSET=/etc/vpn-panel/xray-geo /usr/local/bin/xray run -test -c "$XRAY_CFG" >/dev/null 2>&1 \
  || { echo "xray -test FAILED"; rollback; }
echo "xray -test: valid"

echo "=== 4/5 validate nginx, then start ==="
nginx -t || { echo "nginx -t FAILED"; rollback; }

systemctl restart xray.service
sleep 2
systemctl is-active xray.service >/dev/null || { echo "xray not active"; rollback; }

# 443 must be free before nginx can bind it
if ss -lnt 2>/dev/null | grep -q ":443 "; then
  echo "port 443 still held after xray restart"; ss -lntp | grep ":443 " | head -3
  rollback
fi
echo "port 443 released by xray"

systemctl enable nginx >/dev/null 2>&1
systemctl restart nginx || { echo "nginx failed to start"; rollback; }
sleep 2
systemctl is-active nginx >/dev/null || { echo "nginx not active"; rollback; }

echo "=== 5/5 verify local wiring ==="
ss -lnt 2>/dev/null | grep -E ":443 |:23443 " | sed 's/^/  /'
systemctl is-active xray.service nginx | sed 's/^/  active: /'

trap - ERR
echo "DONE — Finland now matches the fleet-canonical shape"
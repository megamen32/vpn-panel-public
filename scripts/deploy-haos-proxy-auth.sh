#!/usr/bin/env bash

set -Eeuo pipefail

haos_target="${HAOS_SMART_EDGE_HOST:-root@192.168.2.101}"
haos_port="${HAOS_SMART_EDGE_PORT:-2228}"
addon_slug=27579e22_bezrabotnyi_transparent_smart_edge
container_name=app_27579e22_bezrabotnyi_transparent_smart_edge
proxy_username="${VPN_PANEL_PROXY_USERNAME:-roomhacker}"
stamp="$(date -u +%Y%m%d_%H%M%S)"

[[ "$proxy_username" =~ ^[A-Za-z0-9._-]{1,128}$ ]] || { printf 'invalid proxy username\n' >&2; exit 2; }

payload="$(mktemp)"
chmod 0600 "$payload"
trap 'rm -f "$payload"' EXIT INT TERM

python3 -c '
import json
import sys

username = sys.argv[1]
password = sys.stdin.buffer.read()
if password.endswith(b"\n"):
    password = password[:-1]
if password.endswith(b"\r"):
    password = password[:-1]
if not password:
    raise SystemExit("empty proxy password")
try:
    password_text = password.decode("utf-8")
except UnicodeDecodeError as exc:
    raise SystemExit("proxy password must be UTF-8") from exc
print(json.dumps({"users": [{"username": username, "password": password_text}]}))
' "$proxy_username" >"$payload"
test -s "$payload"

cat "$payload" | ssh -o BatchMode=yes -o ConnectTimeout=10 -p "$haos_port" "$haos_target" "docker exec -i '$container_name' sh -eu -c '
umask 077
candidate=/data/proxy-users.json.candidate.$stamp
backup=/data/deploy-backups/proxy-auth-$stamp
cat >"\$candidate"
if ! jq -e \"(.users | type == \\\"array\\\") and (.users | length == 1) and all(.users[]; (.username | type == \\\"string\\\" and length > 0) and (.password | type == \\\"string\\\" and length > 0))\" "\$candidate" >/dev/null; then
  rm -f "\$candidate"
  exit 2
fi
if [ -e /data/proxy-users.json ]; then
  install -d -m 0700 "\$backup"
  cp -a /data/proxy-users.json "\$backup/proxy-users.json"
fi
chmod 0600 "\$candidate"
mv -f "\$candidate" /data/proxy-users.json
'"

ssh -o BatchMode=yes -o ConnectTimeout=10 -p "$haos_port" "$haos_target" "ha apps restart '$addon_slug' >/dev/null && docker exec '$container_name' /usr/bin/healthcheck.sh >/dev/null"
printf 'HAOS proxy authentication installed and verified.\n'

#!/usr/bin/env bash
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
TARGET="${TARGET:-roomhacker@192.168.2.5}"
ssh "$TARGET" 'sudo install -d -o roomhacker -g roomhacker -m 0755 /opt/smart-dns /opt/smart-dns/certs'
scp "$ROOT/infra/smart-dns/server.js" "$TARGET:/tmp/smart-dns-server.js"
scp "$ROOT/infra/smart-dns/config.example.json" "$TARGET:/tmp/smart-dns-config.example.json"
scp "$ROOT/infra/smart-dns/smart-dns.service" "$TARGET:/tmp/smart-dns.service"
ssh "$TARGET" '
  set -euo pipefail
  sudo install -o roomhacker -g roomhacker -m 0755 /tmp/smart-dns-server.js /opt/smart-dns/server.js
  if [ ! -f /opt/smart-dns/config.json ]; then
    sudo install -o roomhacker -g roomhacker -m 0640 /tmp/smart-dns-config.example.json /opt/smart-dns/config.json
    echo "Installed example config; replace client id before public exposure." >&2
  fi
  sudo install -o root -g root -m 0644 /tmp/smart-dns.service /etc/systemd/system/smart-dns.service
  sudo systemctl daemon-reload
  sudo systemctl enable --now smart-dns.service
  sudo systemctl status smart-dns.service --no-pager -n 20
'

#!/usr/bin/env bash
set -euo pipefail

cert_source="/etc/letsencrypt/live/dns.bezrabotnyi.com"
cert_target="/opt/smart-dns/certs"

install -d -m 0750 -o root -g roomhacker "$cert_target"
install -m 0644 -o root -g roomhacker "$cert_source/fullchain.pem" "$cert_target/fullchain.pem"
install -m 0640 -o root -g roomhacker "$cert_source/privkey.pem" "$cert_target/privkey.pem"

if systemctl is-enabled smart-dns.service >/dev/null 2>&1; then
  systemctl restart smart-dns.service
fi

#!/usr/bin/env bash
set -euo pipefail

if [[ "${ALLOW_LEGACY_SERVER100_SMARTDNS_ROLLBACK:-0}" != 1 ]]; then
  echo "This coupled server-100 LAN SmartDNS deploy is retired." >&2
  echo "Use scripts/deploy-haos-transparent-smart-edge.sh; set ALLOW_LEGACY_SERVER100_SMARTDNS_ROLLBACK=1 only for an explicit rollback." >&2
  exit 2
fi

script_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
panel_dir="$(cd "$script_dir/.." && pwd)"
source_host="${SMART_DNS_SOURCE_HOST:-roomhacker@192.168.2.5}"
source_config="${SMART_DNS_SOURCE_CONFIG:-}"
lan_smart_edge_ip="${LAN_SMART_EDGE_IP:-192.168.2.1}"
policy_file="${VPN_PANEL_SMART_DNS_POLICY:-/etc/vpn-panel/smart-dns-policy.json}"
dry_run=false

if [[ "${1:-}" == "--dry-run" ]]; then
  dry_run=true
fi

mkdir -p "$panel_dir/.tmp"
work_dir="$(mktemp -d "$panel_dir/.tmp/smartdns-deploy.XXXXXX")"
cleanup() {
  rm -rf "$work_dir"
}
trap cleanup EXIT

echo "Building unified SmartDNS..."
mkdir -p "$panel_dir/.tmp/go"
(cd "$panel_dir/scripts/smartdns-go" && GOTMPDIR="$panel_dir/.tmp/go" go test ./... && GOTMPDIR="$panel_dir/.tmp/go" CGO_ENABLED=0 go build -trimpath -ldflags '-s -w' -o "$work_dir/smartdns" .)

if [[ -n "$source_config" ]]; then
  cp "$source_config" "$work_dir/source-config.json"
elif [[ -r /opt/smart-dns/config.json ]]; then
  # After the first cutover, server-100 is canonical. Falling back to the
  # retired server-44 config would silently revert later Smart Edge changes.
  cp /opt/smart-dns/config.json "$work_dir/source-config.json"
else
  scp -q -o BatchMode=yes -o ConnectTimeout=5 "$source_host:/opt/smart-dns/config.json" "$work_dir/source-config.json"
fi
chmod 0600 "$work_dir/source-config.json"
if [[ ! -r "$policy_file" ]]; then
  echo "ERROR: unified routing policy is not readable: $policy_file" >&2
  exit 1
fi

jq --slurpfile policy "$policy_file" --arg lan_smart_edge_ip "$lan_smart_edge_ip" '
  (.edgeProfiles.public // .smartEdge) as $public
  | if $public == null then error("missing public Smart Edge config") else . end
  | .dohListen = {host:"127.0.0.1", port:8053, profile:"public"}
  | .dotListen = {host:"127.0.0.1", port:8853, profile:"public"}
  | .udpListen = {host:"192.168.2.100", port:53, profile:"local"}
  | .publicDnsListen = {host:"192.168.2.100", port:5354, profile:"public"}
  | del(.staticA["bezrabotny.com"])
  | .staticA["bezrabotnyi.com"] = ["95.165.165.65"]
  | .staticA["vpn2.bezrabotnyi.com"] = ["212.192.31.128"]
  | .staticA["vusa.bezrabotnyi.com"] = ["185.240.120.152"]
  | .staticASuffix["bezrabotnyi.com"] = ["95.165.165.65"]
  | .staticAExclude = ["vpn2.bezrabotnyi.com", "vusa.bezrabotnyi.com"]
  | .tls = {certFile:"/opt/smart-dns/certs/fullchain.pem", keyFile:"/opt/smart-dns/certs/privkey.pem"}
  | .httpProxy.host = $lan_smart_edge_ip
  | .httpProxy.port = 3128
  | .sync.url = "http://127.0.0.1:30129/api/internal/smart-dns/clients"
  | .localDefaultRoute = "direct"
  | .rules = $policy[0].rules
  | del(.directDomains, .directSuffixes, .proxyDomains, .proxySuffixes, .localProxyDomains, .localProxySuffixes, .vusaProxyDomains, .vusaProxySuffixes, .hardDirectDomains, .hardDirectSuffixes)
  | .edgeProfiles = {
      public:$public,
      vusa:{enabled:true, ipv4:"185.240.120.152", ipv4s:["185.240.120.152"], ttl:60},
      local:{enabled:true, ipv4:$lan_smart_edge_ip, ipv4s:[$lan_smart_edge_ip], ttl:60}
    }
  | del(.smartEdge)
' "$work_dir/source-config.json" > "$work_dir/config.json"

jq -e --arg lan_smart_edge_ip "$lan_smart_edge_ip" '
  .dohListen.profile == "public"
  and .dotListen.profile == "public"
  and .udpListen.profile == "local"
  and .udpListen.host == "192.168.2.100"
  and .publicDnsListen.profile == "public"
  and .publicDnsListen.host == "192.168.2.100"
  and .publicDnsListen.port == 5354
  and (.staticA["bezrabotny.com"] == null)
  and .staticA["bezrabotnyi.com"] == ["95.165.165.65"]
  and .staticA["vpn2.bezrabotnyi.com"] == ["212.192.31.128"]
  and .staticA["vusa.bezrabotnyi.com"] == ["185.240.120.152"]
  and .staticASuffix["bezrabotnyi.com"] == ["95.165.165.65"]
  and .staticAExclude == ["vpn2.bezrabotnyi.com", "vusa.bezrabotnyi.com"]
  and .edgeProfiles.local.ipv4 == $lan_smart_edge_ip
  and .edgeProfiles.vusa.ipv4 == "185.240.120.152"
  and (.sync.token | type == "string" and length > 0)
  and (.rules | type == "array")
  and (all(.rules[]; (.id | type == "string") and (.text | type == "string") and (.match == "exact" or .match == "suffix" or .match == "set") and (.through | type == "array") and (.conditions | type == "array")))
' "$work_dir/config.json" >/dev/null
sed "s|ExecStart=/usr/local/bin/smartdns|ExecStart=$work_dir/smartdns|" \
  "$panel_dir/scripts/smartdns-go/smart-dns.service" > "$work_dir/smart-dns.service"
if ! systemd-analyze verify "$work_dir/smart-dns.service" 2>"$work_dir/systemd-verify.log"; then
  # systemd-analyze loads every local unit and can fail on an unrelated broken
  # service. Only diagnostics for the unit being deployed should block this run.
  if grep -E '(^|/)smart-dns\.service:' "$work_dir/systemd-verify.log" >&2; then
    exit 1
  fi
fi

if $dry_run; then
  echo "Dry-run OK: binary, config migration and systemd unit validated."
  exit 0
fi

timestamp="$(date -u +%Y%m%d_%H%M%S)"
echo "Backing up current server-100 SmartDNS state with suffix $timestamp..."
sudo test ! -e /usr/local/bin/smartdns || sudo cp -a /usr/local/bin/smartdns "/usr/local/bin/smartdns.bak_$timestamp"
sudo test ! -e /opt/smart-dns/config.json || sudo cp -a /opt/smart-dns/config.json "/opt/smart-dns/config.json.bak_$timestamp"
sudo test ! -e /etc/systemd/system/smart-dns.service || sudo cp -a /etc/systemd/system/smart-dns.service "/etc/systemd/system/smart-dns.service.bak_$timestamp"

sudo install -d -m 0750 -o root -g roomhacker /opt/smart-dns
sudo install -m 0755 -o root -g root "$work_dir/smartdns" /usr/local/bin/smartdns
sudo install -m 0640 -o root -g roomhacker "$work_dir/config.json" /opt/smart-dns/config.json
sudo install -m 0644 -o root -g root "$panel_dir/scripts/smartdns-go/smart-dns.service" /etc/systemd/system/smart-dns.service
sudo install -m 0755 -o root -g root "$panel_dir/scripts/smartdns-go/renew-certs.sh" /etc/letsencrypt/renewal-hooks/deploy/vpn-panel-smartdns
if command -v ufw >/dev/null 2>&1 && sudo ufw status | grep -q 'активен\|active'; then
  sudo install -d -m 0700 -o root -g root /etc/ufw/backups
  sudo cp -a /etc/ufw/user.rules "/etc/ufw/backups/user.rules.bak_$timestamp"
  sudo cp -a /etc/ufw/user6.rules "/etc/ufw/backups/user6.rules.bak_$timestamp"
  sudo ufw allow from 192.168.2.0/24 to 192.168.2.100 port 53 proto udp comment 'SmartDNS LAN UDP'
  sudo ufw allow from 192.168.2.0/24 to 192.168.2.100 port 53 proto tcp comment 'SmartDNS LAN TCP'
  sudo ufw allow to 192.168.2.100 port 5354 proto udp comment 'SmartDNS Public UDP'
  sudo ufw allow to 192.168.2.100 port 5354 proto tcp comment 'SmartDNS Public TCP'
fi
sudo systemctl daemon-reload
sudo "$panel_dir/scripts/smartdns-go/renew-certs.sh"
sudo systemctl enable --now smart-dns.service

sleep 2
systemctl is-active --quiet smart-dns.service
dig @192.168.2.100 instagram.com A +short +time=3 +tries=1 | grep -Fx "$lan_smart_edge_ip" >/dev/null
dig @192.168.2.100 chatgpt.com A +short +time=3 +tries=1 | grep -Fx "$lan_smart_edge_ip" >/dev/null
if dig @192.168.2.100 ya.ru A +short +time=3 +tries=1 | grep -Fx "$lan_smart_edge_ip" >/dev/null; then
  echo "ERROR: direct domain ya.ru was synthesized to the LAN edge" >&2
  exit 1
fi
dig @192.168.2.100 -p 5354 bezrabotnyi.com A +short +time=3 +tries=1 | grep -Fx '95.165.165.65' >/dev/null
dig @192.168.2.100 -p 5354 wildcard-canary.bezrabotnyi.com A +tcp +short +time=3 +tries=1 | grep -Fx '95.165.165.65' >/dev/null
dig @192.168.2.100 -p 5354 vpn2.bezrabotnyi.com A +short +time=3 +tries=1 | grep -Fx '212.192.31.128' >/dev/null
dig @192.168.2.100 -p 5354 vusa.bezrabotnyi.com A +short +time=3 +tries=1 | grep -Fx '185.240.120.152' >/dev/null

echo "Unified SmartDNS is active on server-100."
echo "Rollback assets use suffix: $timestamp"
echo "Rollback command: sudo cp -a /usr/local/bin/smartdns.bak_$timestamp /usr/local/bin/smartdns && sudo cp -a /opt/smart-dns/config.json.bak_$timestamp /opt/smart-dns/config.json && sudo cp -a /etc/systemd/system/smart-dns.service.bak_$timestamp /etc/systemd/system/smart-dns.service && sudo systemctl daemon-reload && sudo systemctl restart smart-dns.service"

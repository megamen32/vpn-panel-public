#!/usr/bin/env bash
set -euo pipefail

script_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
panel_dir="$(cd "$script_dir/.." && pwd)"
remote="${SERVER88_SSH:-roomhacker@192.168.2.75}"
dry_run=false
if [[ "${1:-}" == "--dry-run" ]]; then
  dry_run=true
elif [[ -n "${1:-}" ]]; then
  echo "usage: $0 [--dry-run]" >&2
  exit 2
fi

config="$panel_dir/deploy/server-88/dnsmasq/lan-dns-compat.conf"
service="$panel_dir/deploy/server-88/systemd/lan-dns-compat.service"
retire_service="$panel_dir/deploy/server-88/systemd/lan-dns-compat-retire.service"
retire_timer="$panel_dir/deploy/server-88/systemd/lan-dns-compat-retire.timer"

grep -Fqx 'server=192.168.2.1' "$config"
if grep -Eq '^(address|local)=' "$config"; then
  echo "compatibility forwarder must not contain routing policy" >&2
  exit 1
fi
verify_log="$(mktemp)"
if ! systemd-analyze verify "$service" "$retire_service" "$retire_timer" 2>"$verify_log"; then
  if grep -E '(^|/)lan-dns-compat[^:]*:' "$verify_log" >&2; then
    rm -f "$verify_log"
    exit 1
  fi
fi
rm -f "$verify_log"

scp -q -o BatchMode=yes -o ConnectTimeout=5 "$config" "$remote:/tmp/lan-dns-compat.conf"
scp -q -o BatchMode=yes -o ConnectTimeout=5 "$service" "$remote:/tmp/lan-dns-compat.service"
scp -q -o BatchMode=yes -o ConnectTimeout=5 "$retire_service" "$remote:/tmp/lan-dns-compat-retire.service"
scp -q -o BatchMode=yes -o ConnectTimeout=5 "$retire_timer" "$remote:/tmp/lan-dns-compat-retire.timer"
ssh -o BatchMode=yes -o ConnectTimeout=5 "$remote" \
  "sudo /usr/sbin/dnsmasq --test --conf-file=/tmp/lan-dns-compat.conf"

if $dry_run; then
  ssh -o BatchMode=yes -o ConnectTimeout=5 "$remote" \
    "rm -f /tmp/lan-dns-compat.conf /tmp/lan-dns-compat.service /tmp/lan-dns-compat-retire.service /tmp/lan-dns-compat-retire.timer"
  echo "Dry-run OK: server-88 compatibility forwarder is policy-free and valid."
  exit 0
fi

timestamp="$(date -u +%Y%m%d_%H%M%S)"
ssh -o BatchMode=yes -o ConnectTimeout=5 "$remote" "sudo bash -s -- '$timestamp'" <<'REMOTE'
set -euo pipefail
timestamp="$1"
conf=/etc/vpn-panel/lan-dns-compat.conf
unit=/etc/systemd/system/lan-dns-compat.service
retire_service=/etc/systemd/system/lan-dns-compat-retire.service
retire_timer=/etc/systemd/system/lan-dns-compat-retire.timer
had_conf=0
had_unit=0
had_retire_service=0
had_retire_timer=0
old_active=0
systemctl is-active --quiet lan-dns-compat.service && old_active=1 || true

backup_if_present() {
  target="$1"
  if [[ -e "$target" ]]; then
    cp -a "$target" "${target}.bak_${timestamp}"
    return 0
  fi
  return 1
}

backup_if_present "$conf" && had_conf=1 || true
backup_if_present "$unit" && had_unit=1 || true
backup_if_present "$retire_service" && had_retire_service=1 || true
backup_if_present "$retire_timer" && had_retire_timer=1 || true

rollback() {
  set +e
  systemctl disable --now lan-dns-compat-retire.timer lan-dns-compat.service >/dev/null 2>&1
  for spec in "$conf:$had_conf" "$unit:$had_unit" "$retire_service:$had_retire_service" "$retire_timer:$had_retire_timer"; do
    target="${spec%:*}"
    had="${spec##*:}"
    if [[ "$had" == 1 ]]; then cp -a "${target}.bak_${timestamp}" "$target"; else rm -f "$target"; fi
  done
  # An inactive pre-existing persistent unit cannot serve stale leases. Remove
  # it so the known-good emergency transient forwarder can reclaim the name.
  if [[ "$old_active" == 0 ]]; then rm -f "$unit"; fi
  systemctl daemon-reload
  if [[ "$had_unit" == 1 && "$old_active" == 1 ]]; then
    systemctl enable --now lan-dns-compat.service >/dev/null 2>&1
  else
    systemd-run --unit=lan-dns-compat.service \
      --property=Restart=on-failure --property=RestartSec=2s \
      /usr/sbin/dnsmasq --keep-in-foreground --port=53 --listen-address=192.168.2.75 \
      --bind-interfaces --no-resolv --no-hosts --server=192.168.2.100 --cache-size=0 >/dev/null
  fi
  echo "server-88 DNS compatibility rollback restored at suffix $timestamp" >&2
}
trap rollback ERR

install -d -m 0755 -o root -g root /etc/vpn-panel
install -m 0644 -o root -g root /tmp/lan-dns-compat.conf "$conf"
install -m 0644 -o root -g root /tmp/lan-dns-compat.service "$unit"
install -m 0644 -o root -g root /tmp/lan-dns-compat-retire.service "$retire_service"
install -m 0644 -o root -g root /tmp/lan-dns-compat-retire.timer "$retire_timer"
rm -f /tmp/lan-dns-compat.conf /tmp/lan-dns-compat.service /tmp/lan-dns-compat-retire.service /tmp/lan-dns-compat-retire.timer

# Replace the emergency transient unit with the durable source-controlled unit.
systemctl stop lan-dns-compat.service || true
systemctl reset-failed lan-dns-compat.service || true
systemctl daemon-reload
systemctl enable --now lan-dns-compat.service lan-dns-compat-retire.timer
systemctl is-active --quiet lan-dns-compat.service
systemctl is-active --quiet lan-dns-compat-retire.timer
trap - ERR
smoke_ok=0
for _attempt in {1..10}; do
  instagram_answer="$(dig @192.168.2.75 instagram.com A +short +time=1 +tries=1 | sort -u)" || true
  chatgpt_answer="$(dig @192.168.2.75 chatgpt.com A +short +time=1 +tries=1 | sort -u)" || true
  direct_answer="$(dig @192.168.2.75 ya.ru A +short +time=1 +tries=1 | sort)" || true
  if [[ "$instagram_answer" == "192.168.2.75" && "$chatgpt_answer" == "192.168.2.75" &&
        -n "$direct_answer" && "$direct_answer" != "192.168.2.75" ]]; then
    smoke_ok=1
    break
  fi
  sleep 1
done
if [[ "$smoke_ok" != 1 ]]; then
  rollback
  exit 1
fi
echo "server-88 compatibility DNS deployed; backup suffix=$timestamp; automatic retirement=48h"
REMOTE

for host in instagram.com chatgpt.com; do
  compat_answer="$(dig @192.168.2.75 "$host" A +short +time=3 +tries=1 | sort -u)"
  [[ "$compat_answer" == "192.168.2.75" ]] || {
    echo "compatibility DNS policy mismatch for $host" >&2
    exit 1
  }
done
direct_answer="$(dig @192.168.2.75 ya.ru A +short +time=3 +tries=1 | sort)"
[[ -n "$direct_answer" && "$direct_answer" != "192.168.2.75" ]]
echo "server-88 DNS compatibility forwarder is active and follows router policy."

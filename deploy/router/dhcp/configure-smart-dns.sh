#!/bin/sh
# Apply generated SmartDNS routing to OpenWrt without keeping a second domain list.

set -u

mode="apply"
if [ "${1:-}" = "--check" ]; then
  mode="check"
  shift
elif [ "${1:-}" = "--repair" ]; then
  mode="repair"
  shift
fi

smart_dns_ip="${1:-192.168.2.100}"
lan_edge_ip="${2:-192.168.2.1}"
rules_file="${3:-/etc/vpn-panel-smart-dns.domains}"
router_dns_ip="${4:-192.168.2.1}"
fallback_dns_ip="${5:-77.88.8.8}"
managed_rules="/etc/vpn-panel-smart-dns.domains"
managed_confdir="/etc/vpn-panel-dnsmasq.d"
managed_config="$managed_confdir/smart-dns.conf"
backup_dir="/etc/vpn-panel-dnsmasq-backups"

# The router keeps the last generated policy, so a supervised canary can
# restore it without needing a control-plane connection or a second domain list.
[ "$mode" != "repair" ] || rules_file="$managed_rules"

validate_rules() {
  [ -s "$rules_file" ] || { echo "SmartDNS rules file is missing or empty: $rules_file" >&2; return 1; }
  count=0
  while IFS= read -r domain || [ -n "$domain" ]; do
    [ -n "$domain" ] || continue
    echo "$domain" | grep -Eq '^[a-z0-9]([a-z0-9._-]*[a-z0-9])?$' || {
      echo "Invalid SmartDNS domain: $domain" >&2
      return 1
    }
    count=$((count + 1))
  done < "$rules_file"
  [ "$count" -gt 0 ] || { echo "SmartDNS rules file has no domains" >&2; return 1; }
  echo "$count"
}

rules_count="$(validate_rules)" || exit 1
if [ "$mode" = "check" ]; then
  echo "SmartDNS candidate OK: rules=$rules_count upstream=$smart_dns_ip fallback=$fallback_dns_ip lan_edge=$lan_edge_ip dhcp_dns=$router_dns_ip"
  exit 0
fi

timestamp="$(date -u +%Y%m%d_%H%M%S)"
backup="/etc/config/dhcp.bak_smartdns_${timestamp}"
managed_backup="${managed_rules}.bak_${timestamp}"
config_backup="$backup_dir/smart-dns.conf.bak_${timestamp}"
had_managed=0
had_config=0
candidate_config=""

cp -a /etc/config/dhcp "$backup" || exit 1
if [ -e "$managed_rules" ]; then
  cp -a "$managed_rules" "$managed_backup" || exit 1
  had_managed=1
fi
mkdir -p "$managed_confdir" "$backup_dir" || exit 1
if [ -e "$managed_config" ]; then
  cp -a "$managed_config" "$config_backup" || exit 1
  had_config=1
fi
# dnsmasq loads every regular file in conf-dir. Older backups in this directory
# were active rules, so move them out before the next restart.
for legacy_backup in "$managed_confdir"/smart-dns.conf.bak_*; do
  [ -e "$legacy_backup" ] || continue
  mv "$legacy_backup" "$backup_dir/" || exit 1
done

rollback() {
  reason="$1"
  [ -z "$candidate_config" ] || rm -f "$candidate_config"
  cp -a "$backup" /etc/config/dhcp
  if [ "$had_managed" -eq 1 ]; then
    cp -a "$managed_backup" "$managed_rules"
  else
    rm -f "$managed_rules"
  fi
  if [ "$had_config" -eq 1 ]; then
    cp -a "$config_backup" "$managed_config"
  else
    rm -f "$managed_config"
  fi
  /etc/init.d/dnsmasq restart >/tmp/dnsmasq-smartdns-rollback.log 2>&1 || true
  echo "SmartDNS rollback: $reason; restored $backup" >&2
  exit 1
}

uci set dhcp.@dnsmasq[0].noresolv='1' || rollback "cannot set noresolv"
uci -q delete dhcp.@dnsmasq[0].server || true
uci add_list "dhcp.@dnsmasq[0].server=$smart_dns_ip" || rollback "cannot set upstream"
uci set "dhcp.@dnsmasq[0].confdir=$managed_confdir" || rollback "cannot set managed confdir"

# Remove only rules from the previous generated set. Preserve OpenWrt's /lan/
# local zone and any unrelated administrator configuration.
if [ -r "$managed_rules" ]; then
  while IFS= read -r domain || [ -n "$domain" ]; do
    [ -n "$domain" ] || continue
    uci -q del_list "dhcp.@dnsmasq[0].address=/$domain/$lan_edge_ip" || true
    uci -q del_list "dhcp.@dnsmasq[0].local=/$domain/" || true
  done < "$managed_rules"
fi

# The router must forward policy domains to HAOS, which synthesizes the private
# LAN edge answer.  Permit only those expected private answers through dnsmasq's
# rebind guard; never preempt HAOS with a second static address/local policy.
candidate_config="${managed_config}.candidate.$$"
: > "$candidate_config" || rollback "cannot create managed dnsmasq candidate"
while IFS= read -r domain || [ -n "$domain" ]; do
  [ -n "$domain" ] || continue
  # These deliberate private answers come from HAOS Smart Edge, not upstream
  # DNS-rebinding. Keep rebind protection on for every other domain.
  printf 'rebind-domain-ok=/%s/\n' "$domain" >> "$candidate_config" || \
    rollback "cannot render dnsmasq rule for $domain"
done < "$rules_file"
/usr/sbin/dnsmasq --test --conf-file="$candidate_config" >/dev/null 2>&1 || rollback "managed dnsmasq candidate is invalid"

# The generated `rebind-domain-ok` lines permit only the intentional private
# answers in the same canonical policy file; keep OpenWrt rebind protection on.
uci -q delete dhcp.@dnsmasq[0].rebind_domain || true

old_dhcp_options="$(uci -q get dhcp.lan.dhcp_option || true)"
uci -q delete dhcp.lan.dhcp_option || true
for option in $old_dhcp_options; do
  case "$option" in
    6,*) ;;
    *) uci add_list "dhcp.lan.dhcp_option=$option" || rollback "cannot preserve DHCP option" ;;
  esac
done
uci add_list "dhcp.lan.dhcp_option=6,$router_dns_ip" || rollback "cannot set DHCP DNS"
uci commit dhcp || rollback "cannot commit DHCP config"
[ "$rules_file" = "$managed_rules" ] || cp "$rules_file" "$managed_rules" || rollback "cannot persist generated rules"
mv "$candidate_config" "$managed_config" || rollback "cannot install managed dnsmasq config"
chmod 0644 "$managed_config" || rollback "cannot set managed dnsmasq permissions"

/etc/init.d/dnsmasq restart >/tmp/dnsmasq-smartdns-restart.log 2>&1 || rollback "dnsmasq restart failed"
sleep 2

runtime_cfg="$(ls /var/etc/dnsmasq.conf.* 2>/dev/null | head -1)"
[ -n "$runtime_cfg" ] || rollback "runtime config is missing"
first_domain="$(head -1 "$rules_file")"
grep -Fqx "server=$smart_dns_ip" "$runtime_cfg" || rollback "runtime upstream is wrong"
grep -Fqx "conf-dir=$managed_confdir" "$runtime_cfg" || rollback "managed confdir is missing"
grep -Fqx "rebind-domain-ok=/$first_domain/" "$managed_config" || rollback "generated rebind exception is missing"
! grep -Fq "address=/$first_domain/" "$managed_config" || rollback "static generated address rule must be absent"
! grep -Fq "local=/$first_domain/" "$managed_config" || rollback "static generated local rule must be absent"
uci -q show dhcp.lan | grep -Fq "6,$router_dns_ip" || rollback "DHCP option 6 is wrong"
pgrep -x dnsmasq >/dev/null || rollback "dnsmasq is not running"

edge_answer="$(nslookup "$first_domain" 127.0.0.1 2>/dev/null)" || rollback "generated rule query failed"
direct_answer="$(nslookup ya.ru 127.0.0.1 2>/dev/null)" || rollback "direct DNS query failed"
echo "$edge_answer" | grep -Fq "Address: $lan_edge_ip" || rollback "generated gateway answer is wrong"
if echo "$direct_answer" | grep -Fq "Address: $lan_edge_ip"; then
  rollback "direct domain ya.ru was overridden"
fi

echo "SmartDNS configured: rules=$rules_count upstream=$smart_dns_ip lan_edge=$lan_edge_ip dhcp_dns=$router_dns_ip backup=$backup"

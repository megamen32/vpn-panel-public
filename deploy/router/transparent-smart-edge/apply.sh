#!/bin/sh
set -eu

mode="${1:---apply}"
haos_ip="${2:-192.168.2.101}"
router_ip="${3:-192.168.2.1}"
lan_cidr="${4:-192.168.2.0/24}"
public_edge_ip="${5:-203.0.113.1}"
backup="${6:-}"

config_dir="${VPN_PANEL_CONFIG_DIR:-/etc/config}"
backup_root="${VPN_PANEL_BACKUP_ROOT:-/root/vpn-panel-transparent-smart-edge/backups}"
initd_dir="${VPN_PANEL_INITD_DIR:-/etc/init.d}"
dnat_section="vpn_panel_transparent_https"
snat_section="vpn_panel_transparent_https_return"
dnat_name="VPN Panel transparent Smart Edge HTTPS"
snat_name="VPN Panel transparent Smart Edge HTTPS return path"
public_dnat_section="vpn_panel_public_smart_edge_https"
public_dnat_name="VPN Panel public Smart Edge HTTPS alias"
proxy_dnat_section="vpn_panel_haos_us_proxy"
proxy_snat_section="vpn_panel_haos_us_proxy_return"
proxy_dnat_name="VPN Panel HAOS US proxy"
proxy_snat_name="VPN Panel HAOS US proxy return path"
de_proxy_dnat_section="vpn_panel_haos_de_proxy"
de_proxy_snat_section="vpn_panel_haos_de_proxy_return"
de_proxy_dnat_name="VPN Panel HAOS DE proxy"
de_proxy_snat_name="VPN Panel HAOS DE proxy return path"
fi_proxy_dnat_section="vpn_panel_haos_fi_proxy"
fi_proxy_snat_section="vpn_panel_haos_fi_proxy_return"
fi_proxy_dnat_name="VPN Panel HAOS Finland proxy"
fi_proxy_snat_name="VPN Panel HAOS Finland proxy return path"
ru_proxy_dnat_section="vpn_panel_haos_ru_proxy"
ru_proxy_snat_section="vpn_panel_haos_ru_proxy_return"
ru_proxy_dnat_name="VPN Panel HAOS Russia proxy"
ru_proxy_snat_name="VPN Panel HAOS Russia proxy return path"
public_us_proxy_section="vpn_panel_public_us_proxy"
public_de_proxy_section="vpn_panel_public_de_proxy"
public_fi_proxy_section="vpn_panel_public_fi_proxy"
public_ru_proxy_section="vpn_panel_public_ru_proxy"
public_us_proxy_port=13127
public_de_proxy_port=13128
public_fi_proxy_port=13129
public_ru_proxy_port=13130
legacy_de_proxy_dnat_section="autoproxy_to_server100"
legacy_de_proxy_snat_section="autoproxy_to_server100_hairpin"
legacy_dns_services="smart-dns-upstream smart-dns-route"

fail() {
  echo "transparent Smart Edge: $*" >&2
  exit 1
}

valid_ipv4() {
  value="$1"
  old_ifs="$IFS"
  IFS=.
  set -- $value
  IFS="$old_ifs"
  [ "$#" -eq 4 ] || return 1
  for octet in "$@"; do
    case "$octet" in
      ''|*[!0-9]*) return 1 ;;
    esac
    [ "$octet" -le 255 ] || return 1
  done
}

non_local_ipv4() {
  case "$1" in
    0.*|10.*|127.*|169.254.*|192.168.*) return 1 ;;
    172.1[6-9].*|172.2[0-9].*|172.3[0-1].*) return 1 ;;
  esac
}

validate_inputs() {
  valid_ipv4 "$haos_ip" || fail "invalid HAOS IPv4 address: $haos_ip"
  valid_ipv4 "$router_ip" || fail "invalid router IPv4 address: $router_ip"
  valid_ipv4 "$public_edge_ip" || fail "invalid public Smart Edge IPv4 address: $public_edge_ip"
  non_local_ipv4 "$public_edge_ip" || fail "public Smart Edge IPv4 address must not be local: $public_edge_ip"
  case "$lan_cidr" in
    */*) valid_ipv4 "${lan_cidr%/*}" || fail "invalid LAN CIDR: $lan_cidr" ;;
    *) fail "invalid LAN CIDR: $lan_cidr" ;;
  esac
}

require_commands() {
  for command_name in uci fw4 nft nslookup curl nc grep sed date cp mkdir; do
    command -v "$command_name" >/dev/null 2>&1 || fail "missing command: $command_name"
  done
}

preflight_haos() {
  nslookup ya.ru "$haos_ip" >/dev/null 2>&1 || fail "HAOS DNS is not answering at $haos_ip:53"
  code="$(curl --noproxy '*' -4 -sS -o /dev/null -w '%{http_code}' \
    --connect-timeout 3 --max-time 10 \
    --resolve chatgpt.com:443:"$haos_ip" https://chatgpt.com/ 2>/dev/null || true)"
  case "$code" in
    ''|000) fail "HAOS Smart Edge is not serving chatgpt.com at $haos_ip:443" ;;
  esac
  # Public proxy lanes require Basic authentication.  Preflight proves
  # listener ownership without embedding credentials or treating 407 as an
  # outage; authenticated payload canaries run after the NAT transaction.
  for proxy_port in 3127 3128 3129 3130 13127 13128 13129 13130; do
    nc "$haos_ip" "$proxy_port" </dev/null >/dev/null 2>&1 || fail "HAOS proxy is not listening at $haos_ip:$proxy_port"
  done
  echo "HAOS target ready: dns=$haos_ip:53 https=$haos_ip:443 code=$code lan_proxy_ports=3127,3128,3129,3130 wan_proxy_ports=13127,13128,13129,13130"
}

preflight_public_alias() {
  nslookup ya.ru "$haos_ip" >/dev/null 2>&1 || fail "HAOS DNS is not answering at $haos_ip:53"
  code="$(curl --noproxy '*' -4 -sS -o /dev/null -w '%{http_code}' --connect-timeout 3 --max-time 10 --resolve chatgpt.com:443:"$haos_ip" https://chatgpt.com/ 2>/dev/null || true)"
  case "$code" in ''|000) fail "HAOS Smart Edge is not serving chatgpt.com at $haos_ip:443" ;; esac
}

candidate_ruleset() {
  fw4 print 2>&1
}

validate_lan_proxy() {
  proxy_section_to_validate="$1"
  proxy_snat_to_validate="$2"
  proxy_port_to_validate="$3"
  proxy_label_to_validate="$4"
  [ "$(uci -q get firewall.$proxy_section_to_validate.target || true)" = "DNAT" ] || fail "$proxy_label_to_validate proxy DNAT section is missing"
  [ "$(uci -q get firewall.$proxy_section_to_validate.src_dip || true)" = "$router_ip" ] || fail "$proxy_label_to_validate proxy DNAT does not match router LAN IP"
  [ "$(uci -q get firewall.$proxy_section_to_validate.src_dport || true)" = "$proxy_port_to_validate" ] || fail "$proxy_label_to_validate proxy DNAT source port is wrong"
  [ "$(uci -q get firewall.$proxy_section_to_validate.dest_ip || true)" = "$haos_ip" ] || fail "$proxy_label_to_validate proxy DNAT target is not HAOS"
  [ "$(uci -q get firewall.$proxy_snat_to_validate.target || true)" = "SNAT" ] || fail "$proxy_label_to_validate proxy return-path SNAT section is missing"
}

validate_public_proxy() {
  public_proxy_section_to_validate="$1"
  public_proxy_port_to_validate="$2"
  public_proxy_label_to_validate="$3"
  [ "$(uci -q get firewall.$public_proxy_section_to_validate.target || true)" = "DNAT" ] || fail "public $public_proxy_label_to_validate proxy DNAT section is missing"
  [ "$(uci -q get firewall.$public_proxy_section_to_validate.src || true)" = "wan" ] || fail "public $public_proxy_label_to_validate proxy source zone is not wan"
  [ "$(uci -q get firewall.$public_proxy_section_to_validate.src_dport || true)" = "$public_proxy_port_to_validate" ] || fail "public $public_proxy_label_to_validate proxy source port is wrong"
  [ "$(uci -q get firewall.$public_proxy_section_to_validate.dest_ip || true)" = "$haos_ip" ] || fail "public $public_proxy_label_to_validate proxy target is not HAOS"
  [ "$(uci -q get firewall.$public_proxy_section_to_validate.dest_port || true)" = "$public_proxy_port_to_validate" ] || fail "public $public_proxy_label_to_validate proxy target port is wrong"
  [ "$(uci -q get firewall.$public_proxy_section_to_validate.reflection || true)" = "0" ] || fail "public $public_proxy_label_to_validate proxy reflection is enabled"
}

assert_candidate_proxy() {
  proxy_rule_name_to_validate="$1"
  proxy_port_to_validate="$2"
  proxy_rule_line_to_validate="$(printf '%s\n' "$ruleset" | grep -F "comment \"!fw4: $proxy_rule_name_to_validate\"" | grep -F "dnat $haos_ip:$proxy_port_to_validate" || true)"
  [ -n "$proxy_rule_line_to_validate" ] || fail "fw4 candidate has no $proxy_rule_name_to_validate DNAT rule"
}

validate_candidate() {
  [ "$(uci -q get dhcp.@dnsmasq[0].noresolv || true)" = "1" ] || fail "dnsmasq noresolv is not enabled"
  dnsmasq_upstream="$(uci -q get dhcp.@dnsmasq[0].server || true)"
  [ "$dnsmasq_upstream" = "$haos_ip" ] || fail "dnsmasq upstream is not $haos_ip (actual: ${dnsmasq_upstream:-missing})"
  dhcp_options="$(uci -q get dhcp.lan.dhcp_option || true)"
  case " $dhcp_options " in
    *" 6,$router_ip "*) ;;
    *) fail "DHCP option 6 does not keep clients on router DNS $router_ip" ;;
  esac
  [ "$(uci -q get firewall.$dnat_section.target || true)" = "DNAT" ] || fail "DNAT section is missing"
  [ "$(uci -q get firewall.$dnat_section.src || true)" = "lan" ] || fail "DNAT source zone is not lan"
  [ "$(uci -q get firewall.$dnat_section.dest || true)" = "lan" ] || fail "DNAT destination zone is not lan"
  [ "$(uci -q get firewall.$dnat_section.src_dip || true)" = "$router_ip" ] || fail "DNAT does not match the router LAN IP"
  [ "$(uci -q get firewall.$dnat_section.src_dport || true)" = "443" ] || fail "DNAT source port is not 443"
  [ "$(uci -q get firewall.$dnat_section.dest_ip || true)" = "$haos_ip" ] || fail "DNAT target is not HAOS"
  [ "$(uci -q get firewall.$public_dnat_section.target || true)" = "DNAT" ] || fail "public alias DNAT section is missing"
  [ "$(uci -q get firewall.$public_dnat_section.src || true)" = "lan" ] || fail "public alias DNAT source zone is not lan"
  [ "$(uci -q get firewall.$public_dnat_section.src_dip || true)" = "$public_edge_ip" ] || fail "public alias DNAT address is wrong"
  [ "$(uci -q get firewall.$public_dnat_section.src_dport || true)" = "443" ] || fail "public alias DNAT source port is not 443"
  [ "$(uci -q get firewall.$public_dnat_section.dest_ip || true)" = "$haos_ip" ] || fail "public alias DNAT target is not HAOS"
  [ "$(uci -q get firewall.$snat_section.target || true)" = "SNAT" ] || fail "return-path SNAT section is missing"
  [ "$(uci -q get firewall.$snat_section.dest || true)" = "lan" ] || fail "SNAT destination zone is not lan"
  [ "$(uci -q get firewall.$snat_section.src_ip || true)" = "$lan_cidr" ] || fail "SNAT source CIDR is wrong"
  [ "$(uci -q get firewall.$snat_section.dest_ip || true)" = "$haos_ip" ] || fail "SNAT destination is not HAOS"
  [ "$(uci -q get firewall.$snat_section.src_dip || true)" = "$router_ip" ] || fail "SNAT rewrite address is not the router"
  [ "$(uci -q get firewall.$proxy_dnat_section.target || true)" = "DNAT" ] || fail "proxy DNAT section is missing"
  [ "$(uci -q get firewall.$proxy_dnat_section.src_dip || true)" = "$router_ip" ] || fail "proxy DNAT does not match router LAN IP"
  [ "$(uci -q get firewall.$proxy_dnat_section.src_dport || true)" = "3127" ] || fail "proxy DNAT source port is not 3127"
  [ "$(uci -q get firewall.$proxy_dnat_section.dest_ip || true)" = "$haos_ip" ] || fail "proxy DNAT target is not HAOS"
  [ "$(uci -q get firewall.$proxy_snat_section.target || true)" = "SNAT" ] || fail "proxy return-path SNAT section is missing"
  [ "$(uci -q get firewall.$de_proxy_dnat_section.target || true)" = "DNAT" ] || fail "DE proxy DNAT section is missing"
  [ "$(uci -q get firewall.$de_proxy_dnat_section.src_dip || true)" = "$router_ip" ] || fail "DE proxy DNAT does not match router LAN IP"
  [ "$(uci -q get firewall.$de_proxy_dnat_section.src_dport || true)" = "3128" ] || fail "DE proxy DNAT source port is not 3128"
  [ "$(uci -q get firewall.$de_proxy_dnat_section.dest_ip || true)" = "$haos_ip" ] || fail "DE proxy DNAT target is not HAOS"
  [ "$(uci -q get firewall.$de_proxy_snat_section.target || true)" = "SNAT" ] || fail "DE proxy return-path SNAT section is missing"
  validate_lan_proxy "$fi_proxy_dnat_section" "$fi_proxy_snat_section" 3129 Finland
  validate_lan_proxy "$ru_proxy_dnat_section" "$ru_proxy_snat_section" 3130 Russia
  validate_public_proxy "$public_us_proxy_section" "$public_us_proxy_port" US
  validate_public_proxy "$public_de_proxy_section" "$public_de_proxy_port" DE
  validate_public_proxy "$public_fi_proxy_section" "$public_fi_proxy_port" Finland
  validate_public_proxy "$public_ru_proxy_section" "$public_ru_proxy_port" Russia
  [ -z "$(uci -q get firewall.$legacy_de_proxy_dnat_section || true)" ] || fail "legacy DE proxy DNAT section is still present"
  [ -z "$(uci -q get firewall.$legacy_de_proxy_snat_section || true)" ] || fail "legacy DE proxy return-path section is still present"
  ! uci show firewall 2>/dev/null | grep -F "name='SQUID_3129_MGTS'" >/dev/null || fail "legacy 3129 DE redirect is still present"

  ruleset="$(candidate_ruleset)" || fail "fw4 could not render the candidate"
  dnat_line="$(printf '%s\n' "$ruleset" | grep -F "comment \"!fw4: $dnat_name\"" | grep -F "dnat $haos_ip:443" || true)"
  [ -n "$dnat_line" ] || fail "fw4 candidate has no HAOS DNAT rule"
  public_dnat_line="$(printf '%s\n' "$ruleset" | grep -F "comment \"!fw4: $public_dnat_name\"" | grep -F "ip daddr $public_edge_ip" | grep -F "dnat $haos_ip:443" || true)"
  [ -n "$public_dnat_line" ] || fail "fw4 candidate has no public alias HAOS DNAT rule"
  proxy_dnat_line="$(printf '%s\n' "$ruleset" | grep -F "comment \"!fw4: $proxy_dnat_name\"" | grep -F "dnat $haos_ip:3127" || true)"
  [ -n "$proxy_dnat_line" ] || fail "fw4 candidate has no HAOS proxy DNAT rule"
  de_proxy_dnat_line="$(printf '%s\n' "$ruleset" | grep -F "comment \"!fw4: $de_proxy_dnat_name\"" | grep -F "dnat $haos_ip:3128" || true)"
  [ -n "$de_proxy_dnat_line" ] || fail "fw4 candidate has no HAOS DE proxy DNAT rule"
  assert_candidate_proxy "$fi_proxy_dnat_name" 3129
  assert_candidate_proxy "$ru_proxy_dnat_name" 3130
  assert_candidate_proxy "VPN Panel public US proxy" "$public_us_proxy_port"
  assert_candidate_proxy "VPN Panel public DE proxy" "$public_de_proxy_port"
  assert_candidate_proxy "VPN Panel public Finland proxy" "$public_fi_proxy_port"
  assert_candidate_proxy "VPN Panel public Russia proxy" "$public_ru_proxy_port"
  snat_line="$(printf '%s\n' "$ruleset" | grep -F "comment \"!fw4: $snat_name\"" || true)"
  case "$snat_line" in
    *" snat $router_ip "*|*" snat ip to $router_ip "*) ;;
    *) fail "fw4 candidate has no router return-path SNAT rule" ;;
  esac
  proxy_snat_line="$(printf '%s\n' "$ruleset" | grep -F "comment \"!fw4: $proxy_snat_name\"" || true)"
  [ -n "$proxy_snat_line" ] || fail "fw4 candidate has no HAOS proxy return-path SNAT rule"
  de_proxy_snat_line="$(printf '%s\n' "$ruleset" | grep -F "comment \"!fw4: $de_proxy_snat_name\"" || true)"
  [ -n "$de_proxy_snat_line" ] || fail "fw4 candidate has no HAOS DE proxy return-path SNAT rule"
  fi_proxy_snat_line="$(printf '%s\n' "$ruleset" | grep -F "comment \"!fw4: $fi_proxy_snat_name\"" || true)"
  [ -n "$fi_proxy_snat_line" ] || fail "fw4 candidate has no HAOS Finland proxy return-path SNAT rule"
  ru_proxy_snat_line="$(printf '%s\n' "$ruleset" | grep -F "comment \"!fw4: $ru_proxy_snat_name\"" || true)"
  [ -n "$ru_proxy_snat_line" ] || fail "fw4 candidate has no HAOS Russia proxy return-path SNAT rule"
  ! printf '%s\n' "$ruleset" | grep -F 'comment "!fw4: autoproxy_to_server100"' >/dev/null || fail "fw4 candidate retains the legacy DE proxy DNAT rule"
  ! printf '%s\n' "$ruleset" | grep -F 'comment "!fw4: autoproxy_to_server100_hairpin"' >/dev/null || fail "fw4 candidate retains the legacy DE proxy return-path rule"
  ! printf '%s\n' "$ruleset" | grep -F 'SQUID_3129_MGTS' >/dev/null || fail "fw4 candidate retains the legacy 3129 DE redirect"
  fw4 check >/dev/null 2>&1 || fail "fw4 candidate validation failed"
}

validate_runtime() {
  validate_candidate
  runtime_rules="$(nft list table inet fw4 2>/dev/null)" || fail "cannot inspect the active fw4 table"
  printf '%s\n' "$runtime_rules" | grep -F "!fw4: $dnat_name" >/dev/null || fail "active DNAT rule is missing"
  printf '%s\n' "$runtime_rules" | grep -F "!fw4: $public_dnat_name" >/dev/null || fail "active public alias DNAT rule is missing"
  printf '%s\n' "$runtime_rules" | grep -F "!fw4: $snat_name" >/dev/null || fail "active return-path SNAT rule is missing"
  printf '%s\n' "$runtime_rules" | grep -F "!fw4: $proxy_dnat_name" >/dev/null || fail "active proxy DNAT rule is missing"
  printf '%s\n' "$runtime_rules" | grep -F "!fw4: $proxy_snat_name" >/dev/null || fail "active proxy return-path SNAT rule is missing"
  printf '%s\n' "$runtime_rules" | grep -F "!fw4: $de_proxy_dnat_name" >/dev/null || fail "active DE proxy DNAT rule is missing"
  printf '%s\n' "$runtime_rules" | grep -F "!fw4: $de_proxy_snat_name" >/dev/null || fail "active DE proxy return-path SNAT rule is missing"
  printf '%s\n' "$runtime_rules" | grep -F "!fw4: $fi_proxy_dnat_name" >/dev/null || fail "active Finland proxy DNAT rule is missing"
  printf '%s\n' "$runtime_rules" | grep -F "!fw4: $fi_proxy_snat_name" >/dev/null || fail "active Finland proxy return-path SNAT rule is missing"
  printf '%s\n' "$runtime_rules" | grep -F "!fw4: $ru_proxy_dnat_name" >/dev/null || fail "active Russia proxy DNAT rule is missing"
  printf '%s\n' "$runtime_rules" | grep -F "!fw4: $ru_proxy_snat_name" >/dev/null || fail "active Russia proxy return-path SNAT rule is missing"
  printf '%s\n' "$runtime_rules" | grep -F '!fw4: VPN Panel public US proxy' >/dev/null || fail "active public US proxy DNAT rule is missing"
  printf '%s\n' "$runtime_rules" | grep -F '!fw4: VPN Panel public DE proxy' >/dev/null || fail "active public DE proxy DNAT rule is missing"
  printf '%s\n' "$runtime_rules" | grep -F '!fw4: VPN Panel public Finland proxy' >/dev/null || fail "active public Finland proxy DNAT rule is missing"
  printf '%s\n' "$runtime_rules" | grep -F '!fw4: VPN Panel public Russia proxy' >/dev/null || fail "active public Russia proxy DNAT rule is missing"
  ! printf '%s\n' "$runtime_rules" | grep -F '!fw4: autoproxy_to_server100' >/dev/null || fail "active legacy DE proxy DNAT rule remains"
  ! printf '%s\n' "$runtime_rules" | grep -F '!fw4: autoproxy_to_server100_hairpin' >/dev/null || fail "active legacy DE proxy return-path rule remains"
  ! printf '%s\n' "$runtime_rules" | grep -F 'SQUID_3129_MGTS' >/dev/null || fail "active legacy 3129 DE redirect remains"
  nslookup ya.ru 127.0.0.1 >/dev/null 2>&1 || fail "router DNS is not answering after cutover"
}

validate_public_alias() {
  [ "$(uci -q get firewall.$public_dnat_section.target || true)" = "DNAT" ] || fail "public alias DNAT section is missing"
  [ "$(uci -q get firewall.$public_dnat_section.src || true)" = "lan" ] || fail "public alias DNAT source zone is not lan"
  [ "$(uci -q get firewall.$public_dnat_section.src_dip || true)" = "$public_edge_ip" ] || fail "public alias DNAT address is wrong"
  [ "$(uci -q get firewall.$public_dnat_section.src_dport || true)" = "443" ] || fail "public alias DNAT source port is not 443"
  [ "$(uci -q get firewall.$public_dnat_section.dest_ip || true)" = "$haos_ip" ] || fail "public alias DNAT target is not HAOS"
  ruleset="$(candidate_ruleset)" || fail "fw4 could not render the public alias candidate"
  printf '%s\n' "$ruleset" | grep -F "comment \"!fw4: $public_dnat_name\"" | grep -F "ip daddr $public_edge_ip" | grep -F "dnat $haos_ip:443" >/dev/null || fail "fw4 candidate has no public alias HAOS DNAT rule"
  fw4 check >/dev/null 2>&1 || fail "fw4 public alias candidate validation failed"
}

apply_public_alias() {
  stamp="$(date -u +%Y%m%d_%H%M%S)"
  backup="$backup_root/public_alias_$stamp"
  [ ! -e "$backup" ] || backup="${backup}_$$"
  mkdir -p "$backup"
  cp -a "$config_dir/firewall" "$backup/firewall"

  rollback_public_alias() {
    reason="$1"
    cp -a "$backup/firewall" "$config_dir/firewall" || true
    "$initd_dir/firewall" reload >/dev/null 2>&1 || true
    fail "$reason; restored $backup"
  }

  uci -q delete "firewall.$public_dnat_section" || true
  uci set "firewall.$public_dnat_section=redirect" || rollback_public_alias "cannot create public alias DNAT"
  uci set "firewall.$public_dnat_section.name=$public_dnat_name" || rollback_public_alias "cannot name public alias DNAT"
  uci set "firewall.$public_dnat_section.family=ipv4" || rollback_public_alias "cannot set public alias family"
  uci set "firewall.$public_dnat_section.proto=tcp" || rollback_public_alias "cannot set public alias protocol"
  uci set "firewall.$public_dnat_section.src=lan" || rollback_public_alias "cannot set public alias source zone"
  uci set "firewall.$public_dnat_section.dest=lan" || rollback_public_alias "cannot set public alias destination zone"
  uci set "firewall.$public_dnat_section.src_dip=$public_edge_ip" || rollback_public_alias "cannot set public alias address"
  uci set "firewall.$public_dnat_section.src_dport=443" || rollback_public_alias "cannot set public alias port"
  uci set "firewall.$public_dnat_section.dest_ip=$haos_ip" || rollback_public_alias "cannot set public alias HAOS target"
  uci set "firewall.$public_dnat_section.dest_port=443" || rollback_public_alias "cannot set public alias HAOS port"
  uci set "firewall.$public_dnat_section.target=DNAT" || rollback_public_alias "cannot set public alias DNAT target"
  uci set "firewall.$public_dnat_section.reflection=0" || rollback_public_alias "cannot set public alias reflection"
  uci commit firewall || rollback_public_alias "cannot commit public alias firewall"
  validate_public_alias || rollback_public_alias "public alias candidate validation failed"
  "$initd_dir/firewall" reload >/dev/null 2>&1 || rollback_public_alias "public alias firewall reload failed"
  runtime_rules="$(nft list table inet fw4 2>/dev/null)" || rollback_public_alias "cannot inspect public alias runtime rules"
  printf '%s\n' "$runtime_rules" | grep -F "!fw4: $public_dnat_name" >/dev/null || rollback_public_alias "active public alias DNAT rule is missing"
  echo "Public Smart Edge alias active: public_alias=$public_edge_ip:443->$haos_ip:443 backup=$backup"
}

restore_backup() {
  restore_dir="$1"
  [ -f "$restore_dir/dhcp" ] || fail "rollback DHCP backup is missing: $restore_dir/dhcp"
  [ -f "$restore_dir/firewall" ] || fail "rollback firewall backup is missing: $restore_dir/firewall"
  cp -a "$restore_dir/dhcp" "$config_dir/dhcp"
  cp -a "$restore_dir/firewall" "$config_dir/firewall"
  fw4 check >/dev/null 2>&1 || fail "restored firewall config is invalid"
  "$initd_dir/firewall" reload >/dev/null 2>&1 || fail "restored firewall reload failed"
  "$initd_dir/dnsmasq" restart >/dev/null 2>&1 || fail "restored dnsmasq restart failed"
  restore_legacy_dns_services "$restore_dir"
  echo "Transparent Smart Edge rolled back: backup=$restore_dir"
}

capture_legacy_dns_services() {
  receipt_dir="$1"
  for service in $legacy_dns_services; do
    enabled=no
    running=no
    if [ -x "$initd_dir/$service" ]; then
      "$initd_dir/$service" enabled >/dev/null 2>&1 && enabled=yes
      "$initd_dir/$service" running >/dev/null 2>&1 && running=yes
    fi
    printf '%s %s\n' "$enabled" "$running" >"$receipt_dir/service.$service"
  done
}

disable_legacy_dns_services() {
  for service in $legacy_dns_services; do
    if [ -x "$initd_dir/$service" ]; then
      "$initd_dir/$service" stop >/dev/null 2>&1 || return 1
      "$initd_dir/$service" disable >/dev/null 2>&1 || return 1
    fi
  done
}

restore_legacy_dns_services() {
  receipt_dir="$1"
  for service in $legacy_dns_services; do
    [ -x "$initd_dir/$service" ] || continue
    state_file="$receipt_dir/service.$service"
    [ -f "$state_file" ] || continue
    read -r enabled running <"$state_file"
    if [ "$enabled" = yes ]; then
      "$initd_dir/$service" enable >/dev/null 2>&1 || true
    else
      "$initd_dir/$service" disable >/dev/null 2>&1 || true
    fi
    if [ "$running" = yes ]; then
      "$initd_dir/$service" start >/dev/null 2>&1 || true
    else
      "$initd_dir/$service" stop >/dev/null 2>&1 || true
    fi
  done
}

apply_config() {
  stamp="$(date -u +%Y%m%d_%H%M%S)"
  backup="$backup_root/$stamp"
  [ ! -e "$backup" ] || backup="${backup}_$$"
  mkdir -p "$backup"
  cp -a "$config_dir/dhcp" "$backup/dhcp"
  cp -a "$config_dir/firewall" "$backup/firewall"
  capture_legacy_dns_services "$backup"

  rollback_on_error() {
    reason="$1"
    cp -a "$backup/dhcp" "$config_dir/dhcp" || true
    cp -a "$backup/firewall" "$config_dir/firewall" || true
    "$initd_dir/firewall" reload >/dev/null 2>&1 || true
    "$initd_dir/dnsmasq" restart >/dev/null 2>&1 || true
    restore_legacy_dns_services "$backup"
    fail "$reason; restored $backup"
  }

  apply_uci() {
    uci "$@" || rollback_on_error "UCI command failed: uci $*"
  }

  disable_legacy_dns_services || rollback_on_error "could not disable legacy SmartDNS watchdogs"

  old_dhcp_options="$(uci -q get dhcp.lan.dhcp_option || true)"
  apply_uci set dhcp.@dnsmasq[0].noresolv='1'
  # OpenWrt's dnsmasq generator consumes this option as a list. Delete the old
  # value first so the retired watchdog target cannot survive alongside HAOS.
  uci -q delete dhcp.@dnsmasq[0].server || true
  apply_uci add_list "dhcp.@dnsmasq[0].server=$haos_ip"
  uci -q delete dhcp.lan.dhcp_option || true
  for option in $old_dhcp_options; do
    case "$option" in
      6,*) ;;
      *) apply_uci add_list "dhcp.lan.dhcp_option=$option" ;;
    esac
  done
  apply_uci add_list "dhcp.lan.dhcp_option=6,$router_ip"

  uci -q delete "firewall.$dnat_section" || true
  apply_uci set "firewall.$dnat_section=redirect"
  apply_uci set "firewall.$dnat_section.name=$dnat_name"
  apply_uci set "firewall.$dnat_section.family=ipv4"
  apply_uci set "firewall.$dnat_section.proto=tcp"
  apply_uci set "firewall.$dnat_section.src=lan"
  apply_uci set "firewall.$dnat_section.dest=lan"
  apply_uci set "firewall.$dnat_section.src_dip=$router_ip"
  apply_uci set "firewall.$dnat_section.src_dport=443"
  apply_uci set "firewall.$dnat_section.dest_ip=$haos_ip"
  apply_uci set "firewall.$dnat_section.dest_port=443"
  apply_uci set "firewall.$dnat_section.target=DNAT"
  apply_uci set "firewall.$dnat_section.reflection=0"

  # LAN DNS answers use this documentation-range address so Chromium classifies
  # the destination as public. It is never exposed on WAN: LAN prerouting DNAT
  # terminates it at HAOS before route lookup, while normal public ingress stays
  # owned by the existing WAN redirect rules.
  uci -q delete "firewall.$public_dnat_section" || true
  apply_uci set "firewall.$public_dnat_section=redirect"
  apply_uci set "firewall.$public_dnat_section.name=$public_dnat_name"
  apply_uci set "firewall.$public_dnat_section.family=ipv4"
  apply_uci set "firewall.$public_dnat_section.proto=tcp"
  apply_uci set "firewall.$public_dnat_section.src=lan"
  apply_uci set "firewall.$public_dnat_section.dest=lan"
  apply_uci set "firewall.$public_dnat_section.src_dip=$public_edge_ip"
  apply_uci set "firewall.$public_dnat_section.src_dport=443"
  apply_uci set "firewall.$public_dnat_section.dest_ip=$haos_ip"
  apply_uci set "firewall.$public_dnat_section.dest_port=443"
  apply_uci set "firewall.$public_dnat_section.target=DNAT"
  apply_uci set "firewall.$public_dnat_section.reflection=0"

  # LAN is not masqueraded on this router. DNAT alone would let HAOS reply
  # directly to the client as 192.168.2.101, breaking a connection opened to
  # 192.168.2.1. This scoped SNAT forces the reply through conntrack on router.
  uci -q delete "firewall.$snat_section" || true
  apply_uci set "firewall.$snat_section=redirect"
  apply_uci set "firewall.$snat_section.name=$snat_name"
  apply_uci set "firewall.$snat_section.family=ipv4"
  apply_uci set "firewall.$snat_section.proto=tcp"
  apply_uci set "firewall.$snat_section.dest=lan"
  apply_uci set "firewall.$snat_section.src_ip=$lan_cidr"
  apply_uci set "firewall.$snat_section.dest_ip=$haos_ip"
  apply_uci set "firewall.$snat_section.dest_port=443"
  apply_uci set "firewall.$snat_section.src_dip=$router_ip"
  apply_uci set "firewall.$snat_section.target=SNAT"

  uci -q delete "firewall.$proxy_dnat_section" || true
  apply_uci set "firewall.$proxy_dnat_section=redirect"
  apply_uci set "firewall.$proxy_dnat_section.name=$proxy_dnat_name"
  apply_uci set "firewall.$proxy_dnat_section.family=ipv4"
  apply_uci set "firewall.$proxy_dnat_section.proto=tcp"
  apply_uci set "firewall.$proxy_dnat_section.src=lan"
  apply_uci set "firewall.$proxy_dnat_section.dest=lan"
  apply_uci set "firewall.$proxy_dnat_section.src_dip=$router_ip"
  apply_uci set "firewall.$proxy_dnat_section.src_dport=3127"
  apply_uci set "firewall.$proxy_dnat_section.dest_ip=$haos_ip"
  apply_uci set "firewall.$proxy_dnat_section.dest_port=3127"
  apply_uci set "firewall.$proxy_dnat_section.target=DNAT"
  apply_uci set "firewall.$proxy_dnat_section.reflection=0"

  uci -q delete "firewall.$proxy_snat_section" || true
  apply_uci set "firewall.$proxy_snat_section=redirect"
  apply_uci set "firewall.$proxy_snat_section.name=$proxy_snat_name"
  apply_uci set "firewall.$proxy_snat_section.family=ipv4"
  apply_uci set "firewall.$proxy_snat_section.proto=tcp"
  apply_uci set "firewall.$proxy_snat_section.dest=lan"
  apply_uci set "firewall.$proxy_snat_section.src_ip=$lan_cidr"
  apply_uci set "firewall.$proxy_snat_section.dest_ip=$haos_ip"
  apply_uci set "firewall.$proxy_snat_section.dest_port=3127"
  apply_uci set "firewall.$proxy_snat_section.src_dip=$router_ip"
  apply_uci set "firewall.$proxy_snat_section.target=SNAT"

  # The old 3128 lane pointed at server-100 HAProxy.  Its rule predates the
  # HAOS redirect and wins first-match evaluation, so leave no competing path.
  uci -q delete "firewall.$legacy_de_proxy_dnat_section" || true
  uci -q delete "firewall.$legacy_de_proxy_snat_section" || true

  uci -q delete "firewall.$de_proxy_dnat_section" || true
  apply_uci set "firewall.$de_proxy_dnat_section=redirect"
  apply_uci set "firewall.$de_proxy_dnat_section.name=$de_proxy_dnat_name"
  apply_uci set "firewall.$de_proxy_dnat_section.family=ipv4"
  apply_uci set "firewall.$de_proxy_dnat_section.proto=tcp"
  apply_uci set "firewall.$de_proxy_dnat_section.src=lan"
  apply_uci set "firewall.$de_proxy_dnat_section.dest=lan"
  apply_uci set "firewall.$de_proxy_dnat_section.src_dip=$router_ip"
  apply_uci set "firewall.$de_proxy_dnat_section.src_dport=3128"
  apply_uci set "firewall.$de_proxy_dnat_section.dest_ip=$haos_ip"
  apply_uci set "firewall.$de_proxy_dnat_section.dest_port=3128"
  apply_uci set "firewall.$de_proxy_dnat_section.target=DNAT"
  apply_uci set "firewall.$de_proxy_dnat_section.reflection=0"

  uci -q delete "firewall.$de_proxy_snat_section" || true
  apply_uci set "firewall.$de_proxy_snat_section=redirect"
  apply_uci set "firewall.$de_proxy_snat_section.name=$de_proxy_snat_name"
  apply_uci set "firewall.$de_proxy_snat_section.family=ipv4"
  apply_uci set "firewall.$de_proxy_snat_section.proto=tcp"
  apply_uci set "firewall.$de_proxy_snat_section.dest=lan"
  apply_uci set "firewall.$de_proxy_snat_section.src_ip=$lan_cidr"
  apply_uci set "firewall.$de_proxy_snat_section.dest_ip=$haos_ip"
  apply_uci set "firewall.$de_proxy_snat_section.dest_port=3128"
  apply_uci set "firewall.$de_proxy_snat_section.src_dip=$router_ip"
  apply_uci set "firewall.$de_proxy_snat_section.target=SNAT"

  configure_lan_proxy() {
    lan_proxy_section="$1"
    lan_proxy_snat_section="$2"
    lan_proxy_name="$3"
    lan_proxy_snat_name="$4"
    lan_proxy_port="$5"
    uci -q delete "firewall.$lan_proxy_section" || true
    apply_uci set "firewall.$lan_proxy_section=redirect"
    apply_uci set "firewall.$lan_proxy_section.name=$lan_proxy_name"
    apply_uci set "firewall.$lan_proxy_section.family=ipv4"
    apply_uci set "firewall.$lan_proxy_section.proto=tcp"
    apply_uci set "firewall.$lan_proxy_section.src=lan"
    apply_uci set "firewall.$lan_proxy_section.dest=lan"
    apply_uci set "firewall.$lan_proxy_section.src_dip=$router_ip"
    apply_uci set "firewall.$lan_proxy_section.src_dport=$lan_proxy_port"
    apply_uci set "firewall.$lan_proxy_section.dest_ip=$haos_ip"
    apply_uci set "firewall.$lan_proxy_section.dest_port=$lan_proxy_port"
    apply_uci set "firewall.$lan_proxy_section.target=DNAT"
    apply_uci set "firewall.$lan_proxy_section.reflection=0"
    uci -q delete "firewall.$lan_proxy_snat_section" || true
    apply_uci set "firewall.$lan_proxy_snat_section=redirect"
    apply_uci set "firewall.$lan_proxy_snat_section.name=$lan_proxy_snat_name"
    apply_uci set "firewall.$lan_proxy_snat_section.family=ipv4"
    apply_uci set "firewall.$lan_proxy_snat_section.proto=tcp"
    apply_uci set "firewall.$lan_proxy_snat_section.dest=lan"
    apply_uci set "firewall.$lan_proxy_snat_section.src_ip=$lan_cidr"
    apply_uci set "firewall.$lan_proxy_snat_section.dest_ip=$haos_ip"
    apply_uci set "firewall.$lan_proxy_snat_section.dest_port=$lan_proxy_port"
    apply_uci set "firewall.$lan_proxy_snat_section.src_dip=$router_ip"
    apply_uci set "firewall.$lan_proxy_snat_section.target=SNAT"
  }

  configure_public_proxy() {
    public_proxy_section="$1"
    public_proxy_name="$2"
    public_proxy_port="$3"
    uci -q delete "firewall.$public_proxy_section" || true
    apply_uci set "firewall.$public_proxy_section=redirect"
    apply_uci set "firewall.$public_proxy_section.name=$public_proxy_name"
    apply_uci set "firewall.$public_proxy_section.family=ipv4"
    apply_uci set "firewall.$public_proxy_section.proto=tcp"
    apply_uci set "firewall.$public_proxy_section.src=wan"
    apply_uci set "firewall.$public_proxy_section.dest=lan"
    apply_uci set "firewall.$public_proxy_section.src_dport=$public_proxy_port"
    apply_uci set "firewall.$public_proxy_section.dest_ip=$haos_ip"
    apply_uci set "firewall.$public_proxy_section.dest_port=$public_proxy_port"
    apply_uci set "firewall.$public_proxy_section.target=DNAT"
    apply_uci set "firewall.$public_proxy_section.reflection=0"
  }

  # The legacy anonymous router redirect sent 3129 into the DE lane.  Remove
  # it by its stable display name before the Finland redirect is committed.
  for legacy_proxy_section in $(uci show firewall 2>/dev/null | sed -n "s/^\\(firewall\\.@redirect\\[[0-9][0-9]*\\]\\)\\.name='SQUID_3129_MGTS'$/\\1/p"); do
    uci -q delete "$legacy_proxy_section" || true
  done

  configure_lan_proxy "$fi_proxy_dnat_section" "$fi_proxy_snat_section" "$fi_proxy_dnat_name" "$fi_proxy_snat_name" 3129
  configure_lan_proxy "$ru_proxy_dnat_section" "$ru_proxy_snat_section" "$ru_proxy_dnat_name" "$ru_proxy_snat_name" 3130
  configure_public_proxy "$public_us_proxy_section" "VPN Panel public US proxy" "$public_us_proxy_port"
  configure_public_proxy "$public_de_proxy_section" "VPN Panel public DE proxy" "$public_de_proxy_port"
  configure_public_proxy "$public_fi_proxy_section" "VPN Panel public Finland proxy" "$public_fi_proxy_port"
  configure_public_proxy "$public_ru_proxy_section" "VPN Panel public Russia proxy" "$public_ru_proxy_port"

  apply_uci commit dhcp
  apply_uci commit firewall
  if ! (validate_candidate); then
    rollback_on_error "candidate validation failed"
  fi
  "$initd_dir/firewall" reload >/dev/null 2>&1 || rollback_on_error "firewall reload failed"
  "$initd_dir/dnsmasq" restart >/dev/null 2>&1 || rollback_on_error "dnsmasq restart failed"
  if ! (validate_runtime); then
    rollback_on_error "runtime validation failed"
  fi
  echo "Transparent Smart Edge active: dns=$router_ip:53->$haos_ip:53 https=$router_ip:443->$haos_ip:443 lan_proxies=$router_ip:{3127,3128,3129,3130}->$haos_ip public_proxies=$public_edge_ip:{13127,13128,13129,13130}->$haos_ip backup=$backup"
}

validate_inputs
require_commands

case "$mode" in
  --public-alias-check)
    preflight_public_alias
    ;;
  --public-alias-validate)
    validate_public_alias
    echo "Public Smart Edge alias validation OK"
    ;;
  --public-alias-apply)
    # Deliberately do not gate a DNS-alias-only change on optional LAN HTTP
    # proxy pools; this action touches only one alias DNAT and preserves them.
    preflight_public_alias
    apply_public_alias
    ;;
  --check)
    preflight_haos
    ;;
  --validate)
    validate_runtime
    echo "Transparent Smart Edge validation OK"
    ;;
  --apply)
    preflight_haos
    apply_config
    ;;
  --rollback)
    [ -n "$backup" ] || fail "usage: $0 --rollback HAOS_IP ROUTER_IP LAN_CIDR PUBLIC_EDGE_IP BACKUP_DIR"
    case "$backup" in
      "$backup_root"/*) ;;
      *) fail "rollback path must be below $backup_root" ;;
    esac
    restore_backup "$backup"
    ;;
  *)
    fail "usage: $0 [--check|--validate|--apply|--rollback|--public-alias-check|--public-alias-validate|--public-alias-apply] [HAOS_IP] [ROUTER_IP] [LAN_CIDR] [PUBLIC_EDGE_IP] [BACKUP_DIR]"
    ;;
esac

#!/usr/bin/env bash
set -euo pipefail

want_sysctl() {
  local key="$1" want="$2" got
  got="$(sysctl -n "$key" 2>/dev/null || true)"
  if [[ "$got" == "$want" ]]; then
    printf 'OK   sysctl %-38s %s\n' "$key" "$got"
  else
    printf 'WARN sysctl %-38s got=%q want=%q\n' "$key" "$got" "$want"
  fi
}

service_state() {
  local svc="$1"
  if systemctl list-unit-files "${svc}.service" --no-legend 2>/dev/null | grep -q .; then
    printf '%-22s active=%-10s enabled=%s\n' "$svc" "$(systemctl is-active "$svc" 2>/dev/null || true)" "$(systemctl is-enabled "$svc" 2>/dev/null || true)"
  fi
}

printf '== identity ==\n'
hostname
uname -a
printf '\n== sysctl ==\n'
want_sysctl net.core.somaxconn 65535
want_sysctl net.core.netdev_max_backlog 16384
want_sysctl net.ipv4.tcp_max_syn_backlog 65535
want_sysctl net.ipv4.ip_local_port_range $'10000\t65535'
want_sysctl net.ipv4.tcp_fin_timeout 15
want_sysctl net.ipv4.tcp_keepalive_time 600
want_sysctl net.ipv4.tcp_fastopen 3
want_sysctl vm.swappiness 10
want_sysctl vm.vfs_cache_pressure 150
want_sysctl vm.dirty_background_ratio 5
want_sysctl vm.dirty_ratio 10
printf 'INFO tcp_congestion_control=%s\n' "$(sysctl -n net.ipv4.tcp_congestion_control 2>/dev/null || true)"
printf 'INFO default_qdisc=%s\n' "$(sysctl -n net.core.default_qdisc 2>/dev/null || true)"

printf '\n== systemd limits ==\n'
for svc in nginx xray smart-edge gptadmin-shellmcp gptadmin-rootd; do
  if systemctl list-unit-files "${svc}.service" --no-legend 2>/dev/null | grep -q .; then
    printf '%-22s LimitNOFILE=%s\n' "$svc" "$(systemctl show "$svc" -p LimitNOFILE --value --no-pager 2>/dev/null || true)"
  fi
done

printf '\n== services ==\n'
for svc in nginx xray smart-edge edge-cleanup systemd-journald; do service_state "$svc"; done
printf '\n== disabled bloat candidates ==\n'
for svc in snapd snapd.socket packagekit ModemManager multipathd apport unattended-upgrades; do
  unit="$svc"
  [[ "$svc" != *.socket && "$svc" != *.service ]] && unit="${svc}.service"
  if systemctl list-unit-files "$unit" --no-legend 2>/dev/null | grep -q .; then
    printf '%-28s active=%-10s enabled=%s\n' "$unit" "$(systemctl is-active "$unit" 2>/dev/null || true)" "$(systemctl is-enabled "$unit" 2>/dev/null || true)"
  fi
done

printf '\n== logs/disk/memory ==\n'
free -h
swapon --show || true
df -hT /
journalctl --disk-usage || true
du -sh /var/log /var/log/nginx /var/cache/apt /var/lib/apt/lists 2>/dev/null || true
systemctl list-timers edge-cleanup.timer --no-pager || true

printf '\n== validation commands ==\n'
if command -v nginx >/dev/null 2>&1; then nginx -t; fi
if command -v xray >/dev/null 2>&1; then xray -test -config /usr/local/etc/xray/config.json >/tmp/edge-xray-test.out 2>&1 && tail -n 3 /tmp/edge-xray-test.out || { cat /tmp/edge-xray-test.out; exit 1; }; fi

printf '\n== important listeners ==\n'
ss -tlnp | grep -E ':(80|443|8080|8444|9443|23443|28443|3128|1080|10085)\b' || true

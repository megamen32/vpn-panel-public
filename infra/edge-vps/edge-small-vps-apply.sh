#!/usr/bin/env bash
set -euo pipefail

# Managed by GPTAdmin.
# Apply a conservative "tiny VPS, many Internet connections" profile for
# smart-edge nodes running nginx + Xray + GPTAdmin on Ubuntu/Debian.
#
# It is intentionally idempotent and only writes files under:
#   /etc/sysctl.d/99-edge-small-vps-network.conf
#   /etc/security/limits.d/99-edge-nofile.conf
#   /etc/systemd/journald.conf.d/90-edge-tight.conf
#   /etc/logrotate.d/{nginx,edge-hard,btmp,wtmp}
#   /usr/local/sbin/edge-cleanup
#   /etc/systemd/system/edge-cleanup.{service,timer}
#   /etc/systemd/system/<service>.service.d/90-edge-limits.conf
# Optional: create /swapfile when the host has no swap.

usage() {
  cat <<'USAGE'
Usage:
  sudo ./edge-small-vps-apply.sh [options]

Options:
  --swap-size SIZE        Create /swapfile with SIZE when no swap exists. Default: 1G.
  --no-swap              Do not create swap even if none exists.
  --no-disable-services  Do not disable snapd/packagekit/ModemManager/multipathd/apport/unattended-upgrades.
  --no-clean-now         Install cleanup timer but do not run cleanup immediately.
  --help                 Show this help.

Typical edge nodes:
  sudo infra/edge-vps/edge-small-vps-apply.sh --swap-size 1G

Rollback:
  The script stores a timestamped copy of touched files under
  /root/.gptadmin/edge-tuning-backups/<timestamp>/ before writing.
USAGE
}

SWAP_SIZE="1G"
ENABLE_SWAP=1
DISABLE_SERVICES=1
CLEAN_NOW=1

while [[ $# -gt 0 ]]; do
  case "$1" in
    --swap-size)
      SWAP_SIZE="${2:?missing --swap-size value}"; shift 2 ;;
    --no-swap)
      ENABLE_SWAP=0; shift ;;
    --no-disable-services)
      DISABLE_SERVICES=0; shift ;;
    --no-clean-now)
      CLEAN_NOW=0; shift ;;
    --help|-h)
      usage; exit 0 ;;
    *)
      echo "Unknown option: $1" >&2; usage >&2; exit 2 ;;
  esac
done

if [[ "${EUID}" -ne 0 ]]; then
  echo "Run as root: sudo $0" >&2
  exit 1
fi

if ! command -v systemctl >/dev/null 2>&1; then
  echo "systemd is required for this profile" >&2
  exit 1
fi

TS="$(date +%Y%m%d_%H%M%S)"
BACKUP_DIR="/root/.gptadmin/edge-tuning-backups/${TS}"
mkdir -p "$BACKUP_DIR"

backup_path() {
  local p="$1"
  if [[ -e "$p" || -L "$p" ]]; then
    mkdir -p "$BACKUP_DIR$(dirname "$p")"
    cp -a "$p" "$BACKUP_DIR$p"
  fi
}

write_file() {
  local path="$1"
  local mode="$2"
  local owner="${3:-root:root}"
  local tmp
  tmp="$(mktemp)"
  cat > "$tmp"
  backup_path "$path"
  install -D -m "$mode" -o "${owner%:*}" -g "${owner#*:}" "$tmp" "$path"
  rm -f "$tmp"
}

append_once() {
  local path="$1"
  local needle="$2"
  local line="$3"
  backup_path "$path"
  touch "$path"
  if ! grep -Fqx "$needle" "$path"; then
    printf '%s\n' "$line" >> "$path"
  fi
}

choose_qdisc() {
  local dev
  dev="$(ip route show default 2>/dev/null | awk '{print $5; exit}')"
  if [[ -n "$dev" ]] && tc qdisc show dev "$dev" 2>/dev/null | grep -qw fq; then
    printf 'fq'
  else
    printf 'fq_codel'
  fi
}

choose_cc() {
  modprobe tcp_bbr 2>/dev/null || true
  if grep -qw bbr /proc/sys/net/ipv4/tcp_available_congestion_control 2>/dev/null; then
    printf 'bbr'
  else
    cat /proc/sys/net/ipv4/tcp_congestion_control
  fi
}

QDISC="$(choose_qdisc)"
CC="$(choose_cc)"

write_file /etc/sysctl.d/99-edge-small-vps-network.conf 0644 <<EOF_SYSCTL
# Managed by GPTAdmin: small VPS, high connection count, low RAM/disk profile.
# Conservative for 1 CPU / ~1GB RAM smart-edge nodes.
fs.nr_open = 1048576

# Listen queues / SYN pressure.
net.core.somaxconn = 65535
net.core.netdev_max_backlog = 16384
net.ipv4.tcp_max_syn_backlog = 65535
net.ipv4.tcp_syncookies = 1

# Ephemeral outbound ports and TCP lifecycle.
net.ipv4.ip_local_port_range = 10000 65535
net.ipv4.tcp_fin_timeout = 15
net.ipv4.tcp_tw_reuse = 2
net.ipv4.tcp_max_tw_buckets = 262144
net.ipv4.tcp_slow_start_after_idle = 0
net.ipv4.tcp_mtu_probing = 1

# Keep dead mobile connections from living for hours.
net.ipv4.tcp_keepalive_time = 600
net.ipv4.tcp_keepalive_intvl = 30
net.ipv4.tcp_keepalive_probes = 5

# Moderate per-socket max buffers for 1GB VPS.
net.core.rmem_max = 16777216
net.core.wmem_max = 16777216
net.ipv4.tcp_rmem = 4096 87380 8388608
net.ipv4.tcp_wmem = 4096 65536 8388608

# Latency/throughput.
net.core.default_qdisc = ${QDISC}
net.ipv4.tcp_congestion_control = ${CC}
net.ipv4.tcp_fastopen = 3

# Memory/disk writeback.
vm.swappiness = 10
vm.vfs_cache_pressure = 150
vm.dirty_background_ratio = 5
vm.dirty_ratio = 10
EOF_SYSCTL

write_file /etc/security/limits.d/99-edge-nofile.conf 0644 <<'EOF_LIMITS'
# Managed by GPTAdmin: allow many nginx/xray/gptadmin sockets.
* soft nofile 1048576
* hard nofile 1048576
root soft nofile 1048576
root hard nofile 1048576
www-data soft nofile 1048576
www-data hard nofile 1048576
nobody soft nofile 1048576
nobody hard nofile 1048576
EOF_LIMITS

for svc in nginx xray smart-edge gptadmin-shellmcp gptadmin-rootd; do
  mkdir -p "/etc/systemd/system/${svc}.service.d"
  write_file "/etc/systemd/system/${svc}.service.d/90-edge-limits.conf" 0644 <<'EOF_LIMIT_DROPIN'
[Service]
LimitNOFILE=1048576
TasksMax=infinity
EOF_LIMIT_DROPIN
done

mkdir -p /etc/systemd/journald.conf.d
write_file /etc/systemd/journald.conf.d/90-edge-tight.conf 0644 <<'EOF_JOURNALD'
# Managed by GPTAdmin: hard journal limits for tiny VPS disks/RAM.
[Journal]
Storage=persistent
Compress=yes
SystemMaxUse=64M
SystemKeepFree=512M
SystemMaxFileSize=16M
SystemMaxFiles=8
RuntimeMaxUse=32M
RuntimeMaxFileSize=8M
MaxRetentionSec=7day
MaxFileSec=1day
RateLimitIntervalSec=30s
RateLimitBurst=2000
ForwardToSyslog=no
MaxLevelStore=info
EOF_JOURNALD

write_file /etc/logrotate.d/nginx 0644 <<'EOF_LOGROTATE_NGINX'
/var/log/nginx/*.log {
    daily
    rotate 3
    maxsize 20M
    missingok
    notifempty
    compress
    delaycompress
    dateext
    create 0640 www-data adm
    sharedscripts
    postrotate
        if [ -s /run/nginx.pid ]; then
            kill -USR1 `cat /run/nginx.pid`
        fi
    endscript
}
EOF_LOGROTATE_NGINX

write_file /etc/logrotate.d/edge-hard 0644 <<'EOF_LOGROTATE_EDGE'
/var/log/gptadmin*.log /var/log/xray*.log /var/log/smart-edge*.log /var/log/*-access.log /var/log/*-error.log {
    daily
    rotate 3
    maxsize 20M
    missingok
    notifempty
    compress
    delaycompress
    dateext
    copytruncate
}
EOF_LOGROTATE_EDGE

write_file /etc/logrotate.d/btmp 0644 <<'EOF_LOGROTATE_BTMP'
/var/log/btmp {
    daily
    rotate 2
    maxsize 10M
    missingok
    create 0600 root utmp
    compress
    delaycompress
}
EOF_LOGROTATE_BTMP

write_file /etc/logrotate.d/wtmp 0644 <<'EOF_LOGROTATE_WTMP'
/var/log/wtmp {
    weekly
    rotate 2
    maxsize 10M
    missingok
    create 0664 root utmp
    compress
    delaycompress
}
EOF_LOGROTATE_WTMP

write_file /usr/local/sbin/edge-cleanup 0755 <<'EOF_CLEANUP'
#!/bin/sh
set -eu
/usr/bin/journalctl --vacuum-size=64M --vacuum-time=7d >/dev/null 2>&1 || true
/usr/bin/apt-get clean >/dev/null 2>&1 || true
rm -rf /var/cache/apt/archives/*.deb /var/cache/apt/*.bin 2>/dev/null || true
rm -rf /var/lib/apt/lists/* 2>/dev/null || true
find /var/log -type f \( -name '*.gz' -o -name '*.old' -o -name '*.1' -o -name '*.2' -o -name '*.3' \) -mtime +7 -delete 2>/dev/null || true
find /tmp /var/tmp -xdev -type f -mtime +3 -delete 2>/dev/null || true
find /tmp /var/tmp -xdev -type d -empty -mtime +3 -delete 2>/dev/null || true
EOF_CLEANUP

write_file /etc/systemd/system/edge-cleanup.service 0644 <<'EOF_CLEANUP_SERVICE'
[Unit]
Description=GPTAdmin edge cleanup for tiny VPS

[Service]
Type=oneshot
ExecStart=/usr/local/sbin/edge-cleanup
Nice=10
IOSchedulingClass=idle
EOF_CLEANUP_SERVICE

write_file /etc/systemd/system/edge-cleanup.timer 0644 <<'EOF_CLEANUP_TIMER'
[Unit]
Description=Run GPTAdmin edge cleanup daily

[Timer]
OnCalendar=daily
RandomizedDelaySec=30m
Persistent=true

[Install]
WantedBy=timers.target
EOF_CLEANUP_TIMER

if [[ "$ENABLE_SWAP" -eq 1 ]] && ! swapon --show=NAME --noheadings | grep -q .; then
  backup_path /etc/fstab
  if ! swapon --show=NAME --noheadings | grep -qx '/swapfile'; then
    echo "Creating /swapfile ${SWAP_SIZE}"
    fallocate -l "$SWAP_SIZE" /swapfile 2>/dev/null || dd if=/dev/zero of=/swapfile bs=1M count="$(numfmt --from=iec "$SWAP_SIZE" | awk '{print int($1/1024/1024)}')" status=none
    chmod 600 /swapfile
    mkswap /swapfile >/dev/null
    swapon /swapfile
  fi
  append_once /etc/fstab '/swapfile none swap sw 0 0' '/swapfile none swap sw 0 0'
fi

if [[ "$DISABLE_SERVICES" -eq 1 ]]; then
  for svc in snapd.service snapd.socket packagekit.service ModemManager.service multipathd.service apport.service unattended-upgrades.service; do
    if systemctl list-unit-files "$svc" --no-legend 2>/dev/null | grep -q .; then
      systemctl disable --now "$svc" >/dev/null 2>&1 || true
    fi
  done
fi

sysctl --system >/tmp/edge-sysctl-apply.out 2>&1 || { cat /tmp/edge-sysctl-apply.out; exit 1; }
systemd-analyze verify /etc/systemd/system/edge-cleanup.service /etc/systemd/system/edge-cleanup.timer
systemctl daemon-reload
systemctl enable --now edge-cleanup.timer >/dev/null
systemctl restart systemd-journald

if [[ "$CLEAN_NOW" -eq 1 ]]; then
  /usr/local/sbin/edge-cleanup
  : > /var/log/btmp 2>/dev/null || true
fi

logrotate -d /etc/logrotate.conf >/tmp/edge-logrotate-debug.out 2>&1 || {
  tail -80 /tmp/edge-logrotate-debug.out >&2
  exit 1
}

for svc in nginx xray smart-edge; do
  if systemctl list-unit-files "${svc}.service" --no-legend 2>/dev/null | grep -q .; then
    systemctl restart "$svc" || systemctl reload "$svc" || true
  fi
done

cat <<EOF_DONE
Applied edge small VPS profile.
Backup: ${BACKUP_DIR}
Run checks:
  sudo $(dirname "$0")/edge-small-vps-check.sh
EOF_DONE

#!/usr/bin/env bash
# Preview or apply the canonical vpn2 conntrack policy without restarting Xray.
set -euo pipefail

MODE="${1:-preview}"
case "$MODE" in preview|apply) ;; *) echo "usage: $0 [preview|apply]" >&2; exit 2 ;; esac

SCRIPT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
ROOT_DIR="$(cd -- "$SCRIPT_DIR/.." && pwd)"
SYSCTL="$ROOT_DIR/deploy/vpn2/sysctl/99-vpn2-nf-tune.conf"
MODPROBE="$ROOT_DIR/deploy/vpn2/modprobe.d/nf_conntrack-hashsize.conf"
REMOTE="${VPN2_CONNTRACK_HOST:-root@vpn2.bezrabotnyi.com}"
SSH=(ssh -o BatchMode=yes -o ConnectTimeout=10 -i /home/roomhacker/.ssh/id_rsa "$REMOTE")

grep -Fx 'net.netfilter.nf_conntrack_max = 65536' "$SYSCTL" >/dev/null
grep -Fx 'net.netfilter.nf_conntrack_tcp_timeout_established = 86400' "$SYSCTL" >/dev/null
grep -Fx 'net.netfilter.nf_conntrack_tcp_timeout_time_wait = 15' "$SYSCTL" >/dev/null
grep -Fx 'options nf_conntrack hashsize=16384' "$MODPROBE" >/dev/null

if [[ "$MODE" == preview ]]; then
  printf 'vpn2 conntrack policy: valid; no remote change\n'
  exit 0
fi

: "${VPN2_CONNTRACK_LIVE_APPROVED:?set VPN2_CONNTRACK_LIVE_APPROVED=1 to apply}"
[[ "$VPN2_CONNTRACK_LIVE_APPROVED" == 1 ]] || { echo 'approval must equal 1' >&2; exit 2; }

SYSCTL_B64="$(base64 -w 0 "$SYSCTL")"
MODPROBE_B64="$(base64 -w 0 "$MODPROBE")"
"${SSH[@]}" "set -euo pipefail
stamp=\$(date -u +%Y%m%d_%H%M%S)
backup() { test ! -e \"\$1\" || cp -a \"\$1\" \"\$1.bak_conntrack_\$stamp\"; }
sysctl_path=/etc/sysctl.d/99-vpn2-nf-tune.conf
modprobe_path=/etc/modprobe.d/nf_conntrack-hashsize.conf
backup \"\$sysctl_path\"
backup \"\$modprobe_path\"
printf %s '$SYSCTL_B64' | base64 -d > \"\$sysctl_path.pending\"
printf %s '$MODPROBE_B64' | base64 -d > \"\$modprobe_path.pending\"
install -m 0644 \"\$sysctl_path.pending\" \"\$sysctl_path\"
install -m 0644 \"\$modprobe_path.pending\" \"\$modprobe_path\"
rm -f \"\$sysctl_path.pending\" \"\$modprobe_path.pending\"
sysctl -p \"\$sysctl_path\"
test \"\$(cat /sys/module/nf_conntrack/parameters/hashsize)\" = 16384 || printf '%s\\n' 16384 > /sys/module/nf_conntrack/parameters/hashsize
test \"\$(cat /sys/module/nf_conntrack/parameters/hashsize)\" = 16384
test \"\$(sysctl -n net.netfilter.nf_conntrack_max)\" = 65536
"

printf 'vpn2 conntrack policy: applied and verified\n'

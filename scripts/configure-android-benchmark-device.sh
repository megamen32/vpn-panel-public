#!/usr/bin/env bash
# Provision the Samsung benchmark phone as a 4G data-plane and Wi-Fi ADB control-plane device.
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"
DEVICE_SERIAL="${ANDROID_DEVICE_SERIAL:-R5CR702SRFP}"
DEVICE_MAC="${ANDROID_DEVICE_WIFI_MAC:-f4:02:28:58:08:c1}"
DEVICE_IP="${ANDROID_DEVICE_WIFI_IP:-192.168.2.243}"
FIXED_PORT="${ANDROID_ADB_FIXED_PORT:-5555}"
ADB_BIN="${ADB_BIN:-/usr/local/bin/adb}"
SERVER44="${ANDROID_ADB_SERVER44:-roomhacker@192.168.2.5}"
ROUTER="${ANDROID_BENCHMARK_ROUTER:-root@192.168.2.1}"
PACKAGE="com.bezrabotnyi.vpntestagent"

deploy_reconnect_local() {
  sudo install -m 0755 "$SCRIPT_DIR/android-adb-usb-watchdog.sh" /usr/local/sbin/android-adb-usb-watchdog
  sudo install -m 0644 "$REPO_DIR/deploy/server-100/systemd/android-adb-reconnect.service" /etc/systemd/system/android-adb-reconnect.service
  sudo install -m 0644 "$REPO_DIR/deploy/server-100/systemd/android-adb-reconnect.timer" /etc/systemd/system/android-adb-reconnect.timer
  sudo install -m 0755 "$SCRIPT_DIR/android-rndis-traffic-monitor.sh" /usr/local/sbin/android-rndis-traffic-monitor
  sudo install -m 0644 "$REPO_DIR/deploy/server-100/systemd/android-rndis-traffic-monitor.service" /etc/systemd/system/android-rndis-traffic-monitor.service
  sudo install -m 0644 "$REPO_DIR/deploy/server-100/systemd/android-rndis-traffic-monitor.timer" /etc/systemd/system/android-rndis-traffic-monitor.timer
  sudo systemctl daemon-reload
  sudo systemctl enable --now android-adb-reconnect.timer
  sudo systemctl enable --now android-rndis-traffic-monitor.timer
}

deploy_reconnect_server44() {
  local remote_dir
  remote_dir="$(ssh -o BatchMode=yes "$SERVER44" mktemp -d /tmp/android-adb-reconnect-XXXXXX)"
  scp -q "$SCRIPT_DIR/android-adb-reconnect.sh" "$REPO_DIR/deploy/server-44/systemd/android-adb-reconnect.service" \
    "$REPO_DIR/deploy/server-44/systemd/android-adb-reconnect.timer" "$SERVER44:$remote_dir/"
  ssh -o BatchMode=yes "$SERVER44" bash -s -- "$remote_dir" <<'REMOTE'
set -euo pipefail
remote_dir="$1"
sudo install -m 0755 "$remote_dir/android-adb-reconnect.sh" /usr/local/sbin/android-adb-reconnect
sudo install -m 0644 "$remote_dir/android-adb-reconnect.service" /etc/systemd/system/android-adb-reconnect.service
sudo install -m 0644 "$remote_dir/android-adb-reconnect.timer" /etc/systemd/system/android-adb-reconnect.timer
sudo systemctl daemon-reload
sudo systemctl enable --now android-adb-reconnect.timer
rm -rf "$remote_dir"
REMOTE
}

install_agent_from_server44() {
  local remote_dir
  remote_dir="$(ssh -o BatchMode=yes "$SERVER44" mktemp -d /tmp/vpn-benchmark-agent-XXXXXX)"
  scp -q -r "$REPO_DIR/android-test-agent" "$SERVER44:$remote_dir/"
  ssh -o BatchMode=yes "$SERVER44" bash -s -- "$remote_dir" "$DEVICE_IP:$FIXED_PORT" <<'REMOTE'
set -euo pipefail
remote_dir="$1"
endpoint="$2"
apk="$(bash "$remote_dir/android-test-agent/build.sh")"
/usr/local/bin/adb connect "$endpoint" >/dev/null
/usr/local/bin/adb -s "$endpoint" install -r "$apk" >/dev/null
rm -rf "$remote_dir"
REMOTE
}

configure_phone() {
  local endpoint="$DEVICE_IP:$FIXED_PORT"
  "$ADB_BIN" connect "$endpoint" >/dev/null
  local adb=("$ADB_BIN" -s "$endpoint")
  "${adb[@]}" shell settings put global adb_wifi_enabled 1
  "${adb[@]}" shell settings put global adb_allowed_connection_time 0
  "${adb[@]}" shell settings put global mobile_data_always_on 1
  "${adb[@]}" shell settings put global network_avoid_bad_wifi 1
  "${adb[@]}" shell settings put global wifi_sleep_policy 2
  "${adb[@]}" shell settings put global wifi_scan_always_enabled 1
  "${adb[@]}" shell settings put global wifi_wakeup_enabled 1
  "${adb[@]}" shell settings put global wifi_watchdog_poor_network_test_enabled 1
  "${adb[@]}" shell settings put global wifi_switch_to_mobile_data_super_aggressive_mode_on 1
  "${adb[@]}" shell settings put global stay_on_while_plugged_in 0
  "${adb[@]}" shell settings put system screen_off_timeout 300000
  "${adb[@]}" shell settings put global protect_battery 1
  "${adb[@]}" shell svc wifi enable
  "${adb[@]}" shell svc data enable
  "${adb[@]}" shell cmd wifi set-connected-score 0 >/dev/null
  "${adb[@]}" shell cmd deviceidle whitelist "+$PACKAGE" >/dev/null
  "${adb[@]}" shell cmd appops set "$PACKAGE" AUTO_REVOKE_PERMISSIONS_IF_UNUSED ignore >/dev/null 2>&1 || true
  "${adb[@]}" shell am start-foreground-service -n "$PACKAGE/.BenchmarkDeviceService" >/dev/null
}

configure_router() {
  ssh -o BatchMode=yes "$ROUTER" sh -s -- "$DEVICE_MAC" "$DEVICE_IP" <<'REMOTE'
set -eu
device_mac="$1"
device_ip="$2"
timestamp="$(date -u +%Y%m%dT%H%M%SZ)"
backup_dir="/root/vpn-panel-backups/android-benchmark-$timestamp"
mkdir -p "$backup_dir"
cp /etc/config/firewall "$backup_dir/firewall"
cp /etc/config/dhcp "$backup_dir/dhcp"

rollback() {
  cp "$backup_dir/firewall" /etc/config/firewall
  cp "$backup_dir/dhcp" /etc/config/dhcp
  /etc/init.d/firewall reload >/dev/null 2>&1 || true
  /etc/init.d/dnsmasq restart >/dev/null 2>&1 || true
}

uci -q delete dhcp.samsung_vpn_test || true
uci set dhcp.samsung_vpn_test='host'
uci set dhcp.samsung_vpn_test.name='samsung-vpn-test'
uci set dhcp.samsung_vpn_test.mac="$device_mac"
uci set dhcp.samsung_vpn_test.ip="$device_ip"

# Keep Wi-Fi as a LAN-only control plane. Samsung firmware force-prefers every
# validated Wi-Fi network, even after Android's connected score is set to zero.
# Rejecting WAN only for this reserved address makes cellular the data plane
# without changing Wi-Fi or wired behavior for any other LAN client.
uci -q delete firewall.samsung_vpn_test_block_wan || true
uci set firewall.samsung_vpn_test_block_wan='rule'
uci set firewall.samsung_vpn_test_block_wan.name='Samsung benchmark: keep MGTS on 4G'
uci set firewall.samsung_vpn_test_block_wan.src='lan'
uci set firewall.samsung_vpn_test_block_wan.dest='wan'
uci set firewall.samsung_vpn_test_block_wan.src_ip="$device_ip"
uci set firewall.samsung_vpn_test_block_wan.proto='all'
uci set firewall.samsung_vpn_test_block_wan.target='REJECT'

uci -q delete firewall.samsung_vpn_test_block_wanb || true
uci set firewall.samsung_vpn_test_block_wanb='rule'
uci set firewall.samsung_vpn_test_block_wanb.name='Samsung benchmark: keep Beeline on 4G'
uci set firewall.samsung_vpn_test_block_wanb.src='lan'
uci set firewall.samsung_vpn_test_block_wanb.dest='wanb'
uci set firewall.samsung_vpn_test_block_wanb.src_ip="$device_ip"
uci set firewall.samsung_vpn_test_block_wanb.proto='all'
uci set firewall.samsung_vpn_test_block_wanb.target='REJECT'

uci commit dhcp
uci commit firewall
if ! fw4 check >&2; then
  rollback
  echo "OpenWrt firewall validation failed; restored $backup_dir" >&2
  exit 1
fi
if ! /etc/init.d/firewall reload; then
  rollback
  echo "OpenWrt firewall reload failed; restored $backup_dir" >&2
  exit 1
fi
/etc/init.d/dnsmasq restart
echo "$backup_dir"
REMOTE
}

deploy_reconnect_local
deploy_reconnect_server44
ssh -o BatchMode=yes "$SERVER44" 'sudo systemctl reset-failed android-adb-reconnect.service || true; sudo systemctl start android-adb-reconnect.service || true'
for _ in {1..20}; do
  "$ADB_BIN" disconnect "$DEVICE_IP:$FIXED_PORT" >/dev/null 2>&1 || true
  "$ADB_BIN" connect "$DEVICE_IP:$FIXED_PORT" >/dev/null 2>&1 || true
  if [[ "$("$ADB_BIN" -s "$DEVICE_IP:$FIXED_PORT" get-state 2>/dev/null || true)" == "device" ]]; then break; fi
  sleep 1
done
endpoint="$(ANDROID_DEVICE_SERIAL="$DEVICE_SERIAL" ANDROID_ADB_FIXED_PORT="$FIXED_PORT" ANDROID_ADB_PROMOTE_FIXED_PORT=0 "$SCRIPT_DIR/android-adb-reconnect.sh")"
[[ "$endpoint" == "$DEVICE_IP:$FIXED_PORT" ]] || { echo "unexpected Android endpoint: $endpoint" >&2; exit 1; }
sudo systemctl reset-failed android-adb-reconnect.service || true
sudo systemctl start android-adb-reconnect.service || true
"$ADB_BIN" connect "$DEVICE_IP:$FIXED_PORT" >/dev/null
[[ "$("$ADB_BIN" -s "$DEVICE_IP:$FIXED_PORT" get-state 2>/dev/null || true)" == "device" ]] || {
  echo "ADB watchdogs did not leave $DEVICE_IP:$FIXED_PORT reachable" >&2
  exit 1
}
install_agent_from_server44
configure_phone
router_backup="$(configure_router)"
"$ADB_BIN" -s "$DEVICE_IP:$FIXED_PORT" shell input keyevent 223
echo "Android endpoint: $DEVICE_IP:$FIXED_PORT"
echo "OpenWrt backup: $router_backup"

#!/usr/bin/env bash
# Keep the dedicated Android benchmark device on a predictable ADB-over-Wi-Fi port.
set -euo pipefail

ADB_BIN="${ADB_BIN:-/usr/local/bin/adb}"
DEVICE_SERIAL="${ANDROID_DEVICE_SERIAL:-R5CR702SRFP}"
DEVICE_IP="${ANDROID_DEVICE_WIFI_IP:-192.168.2.243}"
FIXED_PORT="${ANDROID_ADB_FIXED_PORT:-5555}"
PROMOTE_FIXED_PORT="${ANDROID_ADB_PROMOTE_FIXED_PORT:-1}"
ADB_COMMAND_TIMEOUT="${ANDROID_ADB_COMMAND_TIMEOUT:-3}"
STATE_DIR="${ANDROID_ADB_STATE_DIR:-${HOME}/.local/state/android-adb-reconnect}"
STATE_FILE="$STATE_DIR/endpoint"
mkdir -p "$STATE_DIR"
fixed_endpoint="$DEVICE_IP:$FIXED_PORT"

adb_command() {
  timeout --foreground "$ADB_COMMAND_TIMEOUT" "$ADB_BIN" "$@"
}

wifi_ipv4() {
  local adb_serial="$1"
  adb_command -s "$adb_serial" shell ip -4 addr show wlan0 2>/dev/null | tr -d '\r' | awk '/inet / {print $2; exit}' | cut -d/ -f1
}

is_target_device() {
  local adb_serial="$1"
  [[ "$(adb_command -s "$adb_serial" get-state 2>/dev/null || true)" == "device" ]] || return 1
  [[ "$(adb_command -s "$adb_serial" shell getprop ro.serialno 2>/dev/null | tr -d '\r')" == "$DEVICE_SERIAL" ]]
}

connect_endpoint() {
  local endpoint="$1"
  adb_command connect "$endpoint" >/dev/null 2>&1 || true
}

recover_fixed_endpoint() {
  connect_endpoint "$fixed_endpoint"
  if is_target_device "$fixed_endpoint"; then return 0; fi
  # ADB keeps stale transports as "offline" across adbd restarts. Clearing only
  # this host's transport is safe and avoids repeatedly restarting adbd. The
  # USB-owning promoter falls back quickly; remote observers wait longer for
  # the fixed port to settle after server-44 restarts adbd.
  adb_command disconnect "$fixed_endpoint" >/dev/null 2>&1 || true
  local recovery_attempts=5
  if [[ "$PROMOTE_FIXED_PORT" == "1" ]]; then recovery_attempts=1; fi
  for ((attempt = 0; attempt < recovery_attempts; attempt++)); do
    sleep 0.5
    connect_endpoint "$fixed_endpoint"
    if is_target_device "$fixed_endpoint"; then return 0; fi
  done
  return 1
}

target=""
if recover_fixed_endpoint; then target="$fixed_endpoint"; fi
while read -r adb_serial state _; do
  [[ -z "$target" ]] || break
  [[ "$state" == "device" ]] || continue
  if is_target_device "$adb_serial"; then target="$adb_serial"; break; fi
done < <(adb_command devices -l | tail -n +2)

if [[ -z "$target" ]]; then
  while read -r service_name service_type endpoint; do
    [[ "$service_type" == "_adb-tls-connect._tcp" ]] || continue
    [[ "$service_name" == *"$DEVICE_SERIAL"* ]] || continue
    connect_endpoint "$endpoint"
  done < <(adb_command mdns services)
  while read -r adb_serial state _; do
    [[ "$state" == "device" ]] || continue
    if is_target_device "$adb_serial"; then target="$adb_serial"; break; fi
  done < <(adb_command devices -l | tail -n +2)
fi

if [[ -z "$target" ]]; then
  echo "Android $DEVICE_SERIAL is not advertising Wireless debugging yet" >&2
  exit 1
fi

device_ip="$(wifi_ipv4 "$target")"
if [[ -z "$device_ip" ]]; then
  # The phone is normally still reachable over its permanent USB cable on
  # server-44. Samsung will not autojoin a known LAN-only network while bad
  # Wi-Fi avoidance is active, so permit the join before scanning. OpenWrt's
  # per-device WAN reject prevents leakage. Wait for DHCP here so this same
  # run can restore avoidance, LTE priority, and fixed-port adbd.
  adb_command -s "$target" shell settings put global network_avoid_bad_wifi 0
  adb_command -s "$target" shell svc wifi enable >/dev/null
  for _ in {1..10}; do
    adb_command -s "$target" shell cmd wifi start-scan >/dev/null 2>&1 || true
    sleep 1
    device_ip="$(wifi_ipv4 "$target")"
    [[ -n "$device_ip" ]] && break
  done
  if [[ -z "$device_ip" ]]; then
    echo "Android $DEVICE_SERIAL has no wlan0 IPv4 address" >&2
    exit 1
  fi
fi

fixed_endpoint="$device_ip:$FIXED_PORT"
if [[ "$target" != "$fixed_endpoint" ]]; then
  adb_command -s "$target" shell settings put global network_avoid_bad_wifi 1
  adb_command -s "$target" shell cmd wifi set-connected-score 0 >/dev/null
  if [[ "$PROMOTE_FIXED_PORT" != "1" ]]; then
    echo "Android $DEVICE_SERIAL is reachable at $target; waiting for server-44 to promote $fixed_endpoint" >&2
    exit 0
  fi
  adb_command -s "$target" tcpip "$FIXED_PORT" >/dev/null
  adb_command disconnect "$fixed_endpoint" >/dev/null 2>&1 || true
  for _ in {1..10}; do
    sleep 0.5
    connect_endpoint "$fixed_endpoint"
    if is_target_device "$fixed_endpoint"; then break; fi
  done
fi
if ! is_target_device "$fixed_endpoint"; then
  echo "Android $DEVICE_SERIAL did not accept ADB on $fixed_endpoint" >&2
  exit 1
fi
adb_command -s "$fixed_endpoint" shell settings put global network_avoid_bad_wifi 1
adb_command -s "$fixed_endpoint" shell cmd wifi set-connected-score 0 >/dev/null

printf '%s\n' "$fixed_endpoint" > "$STATE_FILE"
echo "$fixed_endpoint"

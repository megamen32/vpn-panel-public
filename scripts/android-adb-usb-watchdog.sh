#!/usr/bin/env bash
# Keep host-side ADB usable without changing the phone's USB modem functions.
set -euo pipefail

ADB_BIN="${ADB_BIN:-/usr/local/bin/adb}"
LSUSB_BIN="${LSUSB_BIN:-/usr/bin/lsusb}"
DEVICE_SERIAL="${ANDROID_DEVICE_SERIAL:-R5CR702SRFP}"
ADB_COMMAND_TIMEOUT="${ANDROID_ADB_COMMAND_TIMEOUT:-5}"
USB_VENDOR_PRODUCT_REGEX="${ANDROID_USB_VENDOR_PRODUCT_REGEX:-04e8:(6860|6864)}"
STATE_DIR="${ANDROID_ADB_WATCHDOG_STATE_DIR:-/var/lib/android-adb-reconnect}"
STATE_FILE="$STATE_DIR/transport-state"

mkdir -p "$STATE_DIR"
chmod 700 "$STATE_DIR"

adb_command() {
  timeout --foreground "$ADB_COMMAND_TIMEOUT" "$ADB_BIN" "$@"
}

target_state() {
  local devices
  devices="$(adb_command devices -l 2>/dev/null || true)"
  awk -v serial="$DEVICE_SERIAL" '$1 == serial { print $2; exit }' <<<"$devices"
}

target_is_ready() {
  [[ "$(target_state)" == "device" ]]
}

usb_device_is_present() {
  "$LSUSB_BIN" 2>/dev/null | grep -Eq "ID $USB_VENDOR_PRODUCT_REGEX"
}

log() {
  printf '%s\n' "android-adb-usb-watchdog: $*" >&2
}

log_state_change() {
  local next_state="$1"
  shift
  local previous=""
  [[ -r "$STATE_FILE" ]] && previous="$(<"$STATE_FILE")"
  [[ "$next_state" == "$previous" ]] && return
  local temporary="$STATE_FILE.tmp.$$"
  printf '%s\n' "$next_state" >"$temporary"
  chmod 600 "$temporary"
  mv "$temporary" "$STATE_FILE"
  log "state=$next_state $*"
}

if target_is_ready; then
  log_state_change "USB_ADB_READY" "configured USB ADB transport is ready"
  exit 0
fi

if ! usb_device_is_present; then
  log_state_change "USB_ABSENT" "Samsung USB VID/PID is absent; waiting for cable/device re-enumeration"
  exit 0
fi

adb_command start-server >/dev/null 2>&1 || true
adb_command reconnect usb >/dev/null 2>&1 || true

if target_is_ready; then
  log_state_change "USB_ADB_READY" "USB ADB transport recovered after host reconnect"
  exit 0
fi

if [[ "$(target_state)" == "unauthorized" ]]; then
  log_state_change "USB_ADB_UNAUTHORIZED" "ADB is unauthorized; approve the RSA prompt on Android or re-enumerate the USB cable"
  exit 0
fi

log_state_change "USB_ADB_UNAVAILABLE" "Samsung USB device is present but ADB is unavailable; preserving RNDIS and requiring Android-side USB debugging or replug"
exit 0

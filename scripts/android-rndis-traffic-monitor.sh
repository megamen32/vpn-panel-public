#!/usr/bin/env bash
# Read-only USB RNDIS accounting. Never changes USB, routes, links, or firewall state.
set -euo pipefail

SYS_CLASS_NET_ROOT="${SYS_CLASS_NET_ROOT:-/sys/class/net}"
STATE_FILE="${STATE_FILE:-/var/lib/android-rndis-traffic-monitor/state}"
EVENT_FILE="${EVENT_FILE:-${STATE_FILE}.jsonl}"
INTERVAL_SECONDS="${INTERVAL_SECONDS:-10}"
ITERATIONS="${ITERATIONS:-0}"
SLEEP_BIN="${SLEEP_BIN:-sleep}"
IP_BIN="${IP_BIN:-ip}"
SS_BIN="${SS_BIN:-ss}"

mkdir -p "$(dirname "$STATE_FILE")" "$(dirname "$EVENT_FILE")"
touch "$STATE_FILE" "$EVENT_FILE"

state_get() {
  awk -v wanted="$1" '$1 == wanted { print; exit }' "$STATE_FILE"
}

state_put() {
  local iface="$1" ifindex="$2" epoch="$3" rx="$4" tx="$5" present="$6" tmp
  tmp="$STATE_FILE.tmp.$$"
  awk -v wanted="$iface" '$1 != wanted' "$STATE_FILE" >"$tmp"
  printf '%s %s %s %s %s %s\n' "$iface" "$ifindex" "$epoch" "$rx" "$tx" "$present" >>"$tmp"
  mv "$tmp" "$STATE_FILE"
}

json_string() {
  local value="$1"
  printf '%s' "$value" | perl -0pe 's/\\/\\\\/g; s/"/\\"/g; s/\n/\\n/g; s/\r/\\r/g'
}

interface_context() {
  local iface="$1" addresses routes sockets
  addresses="$($IP_BIN -j -4 addr show dev "$iface" 2>/dev/null | head -c 4096 || true)"
  routes="$($IP_BIN route show dev "$iface" 2>/dev/null | head -c 4096 || true)"
  sockets="$($SS_BIN -H -tunap 2>/dev/null | head -80 | tr '\n' ';' | head -c 8192 || true)"
  printf '%s\t%s\t%s\n' "$addresses" "$routes" "$sockets"
}

emit() {
  local line="$1"
  printf '%s\n' "$line"
  printf '%s\n' "$line" >>"$EVENT_FILE"
}

sample_interface() {
  local dir="$1" iface driver ifindex rx tx address operstate carrier old old_ifindex old_epoch old_rx old_tx old_present epoch reason rx_delta tx_delta context addresses routes sockets
  iface="${dir##*/}"
  [[ "$iface" == enx* ]] || return 0
  [[ -e "$dir/device/driver" ]] || return 0
  driver="$(basename "$(readlink -f "$dir/device/driver")")"
  [[ "$driver" == rndis_host ]] || return 0
  ifindex="$(<"$dir/ifindex")"
  rx="$(<"$dir/statistics/rx_bytes")"
  tx="$(<"$dir/statistics/tx_bytes")"
  address="$(<"$dir/address")"
  operstate="$(<"$dir/operstate")"
  carrier="$(<"$dir/carrier")"
  old="$(state_get "$iface" || true)"
  old_ifindex=""; old_epoch=""; old_rx=""; old_tx=""; old_present=""
  if [[ -n "$old" ]]; then
    read -r _ old_ifindex old_epoch old_rx old_tx old_present <<<"$old"
    [[ -n "$old_present" ]] || old_present=1
  fi
  if [[ -z "$old" || "$old_ifindex" != "$ifindex" || "$old_present" != "1" || "$rx" -lt "$old_rx" || "$tx" -lt "$old_tx" ]]; then
    epoch=$(( ${old_epoch:-0} + 1 )); reason="appearance"; [[ -n "$old" ]] && reason="reset"
    rx_delta=0; tx_delta=0
  else
    epoch="$old_epoch"; reason="sample"; rx_delta=$((rx - old_rx)); tx_delta=$((tx - old_tx))
  fi
  state_put "$iface" "$ifindex" "$epoch" "$rx" "$tx" 1
  if [[ "$reason" != "sample" ]]; then
    context="$(interface_context "$iface")"
    IFS=$'\t' read -r addresses routes sockets <<<"$context"
  else
    addresses=""; routes=""; sockets=""
  fi
  emit "{\"ts\":\"$(date --iso-8601=seconds)\",\"event\":\"sample\",\"interface\":\"$(json_string "$iface")\",\"driver\":\"$driver\",\"ifindex\":$ifindex,\"address\":\"$(json_string "$address")\",\"operstate\":\"$operstate\",\"carrier\":\"$carrier\",\"epoch\":$epoch,\"reason\":\"$reason\",\"rx_bytes\":$rx,\"tx_bytes\":$tx,\"rx_delta\":$rx_delta,\"tx_delta\":$tx_delta,\"addresses\":\"$(json_string "$addresses")\",\"routes\":\"$(json_string "$routes")\",\"sockets\":\"$(json_string "$sockets")\"}"
}

mark_disappeared() {
  local iface="$1" old old_ifindex old_epoch old_rx old_tx old_present context addresses routes sockets
  old="$(state_get "$iface" || true)"
  [[ -n "$old" ]] || return 0
  read -r _ old_ifindex old_epoch old_rx old_tx old_present <<<"$old"
  [[ "$old_present" == "1" ]] || return 0
  state_put "$iface" "$old_ifindex" "$old_epoch" "$old_rx" "$old_tx" 0
  emit "{\"ts\":\"$(date --iso-8601=seconds)\",\"event\":\"disappearance\",\"interface\":\"$(json_string "$iface")\",\"ifindex\":$old_ifindex,\"epoch\":$old_epoch,\"rx_bytes\":$old_rx,\"tx_bytes\":$old_tx,\"reason\":\"interface_missing\"}"
}

iteration=0
while (( ITERATIONS == 0 || iteration < ITERATIONS )); do
  declare -A found=()
  for dir in "$SYS_CLASS_NET_ROOT"/enx*; do
    [[ -d "$dir" ]] || continue
    iface="${dir##*/}"
    [[ -e "$dir/device/driver" ]] || continue
    driver="$(basename "$(readlink -f "$dir/device/driver")")"
    [[ "$driver" == "rndis_host" ]] || continue
    found["$iface"]=1
    sample_interface "$dir"
  done
  while read -r iface _; do
    [[ -n "${iface:-}" ]] || continue
    [[ -n "${found[$iface]:-}" ]] || mark_disappeared "$iface"
  done <"$STATE_FILE"
  iteration=$((iteration + 1))
  (( ITERATIONS != 0 && iteration >= ITERATIONS )) || "$SLEEP_BIN" "$INTERVAL_SECONDS"
done

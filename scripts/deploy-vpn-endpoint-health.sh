#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"
UNIT_DIR="$REPO_DIR/deploy/server-100/systemd"
# The controller ships two timers: a recurring pass over the endpoints a
# subscription can sell, and a periodic exploration pass over every endpoint
# configured for a client. Deploying only the first leaves the second to drift
# away from the repository, so every unit below is owned by this script.
UNIT_NAMES=(
  vpn-endpoint-check.service
  vpn-endpoint-check.timer
  vpn-endpoint-check-explore.service
  vpn-endpoint-check-explore.timer
)
UNITS=()
for unit in "${UNIT_NAMES[@]}"; do UNITS+=("$UNIT_DIR/$unit"); done
SYSTEMD_DIR="${VPN_ENDPOINT_HEALTH_SYSTEMD_DIR:-/etc/systemd/system}"
RUNTIME_DIR="${VPN_ENDPOINT_HEALTH_RUNTIME_DIR:-/usr/local/lib/vpn-panel}"
UNIT_TARGETS=()
for unit in "${UNIT_NAMES[@]}"; do UNIT_TARGETS+=("$SYSTEMD_DIR/$unit"); done
SERVICE_TARGET="$SYSTEMD_DIR/vpn-endpoint-check.service"
TIMER_TARGET="$SYSTEMD_DIR/vpn-endpoint-check.timer"
SECURE_DIR="${VPN_ENDPOINT_HEALTH_SECURE_DIR:-/etc/vpn-panel}"
SECURE_FILE="$SECURE_DIR/secure.json"
RECEIPT_ROOT="${VPN_ENDPOINT_HEALTH_RECEIPT_ROOT:-/var/lib/vpn-panel/deploy-receipts/endpoint-health}"
RECEIPT_ID="${VPN_ENDPOINT_HEALTH_RECEIPT_ID:-$(date -u +%Y%m%dT%H%M%SZ)-$$}"
SYSTEMD_ANALYZE="${VPN_ENDPOINT_HEALTH_SYSTEMD_ANALYZE:-systemd-analyze}"
ACTION="${1:-preview}"

if [[ ! "$RECEIPT_ID" =~ ^[A-Za-z0-9._-]+$ ]]; then
  echo "Invalid endpoint-health receipt id: $RECEIPT_ID" >&2
  exit 2
fi

verify_sources() {
  bash -n "$SCRIPT_DIR/auto-endpoint-check.sh" "$SCRIPT_DIR/run-network-test.sh"
  local unit
  for unit in "${UNITS[@]}"; do test -s "$unit"; done
  "$SYSTEMD_ANALYZE" verify "${UNITS[@]}"
}

preview() {
  verify_sources
  echo "PREVIEW endpoint health controller"
  echo "ACL: setfacl -m u:roomhacker:--x $SECURE_DIR"
  echo "Units: ${UNIT_TARGETS[*]}"
  echo "Timers: enable --now vpn-endpoint-check.timer vpn-endpoint-check-explore.timer"
  echo "Rollback receipt: $RECEIPT_ROOT/$RECEIPT_ID"
  sudo getfacl -p "$SECURE_DIR"
  if sudo -u roomhacker test -r "$SECURE_FILE"; then
    echo "Current readable preflight: PASS"
  else
    echo "Current readable preflight: FAIL (expected before ACL repair)"
  fi
}

restore_unit() {
  local backup="$1" target="$2" missing_marker="$3"
  if sudo test -e "$backup"; then
    sudo cp -a "$backup" "$target"
  elif sudo test -e "$missing_marker"; then
    sudo rm -f "$target"
  else
    echo "Receipt is missing rollback state for $target" >&2
    return 1
  fi
}

capture_unit_state() {
  local unit="$1" prefix="$2" receipt="$3"
  sudo systemctl is-enabled "$unit" 2>/dev/null | sudo tee "$receipt/$prefix.enabled.before" >/dev/null || true
  sudo systemctl is-active "$unit" 2>/dev/null | sudo tee "$receipt/$prefix.active.before" >/dev/null || true
  sudo test -s "$receipt/$prefix.enabled.before" || echo not-found | sudo tee "$receipt/$prefix.enabled.before" >/dev/null
  sudo test -s "$receipt/$prefix.active.before" || echo inactive | sudo tee "$receipt/$prefix.active.before" >/dev/null
}

restore_unit_state() {
  local unit="$1" prefix="$2" receipt="$3"
  local enabled_state active_state
  enabled_state="$(sudo cat "$receipt/$prefix.enabled.before")"
  active_state="$(sudo cat "$receipt/$prefix.active.before")"
  case "$enabled_state" in
    enabled|enabled-runtime|linked|linked-runtime|alias)
      sudo systemctl enable "$unit" >/dev/null
      ;;
    *)
      sudo systemctl disable "$unit" >/dev/null 2>&1 || true
      ;;
  esac
  if [[ "$active_state" == "active" ]]; then
    sudo systemctl start "$unit"
  else
    sudo systemctl stop "$unit" || true
  fi
}

rollback() {
  local receipt="${1:?rollback requires a receipt directory}"
  sudo test -d "$receipt"
  sudo systemctl stop "${UNIT_NAMES[@]}" || true
  local unit
  for unit in "${UNIT_NAMES[@]}"; do
    restore_unit "$receipt/$unit.before" "$SYSTEMD_DIR/$unit" "$receipt/$unit.missing"
  done
  for script in auto-endpoint-check.sh run-network-test.sh; do
    if sudo test -e "$receipt/$script.before" || sudo test -e "$receipt/$script.missing"; then
      restore_unit "$receipt/$script.before" "$RUNTIME_DIR/$script" "$receipt/$script.missing"
    fi
  done
  sudo systemctl daemon-reload
  sudo setfacl --restore="$receipt/etc-vpn-panel.acl.before"
  # Receipt state is keyed by unit name. A shared "timer"/"service" prefix made
  # the second timer's state overwrite the first, so rollback would restore the
  # wrong answer for whichever unit happened to be captured last.
  local state_unit
  for state_unit in "${UNIT_NAMES[@]}"; do
    restore_unit_state "$state_unit" "$state_unit" "$receipt"
  done
  echo "Rolled back endpoint health controller from $receipt"
}

apply() {
  if [[ "${VPN_ENDPOINT_HEALTH_LIVE_APPROVED:-}" != "1" ]]; then
    echo "Refusing live apply without VPN_ENDPOINT_HEALTH_LIVE_APPROVED=1" >&2
    return 2
  fi
  verify_sources

  local receipt="$RECEIPT_ROOT/$RECEIPT_ID"
  if sudo test -e "$receipt"; then
    echo "Refusing to reuse endpoint-health receipt: $receipt" >&2
    return 2
  fi
  sudo install -d -m 0700 "$receipt"
  sudo getfacl -p "$SECURE_DIR" | sudo tee "$receipt/etc-vpn-panel.acl.before" >/dev/null
  local state_unit
  for state_unit in "${UNIT_NAMES[@]}"; do
    capture_unit_state "$state_unit" "$state_unit" "$receipt"
  done
  for unit in "${UNIT_NAMES[@]}"; do
    if sudo test -e "$SYSTEMD_DIR/$unit"; then
      sudo cp -a "$SYSTEMD_DIR/$unit" "$receipt/$unit.before"
    else
      sudo touch "$receipt/$unit.missing"
    fi
  done

  local applied=0
  for script in auto-endpoint-check.sh run-network-test.sh; do
    if sudo test -e "$RUNTIME_DIR/$script"; then
      sudo cp -a "$RUNTIME_DIR/$script" "$receipt/$script.before"
    else
      sudo touch "$receipt/$script.missing"
    fi
  done
  rollback_on_error() {
    local status=$?
    trap - ERR
    if [[ "$applied" -eq 1 ]]; then rollback "$receipt" || true; fi
    exit "$status"
  }
  trap rollback_on_error ERR

  applied=1
  sudo install -d -m 0755 "$RUNTIME_DIR"
  sudo install -m 0755 "$SCRIPT_DIR/auto-endpoint-check.sh" "$SCRIPT_DIR/run-network-test.sh" "$RUNTIME_DIR/"
  sudo setfacl -m u:roomhacker:--x "$SECURE_DIR"
  sudo -u roomhacker test -r "$SECURE_FILE"
  for unit in "${UNITS[@]}"; do
    sudo install -m 0644 -o root -g root "$unit" "$SYSTEMD_DIR/${unit##*/}"
  done
  sudo systemctl daemon-reload
  sudo systemctl enable --now vpn-endpoint-check.timer vpn-endpoint-check-explore.timer
  sudo systemctl start vpn-endpoint-check.service
  sudo systemctl is-active --quiet vpn-endpoint-check.timer vpn-endpoint-check-explore.timer
  sudo systemctl is-failed --quiet vpn-endpoint-check.service vpn-endpoint-check-explore.service && return 1

  trap - ERR
  echo "Endpoint health controller applied; rollback receipt: $receipt"
}

case "$ACTION" in
  preview) preview ;;
  apply) apply ;;
  rollback) rollback "${2:-}" ;;
  *) echo "Usage: $0 [preview|apply|rollback <receipt>]" >&2; exit 2 ;;
esac

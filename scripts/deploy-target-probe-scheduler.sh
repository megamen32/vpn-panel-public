#!/usr/bin/env bash

set -euo pipefail

script_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
repo_dir="$(cd "$script_dir/.." && pwd)"
systemd_dir="${TARGET_PROBE_SYSTEMD_DIR:-/etc/systemd/system}"
receipt_root="${TARGET_PROBE_RECEIPT_ROOT:-/var/lib/vpn-panel/deploy-receipts/target-probe-scheduler}"
receipt_id="${TARGET_PROBE_RECEIPT_ID:-$(date -u +%Y%m%dT%H%M%SZ)-$$}"
service=target-probe-scheduler.service
timer=target-probe-scheduler.timer
legacy_timer=vpn-endpoint-check.timer
action="${1:-preview}"

verify() {
  python3 -m py_compile "$repo_dir/scripts/run-target-probe-scheduler.py"
  "$repo_dir/scripts/run-target-probe-scheduler.py" --list >/dev/null
  systemd-analyze verify \
    "$repo_dir/deploy/server-100/systemd/$service" \
    "$repo_dir/deploy/server-100/systemd/$timer"
}

capture_unit() {
  local unit="$1" receipt="$2"
  sudo systemctl is-enabled "$unit" 2>/dev/null | sudo tee "$receipt/$unit.enabled.before" >/dev/null || true
  sudo systemctl is-active "$unit" 2>/dev/null | sudo tee "$receipt/$unit.active.before" >/dev/null || true
  sudo test -s "$receipt/$unit.enabled.before" || echo not-found | sudo tee "$receipt/$unit.enabled.before" >/dev/null
  sudo test -s "$receipt/$unit.active.before" || echo inactive | sudo tee "$receipt/$unit.active.before" >/dev/null
  if sudo test -e "$systemd_dir/$unit"; then
    sudo cp -a "$systemd_dir/$unit" "$receipt/$unit.before"
  else
    sudo touch "$receipt/$unit.missing"
  fi
}

restore_unit() {
  local unit="$1" receipt="$2" enabled active
  if sudo test -e "$receipt/$unit.before"; then
    sudo cp -a "$receipt/$unit.before" "$systemd_dir/$unit"
  elif sudo test -e "$receipt/$unit.missing"; then
    sudo rm -f "$systemd_dir/$unit"
  else
    printf 'rollback receipt lacks %s\n' "$unit" >&2
    return 1
  fi
  enabled="$(sudo cat "$receipt/$unit.enabled.before")"
  active="$(sudo cat "$receipt/$unit.active.before")"
  case "$enabled" in enabled|enabled-runtime|linked|linked-runtime|alias) sudo systemctl enable "$unit" >/dev/null ;; *) sudo systemctl disable "$unit" >/dev/null 2>&1 || true ;; esac
  [[ "$active" == active ]] && sudo systemctl start "$unit" || sudo systemctl stop "$unit" || true
}

rollback() {
  local receipt="${2:?rollback requires receipt path}"
  sudo systemctl disable --now "$timer" >/dev/null 2>&1 || true
  for unit in "$service" "$timer" "$legacy_timer"; do restore_unit "$unit" "$receipt"; done
  sudo systemctl daemon-reload
  printf 'Rolled back target probe scheduler from %s\n' "$receipt"
}

case "$action" in
  preview)
    verify
    printf 'Dispatcher wake-up: every 5 minutes; actual cadence: vpn-testing/test-plan.json testTargets[].probeSchedule\n'
    "$repo_dir/scripts/run-target-probe-scheduler.py" --list
    ;;
  apply)
    [[ "${TARGET_PROBE_LIVE_APPROVED:-}" == 1 ]] || { printf 'Set TARGET_PROBE_LIVE_APPROVED=1 for live apply\n' >&2; exit 2; }
    verify
    receipt="$receipt_root/$receipt_id"
    sudo install -d -m 0700 "$receipt"
    for unit in "$service" "$timer" "$legacy_timer"; do capture_unit "$unit" "$receipt"; done
    sudo install -m 0644 "$repo_dir/deploy/server-100/systemd/$service" "$systemd_dir/$service"
    sudo install -m 0644 "$repo_dir/deploy/server-100/systemd/$timer" "$systemd_dir/$timer"
    sudo systemctl disable --now "$legacy_timer" >/dev/null 2>&1 || true
    sudo systemctl daemon-reload
    sudo systemctl enable --now "$timer"
    sudo systemctl start "$service"
    sudo systemctl is-active --quiet "$timer"
    printf 'Target probe scheduler installed; rollback receipt: %s\n' "$receipt"
    ;;
  rollback) rollback "$@" ;;
  *) printf 'Usage: %s preview | apply | rollback RECEIPT\n' "$0" >&2; exit 2 ;;
esac


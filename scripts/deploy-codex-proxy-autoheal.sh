#!/usr/bin/env bash
set -Eeuo pipefail

script_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
repo_dir="$(cd "$script_dir/.." && pwd)"
remote_host="${CODEX_PROXY_AUTOHEAL_REMOTE:-server-44}"
systemd_dir="${CODEX_PROXY_AUTOHEAL_SYSTEMD_DIR:-/etc/systemd/system}"
remote_lib_dir="${CODEX_PROXY_AUTOHEAL_LIB_DIR:-/usr/local/lib/vpn-panel}"
receipt_root="${CODEX_PROXY_AUTOHEAL_RECEIPT_ROOT:-/var/lib/vpn-panel/deploy-receipts/codex-proxy-autoheal}"
stage_root="${CODEX_PROXY_AUTOHEAL_STAGE_ROOT:-/var/lib/vpn-panel/.tmp/codex-proxy-autoheal}"
receipt_id="${CODEX_PROXY_AUTOHEAL_RECEIPT_ID:-$(date -u +%Y%m%dT%H%M%SZ)-$BASHPID}"
artifact_dir="$repo_dir/deploy/server-44/codex-proxy-autoheal"
remote_script="$remote_lib_dir/codex-proxy-autoheal.sh"
service=codex-proxy-autoheal.service
timer=codex-proxy-autoheal.timer
target_service="${CODEX_PROXY_AUTOHEAL_TARGET_SERVICE:-sing-box}"
action="${1:-preview}"

[[ "$receipt_id" =~ ^[A-Za-z0-9._-]+$ ]] || {
  printf 'CODEX_PROXY_AUTOHEAL_RECEIPT_ID has unsupported characters\n' >&2
  exit 2
}
[[ "$target_service" =~ ^[A-Za-z0-9@_.:-]+$ ]] || {
  printf 'CODEX_PROXY_AUTOHEAL_TARGET_SERVICE has unsupported characters\n' >&2
  exit 2
}

verify() {
  local verify_dir
  bash -n "$artifact_dir/codex-proxy-autoheal.sh"
  mkdir -p "$repo_dir/.tmp"
  verify_dir="$(mktemp -d "$repo_dir/.tmp/codex-proxy-autoheal-verify.XXXXXX")"
  sed 's|^ExecStart=.*|ExecStart=/bin/true|' "$artifact_dir/$service" \
    > "$verify_dir/$service"
  install -m 0644 "$artifact_dir/$timer" "$verify_dir/$timer"
  if ! systemd-analyze verify \
    "$verify_dir/$service" \
    "$verify_dir/$timer"; then
    rm -rf "$verify_dir"
    return 1
  fi
  rm -rf "$verify_dir"
}

apply() {
  [[ "${CODEX_PROXY_AUTOHEAL_LIVE_APPROVED:-}" == 1 ]] || {
    printf 'Set CODEX_PROXY_AUTOHEAL_LIVE_APPROVED=1 for live apply\n' >&2
    exit 2
  }
  verify

  local receipt="$receipt_root/$receipt_id"
  local stage="$stage_root/$receipt_id"
  ssh -o BatchMode=yes "$remote_host" \
    "sudo install -d -m 0700 -o roomhacker -g roomhacker '$stage'"
  scp -q -o BatchMode=yes \
    "$artifact_dir/codex-proxy-autoheal.sh" \
    "$artifact_dir/$service" \
    "$artifact_dir/$timer" \
    "$remote_host:$stage/"

  ssh -o BatchMode=yes "$remote_host" \
    "sudo bash -s -- '$stage' '$receipt' '$systemd_dir' '$remote_lib_dir' '$target_service'" <<'REMOTE'
set -Eeuo pipefail
stage="$1"
receipt="$2"
systemd_dir="$3"
remote_lib_dir="$4"
target_service="$5"
service=codex-proxy-autoheal.service
timer=codex-proxy-autoheal.timer
remote_script="$remote_lib_dir/codex-proxy-autoheal.sh"
rendered_service="$stage/codex-proxy-autoheal-rendered.service"

capture_path() {
  local name="$1" path="$2"
  if [[ -e "$path" ]]; then
    cp -a "$path" "$receipt/files/$name"
  else
    : > "$receipt/files/$name.missing"
  fi
}

restore_path() {
  local name="$1" path="$2"
  if [[ -e "$receipt/files/$name" ]]; then
    install -D -m "$(stat -c '%a' "$receipt/files/$name")" \
      "$receipt/files/$name" "$path"
  else
    rm -f "$path"
  fi
}

capture_unit_state() {
  local unit="$1"
  systemctl is-enabled "$unit" > "$receipt/$unit.enabled.before" 2>/dev/null \
    || printf 'disabled\n' > "$receipt/$unit.enabled.before"
  systemctl is-active "$unit" > "$receipt/$unit.active.before" 2>/dev/null \
    || printf 'inactive\n' > "$receipt/$unit.active.before"
}

restore_unit_state() {
  local unit="$1" enabled active
  enabled="$(cat "$receipt/$unit.enabled.before")"
  active="$(cat "$receipt/$unit.active.before")"
  case "$enabled" in
    enabled|enabled-runtime|linked|linked-runtime|alias) systemctl enable "$unit" >/dev/null ;;
    *) systemctl disable "$unit" >/dev/null 2>&1 || true ;;
  esac
  [[ "$active" == active ]] && systemctl start "$unit" || systemctl stop "$unit" || true
}

rollback() {
  systemctl disable --now "$timer" >/dev/null 2>&1 || true
  systemctl stop "$service" >/dev/null 2>&1 || true
  restore_path service "$systemd_dir/$service"
  restore_path timer "$systemd_dir/$timer"
  restore_path script "$remote_script"
  systemctl daemon-reload
  restore_unit_state "$service"
  restore_unit_state "$timer"
}

install -d -m 0700 "$receipt/files"
capture_path service "$systemd_dir/$service"
capture_path timer "$systemd_dir/$timer"
capture_path script "$remote_script"
capture_unit_state "$service"
capture_unit_state "$timer"
trap 'status=$?; rollback; rm -rf "$stage"; exit "$status"' ERR

install -d -m 0755 "$remote_lib_dir"
install -m 0755 "$stage/codex-proxy-autoheal.sh" "$remote_script"
sed -E "s|^Environment=CODEX_PROXY_AUTOHEAL_SERVICE=.*$|Environment=CODEX_PROXY_AUTOHEAL_SERVICE=$target_service|" \
  "$stage/$service" > "$rendered_service"
systemd-analyze verify "$rendered_service" "$stage/$timer"
install -m 0644 "$rendered_service" "$systemd_dir/$service"
install -m 0644 "$stage/$timer" "$systemd_dir/$timer"
rm -rf "$stage"
systemctl daemon-reload
systemctl enable --now "$timer"
systemctl start "$service"
systemctl is-active --quiet "$timer"
trap - ERR
REMOTE
  printf 'Codex proxy autoheal installed; rollback receipt: %s\n' "$receipt"
  printf "Rollback: CODEX_PROXY_AUTOHEAL_REMOTE=%q %q rollback %q\n" \
    "$remote_host" "$0" "$receipt"
}

rollback() {
  local receipt="${2:?rollback requires receipt path}"
  [[ "$receipt" == "$receipt_root/"* ]] || {
    printf 'rollback receipt must be under %s\n' "$receipt_root" >&2
    exit 2
  }
  ssh -o BatchMode=yes "$remote_host" \
    "sudo bash -s -- '$receipt' '$systemd_dir' '$remote_lib_dir'" <<'REMOTE'
set -Eeuo pipefail
receipt="$1"
systemd_dir="$2"
remote_lib_dir="$3"
service=codex-proxy-autoheal.service
timer=codex-proxy-autoheal.timer
remote_script="$remote_lib_dir/codex-proxy-autoheal.sh"

restore_path() {
  local name="$1" path="$2"
  if [[ -e "$receipt/files/$name" ]]; then
    install -D -m "$(stat -c '%a' "$receipt/files/$name")" \
      "$receipt/files/$name" "$path"
  else
    rm -f "$path"
  fi
}

restore_unit_state() {
  local unit="$1" enabled active
  enabled="$(cat "$receipt/$unit.enabled.before")"
  active="$(cat "$receipt/$unit.active.before")"
  case "$enabled" in
    enabled|enabled-runtime|linked|linked-runtime|alias) systemctl enable "$unit" >/dev/null ;;
    *) systemctl disable "$unit" >/dev/null 2>&1 || true ;;
  esac
  [[ "$active" == active ]] && systemctl start "$unit" || systemctl stop "$unit" || true
}

[[ -d "$receipt/files" ]] || {
  printf 'rollback receipt is incomplete: %s\n' "$receipt" >&2
  exit 2
}
systemctl disable --now "$timer" >/dev/null 2>&1 || true
systemctl stop "$service" >/dev/null 2>&1 || true
restore_path service "$systemd_dir/$service"
restore_path timer "$systemd_dir/$timer"
restore_path script "$remote_script"
systemctl daemon-reload
restore_unit_state "$service"
restore_unit_state "$timer"
printf 'Rolled back Codex proxy autoheal from %s\n' "$receipt"
REMOTE
}

case "$action" in
  preview)
    verify
    printf 'Codex proxy autoheal: probe api.openai.com through %s every five minutes; repair service %s\n' \
      "$remote_host" "$target_service"
    ;;
  apply) apply ;;
  rollback) rollback "$@" ;;
  *)
    printf 'Usage: %s [preview|apply|rollback RECEIPT]\n' "$0" >&2
    exit 2
    ;;
esac

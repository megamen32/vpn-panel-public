#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"
UNIT_DIR="$REPO_DIR/deploy/server-100/systemd"
SYSTEMD_DIR="${GITHUB_ROUTE_SYSTEMD_DIR:-/etc/systemd/system}"
SERVICE="$SYSTEMD_DIR/github-route-autoheal.service"
TIMER="$SYSTEMD_DIR/github-route-autoheal.timer"
ACTION="${1:-preview}"

verify() {
  bash -n "$REPO_DIR/scripts/github-route-autoheal.sh"
  bash -n "$0"
  systemd-analyze verify \
    "$UNIT_DIR/github-route-autoheal.service" \
    "$UNIT_DIR/github-route-autoheal.timer"
}

preview() {
  verify
  echo "PREVIEW GitHub route semantic auto-heal"
  echo "Install: $SERVICE $TIMER"
  echo "Enable: github-route-autoheal.timer"
  echo "Rollback: $0 rollback <timestamp>"
}

apply() {
  [[ "${GITHUB_ROUTE_AUTOHEAL_LIVE_APPROVED:-}" == "1" ]] || {
    echo "Refusing live apply without GITHUB_ROUTE_AUTOHEAL_LIVE_APPROVED=1" >&2
    return 2
  }
  verify
  local timestamp
  timestamp="$(date +%Y%m%d_%H%M%S)"
  for target in "$SERVICE" "$TIMER"; do
    if sudo test -e "$target"; then
      sudo cp -a "$target" "${target}.bak_${timestamp}"
    else
      sudo touch "${target}.missing_${timestamp}"
    fi
  done
  sudo install -m 0644 "$UNIT_DIR/github-route-autoheal.service" "$SERVICE"
  sudo install -m 0644 "$UNIT_DIR/github-route-autoheal.timer" "$TIMER"
  sudo install -d -m 0750 -o roomhacker -g roomhacker "$REPO_DIR/data"
  sudo systemctl daemon-reload
  sudo systemctl enable --now github-route-autoheal.timer
  sudo systemctl start github-route-autoheal.service
  sudo systemctl is-active --quiet github-route-autoheal.timer
  echo "GitHub route auto-heal applied; rollback: $0 rollback $timestamp"
}

restore() {
  local target="$1" timestamp="$2"
  if sudo test -e "${target}.bak_${timestamp}"; then
    sudo cp -a "${target}.bak_${timestamp}" "$target"
  elif sudo test -e "${target}.missing_${timestamp}"; then
    sudo rm -f "$target"
  else
    echo "Missing rollback receipt for $target at $timestamp" >&2
    return 1
  fi
}

rollback() {
  local timestamp="${1:?rollback requires timestamp}"
  sudo systemctl disable --now github-route-autoheal.timer || true
  restore "$SERVICE" "$timestamp"
  restore "$TIMER" "$timestamp"
  sudo systemctl daemon-reload
  echo "GitHub route auto-heal rolled back from $timestamp"
}

case "$ACTION" in
  preview) preview ;;
  apply) apply ;;
  rollback) rollback "${2:-}" ;;
  *) echo "usage: $0 [preview|apply|rollback <timestamp>]" >&2; exit 2 ;;
esac

#!/usr/bin/env bash
# test2git pre-push hook for VPN Panel. See scripts/test2git-vpn-panel.sh.
set -euo pipefail

REPO_ROOT="$(git rev-parse --show-toplevel)"
exec "$REPO_ROOT/scripts/test2git-vpn-panel.sh"

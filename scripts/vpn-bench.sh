#!/usr/bin/env bash
# Cross-platform local compatibility entrypoint for the shared benchmark plan.
set -euo pipefail
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"
VPN_TOKEN="${VPN_TOKEN:?VPN_TOKEN is required}"
OUTPUT_DIR="${OUTPUT_DIR:-$REPO_DIR/vpn-testing/results}"
mkdir -p "$OUTPUT_DIR"

case "${USE_DOCKER:-auto}" in
  1) mode=docker ;;
  0) mode=native ;;
  auto) if command -v xray >/dev/null 2>&1 || [[ -x /opt/homebrew/bin/xray ]]; then mode=native; else mode=docker; fi ;;
  *) echo "USE_DOCKER must be 0, 1, or auto" >&2; exit 2 ;;
esac
if [[ -n "${TEST_TARGET:-}" ]]; then
  target="$TEST_TARGET"
elif [[ "$(uname -s)" == "Darwin" ]]; then
  target=external-mac
else
  target=local-server100
fi
endpoint_csv="${ENDPOINTS:-}"
endpoint_csv="${endpoint_csv// /,}"
parallelism="${PARALLELISM:-}"
if [[ -n "$parallelism" && ! "$parallelism" =~ ^[1-9][0-9]*$ ]]; then
  echo "PARALLELISM must be a positive integer" >&2
  exit 2
fi
output="$OUTPUT_DIR/unified-${target}-benchmark-$(date +%Y%m%d_%H%M%S).json"
args=(python3 "$REPO_DIR/vpn-testing/unified_runner.py" --profile benchmark --target "$target" --mode "$mode" --output "$output")
if [[ -n "$endpoint_csv" && "$endpoint_csv" != auto ]]; then args+=(--endpoints "$endpoint_csv"); fi
if [[ -n "${XRAY_BIN:-}" && "$XRAY_BIN" != auto ]]; then args+=(--xray-bin "$XRAY_BIN"); fi
if [[ -n "$parallelism" ]]; then args+=(--parallelism "$parallelism"); fi
"${args[@]}" || status=$?
echo "$output"
exit "${status:-0}"

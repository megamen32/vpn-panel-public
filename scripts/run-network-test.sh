#!/usr/bin/env bash
# Execute the same staged plan on one named network target and fetch its JSON.
set -euo pipefail

PROFILE="${PROFILE:-benchmark}"
TARGET="${TARGET:-lan-server44}"
ENDPOINTS="${ENDPOINTS:-}"
CHECKS="${CHECKS-__PLAN_DEFAULTS__}"
REMOTE_RUN_TIMEOUT_SECONDS="${REMOTE_RUN_TIMEOUT_SECONDS:-120}"
if ! [[ "$REMOTE_RUN_TIMEOUT_SECONDS" =~ ^[1-9][0-9]*$ ]]; then
  echo "REMOTE_RUN_TIMEOUT_SECONDS must be a positive integer" >&2
  exit 2
fi
REMOTE_CLEANUP_TIMEOUT_SECONDS="${REMOTE_CLEANUP_TIMEOUT_SECONDS:-20}"
SCRIPT_DIR="${VPN_PANEL_SCRIPT_DIR:-$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)}"
REPO_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"
if [[ -f "$REPO_DIR/.env" ]]; then
  set -a
  source "$REPO_DIR/.env"
  set +a
fi
RESULTS_DIR="${RESULTS_DIR:-$REPO_DIR/vpn-testing/results}"
RUNNER="$REPO_DIR/vpn-testing/unified_runner.py"
PLAN="${VPN_TEST_PLAN:-$REPO_DIR/vpn-testing/test-plan.json}"
VPN_TOKEN="${VPN_TOKEN:?VPN_TOKEN is required}"
mkdir -p "$RESULTS_DIR"

if [[ "${RENDER_TEST_PLAN:-1}" == "1" && -n "${DATABASE_URL:-}" ]]; then
  (cd "$REPO_DIR" && npm run render:test-plan -- "$PLAN" "$REPO_DIR/vpn-testing/test-plan.json" >/dev/null)
fi

usage() {
  echo "Usage: $0 [--profile=quick|health|benchmark] [--target=TARGET_ID] [--endpoints=id1,id2] [--checks=id1,id2]" >&2
}

for arg in "$@"; do
  case "$arg" in
    --profile=*) PROFILE="${arg#*=}" ;;
    --target=*) TARGET="${arg#*=}" ;;
    --endpoints=*) ENDPOINTS="${arg#*=}" ;;
    --checks=*) CHECKS="${arg#*=}" ;;
    -h|--help) usage; exit 0 ;;
    *) echo "Unknown option: $arg" >&2; usage; exit 2 ;;
  esac
done

timestamp="$(date +%Y%m%d_%H%M%S)"
output="$RESULTS_DIR/unified-${TARGET}-${PROFILE}-${timestamp}.json"

target_config="$(python3 - "$PLAN" "$TARGET" <<'PY'
import json
import sys

plan_path, target_id = sys.argv[1:]
with open(plan_path, encoding="utf-8") as handle:
    plan = json.load(handle)
target = next((item for item in plan["testTargets"] if item["id"] == target_id and item.get("enabled", True)), None)
if target is None:
    raise SystemExit(f"unknown or disabled test target: {target_id}")
values = [target[key] for key in ("runner", "sshHost", "sshPort", "mode", "engine")]
if target["runner"] == "android-adb":
    values.append(target["adbSerial"])
print("\t".join(str(value) for value in values))
PY
)" || exit 2
IFS=$'\t' read -r runner remote ssh_port mode engine adb_serial <<<"$target_config"

if [[ "$runner" == "android-adb" ]]; then
  android_args=("$SCRIPT_DIR/run-android-network-test.sh" "--profile=$PROFILE" "--output=$output")
  android_args+=("--adb-host=$remote")
  android_args+=("--adb-serial=$adb_serial")
  if [[ -n "$ENDPOINTS" ]]; then android_args+=("--endpoints=$ENDPOINTS"); fi
  if [[ "$CHECKS" != "__PLAN_DEFAULTS__" ]]; then android_args+=("--checks=$CHECKS"); fi
  exec "${android_args[@]}"
fi
if [[ "$runner" != "ssh" ]]; then echo "Unsupported test target runner: $runner" >&2; exit 2; fi
ssh_command=(ssh -o BatchMode=yes -o StrictHostKeyChecking=accept-new -p "$ssh_port" "$remote")
scp_command=(scp -o BatchMode=yes -o StrictHostKeyChecking=accept-new -P "$ssh_port")

remote_dir="${REMOTE_WORK_ROOT:-/tmp}/vpn-unified-${USER:-runner}-$$"
remote_result="$remote_dir/result.json"
remote_pid="$remote_dir/runner.pid"
"${ssh_command[@]}" "mkdir -p '$remote_dir'"
cleanup() {
  timeout --signal=TERM --kill-after=5 "$REMOTE_CLEANUP_TIMEOUT_SECONDS" "${ssh_command[@]}" "if test -s '$remote_pid'; then pid=\$(cat '$remote_pid'); pkill -TERM -P \"\$pid\" 2>/dev/null || true; kill \"\$pid\" 2>/dev/null || true; fi; rm -rf '$remote_dir'" >/dev/null 2>&1 || true
}
trap cleanup EXIT
"${scp_command[@]}" "$RUNNER" "$remote:$remote_dir/"
"${scp_command[@]}" "$PLAN" "$remote:$remote_dir/test-plan.json"

remote_args=(python3 "$remote_dir/unified_runner.py" --plan "$remote_dir/test-plan.json" --profile "$PROFILE" --target "$TARGET" --mode "$mode" --engine "$engine" --output "$remote_result")
# Concurrent downloads compete for the same client uplink and cannot rank
# endpoint capacity fairly. Health checks keep their plan's concurrency.
if [[ "$PROFILE" == benchmark ]]; then remote_args+=(--parallelism 1); fi
if [[ -n "$ENDPOINTS" ]]; then remote_args+=(--endpoints "$ENDPOINTS"); fi
if [[ "$CHECKS" != "__PLAN_DEFAULTS__" ]]; then remote_args+=(--checks "$CHECKS"); fi

telemetry_url="${TELEMETRY_URL:-https://vpn.bezrabotnyi.com/api/telemetry/vpn-tests/events}"
telemetry_key="${TELEMETRY_API_KEY:-${HEALTH_API_KEY:-${VPN_PANEL_HEALTH_API_KEY:-}}}"
# The remote target uses the public ingress, while the retrieved artifact is
# recorded locally. This avoids making the scheduler depend on an unrelated
# public nginx location for its authoritative handoff.
local_telemetry_url="${LOCAL_TELEMETRY_URL:-http://127.0.0.1:30129/api/telemetry/vpn-tests/events}"
# The runner executes on the target host. A local $HOME path is invalid on the
# Mac target and previously produced a Linux path there.
remote_spool_dir="$remote_dir/telemetry-spool"
remote_env="$remote_dir/runner-env.json"
env_payload="$(jq -cn \
  --arg token "$VPN_TOKEN" \
  --arg telemetry_url "$telemetry_url" \
  --arg telemetry_key "$telemetry_key" \
  --arg s3_uri "${TELEMETRY_S3_URI:-}" \
  --arg s3_endpoint "${TELEMETRY_S3_ENDPOINT:-}" \
  --arg spool_dir "${REMOTE_TELEMETRY_SPOOL_DIR:-$remote_spool_dir}" \
  --arg telemetry_disabled "${REMOTE_TELEMETRY_DISABLED:-1}" \
  --arg diagnostic "${DIAGNOSTIC_SUBSCRIPTION:-0}" \
  --arg work_dir "$remote_dir" \
  '{VPN_TOKEN:$token,TELEMETRY_URL:$telemetry_url,TELEMETRY_API_KEY:$telemetry_key,TELEMETRY_S3_URI:$s3_uri,TELEMETRY_S3_ENDPOINT:$s3_endpoint,TELEMETRY_SPOOL_DIR:$spool_dir,VPN_TEST_TELEMETRY_DISABLED:$telemetry_disabled,DIAGNOSTIC_SUBSCRIPTION:$diagnostic,TMPDIR:$work_dir}')"
printf '%s\n' "$env_payload" | "${ssh_command[@]}" "umask 077; cat > '$remote_env'"
launcher=(python3 -c 'import json, os, sys; path=sys.argv[1]; env=os.environ.copy(); env.update(json.load(open(path, encoding="utf-8"))); os.unlink(path); os.execvpe(sys.argv[2], sys.argv[2:], env)' "$remote_env" "${remote_args[@]}")
printf -v quoted_launcher '%q ' "${launcher[@]}"

set +e
timeout --signal=TERM --kill-after=15 "$REMOTE_RUN_TIMEOUT_SECONDS" "${ssh_command[@]}" "echo \$\$ > '$remote_pid'; exec $quoted_launcher"
runner_status=$?
set -e
if [[ "$runner_status" -eq 124 ]]; then
  cleanup
  trap - EXIT
  echo "remote VPN measurement timed out after ${REMOTE_RUN_TIMEOUT_SECONDS}s" >&2
  exit "$runner_status"
fi
"${scp_command[@]}" "$remote:$remote_result" "$output"
if python3 - "$output" "$REPO_DIR" <<'PY'
import os
import pathlib
import sys

artifact = pathlib.Path(sys.argv[1]).resolve()
repo = pathlib.Path(sys.argv[2]).resolve()
roots = [repo / "bench-results", repo / "vpn-testing" / "results"]
raise SystemExit(0 if any(str(artifact).startswith(f"{root.resolve()}{os.sep}") for root in roots) else 1)
PY
then
  : "${telemetry_key:?TELEMETRY_API_KEY, HEALTH_API_KEY, or VPN_PANEL_HEALTH_API_KEY is required for local artifact handoff}"
  TELEMETRY_API_KEY="$telemetry_key" LOCAL_TELEMETRY_URL="$local_telemetry_url" REMOTE_TELEMETRY_DISABLED="${REMOTE_TELEMETRY_DISABLED:-1}" \
    python3 "$REPO_DIR/vpn-testing/record-artifact.py" "$output"
fi
echo "$output"
if [[ "$runner_status" -ne 0 && "$runner_status" -ne 2 ]]; then exit "$runner_status"; fi

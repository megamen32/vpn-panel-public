#!/usr/bin/env bash
# Build/install the Android agent, run Xray on-device, and collect common JSON.
set -euo pipefail

PROFILE="benchmark"
ENDPOINTS=""
CHECKS="__PLAN_DEFAULTS__"
OUTPUT=""
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"
VPN_TOKEN="${VPN_TOKEN:?VPN_TOKEN is required}"
XRAY_VERSION="${XRAY_VERSION:-26.6.1}"
XRAY_SHA256="${XRAY_ANDROID_SHA256:-9298fad55abc8d55b5fac4445045446536b6e1d2f8f67a00a806397d0c94d9c3}"
ADB_SERIAL="${ANDROID_SERIAL:-}"
ADB_HOST="${ANDROID_ADB_HOST:-roomhacker@192.168.2.100}"
CELLULAR_BRIDGE_PORT="${ANDROID_CELLULAR_BRIDGE_PORT:-12080}"
MOBILE_DATA_ORIGINAL=""
MOBILE_DATA_ALWAYS_ON_ORIGINAL=""

for arg in "$@"; do
  case "$arg" in
    --profile=*) PROFILE="${arg#*=}" ;;
    --endpoints=*) ENDPOINTS="${arg#*=}" ;;
    --checks=*) CHECKS="${arg#*=}" ;;
    --output=*) OUTPUT="${arg#*=}" ;;
    --adb-host=*) ADB_HOST="${arg#*=}" ;;
    --adb-serial=*) ADB_SERIAL="${arg#*=}" ;;
    *) echo "Unknown option: $arg" >&2; exit 2 ;;
  esac
done
if [[ -z "$OUTPUT" ]]; then OUTPUT="$REPO_DIR/vpn-testing/results/unified-external-wireless-android-$PROFILE-$(date +%Y%m%d_%H%M%S).json"; fi
mkdir -p "$(dirname "$OUTPUT")"

mkdir -p "$REPO_DIR/.tmp"
work_dir="$(mktemp -d "$REPO_DIR/.tmp/vpn-android-test-XXXXXX")"
remote_dir="$REPO_DIR/.tmp/vpn-android-remote-$$"
cleanup() {
  if [[ -n "$ADB_SERIAL" ]]; then
    ssh -o BatchMode=yes "$ADB_HOST" bash -s -- "$ADB_SERIAL" "$MOBILE_DATA_ORIGINAL" "$MOBILE_DATA_ALWAYS_ON_ORIGINAL" "$remote_dir" >/dev/null 2>&1 <<'REMOTE' || true
serial="$1"; original_data="$2"; original_always_on="$3"; remote_dir="$4"
adb=(/usr/local/bin/adb -s "$serial")
"${adb[@]}" shell 'pidof vpn-panel-xray | xargs -r kill' || true
"${adb[@]}" shell am stopservice -n com.bezrabotnyi.vpntestagent/.CellularForwarderService || true
if [[ -n "$original_data" && "$original_data" != "1" ]]; then "${adb[@]}" shell svc data disable || true; fi
if [[ "$original_always_on" == "null" ]]; then
  "${adb[@]}" shell settings delete global mobile_data_always_on || true
elif [[ -n "$original_always_on" ]]; then
  "${adb[@]}" shell settings put global mobile_data_always_on "$original_always_on" || true
fi
rm -rf "$remote_dir"
REMOTE
  else
    ssh -o BatchMode=yes "$ADB_HOST" "rm -rf '$remote_dir'" >/dev/null 2>&1 || true
  fi
  rm -rf "$work_dir"
}
trap cleanup EXIT

ADB_SERIAL="$(ssh -o BatchMode=yes -o StrictHostKeyChecking=accept-new "$ADB_HOST" bash -s -- "$ADB_SERIAL" <<'REMOTE'
set -euo pipefail
requested="${1:-}"
adb=/usr/local/bin/adb
if [[ -n "$requested" ]]; then
  "$adb" connect "$requested" >/dev/null 2>&1 || true
  if [[ "$("$adb" -s "$requested" get-state 2>/dev/null || true)" == "device" ]]; then
    echo "$requested"
    exit 0
  fi
fi
mapfile -t devices < <("$adb" devices | awk '$2 == "device" {print $1}')
if [[ "${#devices[@]}" -eq 1 ]]; then
  echo "${devices[0]}"
  exit 0
fi
mapfile -t services < <("$adb" mdns services | awk '$2 == "_adb-tls-connect._tcp" {print $3}')
for service in "${services[@]}"; do "$adb" connect "$service" >/dev/null 2>&1 || true; done
mapfile -t devices < <("$adb" devices | awk '$2 == "device" {print $1}')
if [[ "${#devices[@]}" -ne 1 ]]; then
  echo "expected exactly one Android ADB device, found ${#devices[@]}; enable Wireless debugging" >&2
  exit 1
fi
echo "${devices[0]}"
REMOTE
)"

MOBILE_DATA_ORIGINAL="$(ssh -o BatchMode=yes "$ADB_HOST" "/usr/local/bin/adb -s '$ADB_SERIAL' shell settings get global mobile_data" | tr -d '\r')"
MOBILE_DATA_ALWAYS_ON_ORIGINAL="$(ssh -o BatchMode=yes "$ADB_HOST" "/usr/local/bin/adb -s '$ADB_SERIAL' shell settings get global mobile_data_always_on" | tr -d '\r')"
ssh -o BatchMode=yes "$ADB_HOST" "/usr/local/bin/adb -s '$ADB_SERIAL' shell svc data enable; /usr/local/bin/adb -s '$ADB_SERIAL' shell settings put global mobile_data_always_on 1" >/dev/null

cellular_interface=""
for _ in {1..10}; do
  connectivity_dump="$(ssh -o BatchMode=yes "$ADB_HOST" "/usr/local/bin/adb -s '$ADB_SERIAL' shell dumpsys connectivity")"
  if cellular_interface="$(printf '%s\n' "$connectivity_dump" | python3 "$REPO_DIR/vpn-testing/android_network.py" 2>/dev/null)"; then break; fi
  sleep 2
done
if [[ -z "$cellular_interface" ]]; then
  echo "Android cellular network did not become connected and validated" >&2
  exit 1
fi
echo "Android ADB=$ADB_SERIAL; VPN traffic interface=$cellular_interface" >&2

curl -sfL "${BASE_URL:-https://vpn.bezrabotnyi.com}/sub/$VPN_TOKEN/xray-json" -o "$work_dir/base.json"
python3 - "$work_dir/base.json" "$work_dir" "$ENDPOINTS" "$REPO_DIR" "$CELLULAR_BRIDGE_PORT" <<'PY'
import json, pathlib, sys
sys.path.insert(0, str(pathlib.Path(sys.argv[4]) / 'vpn-testing'))
from unified_runner import cellular_bridge_endpoint_config
base=json.load(open(sys.argv[1]))
requested=[x for x in sys.argv[3].split(',') if x]
tags=[o['tag'] for o in base.get('outbounds',[]) if o.get('tag') not in ('direct','block')]
if requested: tags=[tag for tag in tags if tag in requested]
if requested and not tags: raise SystemExit('none of the requested endpoints exist in the subscription')
out=pathlib.Path(sys.argv[2]); (out/'endpoints.txt').write_text('\n'.join(tags)+'\n')
forwarders=[]
for index, tag in enumerate(tags):
    config, remote_host, remote_port = cellular_bridge_endpoint_config(base,tag,11080,int(sys.argv[5]))
    (out/f'config-{index}.json').write_text(json.dumps(config,indent=2))
    forwarders.append(f'{remote_host}\t{remote_port}\t{sys.argv[5]}')
(out/'forwarders.tsv').write_text('\n'.join(forwarders)+'\n')
PY

ssh -o BatchMode=yes -o StrictHostKeyChecking=accept-new "$ADB_HOST" "mkdir -p '$remote_dir/configs' '$remote_dir/results'"
scp -q -r "$REPO_DIR/android-test-agent" "$ADB_HOST:$remote_dir/"
scp -q "$work_dir"/config-*.json "$work_dir/endpoints.txt" "$work_dir/forwarders.tsv" "$REPO_DIR/vpn-testing/test-plan.json" "$ADB_HOST:$remote_dir/configs/"

ssh -o BatchMode=yes "$ADB_HOST" bash -s -- "$remote_dir" "$XRAY_VERSION" "$XRAY_SHA256" "$ADB_SERIAL" <<'REMOTE'
set -euo pipefail
remote_dir="$1"; version="$2"; expected_sha="$3"; serial="${4:-}"
adb_cmd=(/usr/local/bin/adb); if [[ -n "$serial" ]]; then adb_cmd+=(-s "$serial"); fi
adb_run() { "${adb_cmd[@]}" "$@" </dev/null; }
cache="$HOME/.cache/vpn-panel/xray-android-$version"
mkdir -p "$cache"
archive="$cache/Xray-android-arm64-v8a.zip"
if [[ ! -f "$archive" ]]; then
  curl -fL "https://github.com/XTLS/Xray-core/releases/download/v$version/Xray-android-arm64-v8a.zip" -o "$archive"
fi
echo "$expected_sha  $archive" | sha256sum -c -
if [[ ! -x "$cache/xray" ]]; then unzip -jo "$archive" xray -d "$cache"; chmod +x "$cache/xray"; fi
apk="$(bash "$remote_dir/android-test-agent/build.sh")"
install_output="$(adb_run install -r "$apk" 2>&1)" || {
  if [[ "$install_output" != *"INSTALL_FAILED_UPDATE_INCOMPATIBLE"* ]]; then
    echo "$install_output" >&2
    exit 1
  fi
  echo "Replacing stale vpn-test-agent signed by another local test key" >&2
  adb_run uninstall com.bezrabotnyi.vpntestagent >/dev/null
  adb_run install "$apk" >/dev/null
}
adb_run push "$cache/xray" /data/local/tmp/vpn-panel-xray >/dev/null
adb_run shell chmod 755 /data/local/tmp/vpn-panel-xray
REMOTE

plan_base64="$(base64 -w0 "$REPO_DIR/vpn-testing/test-plan.json")"
run_id="$(python3 -c 'import uuid; print(uuid.uuid4())')"
telemetry_url="${TELEMETRY_URL:-https://vpn.bezrabotnyi.com/api/telemetry/vpn-tests/events}"
telemetry_key="${TELEMETRY_API_KEY:-${HEALTH_API_KEY:-${VPN_PANEL_HEALTH_API_KEY:-}}}"
lan_public_ip="${LAN_PUBLIC_IP:-95.165.165.65}"
index=0
endpoint_total="$(wc -l < "$work_dir/endpoints.txt")"
if [[ "$endpoint_total" -eq 0 ]]; then echo "Subscription contains no endpoints" >&2; exit 2; fi
while IFS= read -r endpoint; do
  [[ -n "$endpoint" ]] || continue
  echo "Android endpoint $((index + 1))/$endpoint_total: $endpoint" >&2
  ssh -o BatchMode=yes "$ADB_HOST" bash -s -- "$remote_dir" "$index" "$endpoint_total" "$endpoint" "$PROFILE" "$run_id" "$plan_base64" "$telemetry_url" "$telemetry_key" "$lan_public_ip" "$ADB_SERIAL" "$cellular_interface" "$CHECKS" <<'REMOTE'
set -euo pipefail
remote_dir="$1"; index="$2"; endpoint_total="$3"; endpoint="$4"; profile="$5"; run_id="$6"; plan="$7"; telemetry_url="$8"; telemetry_key="$9"; lan_public_ip="${10}"; serial="${11:-}"; cellular_interface="${12}"; checks="${13}"
adb_cmd=(/usr/local/bin/adb); if [[ -n "$serial" ]]; then adb_cmd+=(-s "$serial"); fi
adb_run() { "${adb_cmd[@]}" "$@" </dev/null; }
IFS=$'\t' read -r remote_host remote_port bridge_port < <(sed -n "$((index + 1))p" "$remote_dir/configs/forwarders.tsv")
if [[ -z "$remote_host" || -z "$remote_port" || -z "$bridge_port" ]]; then echo "missing Android bridge target for $endpoint" >&2; exit 1; fi
echo "  pushing endpoint config" >&2
adb_run push "$remote_dir/configs/config-$index.json" /data/local/tmp/vpn-panel-config.json >/dev/null
adb_run shell 'pidof vpn-panel-xray | xargs -r kill' || true
adb_run shell am stopservice -n com.bezrabotnyi.vpntestagent/.CellularForwarderService >/dev/null 2>&1 || true
adb_run shell am force-stop com.bezrabotnyi.vpntestagent >/dev/null 2>&1 || true
adb_run shell am start-foreground-service -n com.bezrabotnyi.vpntestagent/.BenchmarkDeviceService >/dev/null
adb_run shell rm -f \
  /sdcard/Android/data/com.bezrabotnyi.vpntestagent/files/forwarder-status.json \
  /sdcard/Android/data/com.bezrabotnyi.vpntestagent/files/instrumentation-status.json \
  /sdcard/Android/data/com.bezrabotnyi.vpntestagent/files/latest-result.json \
  /data/local/tmp/vpn-panel-instrumentation.log
echo "  starting device Xray" >&2
adb_run shell "nohup /data/local/tmp/vpn-panel-xray run -c /data/local/tmp/vpn-panel-config.json >/data/local/tmp/vpn-panel-xray.log 2>&1 </dev/null & echo \$! >/data/local/tmp/vpn-panel-xray.pid"
sleep 2
if ! adb_run shell 'kill -0 $(cat /data/local/tmp/vpn-panel-xray.pid)' >/dev/null 2>&1; then
  adb_run shell cat /data/local/tmp/vpn-panel-xray.log >&2 || true
  exit 1
fi
echo "  device SOCKS ready; starting instrumentation waiter" >&2
instrument_args=(am instrument -w -r \
  -e endpoint "$endpoint" -e profile "$profile" -e socksPort 11080 -e runId "$run_id" \
  -e sequenceBase "$((index * 1000))" -e endpointIndex "$index" -e endpointTotal "$endpoint_total" \
  -e lanPublicIp "$lan_public_ip" -e requiredTransport cellular -e outboundInterface "$cellular_interface" \
  -e outboundPath android-network-socket-forwarder -e bridgePort "$bridge_port" \
  -e planBase64 "$plan" -e telemetryUrl "$telemetry_url" -e telemetryKey "$telemetry_key" \
  com.bezrabotnyi.vpntestagent/com.bezrabotnyi.vpntestagent.VpnTestInstrumentation)
if [[ "$checks" != "__PLAN_DEFAULTS__" ]]; then instrument_args+=( -e checks "$checks" ); fi
printf -v instrument_command '%q ' "${instrument_args[@]}"
  adb_run shell "nohup $instrument_command >/data/local/tmp/vpn-panel-instrumentation.log 2>&1 </dev/null &"
instrumentation_waiting=false
for _ in {1..40}; do
  instrumentation_status="$(adb_run shell cat /sdcard/Android/data/com.bezrabotnyi.vpntestagent/files/instrumentation-status.json 2>/dev/null | tr -d '\r' || true)"
  if [[ "$instrumentation_status" == *'"state":"error"'* ]]; then echo "Android instrumentation failed: $instrumentation_status" >&2; exit 1; fi
  if [[ "$instrumentation_status" == *'"state":"waiting_for_bridge"'* || "$instrumentation_status" == *'"state":"running"'* ]]; then instrumentation_waiting=true; break; fi
  sleep 0.25
done
if [[ "$instrumentation_waiting" != true ]]; then adb_run shell cat /data/local/tmp/vpn-panel-instrumentation.log >&2 || true; echo "Android instrumentation did not start" >&2; exit 1; fi

echo "  instrumentation ready; starting cellular bridge" >&2
adb_run shell am start-foreground-service -n com.bezrabotnyi.vpntestagent/.CellularForwarderService \
  --es remoteHost "$remote_host" --ei remotePort "$remote_port" --ei listenPort "$bridge_port" >/dev/null
bridge_ready=false
for _ in {1..40}; do
  bridge_status="$(adb_run shell cat /sdcard/Android/data/com.bezrabotnyi.vpntestagent/files/forwarder-status.json 2>/dev/null | tr -d '\r' || true)"
  if [[ "$bridge_status" == *'"state":"error"'* ]]; then echo "Android cellular bridge failed: $bridge_status" >&2; exit 1; fi
  if [[ "$bridge_status" == *'"state":"ready"'* && "$bridge_status" == *'"listenPort":'"$bridge_port"* ]]; then bridge_ready=true; break; fi
  sleep 0.25
done
if [[ "$bridge_ready" != true ]]; then echo "Android cellular bridge did not become ready" >&2; exit 1; fi

result_path="$(adb_run shell 'echo /sdcard/Android/data/com.bezrabotnyi.vpntestagent/files/latest-result.json' | tr -d '\r')"
case "$profile" in quick) result_attempts=180 ;; health) result_attempts=360 ;; benchmark) result_attempts=600 ;; *) result_attempts=180 ;; esac
result_ready=false
for ((attempt = 0; attempt < result_attempts; attempt++)); do
  if adb_run shell test -s "$result_path" >/dev/null 2>&1; then result_ready=true; break; fi
  sleep 0.5
done
adb_run shell cat /data/local/tmp/vpn-panel-instrumentation.log >&2 || true
if [[ "$result_ready" != true ]]; then echo "Android instrumentation result timed out" >&2; exit 1; fi
echo "  instrumentation returned; pulling result" >&2
adb_run pull "$result_path" "$remote_dir/results/endpoint-$index.json" >/dev/null
adb_run shell am stopservice -n com.bezrabotnyi.vpntestagent/.CellularForwarderService >/dev/null 2>&1 || true
REMOTE
  scp -q "$ADB_HOST:$remote_dir/results/endpoint-$index.json" "$work_dir/endpoint-$index.json"
  index=$((index + 1))
done < "$work_dir/endpoints.txt"

stable_spool="$REPO_DIR/vpn-testing/results/spool/android-$run_id"
mkdir -p "$stable_spool"
ssh -o BatchMode=yes "$ADB_HOST" "/usr/local/bin/adb -s '$ADB_SERIAL' pull /sdcard/Android/data/com.bezrabotnyi.vpntestagent/files/telemetry-spool '$remote_dir/device-spool' >/dev/null 2>&1 || true"
ssh -o BatchMode=yes "$ADB_HOST" "test ! -d '$remote_dir/device-spool' || tar -C '$remote_dir/device-spool' -cf - ." | tar -C "$stable_spool" -xf -
ssh -o BatchMode=yes "$ADB_HOST" "/usr/local/bin/adb -s '$ADB_SERIAL' shell 'rm -f /sdcard/Android/data/com.bezrabotnyi.vpntestagent/files/telemetry-spool/*.json'" >/dev/null 2>&1 || true
TELEMETRY_SPOOL_DIR="$stable_spool" python3 - "$REPO_DIR" "$run_id" "$PROFILE" <<'PY'
import pathlib, sys
sys.path.insert(0, str(pathlib.Path(sys.argv[1]) / 'vpn-testing'))
from unified_runner import TelemetrySink
spool=pathlib.Path(__import__('os').environ['TELEMETRY_SPOOL_DIR'])
TelemetrySink(sys.argv[2], sys.argv[3], {'id':'external-wireless-android','networkClass':'external-mobile','client':'xray','accessMethod':'socks-proxy','wireMethod':'4g','hostRole':'android'}, spool.parent)
PY

python3 "$REPO_DIR/vpn-testing/merge_android_results.py" --plan "$REPO_DIR/vpn-testing/test-plan.json" \
  --profile "$PROFILE" --run-id "$run_id" --input-dir "$work_dir" --output "$OUTPUT"
echo "$OUTPUT"

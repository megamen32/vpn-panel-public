#!/usr/bin/env bash

set -euo pipefail

OPTIONS_PATH="${OPTIONS_PATH:-/data/options.json}"
CONFIG_PATH=/data/config.json
RUNTIME_CONFIG_PATH=/data/runtime-config.json
DEFAULT_CONFIG_PATH=/etc/transparent-smart-edge/config.default.json
SINGBOX_CONFIG_PATH=/data/singbox.json
SINGBOX_RUNTIME_PATH=/data/singbox-runtime.json
PROXY_USERS_PATH=/data/proxy-users.json
EMPTY_PROXY_USERS_PATH=/etc/transparent-smart-edge/proxy-users.empty.json

# shellcheck source=/dev/null
source /usr/lib/transparent-smart-edge-options.sh

require_port() {
    local name="$1"
    local value="$2"
    if [[ ! "$value" =~ ^[0-9]+$ ]] || (( value < 1 || value > 65535 )); then
        printf 'invalid %s: %s\n' "$name" "$value" >&2
        exit 2
    fi
}

DNS_LISTEN_HOST="$(option dns_listen_host 0.0.0.0)"
DNS_PORT="$(option dns_port 1053)"
DOH_PORT="$(option doh_port 18053)"
EDGE_LISTEN_HOST="$(option edge_listen_host 0.0.0.0)"
EDGE_PORT="$(option edge_port 10443)"
EDGE_IPV4="$(option edge_ipv4 192.168.2.1)"
SINGBOX_INTERNAL_PORT="$(option singbox_internal_port 23128)"
SINGBOX_OUTBOUND_TAG="$(option singbox_outbound_tag de-regional)"
TELEGRAM_OUTBOUND_TAG="$(option telegram_outbound_tag us-regional)"
REQUIRE_SINGBOX_CONFIG="$(option require_singbox_config false)"
TELEGRAM_TPROXY_ENABLED="$(option telegram_tproxy_enabled false)"
TELEGRAM_TPROXY_PORT="$(option telegram_tproxy_port 12555)"
LAN_US_PROXY_ENABLED="$(option lan_us_proxy_enabled true)"
LAN_US_PROXY_PORT="$(option lan_us_proxy_port 3127)"
LAN_US_PROXY_OUTBOUND_TAG="$(option lan_us_proxy_outbound_tag us-regional)"
LAN_DE_PROXY_ENABLED="$(option lan_de_proxy_enabled true)"
LAN_DE_PROXY_PORT="$(option lan_de_proxy_port 3128)"
LAN_DE_PROXY_OUTBOUND_TAG="$(option lan_de_proxy_outbound_tag de-regional)"
LAN_FI_PROXY_ENABLED="$(option lan_fi_proxy_enabled true)"
LAN_FI_PROXY_PORT="$(option lan_fi_proxy_port 3129)"
LAN_FI_PROXY_OUTBOUND_TAG="$(option lan_fi_proxy_outbound_tag fi-helsinki)"
LAN_RU_PROXY_ENABLED="$(option lan_ru_proxy_enabled true)"
LAN_RU_PROXY_PORT="$(option lan_ru_proxy_port 3130)"
LAN_RU_PROXY_OUTBOUND_TAG="$(option lan_ru_proxy_outbound_tag direct)"
AI_ROUTE_ENABLED="$(option ai_route_enabled true)"

require_port dns_port "$DNS_PORT"
require_port doh_port "$DOH_PORT"
require_port edge_port "$EDGE_PORT"
require_port singbox_internal_port "$SINGBOX_INTERNAL_PORT"
require_port telegram_tproxy_port "$TELEGRAM_TPROXY_PORT"
require_port lan_us_proxy_port "$LAN_US_PROXY_PORT"
require_port lan_de_proxy_port "$LAN_DE_PROXY_PORT"
require_port lan_fi_proxy_port "$LAN_FI_PROXY_PORT"
require_port lan_ru_proxy_port "$LAN_RU_PROXY_PORT"

proxy_users_required=false
for proxy_enabled in "$LAN_US_PROXY_ENABLED" "$LAN_DE_PROXY_ENABLED" "$LAN_FI_PROXY_ENABLED" "$LAN_RU_PROXY_ENABLED"; do
    if [[ "$proxy_enabled" == true ]]; then
        proxy_users_required=true
        break
    fi
done

PROXY_USERS_FILE="$EMPTY_PROXY_USERS_PATH"
if [[ "$proxy_users_required" == true ]]; then
    [[ -s "$PROXY_USERS_PATH" ]] || { printf 'missing required proxy auth file: %s\n' "$PROXY_USERS_PATH" >&2; exit 2; }
    jq -e '(.users | type == "array") and (.users | length > 0) and all(.users[]?; (.username | type == "string" and length > 0) and (.password | type == "string" and length > 0))' "$PROXY_USERS_PATH" >/dev/null
    PROXY_USERS_FILE="$PROXY_USERS_PATH"
fi

if ! /usr/bin/sing-box version 2>/dev/null | grep -Fq 'sing-box version 1.13.14'; then
    printf 'bundled sing-box is not version 1.13.14\n' >&2
    exit 2
fi

singbox_enabled=0
if [[ -s "$SINGBOX_CONFIG_PATH" ]]; then
    /usr/bin/configure-runtime-inbounds.sh \
      "$SINGBOX_CONFIG_PATH" "$SINGBOX_RUNTIME_PATH.tmp" \
      "$TELEGRAM_TPROXY_ENABLED" "$TELEGRAM_TPROXY_PORT" "$TELEGRAM_OUTBOUND_TAG" \
      "$LAN_US_PROXY_ENABLED" "$LAN_US_PROXY_PORT" "$LAN_US_PROXY_OUTBOUND_TAG" \
      "$LAN_DE_PROXY_ENABLED" "$LAN_DE_PROXY_PORT" "$LAN_DE_PROXY_OUTBOUND_TAG" \
      "$LAN_FI_PROXY_ENABLED" "$LAN_FI_PROXY_PORT" "$LAN_FI_PROXY_OUTBOUND_TAG" \
      "$LAN_RU_PROXY_ENABLED" "$LAN_RU_PROXY_PORT" "$LAN_RU_PROXY_OUTBOUND_TAG" \
      "$PROXY_USERS_FILE" \
      "$AI_ROUTE_ENABLED"
    chmod 0600 "$SINGBOX_RUNTIME_PATH.tmp"
    mv -f "$SINGBOX_RUNTIME_PATH.tmp" "$SINGBOX_RUNTIME_PATH"
    /usr/bin/validate-singbox-config.sh "$SINGBOX_RUNTIME_PATH" "$SINGBOX_INTERNAL_PORT" "$SINGBOX_OUTBOUND_TAG" "$TELEGRAM_OUTBOUND_TAG" "$LAN_US_PROXY_ENABLED" "$LAN_US_PROXY_PORT" "$LAN_US_PROXY_OUTBOUND_TAG" "$LAN_DE_PROXY_ENABLED" "$LAN_DE_PROXY_PORT" "$LAN_DE_PROXY_OUTBOUND_TAG" "$LAN_FI_PROXY_ENABLED" "$LAN_FI_PROXY_PORT" "$LAN_FI_PROXY_OUTBOUND_TAG" "$LAN_RU_PROXY_ENABLED" "$LAN_RU_PROXY_PORT" "$LAN_RU_PROXY_OUTBOUND_TAG" "$AI_ROUTE_ENABLED"
    singbox_enabled=1
elif [[ "$REQUIRE_SINGBOX_CONFIG" == true || "$DNS_PORT" == 53 || "$EDGE_PORT" == 443 ]]; then
    printf 'missing %s; refusing final-port startup without a validated transport\n' "$SINGBOX_CONFIG_PATH" >&2
    exit 2
else
    printf 'staging mode: %s is absent; DNS/TCP listeners will start without transport readiness\n' "$SINGBOX_CONFIG_PATH" >&2
fi

if [[ ! -s "$CONFIG_PATH" ]]; then
    install -m 0600 "$DEFAULT_CONFIG_PATH" "$CONFIG_PATH"
fi

# Keep the panel-rendered policy durable in /data/config.json. Listener and
# HAOS-local transport details are projected into a separate runtime file so
# restarts and staging-to-final port changes never rewrite the policy source.
jq \
    --arg dns_host "$DNS_LISTEN_HOST" \
    --argjson dns_port "$DNS_PORT" \
    --argjson doh_port "$DOH_PORT" \
    --arg edge_ipv4 "$EDGE_IPV4" \
    --argjson proxy_port "$SINGBOX_INTERNAL_PORT" \
    '.udpListen = {host: $dns_host, port: $dns_port, profile: "local"}
     | .dohListen = {host: "127.0.0.1", port: $doh_port, profile: "local"}
     | del(.dotListen, .tls, .publicDnsListen, .sync)
     | .httpProxy = {host: "127.0.0.1", port: $proxy_port, timeoutMs: 5000}
     | .edgeProfiles = (.edgeProfiles // {})
     | .edgeProfiles.local = {enabled: true, ipv4: $edge_ipv4, ttl: 60}' \
    "$CONFIG_PATH" >"$RUNTIME_CONFIG_PATH.tmp"
chmod 0600 "$RUNTIME_CONFIG_PATH.tmp"
mv -f "$RUNTIME_CONFIG_PATH.tmp" "$RUNTIME_CONFIG_PATH"

export SMART_DNS_CONFIG="$RUNTIME_CONFIG_PATH"
export LISTEN_HOST="$EDGE_LISTEN_HOST"
export LISTEN_PORT="$EDGE_PORT"
export CONNECT_PORT=443
export PROXY_HOST=127.0.0.1
export PROXY_PORT="$SINGBOX_INTERNAL_PORT"

# --- multi-upstream failover for the SNI edge -------------------------------
# world-auto stays first: it is a sing-box urltest group over DE/FI/US members
# that already re-probes every 30s. The per-region LAN inbounds follow as
# independent exits, so one dead or black-holed lane no longer takes the whole
# transparent edge down. The RU lane is deliberately excluded: it is bound to a
# `direct` outbound rather than an exit, so failing back to it would hand the
# client traffic that connects but stays blocked.
edge_upstreams="world-auto=127.0.0.1:$SINGBOX_INTERNAL_PORT"
if [[ "$LAN_FI_PROXY_ENABLED" == true ]]; then
    edge_upstreams+=",fi=127.0.0.1:$LAN_FI_PROXY_PORT"
fi
if [[ "$LAN_DE_PROXY_ENABLED" == true ]]; then
    edge_upstreams+=",de=127.0.0.1:$LAN_DE_PROXY_PORT"
fi
if [[ "$LAN_US_PROXY_ENABLED" == true ]]; then
    edge_upstreams+=",us=127.0.0.1:$LAN_US_PROXY_PORT"
fi
export PROXY_UPSTREAMS="$edge_upstreams"
unset edge_upstreams
# ---------------------------------------------------------------------------

/usr/bin/smartdns &
smartdns_pid="$!"
: > /run/smartdns-policy-reload
singbox_pid=""
if [[ "$singbox_enabled" == 1 ]]; then
    /usr/bin/sing-box run -c "$SINGBOX_RUNTIME_PATH" &
    singbox_pid="$!"
    export SINGBOX_PID="$singbox_pid"
fi
/usr/bin/smart-edge &
smart_edge_pid="$!"

cleanup() {
    local pids=("$smartdns_pid" "$smart_edge_pid")
    if [[ -n "$singbox_pid" ]]; then
        pids+=("$singbox_pid")
    fi
    if [[ -n "$tproxy_watchdog_pid" ]]; then
        pids+=("$tproxy_watchdog_pid")
    fi
    if [[ -n "${route_health_pid:-}" ]]; then
        pids+=("$route_health_pid")
    fi
    kill "${pids[@]}" 2>/dev/null || true
    wait "${pids[@]}" 2>/dev/null || true
}
trap cleanup EXIT INT TERM

tproxy_watchdog_pid=""
if [[ "$TELEGRAM_TPROXY_ENABLED" == true ]]; then
    /usr/bin/telegram-tproxy-policy.sh "$TELEGRAM_TPROXY_PORT" --apply
    /usr/bin/telegram-tproxy-watchdog.sh "$TELEGRAM_TPROXY_PORT" &
    tproxy_watchdog_pid="$!"
fi

route_health_pid=""
if [[ "$singbox_enabled" == 1 && "$AI_ROUTE_ENABLED" == true ]]; then
    (
        while true; do
            /usr/bin/route-health.sh
            status="$?"
            printf 'route-health: loop exited with status %s; restarting in 5s\n' "$status" >&2
            sleep 5
        done
    ) &
    route_health_pid="$!"
fi

ready=0
for _ in $(seq 1 50); do
    if ! kill -0 "$smartdns_pid" 2>/dev/null || ! kill -0 "$smart_edge_pid" 2>/dev/null; then
        break
    fi
    if [[ -n "$singbox_pid" ]] && ! kill -0 "$singbox_pid" 2>/dev/null; then
        break
    fi
    if /usr/bin/healthcheck.sh; then
        ready=1
        break
    fi
    sleep 0.1
done

if [[ "$ready" != 1 ]]; then
    printf 'transparent Smart Edge listeners did not become ready\n' >&2
    exit 1
fi

set +e
child_pids=("$smartdns_pid" "$smart_edge_pid")
if [[ -n "$singbox_pid" ]]; then
    child_pids+=("$singbox_pid")
fi
if [[ -n "$tproxy_watchdog_pid" ]]; then
    child_pids+=("$tproxy_watchdog_pid")
fi
if [[ -n "${route_health_pid:-}" ]]; then
    child_pids+=("$route_health_pid")
fi
wait -n "${child_pids[@]}"
status="$?"
set -e
printf 'transparent Smart Edge child exited with status %s\n' "$status" >&2
exit "$status"

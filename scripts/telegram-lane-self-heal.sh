#!/usr/bin/env bash
# End-to-end watchdog for the Telegram transparent lane, run on server-100.
# It probes Telegram DC IPs through the real LAN path (router mark -> HAOS
# TPROXY -> sing-box), the path the router-side telegram-transparent-lane
# watchdog cannot see: it only checks HAOS :12555 reachability, which stays
# green when the HAOS-side nft policy is missing (2026-09-06 incident).
# Recovery action is the proven one: restart the Smart Edge addon container.
# The addon-internal policy watchdog (0.1.9+) repairs a missing nft table on
# its own; this LAN-side watchdog is the outer safety net for everything the
# inner loop cannot fix.
set -euo pipefail

probe_timeout="${TELEGRAM_LANE_PROBE_TIMEOUT:-5}"
probe_ips="${TELEGRAM_LANE_PROBE_IPS:-149.154.167.51 149.154.167.35}"
router_host="${TELEGRAM_LANE_ROUTER_HOST:-192.168.2.1}"
max_dynamic_dcs="${TELEGRAM_LANE_MAX_DYNAMIC_DCS:-8}"
probe_attempts="${TELEGRAM_LANE_PROBE_ATTEMPTS:-3}"
probe_required_successes="${TELEGRAM_LANE_PROBE_REQUIRED_SUCCESSES:-5}"
failures_before_action="${TELEGRAM_LANE_FAILURES_BEFORE_ACTION:-2}"
cooldown_seconds="${TELEGRAM_LANE_COOLDOWN_SECONDS:-900}"
home_dir="${HOME:-/home/roomhacker}"
state_dir="${TELEGRAM_LANE_STATE_DIR:-$home_dir/.local/state/telegram-lane-self-heal}"
haos_host="${TELEGRAM_LANE_HAOS_HOST:-192.168.2.101}"
haos_ssh_port="${TELEGRAM_LANE_HAOS_SSH_PORT:-2228}"
ssh_command_timeout="${TELEGRAM_LANE_SSH_COMMAND_TIMEOUT:-15}"
restart_command_timeout="${TELEGRAM_LANE_RESTART_COMMAND_TIMEOUT:-30}"
router_command_timeout="${TELEGRAM_LANE_ROUTER_COMMAND_TIMEOUT:-10}"
addon_slug="${TELEGRAM_LANE_ADDON_SLUG:-27579e22_bezrabotnyi_transparent_smart_edge}"
addon_container="${TELEGRAM_LANE_ADDON_CONTAINER:-app_$addon_slug}"

dry_run=0
for arg in "$@"; do
    case "$arg" in
        --once) ;;
        --dry-run) dry_run=1 ;;
        *) printf 'usage: telegram-lane-self-heal.sh [--once] [--dry-run]\n' >&2; exit 2 ;;
    esac
done

log() { printf '%s telegram-lane-self-heal: %s\n' "$(date -Is)" "$*"; }

mkdir -p "$state_dir"
exec 9>"$state_dir/lock"
flock -n 9 || exit 0
state_file="$state_dir/consecutive-failures"
last_action_file="$state_dir/last-action"

discover_active_dc_ips() {
    # Follow the DCs actually used by LAN Telegram clients. OpenWrt already
    # routes the full telegram_v4 ipset to HAOS; this only expands health probes.
    timeout "$router_command_timeout" ssh -o BatchMode=yes -o ConnectTimeout=5 "root@$router_host" '
        { conntrack -L 2>/dev/null || cat /proc/net/nf_conntrack 2>/dev/null || cat /proc/net/ip_conntrack 2>/dev/null || true; } |
        grep -oE "dst=([0-9]{1,3}\\.){3}[0-9]{1,3}" | cut -d= -f2 | sort -u |
        while read -r ip; do
            ipset test telegram_v4 "$ip" >/dev/null 2>&1 && echo "$ip"
        done
    ' 2>/dev/null | head -n "$max_dynamic_dcs"
}

current_probe_ips() {
    {
        printf '%s\n' $probe_ips
        discover_active_dc_ips || true
    } | awk 'NF && !seen[$0]++'
}

lane_broken() {
    local ip attempt successes=0 total=0 targets target_count required
    targets="$(current_probe_ips)"
    target_count="$(printf '%s\n' "$targets" | awk 'NF{n++} END{print n+0}')"
    if (( target_count == 0 )); then
        log "probe discovery returned no Telegram DC targets"
        return 0
    fi

    # Require ~80% of all attempts. This tolerates one transient DC while
    # detecting a partially degraded Smart Edge path.
    while read -r ip; do
        [[ -n "$ip" ]] || continue
        for ((attempt=1; attempt<=probe_attempts; attempt++)); do
            total=$((total + 1))
            if timeout "$probe_timeout" bash -c "exec 3<>/dev/tcp/$ip/443" 2>/dev/null; then
                successes=$((successes + 1))
            fi
        done
    done <<< "$targets"

    required=$(( (total * 80 + 99) / 100 ))
    # Preserve the explicit floor for the historical 2-DC/3-attempt case.
    if (( target_count <= 2 && probe_required_successes > required )); then
        required="$probe_required_successes"
    fi
    if (( successes >= required )); then
        return 1
    fi
    log "probe degraded: $successes/$total TCP connects succeeded across $target_count DC(s) (need >=$required); targets=$(echo "$targets" | tr '\n' ',' | sed 's/,$//')"
    return 0
}

haos_stack_broken() {
    # Validate the inner HAOS layer itself, not only end-to-end TCP reachability.
    # Expected healthy state: addon container running, TPROXY listener :12555,
    # fwmark rule present and table 100 routes marked traffic locally.
    timeout "$ssh_command_timeout" ssh -p "$haos_ssh_port" -o BatchMode=yes -o ConnectTimeout=8 "root@$haos_host" \
        "docker inspect -f '{{.State.Running}}' '$addon_container' 2>/dev/null | grep -qx true && \
         docker exec '$addon_container' /usr/bin/healthcheck.sh >/dev/null 2>&1 && \
         ss -lntup 2>/dev/null | grep -q ':12555' && \
         ip rule 2>/dev/null | grep -Eq 'fwmark 0x1.*lookup 100|fwmark 0x1.*table 100' && \
         ip route show table 100 2>/dev/null | grep -q ." \
        >/dev/null 2>&1 || return 0
    # Require a real UDP DNS response, not merely an accepting TCP socket.
    # SERVFAIL still proves the local resolver responds; upstream outages are
    # handled by endpoint selection rather than repeated LAN restarts.
    local name
    for name in example.com github.com; do
        if dig +time=3 +tries=1 "@$haos_host" "$name" A | grep -q 'HEADER'; then
            return 1
        fi
    done
    log "local DNS produced no response for either probe"
    return 0
}

haos_recent_critical_errors() {
    # Treat a burst of fresh transport/DNS failures as degraded even when some
    # Telegram TCP handshakes still succeed. Keep the window short to avoid
    # reacting to historical noise.
    local n
    n="$(timeout "$ssh_command_timeout" ssh -p "$haos_ssh_port" -o BatchMode=yes -o ConnectTimeout=8 "root@$haos_host" \
        "docker logs --since 6m '$addon_container' 2>&1 | grep -Eic 'dns.*timeout|connection reset by peer|i/o timeout|context deadline exceeded|network is unreachable|dial tcp.*timeout' || true" 2>/dev/null || echo 0)"
    [[ "$n" =~ ^[0-9]+$ ]] || n=0
    if (( n >= 6 )); then
        log "HAOS Smart Edge degraded: $n critical transport/DNS errors in last 6m"
        return 0
    fi
    return 1
}

haos_reachable() {
    timeout 8 bash -c "exec 3<>/dev/tcp/$haos_host/$haos_ssh_port" 2>/dev/null
}

restart_addon() {
    timeout "$restart_command_timeout" ssh -p "$haos_ssh_port" -o BatchMode=yes -o ConnectTimeout=10 \
        "root@$haos_host" "ha apps restart '$addon_slug' >/dev/null"
}

failures=0
if [[ -s "$state_file" ]]; then
    failures="$(cat "$state_file")"
fi
[[ "$failures" =~ ^[0-9]+$ ]] || failures=0

stack_bad=0
if haos_reachable; then
    if haos_stack_broken; then
        stack_bad=1
    fi
else
    log "HAOS management unreachable; preserve runtime and retry next cycle"
    exit 0
fi

if (( stack_bad == 0 )); then
    # An upstream/provider outage cannot be repaired by restarting healthy LAN
    # DNS. Log end-to-end degradation, but leave working sessions untouched.
    if lane_broken; then
        log "upstream lane degraded but local stack healthy; no restart"
    fi
    if (( failures > 0 )); then
        log "lane healthy again after $failures failed cycle(s)"
    fi
    printf '0\n' > "$state_file"
    exit 0
fi

failures=$((failures + 1))
printf '%s\n' "$failures" > "$state_file"
log "lane degraded, consecutive cycles: $failures/$failures_before_action"

if (( failures < failures_before_action )); then
    exit 0
fi

now="$(date +%s)"
last_action=0
if [[ -s "$last_action_file" ]]; then
    last_action="$(cat "$last_action_file")"
fi
[[ "$last_action" =~ ^[0-9]+$ ]] || last_action=0
if (( now - last_action < cooldown_seconds )); then
    log "cooldown active ($((cooldown_seconds - (now - last_action)))s left); skipping restart"
    exit 0
fi

if ! haos_reachable; then
    log "HAOS $haos_host:$haos_ssh_port unreachable; a restart cannot help"
    exit 0
fi

if (( dry_run )); then
    log "dry-run: would restart $addon_container on $haos_host"
    exit 0
fi

log "restarting $addon_container on $haos_host"
printf '%s\n' "$now" > "$last_action_file"
if restart_addon >/dev/null; then
    sleep 25
    if haos_stack_broken || lane_broken; then
        log "restart performed but lane still broken; next cycles will re-evaluate"
    else
        log "restart performed; lane healthy again"
    fi
else
    log "restart command failed"
fi

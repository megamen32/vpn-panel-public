#!/usr/bin/env bash
# route-health.sh — automatic best-route selection and self-healing for the
# ai-route selector. Every round it probes each regional lane through the
# add-on's own LAN HTTP proxy inbounds (a real end-to-end request to the AI
# endpoint), scores lanes by latency (EWMA) and error streaks, and switches
# the selector via the local clash API when:
#   * the currently selected lane starts erroring (heal), or
#   * another proven lane is >=30% faster for two consecutive rounds.
# If every lane fails for several rounds it restarts sing-box (the run.sh
# supervisor then restarts the add-on with fresh state).

set -uo pipefail

OPTIONS_PATH="${OPTIONS_PATH:-/data/options.json}"
# shellcheck source=/dev/null
source /usr/lib/transparent-smart-edge-options.sh 2>/dev/null || true
if ! declare -F option >/dev/null 2>&1; then
    option() { printf '%s' "$2"; }
fi

CLASH_API="${ROUTE_HEALTH_CLASH_API:-http://127.0.0.1:9095}"
SELECTOR="${ROUTE_HEALTH_SELECTOR:-ai-route}"
STATE_PATH="${ROUTE_HEALTH_STATE:-/data/route-health-state.json}"
INTERVAL="${ROUTE_HEALTH_INTERVAL:-45}"
PROBE_URL="${ROUTE_HEALTH_PROBE_URL:-https://api.openai.com/v1/models}"
CURL="${CURL_BIN:-curl}"
ALL_FAIL_ROUNDS_TO_RESTART="${ROUTE_HEALTH_ALL_FAIL_ROUNDS:-3}"
SWITCH_RATIO_NUM="${ROUTE_HEALTH_SWITCH_RATIO_NUM:-7}"
SWITCH_RATIO_DEN="${ROUTE_HEALTH_SWITCH_RATIO_DEN:-10}"
ONCE="${ROUTE_HEALTH_ONCE:-false}"

lanes_default="$(option lan_fi_proxy_outbound_tag fi-helsinki):$(option lan_fi_proxy_port 3129) $(option lan_de_proxy_outbound_tag de-regional):$(option lan_de_proxy_port 3128) $(option lan_us_proxy_outbound_tag us-regional):$(option lan_us_proxy_port 3127)"
LANES="${ROUTE_HEALTH_LANES:-$lanes_default}"

log() { printf 'route-health: %s\n' "$*"; }

state_read() {
    if [[ -s "$STATE_PATH" ]] && jq -e 'type == "object"' "$STATE_PATH" >/dev/null 2>&1; then
        cat "$STATE_PATH"
    else
        printf '{}'
    fi
}

state_write() {
    jq '.' <<<"$1" >/dev/null 2>&1 || return 0
    printf '%s' "$1" >"${STATE_PATH}.tmp" && mv -f "${STATE_PATH}.tmp" "$STATE_PATH"
}

lane_field() { # state tag field
    jq -r --arg t "$2" --arg f "$3" '(.lanes[$t][$f] // 0)' <<<"$1" 2>/dev/null
}

probe_lane() { # port -> "ok <seconds>" | "err"
    local out code
    out="$("$CURL" -s -o /dev/null -w '%{http_code} %{time_total}' -x "http://127.0.0.1:$1" -m 6 "$PROBE_URL" 2>/dev/null)" || { printf 'err'; return; }
    code="${out%% *}"
    case "$code" in
        2*|3*|4*) printf 'ok %s' "${out##* }" ;;
        *) printf 'err' ;;
    esac
}

clash_get_now() {
    "$CURL" -s -m 3 "$CLASH_API/proxies/$SELECTOR" 2>/dev/null | jq -r '.now // empty' 2>/dev/null
}

clash_select() { # tag
    "$CURL" -s -m 3 -X PUT -H 'Content-Type: application/json' \
        -d "{\"name\":\"$1\"}" "$CLASH_API/proxies/$SELECTOR" >/dev/null 2>&1
}

pid_of_singbox() {
    if [[ -n "${SINGBOX_PID:-}" ]] && kill -0 "$SINGBOX_PID" 2>/dev/null; then
        printf '%s' "$SINGBOX_PID"
        return
    fi
    pgrep -o -x sing-box 2>/dev/null | head -1 || true
}

wait_for_clash() {
    local i
    for i in $(seq 1 30); do
        [[ -n "$(clash_get_now)" ]] && return 0
        sleep 1
    done
    return 1
}

score_of() { # ewma_ms err_streak -> score
    awk -v e="$1" -v s="$2" 'BEGIN { pen = (s > 0) ? 3 : 1; printf "%.0f", e * pen }'
}

round() {
    local state chosen all_fail line="" best_tag="" best_score=0 any_ok=false
    local spec tag port res ms ewma errs oks score
    state="$(state_read)"
    chosen="$(jq -r '.chosen // empty' <<<"$state" 2>/dev/null)"
    all_fail="$(jq -r '.all_fail_rounds // 0' <<<"$state" 2>/dev/null)"

    for spec in $LANES; do
        tag="${spec%%:*}"
        port="${spec##*:}"
        res="$(probe_lane "$port")"
        ewma="$(lane_field "$state" "$tag" ewma_ms)"; ewma="${ewma%%.*}"
        [[ "$ewma" =~ ^[0-9]+$ ]] || ewma=0
        errs="$(lane_field "$state" "$tag" err_streak)"
        [[ "$errs" =~ ^[0-9]+$ ]] || errs=0
        oks="$(lane_field "$state" "$tag" ok_streak)"
        [[ "$oks" =~ ^[0-9]+$ ]] || oks=0
        if [[ "$res" == ok* ]]; then
            ms="$(awk -v t="${res#ok }" 'BEGIN { printf "%.0f", t * 1000 }')"
            if (( ewma == 0 )); then ewma=$ms; else ewma=$(( (7 * ewma + 3 * ms) / 10 )); fi
            oks=$((oks + 1)); errs=0
            any_ok=true
        else
            errs=$((errs + 1)); oks=0
            if (( ewma > 0 )); then ewma=$(( ewma * 3 )); else ewma=10000; fi
            (( ewma > 30000 )) && ewma=30000
            ms=0
        fi
        state="$(jq --arg t "$tag" --argjson e "$ewma" --argjson r "$errs" --argjson o "$oks" \
            '.lanes[$t] = {ewma_ms:$e, err_streak:$r, ok_streak:$o}' <<<"$state")"
        line+="${tag}=${ms}ms/$([[ "$res" == ok* ]] && printf 'ok' || printf "err${errs}") "
        score="$(score_of "$ewma" "$errs")"
        if [[ "$res" == ok* ]]; then
            if [[ -z "$best_tag" ]] || (( score < best_score )); then
                best_tag="$tag"; best_score=$score
            fi
        fi
    done

    if [[ "$any_ok" != true ]]; then
        all_fail=$((all_fail + 1))
        state="$(jq --argjson a "$all_fail" '.all_fail_rounds = $a' <<<"$state")"
        state_write "$state"
        log "round: $line| ALL LANES FAILING (${all_fail}/${ALL_FAIL_ROUNDS_TO_RESTART})"
        if (( all_fail >= ALL_FAIL_ROUNDS_TO_RESTART )); then
            local sbp
            sbp="$(pid_of_singbox)"
            if [[ -n "$sbp" ]]; then
                log "AUTOHEAL: every lane failed ${all_fail} rounds; restarting sing-box (pid ${sbp})"
                kill -TERM "$sbp" 2>/dev/null || true
            fi
            state="$(jq '.all_fail_rounds = 0' <<<"$state")"
            state_write "$state"
        fi
        return 0
    fi
    state="$(jq '.all_fail_rounds = 0' <<<"$state")"

    local now cur_tag cur_ewma cur_errs cur_oks cur_score best_oks action
    now="$(clash_get_now)"
    [[ -n "$now" ]] || now="$chosen"
    cur_tag="$now"
    cur_ewma="$(lane_field "$state" "$cur_tag" ewma_ms)"; cur_ewma="${cur_ewma%%.*}"
    cur_errs="$(lane_field "$state" "$cur_tag" err_streak)"
    cur_oks="$(lane_field "$state" "$cur_tag" ok_streak)"
    cur_score="$(score_of "${cur_ewma:-0}" "${cur_errs:-0}")"
    best_oks="$(lane_field "$state" "$best_tag" ok_streak)"

    action="keep"
    if [[ -z "$cur_tag" || "${cur_oks:-0}" -eq 0 ]]; then
        action="switch"
    elif [[ "$best_tag" != "$cur_tag" ]] && (( best_oks >= 2 )); then
        if (( cur_score == 0 )) || (( SWITCH_RATIO_NUM * best_score <= SWITCH_RATIO_DEN * cur_score )); then
            action="switch"
        fi
    fi

    if [[ "$action" == switch && -n "$best_tag" && "$best_tag" != "$cur_tag" ]]; then
        if clash_select "$best_tag"; then
            state="$(jq --arg c "$best_tag" '.chosen = $c' <<<"$state")"
            log "SWITCH ${SELECTOR} -> ${best_tag} (from ${cur_tag:-none}, score ${cur_score}ms -> ${best_score}ms) | $line"
        else
            log "switch to ${best_tag} via clash API failed; keeping ${cur_tag:-none}"
        fi
    else
        log "round: $line| chosen=${cur_tag:-none} best=${best_tag}(${best_score}ms) -> keep"
    fi
    state_write "$state"
}

main() {
    log "started: lanes=[${LANES// /, }] probe=${PROBE_URL} every ${INTERVAL}s"
    if ! wait_for_clash; then
        log "clash API not reachable at ${CLASH_API}; selector control unavailable this start"
    fi
    local state saved
    state="$(state_read)"
    saved="$(jq -r '.chosen // empty' <<<"$state" 2>/dev/null)"
    if [[ -n "$saved" && "$saved" != "$(clash_get_now)" ]]; then
        clash_select "$saved" && log "restored saved selection: ${saved}"
    fi
    while true; do
        round
        [[ "$ONCE" == true ]] && break
        sleep "$INTERVAL"
    done
}

main "$@"

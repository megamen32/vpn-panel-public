#!/usr/bin/env bash
# The boot-time TPROXY policy apply in run.sh is one-shot. If an interface
# race or an external flush removes the nft table or the marked route, every
# listener health check stays green while the Telegram lane silently dies
# (2026-09-06 incident). This watchdog re-applies the idempotent policy from
# telegram-tproxy-policy.sh until the transparent path exists again.
set -euo pipefail

POLICY_BIN="${POLICY_BIN:-/usr/bin/telegram-tproxy-policy.sh}"
TABLE="${TABLE:-telegram_transparent}"
MARKED_TABLE="${MARKED_TABLE:-100}"

usage() {
    printf 'usage: telegram-tproxy-watchdog.sh PORT [interval-seconds] [--once]\n' >&2
    exit 2
}

[[ $# -ge 1 ]] || usage
port=""
interval=""
once=0
while [[ $# -gt 0 ]]; do
    case "$1" in
        --once)
            once=1
            ;;
        *)
            if [[ -z "$port" ]]; then
                port="$1"
            elif [[ -z "$interval" ]]; then
                interval="$1"
            else
                usage
            fi
            ;;
    esac
    shift
done
[[ "$port" =~ ^[0-9]+$ ]] || usage
[[ -z "$interval" || "$interval" =~ ^[0-9]+$ ]] || usage
interval="${interval:-15}"

policy_present() {
    nft list table "inet $TABLE" >/dev/null 2>&1 \
        && ip route show table "$MARKED_TABLE" 2>/dev/null | grep -q '^local'
}

state=ok
while true; do
    if policy_present; then
        if [[ "$state" != ok ]]; then
            printf 'telegram tproxy policy present again\n'
            state=ok
        fi
    else
        if [[ "$state" == ok ]]; then
            printf 'telegram tproxy policy missing; re-applying\n'
            state=broken
        fi
        "$POLICY_BIN" "$port" --apply || printf 'telegram tproxy re-apply failed\n'
    fi
    if [[ "$once" == 1 ]]; then
        exit 0
    fi
    sleep "$interval"
done

#!/usr/bin/env bash

option() {
    local key="$1"
    local fallback="$2"
    local value=""
    if [[ -s "$OPTIONS_PATH" ]]; then
        value="$(jq -er --arg key "$key" 'if has($key) then .[$key] else empty end' "$OPTIONS_PATH" 2>/dev/null || true)"
    fi
    [[ -n "$value" ]] && printf '%s' "$value" || printf '%s' "$fallback"
}

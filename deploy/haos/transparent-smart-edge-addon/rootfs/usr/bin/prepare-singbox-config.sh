#!/usr/bin/env bash

set -euo pipefail

source_config="${1:?usage: prepare-singbox-config.sh SOURCE_CONFIG [OUTBOUND_TAG] [DESTINATION] [LOOPBACK_PORT] [TELEGRAM_OUTBOUND_TAG]}"
outbound_tag="${2:-de-regional}"
destination="${3:-/data/singbox.json}"
listen_port="${4:-23128}"
telegram_outbound_tag="${5:-us-regional}"
validator="${VALIDATOR_BIN:-/usr/bin/validate-singbox-config.sh}"

if [[ ! -s "$source_config" ]]; then
    printf 'missing source sing-box config at %s\n' "$source_config" >&2
    exit 2
fi

umask 077
tmp="${destination}.tmp.$$"
cleanup() {
    rm -f "$tmp"
}
trap cleanup EXIT INT TERM

# Extract the selected urltest groups and their direct VLESS dependencies.
# Credentials remain only in the source and the mode-0600 destination; neither
# jq nor this script prints them.
if ! jq -e \
    --arg tag "$outbound_tag" \
    --arg telegram_tag "$telegram_outbound_tag" \
    --argjson port "$listen_port" \
    '. as $root
     | def by_tag($wanted): [$root.outbounds[]? | select(.tag == $wanted)];
     def valid_leaf:
       .type == "vless"
       and .tls.enabled == true
       and .tls.utls.enabled == true
       and ((.transport.type == "ws") or (.transport.type == "httpupgrade") or (.tls.reality.enabled == true));
     def expand($wanted):
       by_tag($wanted) as $matches
       | select(($matches | length) == 1)
       | $matches[0] as $selected
       | if $selected.type == "urltest" then
           select(($selected.outbounds | type) == "array" and ($selected.outbounds | length) > 0)
           | [$selected.outbounds[] | . as $member | by_tag($member)[] | select(valid_leaf)] as $leaves
           | select(($leaves | length) == ($selected.outbounds | length))
           | $leaves + [$selected]
         else
           select($selected | valid_leaf)
           | [$selected]
         end;
     (expand($tag)) as $primary
     | (if $telegram_tag == "" or $telegram_tag == $tag then [] else expand($telegram_tag) end) as $telegram
     | {
         log: {level: "info", timestamp: true},
         inbounds: [{
           type: "http",
           tag: "transparent-edge-http",
           listen: "127.0.0.1",
           listen_port: $port
         }],
         outbounds: (($primary + $telegram) | unique_by(.tag)),
         route: {rules: [], final: $tag}
       }' \
    "$source_config" >"$tmp"; then
    printf 'source config has no complete transport group for %s / %s\n' "$outbound_tag" "$telegram_outbound_tag" >&2
    exit 2
fi

chmod 0600 "$tmp"
"$validator" "$tmp" "$listen_port" "$outbound_tag" "$telegram_outbound_tag"
mv -f "$tmp" "$destination"
trap - EXIT INT TERM
printf 'sing-box transport installed at %s using automatic groups %s / %s\n' "$destination" "$outbound_tag" "$telegram_outbound_tag"

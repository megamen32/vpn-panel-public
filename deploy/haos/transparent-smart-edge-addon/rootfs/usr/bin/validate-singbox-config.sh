#!/usr/bin/env bash

set -euo pipefail

config_path="${1:-/data/singbox.json}"
listen_port="${2:-23128}"
outbound_tag="${3:-de-regional}"
telegram_outbound_tag="${4:-us-regional}"
lan_us_enabled="${5:-false}"
lan_us_port="${6:-3127}"
lan_us_outbound_tag="${7:-us-regional}"
lan_de_enabled="${8:-false}"
lan_de_port="${9:-3128}"
lan_de_outbound_tag="${10:-de-regional}"
lan_fi_enabled="${11:-false}"
lan_fi_port="${12:-3129}"
lan_fi_outbound_tag="${13:-fi-helsinki}"
lan_ru_enabled="${14:-false}"
lan_ru_port="${15:-3130}"
lan_ru_outbound_tag="${16:-direct}"
ai_route_enabled="${17:-false}"
clash_api_address="${CLASH_API_ADDRESS:-127.0.0.1:9095}"
singbox_bin="${SING_BOX_BIN:-/usr/bin/sing-box}"

if [[ ! -s "$config_path" ]]; then
    printf 'missing sing-box config at %s\n' "$config_path" >&2
    exit 2
fi

if ! jq -e \
    --arg tag "$outbound_tag" \
    --arg telegram_tag "$telegram_outbound_tag" \
    --argjson port "$listen_port" \
    --argjson lan_us_enabled "$lan_us_enabled" \
    --argjson lan_us_port "$lan_us_port" \
    --arg lan_us_tag "$lan_us_outbound_tag" \
    --argjson lan_de_enabled "$lan_de_enabled" \
    --argjson lan_de_port "$lan_de_port" \
    --arg lan_de_tag "$lan_de_outbound_tag" \
    --argjson lan_fi_enabled "$lan_fi_enabled" \
    --argjson lan_fi_port "$lan_fi_port" \
    --arg lan_fi_tag "$lan_fi_outbound_tag" \
    --argjson lan_ru_enabled "$lan_ru_enabled" \
    --argjson lan_ru_port "$lan_ru_port" \
    --arg lan_ru_tag "$lan_ru_outbound_tag" \
    --argjson ai_enabled "$ai_route_enabled" \
    --arg clash_api "$clash_api_address" \
    '. as $root
     | def by_tag($wanted): [$root.outbounds[]? | select(.tag == $wanted)];
     def valid_leaf:
       .type == "vless"
       and ((.server | type) == "string" and (.server | length) > 0)
       and ((.server_port | type) == "number" and .server_port > 0 and .server_port <= 65535)
       and ((.uuid | type) == "string" and (.uuid | length) > 0)
       and .tls.enabled == true
       and .tls.utls.enabled == true
       and ((.transport.type == "ws") or (.transport.type == "httpupgrade") or (.tls.reality.enabled == true));
     def valid_target($wanted):
       by_tag($wanted) as $matches
       | ($matches | length) == 1
       and ($matches[0] as $selected
         | if $selected.type == "urltest" then
             (($selected.outbounds | type) == "array" and ($selected.outbounds | length) > 0)
             and all($selected.outbounds[]; . as $member | (by_tag($member) | length) == 1 and (by_tag($member)[0] | valid_leaf))
           else ($selected | valid_leaf) end);
     ([.inbounds[]? | select(.type == "http" and .tag == "transparent-edge-http" and .listen == "127.0.0.1" and .listen_port == $port)] | length) == 1
     and valid_target($tag)
     and .route.final == $tag
     and (if $telegram_tag == "" then true else valid_target($telegram_tag) end)
     and (if $lan_us_enabled then
            valid_target($lan_us_tag)
            and ([.inbounds[]? | select(.type == "http" and .tag == "lan-us-http" and .listen == "0.0.0.0" and .listen_port == $lan_us_port and ((.users // []) | length) == 0)] | length) == 1
            and ([.route.rules[]? | select(.outbound == $lan_us_tag and ((.inbound // []) | index("lan-us-http")))] | length) == 1
            and ([.inbounds[]? | select(.type == "http" and .tag == "wan-us-http" and .listen == "0.0.0.0" and .listen_port == ($lan_us_port + 10000) and (.users | length) > 0)] | length) == 1
            and ([.route.rules[]? | select(.outbound == $lan_us_tag and ((.inbound // []) | index("wan-us-http")))] | length) == 1
          else ([.inbounds[]? | select(.tag == "lan-us-http" or .tag == "wan-us-http")] | length) == 0 end)
     and (if $lan_de_enabled then
            valid_target($lan_de_tag)
            and ([.inbounds[]? | select(.type == "http" and .tag == "lan-de-http" and .listen == "0.0.0.0" and .listen_port == $lan_de_port and ((.users // []) | length) == 0)] | length) == 1
            and ([.route.rules[]? | select(.outbound == $lan_de_tag and ((.inbound // []) | index("lan-de-http")))] | length) == 1
            and ([.inbounds[]? | select(.type == "http" and .tag == "wan-de-http" and .listen == "0.0.0.0" and .listen_port == ($lan_de_port + 10000) and (.users | length) > 0)] | length) == 1
            and ([.route.rules[]? | select(.outbound == $lan_de_tag and ((.inbound // []) | index("wan-de-http")))] | length) == 1
          else ([.inbounds[]? | select(.tag == "lan-de-http" or .tag == "wan-de-http")] | length) == 0 end)
     and (if $lan_fi_enabled then
            valid_target($lan_fi_tag)
            and ([.inbounds[]? | select(.type == "http" and .tag == "lan-fi-http" and .listen == "0.0.0.0" and .listen_port == $lan_fi_port and ((.users // []) | length) == 0)] | length) == 1
            and ([.route.rules[]? | select(.outbound == $lan_fi_tag and ((.inbound // []) | index("lan-fi-http")))] | length) == 1
            and ([.inbounds[]? | select(.type == "http" and .tag == "wan-fi-http" and .listen == "0.0.0.0" and .listen_port == ($lan_fi_port + 10000) and (.users | length) > 0)] | length) == 1
            and ([.route.rules[]? | select(.outbound == $lan_fi_tag and ((.inbound // []) | index("wan-fi-http")))] | length) == 1
          else ([.inbounds[]? | select(.tag == "lan-fi-http" or .tag == "wan-fi-http")] | length) == 0 end)
     and (if $lan_ru_enabled then
            ([.outbounds[]? | select(.tag == $lan_ru_tag and .type == "direct")] | length) == 1
            and ([.inbounds[]? | select(.type == "http" and .tag == "lan-ru-http" and .listen == "0.0.0.0" and .listen_port == $lan_ru_port and ((.users // []) | length) == 0)] | length) == 1
            and ([.route.rules[]? | select(.outbound == $lan_ru_tag and ((.inbound // []) | index("lan-ru-http")))] | length) == 1
            and ([.inbounds[]? | select(.type == "http" and .tag == "wan-ru-http" and .listen == "0.0.0.0" and .listen_port == ($lan_ru_port + 10000) and (.users | length) > 0)] | length) == 1
            and ([.route.rules[]? | select(.outbound == $lan_ru_tag and ((.inbound // []) | index("wan-ru-http")))] | length) == 1
          else ([.inbounds[]? | select(.tag == "lan-ru-http" or .tag == "wan-ru-http")] | length) == 0 end)
     and (if ([.inbounds[]? | select(.tag == "telegram-tproxy")] | length) == 0 then true
          else ([.route.rules[]? | select(.outbound == $telegram_tag and ((.inbound // []) | index("telegram-tproxy")))] | length) == 1 end)
     and (if $ai_enabled then
            ([.outbounds[]? | select(.tag == "ai-route" and .type == "selector")] | length) == 1
            and (([.outbounds[]? | select(.tag == "ai-route")] | first | .outbounds | length) > 0)
            and (([.outbounds[]? | select(.tag == "ai-route")] | first | .outbounds | map(select(. as $m | (by_tag($m) | length) == 0)) | length) == 0)
            and (.experimental.clash_api.external_controller == $clash_api)
            and ([.route.rules[]? | select(.outbound == "ai-route" and ((.domain_suffix // []) | index("openai.com")))] | length) == 1
          else ([.outbounds[]? | select(.tag == "ai-route")] | length) == 0 end)' \
    "$config_path" >/dev/null; then
    printf 'sing-box config does not expose the required automatic transport groups and Telegram route\n' >&2
    exit 2
fi

if ! "$singbox_bin" check -c "$config_path" >/dev/null 2>&1; then
    printf 'sing-box 1.13.14 rejected the supplied transport config\n' >&2
    exit 2
fi

printf 'sing-box transport config valid: outbound=%s telegram=%s loopback_port=%s ai_route=%s\n' "$outbound_tag" "$telegram_outbound_tag" "$listen_port" "$ai_route_enabled"

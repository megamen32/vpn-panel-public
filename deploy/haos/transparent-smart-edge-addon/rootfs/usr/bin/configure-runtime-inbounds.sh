#!/usr/bin/env bash

set -euo pipefail

source_config="${1:?usage: configure-runtime-inbounds.sh SOURCE DEST TELEGRAM_ENABLED TELEGRAM_PORT TELEGRAM_OUTBOUND LAN_US_ENABLED LAN_US_PORT LAN_US_OUTBOUND LAN_DE_ENABLED LAN_DE_PORT LAN_DE_OUTBOUND LAN_FI_ENABLED LAN_FI_PORT LAN_FI_OUTBOUND LAN_RU_ENABLED LAN_RU_PORT LAN_RU_OUTBOUND PROXY_USERS_FILE AI_ROUTE_ENABLED [AI_DOMAINS_CSV]}"
destination="${2:?missing destination}"
telegram_enabled="${3:?missing telegram enabled}"
telegram_port="${4:?missing telegram port}"
telegram_outbound="${5:?missing telegram outbound}"
lan_us_enabled="${6:?missing LAN US enabled}"
lan_us_port="${7:?missing LAN US port}"
lan_us_outbound="${8:?missing LAN US outbound}"
lan_de_enabled="${9:?missing LAN DE enabled}"
lan_de_port="${10:?missing LAN DE port}"
lan_de_outbound="${11:?missing LAN DE outbound}"
lan_fi_enabled="${12:?missing LAN Finland enabled}"
lan_fi_port="${13:?missing LAN Finland port}"
lan_fi_outbound="${14:?missing LAN Finland outbound}"
lan_ru_enabled="${15:?missing LAN RU enabled}"
lan_ru_port="${16:?missing LAN RU port}"
lan_ru_outbound="${17:?missing LAN RU outbound}"
proxy_users_file="${18:?missing proxy users file}"
ai_route_enabled="${19:?missing AI route enabled}"
ai_domains_csv="${20:-openai.com,chatgpt.com,oaistatic.com,oaiusercontent.com,oaistatsig.com,sora.com,anthropic.com,claude.ai,claude.com}"
clash_api_address="${CLASH_API_ADDRESS:-127.0.0.1:9095}"

jq -e '(.users | type == "array") and all(.users[]?; (.username | type == "string" and length > 0) and (.password | type == "string" and length > 0))' "$proxy_users_file" >/dev/null

jq \
  --argjson telegram_enabled "$telegram_enabled" \
  --argjson telegram_port "$telegram_port" \
  --arg telegram_outbound "$telegram_outbound" \
  --argjson lan_us_enabled "$lan_us_enabled" \
  --argjson lan_us_port "$lan_us_port" \
  --arg lan_us_outbound "$lan_us_outbound" \
  --argjson lan_de_enabled "$lan_de_enabled" \
  --argjson lan_de_port "$lan_de_port" \
  --arg lan_de_outbound "$lan_de_outbound" \
  --argjson lan_fi_enabled "$lan_fi_enabled" \
  --argjson lan_fi_port "$lan_fi_port" \
  --arg lan_fi_outbound "$lan_fi_outbound" \
  --argjson lan_ru_enabled "$lan_ru_enabled" \
  --argjson lan_ru_port "$lan_ru_port" \
  --arg lan_ru_outbound "$lan_ru_outbound" \
  --argjson ai_route_enabled "$ai_route_enabled" \
  --arg ai_domains "$ai_domains_csv" \
  --arg clash_api "$clash_api_address" \
  --slurpfile proxy_auth "$proxy_users_file" '
  def lan_http($tag; $port):
    {type:"http",tag:$tag,listen:"0.0.0.0",listen_port:$port};
  def wan_http($tag; $port):
    {type:"http",tag:$tag,listen:"0.0.0.0",listen_port:($port + 10000),users:$proxy_auth[0].users};
  .outbounds = ((.outbounds // []) | map(select(.tag != "ai-route")))
  | .inbounds = ((.inbounds // []) | map(select(.tag != "telegram-tproxy" and .tag != "lan-us-http" and .tag != "lan-de-http" and .tag != "lan-fi-http" and .tag != "lan-ru-http" and .tag != "wan-us-http" and .tag != "wan-de-http" and .tag != "wan-fi-http" and .tag != "wan-ru-http")))
  | .route.rules = ((.route.rules // []) | map(select(
      ((.inbound // []) | index("telegram-tproxy")) == null
      and ((.inbound // []) | index("lan-us-http")) == null
      and ((.inbound // []) | index("lan-de-http")) == null
      and ((.inbound // []) | index("lan-fi-http")) == null
      and ((.inbound // []) | index("lan-ru-http")) == null
      and ((.inbound // []) | index("wan-us-http")) == null
      and ((.inbound // []) | index("wan-de-http")) == null
      and ((.inbound // []) | index("wan-fi-http")) == null
      and ((.inbound // []) | index("wan-ru-http")) == null
      and ((.outbound // "") != "ai-route")
    )))
  | if $telegram_enabled then
      .inbounds += [{type:"tproxy",tag:"telegram-tproxy",listen:"0.0.0.0",listen_port:$telegram_port}]
      | .route.rules = ([{inbound:["telegram-tproxy"],outbound:$telegram_outbound}] + .route.rules)
    else . end
  | if $ai_route_enabled then
      ([$lan_fi_outbound, $lan_de_outbound, $lan_us_outbound] | map(select(. != "")) | reduce .[] as $x ([]; if index($x) then . else . + [$x] end)) as $ai_candidates
      | ([(.outbounds // [])[]? | .tag]) as $known_tags
      | ([$ai_candidates[] | select(. as $t | ($known_tags | index($t)) != null)]) as $ai_members
      | if ($ai_members | length) > 0 then
          .outbounds += [{type:"selector", tag:"ai-route", outbounds:$ai_members, default:$ai_members[0]}]
          | .experimental = ((.experimental // {}) + {clash_api:{external_controller:$clash_api}})
          | .route.rules = ([{domain_suffix:($ai_domains | split(",")), outbound:"ai-route"}] + .route.rules)
        else . end
    else . end
  | if $lan_us_enabled then
      .inbounds += [lan_http("lan-us-http"; $lan_us_port), wan_http("wan-us-http"; $lan_us_port)]
      | .route.rules = ([{inbound:["lan-us-http"],outbound:$lan_us_outbound}] + .route.rules)
      | .route.rules = ([{inbound:["wan-us-http"],outbound:$lan_us_outbound}] + .route.rules)
    else . end
  | if $lan_de_enabled then
      .inbounds += [lan_http("lan-de-http"; $lan_de_port), wan_http("wan-de-http"; $lan_de_port)]
      | .route.rules = ([{inbound:["lan-de-http"],outbound:$lan_de_outbound}] + .route.rules)
      | .route.rules = ([{inbound:["wan-de-http"],outbound:$lan_de_outbound}] + .route.rules)
    else . end
  | if $lan_fi_enabled then
      .inbounds += [lan_http("lan-fi-http"; $lan_fi_port), wan_http("wan-fi-http"; $lan_fi_port)]
      | .route.rules = ([{inbound:["lan-fi-http"],outbound:$lan_fi_outbound}] + .route.rules)
      | .route.rules = ([{inbound:["wan-fi-http"],outbound:$lan_fi_outbound}] + .route.rules)
    else . end
  | if $lan_ru_enabled then
      .inbounds += [lan_http("lan-ru-http"; $lan_ru_port), wan_http("wan-ru-http"; $lan_ru_port)]
      | .route.rules = ([{inbound:["lan-ru-http"],outbound:$lan_ru_outbound}] + .route.rules)
      | .route.rules = ([{inbound:["wan-ru-http"],outbound:$lan_ru_outbound}] + .route.rules)
    else . end
' "$source_config" >"$destination"

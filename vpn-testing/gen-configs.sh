#!/usr/bin/env bash
set -euo pipefail

SUBSCRIPTION_URL="${1:-}"
SOCKS_PORT=11080

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
XRAY_DIR="$SCRIPT_DIR/configs/xray"
SINGBOX_DIR="$SCRIPT_DIR/configs/singbox"

CYAN='\033[0;36m'
GREEN='\033[0;32m'
BOLD='\033[1m'
NC='\033[0m'

log() { echo -e "${CYAN}[gen-configs]${NC} $*"; }
ok()  { echo -e "${GREEN}[OK]${NC} $*"; }

mkdir -p "$XRAY_DIR" "$SINGBOX_DIR"

fetch_subscription() {
  if [[ -n "$SUBSCRIPTION_URL" ]]; then
    curl -sf "$SUBSCRIPTION_URL"
    return
  fi
  local token
  token=$(sudo -u postgres psql -t -A -d vpn_panel \
    -c "SELECT token FROM subscription_tokens WHERE client_id IN (SELECT id FROM clients WHERE name IN ('geier25','Nikita')) LIMIT 1" 2>/dev/null || true)
  if [[ -z "$token" ]]; then
    echo "ERROR: Could not auto-fetch subscription token. Pass URL as argument." >&2
    exit 1
  fi
  curl -sf "http://127.0.0.1:3129/sub/$token/plain"
}

parse_vless_link() {
  local link="$1"
  local uuid address port
  uuid=$(echo "$link" | sed -E 's|^vless://([^@]+)@.*|\1|')
  local rest="${link#vless://$uuid@}"
  address=$(echo "$rest" | sed -E 's|^([^:?#]+).*|\1|')
  rest="${rest#$address}"
  if [[ "$rest" == :* ]]; then
    port=$(echo "$rest" | sed -E 's|^:([0-9]+).*|\1|')
    rest="${rest#$port}"
    rest="${rest#:}"
  else
    port="443"
  fi
  local query="" fragment=""
  if [[ "$rest" == *"?"* ]]; then
    query="${rest#*?}"
    query="${query%%#*}"
  fi
  if [[ "$rest" == *"#"* ]]; then
    fragment="${rest#*#}"
    fragment=$(python3 -c "import urllib.parse,sys; print(urllib.parse.unquote(sys.argv[1]))" "$fragment" 2>/dev/null || echo "$fragment")
  fi

  local type="tcp" security="tls" sni="" path="" host="" fp="" pbk="" sid="" alpn="" flow="" mode="auto" h2="false"
  if [[ -n "$query" ]]; then
    IFS='&' read -ra pairs <<< "$query"
    for pair in "${pairs[@]}"; do
      local key="${pair%%=*}" val="${pair#*=}"
      val=$(python3 -c "import urllib.parse,sys; print(urllib.parse.unquote(sys.argv[1]))" "$val" 2>/dev/null || echo "$val")
      case "$key" in
        type)     type="$val" ;;
        security) security="$val" ;;
        sni)      sni="$val" ;;
        path)     path="$val" ;;
        host)     host="$val" ;;
        fp)       fp="$val" ;;
        pbk)      pbk="$val" ;;
        sid)      sid="$val" ;;
        alpn)     alpn="$val" ;;
        flow)     flow="$val" ;;
        mode)     mode="$val" ;;
        h2)       h2="$val" ;;
      esac
    done
  fi

  local id
  id=$(echo "$fragment" | sed 's/[^a-zA-Z0-9_-]/-/g; s/--*/-/g; s/^-//; s/-$//' | tr '[:upper:]' '[:lower:]')
  [[ -z "$id" ]] && id="${address}-${port}-${type}"

  jq -n \
    --arg id "$id" --arg name "$fragment" --arg uuid "$uuid" \
    --arg address "$address" --argjson port "$port" \
    --arg type "$type" --arg security "$security" \
    --arg sni "$sni" --arg path "$path" --arg host "$host" \
    --arg fp "$fp" --arg pbk "$pbk" --arg sid "$sid" \
    --arg alpn "$alpn" --arg flow "$flow" \
    --arg mode "$mode" --argjson h2 "$h2" \
    '{id:$id, name:$name, uuid:$uuid, address:$address, port:$port, type:$type, security:$security, sni:$sni, path:$path, host:$host, fp:$fp, pbk:$pbk, sid:$sid, alpn:$alpn, flow:$flow, mode:$mode, h2:$h2}'
}

gen_xray_config() {
  local ep_json="$1"
  local uuid address port type security sni path host fp pbk sid alpn flow mode h2
  uuid=$(echo "$ep_json"    | jq -r '.uuid')
  address=$(echo "$ep_json" | jq -r '.address')
  port=$(echo "$ep_json"    | jq -r '.port')
  type=$(echo "$ep_json"    | jq -r '.type')
  security=$(echo "$ep_json"| jq -r '.security')
  sni=$(echo "$ep_json"     | jq -r '.sni')
  path=$(echo "$ep_json"    | jq -r '.path')
  host=$(echo "$ep_json"    | jq -r '.host')
  fp=$(echo "$ep_json"      | jq -r '.fp')
  pbk=$(echo "$ep_json"     | jq -r '.pbk')
  sid=$(echo "$ep_json"     | jq -r '.sid')
  alpn=$(echo "$ep_json"    | jq -r '.alpn')
  flow=$(echo "$ep_json"    | jq -r '.flow')
  mode=$(echo "$ep_json"    | jq -r '.mode // "auto"')
  h2=$(echo "$ep_json"      | jq -r '.h2 // false')

  local user_obj
  if [[ -n "$flow" && "$flow" != "null" ]]; then
    user_obj=$(jq -n --arg id "$uuid" --arg flow "$flow" '{id:$id, encryption:"none", flow:$flow}')
  else
    user_obj=$(jq -n --arg id "$uuid" '{id:$id, encryption:"none"}')
  fi

  local stream_settings
  if [[ "$security" == "reality" ]]; then
    stream_settings=$(jq -n \
      --arg network "${type:-tcp}" \
      --arg sni "$sni" --arg fp "${fp:-chrome}" --arg pbk "$pbk" --arg sid "$sid" \
      '{network:(if $network == "null" or $network == "" then "tcp" else $network end), security:"reality", realitySettings:{serverName:$sni, fingerprint:$fp, publicKey:$pbk, shortId:$sid}}')
  else
    local tls_settings
    tls_settings=$(jq -n --arg sni "$sni" --arg fp "${fp:-chrome}" '{serverName:$sni, fingerprint:$fp}')
    if [[ "$type" == "ws" ]]; then
      tls_settings=$(echo "$tls_settings" | jq '. + {alpn:["http/1.1"]}')
    elif [[ -n "$alpn" && "$alpn" != "null" ]]; then
      local alpn_arr
      alpn_arr=$(echo "$alpn" | tr ',' '\n' | jq -R . | jq -s .)
      tls_settings=$(echo "$tls_settings" | jq --argjson a "$alpn_arr" '. + {alpn:$a}')
    fi
    stream_settings=$(jq -n --arg network "$type" --argjson tls "$tls_settings" '{network:$network, security:"tls", tlsSettings:$tls}')
    case "$type" in
      ws)
        local ws_settings
        ws_settings=$(jq -n --arg path "$path" --arg host "$host" '{path:$path} + (if $host != "" and $host != "null" then {host:$host} else {} end)')
        stream_settings=$(echo "$stream_settings" | jq --argjson ws "$ws_settings" '. + {wsSettings:$ws}')
        ;;
      httpupgrade)
        local hu_settings
        hu_settings=$(jq -n --arg path "$path" --arg host "$host" '{path:$path} + (if $host != "" and $host != "null" then {host:$host} else {} end)')
        stream_settings=$(echo "$stream_settings" | jq --argjson hu "$hu_settings" '. + {httpupgradeSettings:$hu}')
        ;;
      xhttp)
        local xh_settings
        xh_settings=$(jq -n --arg path "$path" --arg host "$host" --arg mode "$mode" --argjson h2 "$h2" \
          '{path:$path, mode:$mode, h2:$h2} + (if $host != "" and $host != "null" then {host:$host} else {} end)')
        stream_settings=$(echo "$stream_settings" | jq --argjson xh "$xh_settings" '. + {xhttpSettings:$xh}')
        ;;
      grpc)
        local grpc_settings
        grpc_settings=$(jq -n --arg sn "$path" '{serviceName:$sn, multiMode:true}')
        stream_settings=$(echo "$stream_settings" | jq --argjson g "$grpc_settings" '. + {grpcSettings:$g}')
        ;;
    esac
  fi

  jq -n \
    --argjson user "$user_obj" --arg address "$address" --argjson port "$port" \
    --argjson stream "$stream_settings" --argjson socks_port "$SOCKS_PORT" \
    '{
      log:{loglevel:"error"},
      inbounds:[{tag:"socks-in", port:$socks_port, listen:"127.0.0.1", protocol:"socks", settings:{auth:"noauth", udp:true}}],
      outbounds:[{tag:"proxy", protocol:"vless", settings:{vnext:[{address:$address, port:$port, users:[$user]}]}, streamSettings:$stream},{tag:"direct", protocol:"freedom"}],
      routing:{rules:[{type:"field", network:"tcp,udp", outboundTag:"proxy"}]}
    }'
}

gen_singbox_config() {
  local ep_json="$1"
  local uuid address port type security sni path host fp pbk sid flow
  uuid=$(echo "$ep_json"    | jq -r '.uuid')
  address=$(echo "$ep_json" | jq -r '.address')
  port=$(echo "$ep_json"    | jq -r '.port')
  type=$(echo "$ep_json"    | jq -r '.type')
  security=$(echo "$ep_json"| jq -r '.security')
  sni=$(echo "$ep_json"     | jq -r '.sni')
  path=$(echo "$ep_json"    | jq -r '.path')
  host=$(echo "$ep_json"    | jq -r '.host')
  fp=$(echo "$ep_json"      | jq -r '.fp')
  pbk=$(echo "$ep_json"     | jq -r '.pbk')
  sid=$(echo "$ep_json"     | jq -r '.sid')
  flow=$(echo "$ep_json"    | jq -r '.flow')

  local tls_obj
  if [[ "$security" == "reality" ]]; then
    tls_obj=$(jq -n --arg sni "$sni" --arg fp "${fp:-chrome}" --arg pbk "$pbk" --arg sid "$sid" \
      '{enabled:true, server_name:$sni, reality:{enabled:true, public_key:$pbk, short_id:$sid}, utls:{enabled:true, fingerprint:$fp}}')
  else
    tls_obj=$(jq -n --arg sni "$sni" --arg fp "${fp:-chrome}" \
      '{enabled:true, server_name:$sni, utls:{enabled:true, fingerprint:$fp}}')
  fi

  local outbound
  outbound=$(jq -n --arg uuid "$uuid" --arg server "$address" --argjson port "$port" --argjson tls "$tls_obj" \
    '{type:"vless", tag:"proxy", server:$server, server_port:$port, uuid:$uuid, tls:$tls}')

  if [[ -n "$flow" && "$flow" != "null" ]]; then
    outbound=$(echo "$outbound" | jq --arg flow "$flow" '. + {flow:$flow}')
  fi

  if [[ "$security" != "reality" && "$type" != "tcp" && "$type" != "null" ]]; then
    local transport_obj
    case "$type" in
      ws)
        transport_obj=$(jq -n --arg path "$path" --arg host "$host" \
          '{type:"ws", path:$path} + (if $host != "" and $host != "null" then {headers:{Host:$host}} else {} end)')
        ;;
      httpupgrade)
        transport_obj=$(jq -n --arg path "$path" --arg host "$host" \
          '{type:"httpupgrade", path:$path} + (if $host != "" and $host != "null" then {host:$host} else {} end)')
        ;;
      grpc)
        transport_obj=$(jq -n --arg sn "$path" '{type:"grpc", service_name:$sn}')
        ;;
      *) transport_obj="null" ;;
    esac
    if [[ "$transport_obj" != "null" ]]; then
      outbound=$(echo "$outbound" | jq --argjson t "$transport_obj" '. + {transport:$t}')
    fi
  fi

  jq -n --argjson outbound "$outbound" --argjson socks_port "$SOCKS_PORT" \
    '{log:{level:"error"}, inbounds:[{type:"socks", tag:"socks-in", listen:"127.0.0.1", listen_port:$socks_port}], outbounds:[$outbound, {type:"direct", tag:"direct"}], route:{rules:[], final:"proxy", auto_detect_interface:true}}'
}

# ─── Main ────────────────────────────────────────────────────────────────────
log "Fetching subscription..."
SUBSCRIPTION_TEXT=$(fetch_subscription)
if [[ -z "$SUBSCRIPTION_TEXT" ]]; then
  echo "ERROR: Empty subscription" >&2
  exit 1
fi

rm -f "$XRAY_DIR"/*.json "$SINGBOX_DIR"/*.json

log "Parsing VLESS links..."
count=0
while IFS= read -r line; do
  [[ -z "$line" || "$line" != vless://* ]] && continue
  ep=$(parse_vless_link "$line")
  id=$(echo "$ep" | jq -r '.id')
  safe_id=$(echo "$id" | sed 's/[^a-zA-Z0-9._-]/_/g')

  gen_xray_config "$ep" > "$XRAY_DIR/${safe_id}.json"
  ok "Xray config:    ${safe_id}.json"

  gen_singbox_config "$ep" > "$SINGBOX_DIR/${safe_id}.json"
  ok "SingBox config: ${safe_id}.json"

  count=$((count + 1))
done <<< "$SUBSCRIPTION_TEXT"

log "Generated ${BOLD}$count${NC} endpoint configs in:"
log "  Xray:    $XRAY_DIR/"
log "  SingBox: $SINGBOX_DIR/"

#!/usr/bin/env bash
set -euo pipefail

# ─── Defaults ────────────────────────────────────────────────────────────────
NODE="server-100"
ENGINE="xray"
SUBSCRIPTION_URL=""
TIMEOUT=15
ENDPOINT_FILTER=""
SOCKS_PORT=11080
XRAY_IMAGE="teddysun/xray:26.6.1"
SINGBOX_IMAGE="ghcr.io/sagernet/sing-box:v1.13.14"

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
RESULTS_DIR="$SCRIPT_DIR/results"
CONFIGS_DIR="$SCRIPT_DIR/configs"

SITES=("chatgpt.com" "youtube.com" "telegram.org" "instagram.com" "discord.com" "whatsapp.com")

# SSH targets
declare -A SSH_HOSTS=(
  [mac]="user@localhost -p 2222"
  [server-44]="192.168.2.5"
  [server-88]="192.168.2.75"
)

# ─── Colors ──────────────────────────────────────────────────────────────────
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
CYAN='\033[0;36m'
BOLD='\033[1m'
NC='\033[0m'

# ─── Usage ───────────────────────────────────────────────────────────────────
usage() {
  cat <<EOF
Usage: $0 [OPTIONS]
  --node=server-100|mac|server-44|server-88|auto  (default: server-100)
  --engine=xray|singbox|both                       (default: xray)
  --subscription=URL   (or auto-fetch from local panel)
  --timeout=SECONDS    (default: 15 per site)
  --endpoints=id1,id2  (comma-separated filter, default: all)
  -h|--help
EOF
  exit 0
}

# ─── Parse args ──────────────────────────────────────────────────────────────
for arg in "$@"; do
  case "$arg" in
    --node=*)       NODE="${arg#*=}" ;;
    --engine=*)     ENGINE="${arg#*=}" ;;
    --subscription=*) SUBSCRIPTION_URL="${arg#*=}" ;;
    --timeout=*)    TIMEOUT="${arg#*=}" ;;
    --endpoints=*)  ENDPOINT_FILTER="${arg#*=}" ;;
    -h|--help)      usage ;;
    *)              echo "Unknown option: $arg"; usage ;;
  esac
done

mkdir -p "$RESULTS_DIR" "$CONFIGS_DIR/xray" "$CONFIGS_DIR/singbox"

# ─── Fetch subscription ──────────────────────────────────────────────────────
fetch_subscription() {
  if [[ -n "$SUBSCRIPTION_URL" ]]; then
    curl -sf "$SUBSCRIPTION_URL"
    return
  fi
  local token
  token=$(sudo -u postgres psql -t -A -d vpn_panel \
    -c "SELECT token FROM subscription_tokens WHERE enabled=true ORDER BY created_at DESC LIMIT 1" 2>/dev/null || true)
  if [[ -z "$token" ]]; then
    echo "ERROR: Could not auto-fetch subscription token. Use --subscription=URL" >&2
    exit 1
  fi
  curl -sf "http://127.0.0.1:3129/sub/$token/plain"
}

# ─── Helper: extract query param ─────────────────────────────────────────────
get_param() {
  local query="$1" key="$2"
  echo "$query" | grep -oP "(^|[?&])${key}=\K[^&]*" | head -1 || echo ""
}

# ─── Parse VLESS link ────────────────────────────────────────────────────────
parse_vless_link() {
  local link="$1"

  # Parse vless://UUID@ADDRESS:PORT?QUERY#NAME
  local proto_rest="${link#vless://}"
  local uuid="${proto_rest%%@*}"
  local rest="${proto_rest#*@}"

  # Split host:port from query string
  local hostport="${rest%%\?*}"
  local query="${rest#*\?}"
  query="${query%%#*}"  # remove fragment from query

  # Extract fragment (name)
  local fragment=""
  if [[ "$rest" == *"#"* ]]; then
    fragment="${rest#*#}"
    fragment=$(python3 -c "import urllib.parse,sys; print(urllib.parse.unquote(sys.argv[1]))" "$fragment" 2>/dev/null || echo "$fragment")
  fi

  # Extract address and port from hostport
  local address="${hostport%%:*}"
  local port
  if [[ "$hostport" == *:* ]]; then
    port="${hostport##*:}"
  else
    port="443"
  fi

  # Parse query params individually
  local type security sni path host fp pbk sid alpn flow mode h2
  type=$(get_param "$query" "type")
  [[ -z "$type" ]] && type="tcp"
  security=$(get_param "$query" "security")
  [[ -z "$security" ]] && security="tls"
  sni=$(get_param "$query" "sni")
  path=$(get_param "$query" "path")
  host=$(get_param "$query" "host")
  fp=$(get_param "$query" "fp")
  pbk=$(get_param "$query" "pbk")
  sid=$(get_param "$query" "sid")
  alpn=$(get_param "$query" "alpn")
  flow=$(get_param "$query" "flow")
  mode=$(get_param "$query" "mode")
  h2=$(get_param "$query" "h2")

  # URL-decode values
  local decode='import urllib.parse,sys; print(urllib.parse.unquote(sys.argv[1]))'
  sni=$(python3 -c "$decode" "$sni" 2>/dev/null || echo "$sni")
  path=$(python3 -c "$decode" "$path" 2>/dev/null || echo "$path")
  host=$(python3 -c "$decode" "$host" 2>/dev/null || echo "$host")

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
    --arg mode "${mode:-auto}" --argjson h2 "${h2:-false}" \
    '{id:$id, name:$name, uuid:$uuid, address:$address, port:$port, type:$type, security:$security, sni:$sni, path:$path, host:$host, fp:$fp, pbk:$pbk, sid:$sid, alpn:$alpn, flow:$flow, mode:$mode, h2:$h2}'
}

# ─── Generate Xray config ───────────────────────────────────────────────────
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
        xh_settings=$(jq -n --arg path "$path" --arg host "$host" --arg mode "${mode:-auto}" --argjson h2 "${h2:-false}" \
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

# ─── Generate SingBox config ────────────────────────────────────────────────
gen_singbox_config() {
  local ep_json="$1"
  local uuid address port type security sni path host fp pbk sid alpn flow
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

# ─── Run helpers (all logging to stderr) ─────────────────────────────────────
log()  { echo -e "${CYAN}[$(date +%H:%M:%S)]${NC} $*" >&2; }
ok()   { echo -e "${GREEN}[OK]${NC} $*" >&2; }
warn() { echo -e "${YELLOW}[WARN]${NC} $*" >&2; }
fail() { echo -e "${RED}[FAIL]${NC} $*" >&2; }

# ─── SOCKS curl helper (runs locally or via SSH for mac) ─────────────────────
# Usage: socks_curl <curl_args...>
# Runs curl locally, or via SSH to mac if NODE=mac
socks_curl() {
  if [[ "$NODE" == "mac" ]]; then
    local ssh_cmd="${SSH_HOSTS[mac]}"
    # Build the full curl command as a single string for SSH
    local curl_cmd="curl"
    for a in "$@"; do
      curl_cmd+=" $(printf '%q' "$a")"
    done
    # shellcheck disable=SC2086
    ssh -n -o ConnectTimeout=5 $ssh_cmd "$curl_cmd" 2>/dev/null
  else
    curl "$@" 2>/dev/null
  fi
}

# ─── Test one endpoint ──────────────────────────────────────────────────────
test_endpoint() {
  local ep_json="$1"
  local engine="$2"
  local id address port
  id=$(echo "$ep_json" | jq -r '.id')
  address=$(echo "$ep_json" | jq -r '.address')
  port=$(echo "$ep_json" | jq -r '.port')

  log "Testing endpoint: ${BOLD}$id${NC} ($address:$port) via $engine"

  local result='{}'
  result=$(echo "$result" | jq --arg id "$id" '. + {id:$id}')

  # 1. TCP reachability
  local tcp_ok=false
  if nc -zv -w 5 "$address" "$port" 2>/dev/null; then
    tcp_ok=true
    ok "TCP reachable"
  else
    fail "TCP unreachable"
  fi
  result=$(echo "$result" | jq --argjson v "$tcp_ok" '. + {tcp_reachable:$v}')

  if [[ "$tcp_ok" == "false" ]]; then
    result=$(echo "$result" | jq '. + {tunnel_up:false, exit_ip:"", sites:[], speed_mbps:0, large_transfer_mbps:0, large_transfer_ok:false}')
    echo "$result" | jq -c .
    return
  fi

  # 2. Generate config and start engine
  local config_file="$CONFIGS_DIR/${engine}/probe-${engine}-${id}.json"
  local container_name="probe-${engine}-${id}"
  rm -f "$config_file"

  if [[ "$engine" == "xray" ]]; then
    gen_xray_config "$ep_json" > "$config_file"
  else
    gen_singbox_config "$ep_json" > "$config_file"
  fi

  start_engine "$engine" "$config_file" "$container_name"
  sleep 3

  # Verify proxy is up
  local tunnel_up=false
  local probe_raw
  probe_raw=$(socks_curl --socks5-hostname "127.0.0.1:$SOCKS_PORT" --max-time 5 -o /dev/null -w "%{http_code}" "https://www.gstatic.com/generate_204" 2>/dev/null) || true
  [[ -z "$probe_raw" ]] && probe_raw="000"
  if [[ "$probe_raw" == "204" || "$probe_raw" == "200" ]]; then
    tunnel_up=true
    ok "Tunnel up"
  else
    fail "Tunnel not responding (got: $probe_raw)"
  fi
  result=$(echo "$result" | jq --argjson v "$tunnel_up" '. + {tunnel_up:$v}')

  if [[ "$tunnel_up" == "false" ]]; then
    stop_engine "$engine" "$container_name"
    result=$(echo "$result" | jq '. + {exit_ip:"", sites:[], speed_mbps:0, large_transfer_mbps:0, large_transfer_ok:false}')
    echo "$result" | jq -c .
    return
  fi

  # 3. Exit IP
  local exit_ip
  exit_ip=$(socks_curl --socks5-hostname "127.0.0.1:$SOCKS_PORT" -s --max-time 10 "https://ifconfig.me" 2>/dev/null) || true
  if [[ -n "$exit_ip" ]]; then
    ok "Exit IP: $exit_ip"
  else
    warn "Could not determine exit IP"
  fi
  result=$(echo "$result" | jq --arg ip "$exit_ip" '. + {exit_ip:$ip}')

  # 4. Website access
  local sites_json="[]"
  for site in "${SITES[@]}"; do
    local raw http_code latency_ms
    raw=$(socks_curl --socks5-hostname "127.0.0.1:$SOCKS_PORT" -s --max-time "$TIMEOUT" -w "%{http_code} %{time_total}" -o /dev/null "https://$site" 2>/dev/null) || true
    [[ -z "$raw" ]] && raw="000 0"
    http_code=$(echo "$raw" | awk '{print $1}')
    latency_ms=$(echo "$raw" | awk '{printf "%.0f", $2 * 1000}')

    if [[ "$http_code" == "200" ]]; then
      ok "$site -> ${http_code} (${latency_ms}ms)"
    elif [[ "$http_code" == "000" ]]; then
      fail "$site -> timeout"
    else
      warn "$site -> ${http_code} (${latency_ms}ms)"
    fi

    sites_json=$(echo "$sites_json" | jq \
      --arg url "$site" \
      --argjson code "${http_code:-0}" \
      --argjson ms "${latency_ms:-0}" \
      '. + [{url:$url, http_code:$code, latency_ms:$ms}]')
  done
  result=$(echo "$result" | jq --argjson s "$sites_json" '. + {sites:$s}')

  # 5. Download speed (2MB)
  local speed_bytes speed_mbps
  speed_bytes=$(socks_curl --socks5-hostname "127.0.0.1:$SOCKS_PORT" -s --max-time 30 -o /dev/null -w "%{speed_download}" "https://speed.cloudflare.com/__down?bytes=2000000" 2>/dev/null) || true
  [[ -z "$speed_bytes" ]] && speed_bytes="0"
  speed_mbps=$(echo "$speed_bytes" | awk '{printf "%.2f", $1 * 8 / 1000000}')
  ok "Speed: ${speed_mbps} Mbps"
  result=$(echo "$result" | jq --argjson v "${speed_mbps:-0}" '. + {speed_mbps:$v}')

  # 6. Large transfer (10MB)
  local large_raw large_speed_bytes large_code large_mbps large_ok
  large_raw=$(socks_curl --socks5-hostname "127.0.0.1:$SOCKS_PORT" -s --max-time 60 -o /dev/null -w "%{speed_download} %{http_code}" "https://speed.cloudflare.com/__down?bytes=10000000" 2>/dev/null) || true
  [[ -z "$large_raw" ]] && large_raw="0 000"
  large_speed_bytes=$(echo "$large_raw" | awk '{print $1}')
  large_code=$(echo "$large_raw" | awk '{print $2}')
  large_mbps=$(echo "$large_speed_bytes" | awk '{printf "%.2f", $1 * 8 / 1000000}')
  large_ok=false
  [[ "$large_code" == "200" ]] && large_ok=true
  if [[ "$large_ok" == "true" ]]; then
    ok "Large transfer: ${large_mbps} Mbps (OK)"
  else
    fail "Large transfer: ${large_mbps} Mbps (HTTP $large_code)"
  fi
  result=$(echo "$result" | jq \
    --argjson v "${large_mbps:-0}" \
    --argjson ok_v "$large_ok" \
    '. + {large_transfer_mbps:$v, large_transfer_ok:$ok_v}')

  stop_engine "$engine" "$container_name"
  echo "$result" | jq -c .
}

# ─── Engine lifecycle ────────────────────────────────────────────────────────
start_engine() {
  local engine="$1" config_file="$2" container_name="$3"

  if [[ "$NODE" == "server-100" ]]; then
    docker rm -f "$container_name" >/dev/null 2>&1 || true
    if [[ "$engine" == "xray" ]]; then
      docker run --rm -d --name "$container_name" --network host \
        -v "$config_file:/etc/xray/config.json:ro" \
        "$XRAY_IMAGE" >/dev/null 2>&1
    else
      docker run --rm -d --name "$container_name" --network host \
        -v "$config_file:/etc/sing-box/config.json:ro" \
        "$SINGBOX_IMAGE" >/dev/null 2>&1
    fi
  elif [[ "$NODE" == "mac" ]]; then
    local ssh_cmd="${SSH_HOSTS[mac]}"
    # shellcheck disable=SC2086
    ssh -n -o ConnectTimeout=5 -o StrictHostKeyChecking=no $ssh_cmd "mkdir -p /tmp/probe" >/dev/null 2>&1 || true
    # shellcheck disable=SC2086
    scp -o ConnectTimeout=5 -P 2222 "$config_file" user@localhost:/tmp/probe/config.json >/dev/null 2>&1 || true
    # shellcheck disable=SC2086
    ssh -n -o ConnectTimeout=5 $ssh_cmd "pkill -f 'xray.*probe' 2>/dev/null; nohup xray run -c /tmp/probe/config.json >/dev/null 2>&1 &" >/dev/null 2>&1 || true
  else
    local ssh_target="${SSH_HOSTS[$NODE]:-$NODE}"
    ssh -n -o ConnectTimeout=5 -o StrictHostKeyChecking=no "$ssh_target" "docker rm -f $container_name >/dev/null 2>&1; mkdir -p /tmp/probe" 2>/dev/null || true
    scp "$config_file" "$ssh_target:/tmp/probe/config.json" 2>/dev/null || true
    if [[ "$engine" == "xray" ]]; then
      ssh -n "$ssh_target" "docker run --rm -d --name $container_name --network host -v /tmp/probe/config.json:/etc/xray/config.json:ro $XRAY_IMAGE" >/dev/null 2>&1 || true
    else
      ssh -n "$ssh_target" "docker run --rm -d --name $container_name --network host -v /tmp/probe/config.json:/etc/sing-box/config.json:ro $SINGBOX_IMAGE" >/dev/null 2>&1 || true
    fi
  fi
}

stop_engine() {
  local engine="$1" container_name="$2"
  if [[ "$NODE" == "server-100" ]]; then
    docker rm -f "$container_name" >/dev/null 2>&1 || true
  elif [[ "$NODE" == "mac" ]]; then
    local ssh_cmd="${SSH_HOSTS[mac]}"
    # shellcheck disable=SC2086
    ssh -n -o ConnectTimeout=5 $ssh_cmd "pkill -f 'xray.*probe' 2>/dev/null" >/dev/null 2>&1 || true
  else
    local ssh_target="${SSH_HOSTS[$NODE]:-$NODE}"
    ssh -n -o ConnectTimeout=5 "$ssh_target" "docker rm -f $container_name >/dev/null 2>&1" >/dev/null 2>&1 || true
  fi
}

# ─── Node reachability ──────────────────────────────────────────────────────
node_reachable() {
  local node="$1"
  case "$node" in
    server-100) return 0 ;;
    mac)
      local ssh_cmd="${SSH_HOSTS[mac]}"
      # shellcheck disable=SC2086
      ssh -o ConnectTimeout=5 -o StrictHostKeyChecking=no $ssh_cmd "echo ok" >/dev/null 2>&1
      ;;
    server-44|server-88)
      local ssh_target="${SSH_HOSTS[$node]}"
      ssh -o ConnectTimeout=5 -o StrictHostKeyChecking=no "$ssh_target" "echo ok" >/dev/null 2>&1
      ;;
    *) return 1 ;;
  esac
}

# ─── Get node public IP ─────────────────────────────────────────────────────
get_node_ip() {
  local node="$1"
  case "$node" in
    server-100) curl -s --max-time 5 https://ifconfig.me 2>/dev/null || echo "unknown" ;;
    mac)
      local ssh_cmd="${SSH_HOSTS[mac]}"
      # shellcheck disable=SC2086
      ssh -o ConnectTimeout=5 $ssh_cmd "curl -s --max-time 5 https://ifconfig.me" 2>/dev/null || echo "unknown"
      ;;
    *)
      local ssh_target="${SSH_HOSTS[$node]:-$node}"
      ssh -o ConnectTimeout=5 "$ssh_target" "curl -s --max-time 5 https://ifconfig.me" 2>/dev/null || echo "unknown"
      ;;
  esac
}

# ─── Run tests on a node ────────────────────────────────────────────────────
run_on_node() {
  local node="$1"
  local engines_arg="$2"
  local engines=()
  if [[ "$engines_arg" == "both" ]]; then
    engines=("xray" "singbox")
  else
    engines=("$engines_arg")
  fi

  log "Node: ${BOLD}$node${NC}"
  if ! node_reachable "$node"; then
    warn "Node $node unreachable, skipping"
    return
  fi

  local node_ip
  node_ip=$(get_node_ip "$node")
  log "Node IP: $node_ip"

  for eng in "${engines[@]}"; do
    log "Engine: ${BOLD}$eng${NC}"
    local timestamp
    timestamp=$(date -u +"%Y-%m-%dT%H:%M:%SZ")
    local result_file="$RESULTS_DIR/probe-${node}-${eng}-$(date +%Y%m%d_%H%M%S).json"

    local endpoints_json="[]"
    while IFS= read -r ep_json_line; do
      [[ -z "$ep_json_line" ]] && continue
      local ep_id
      ep_id=$(echo "$ep_json_line" | jq -r '.id')

      if [[ -n "$ENDPOINT_FILTER" ]]; then
        if ! echo "$ENDPOINT_FILTER" | tr ',' '\n' | grep -qx "$ep_id"; then
          continue
        fi
      fi

      local ep_result
      ep_result=$(test_endpoint "$ep_json_line" "$eng")
      endpoints_json=$(echo "$endpoints_json" | jq --argjson ep "$ep_result" '. + [$ep]')
    done < <(echo "$PARSED_ENDPOINTS" | jq -c '.[]')

    jq -n \
      --arg ts "$timestamp" \
      --arg node "$node" \
      --arg ip "$node_ip" \
      --arg engine "$eng" \
      --argjson endpoints "$endpoints_json" \
      '{timestamp:$ts, node:$node, network_ip:$ip, engine:$engine, endpoints:$endpoints}' \
      > "$result_file"

    log "Results written to: ${BOLD}$result_file${NC}"
    print_summary_table "$result_file"
  done
}

# ─── Summary table ───────────────────────────────────────────────────────────
print_summary_table() {
  local file="$1"
  local node engine
  node=$(jq -r '.node' "$file")
  engine=$(jq -r '.engine' "$file")

  echo "" >&2
  echo -e "${BOLD}=== Probe Results: $node ($engine) ===${NC}" >&2
  printf "  ${BOLD}%-25s %-6s %-6s %-16s %-10s %-10s %-8s${NC}\n" 'ENDPOINT' 'TCP' 'VPN' 'EXIT_IP' 'SPEED' '10MB' 'SITES' >&2
  echo "  -----------------------------------------------------------------------------------" >&2

  while IFS= read -r ep; do
    local id tcp vpn exit_ip speed large large_ok
    id=$(echo "$ep" | jq -r '.id')
    tcp=$(echo "$ep" | jq -r '.tcp_reachable')
    vpn=$(echo "$ep" | jq -r '.tunnel_up')
    exit_ip=$(echo "$ep" | jq -r '.exit_ip')
    speed=$(echo "$ep" | jq -r '.speed_mbps')
    large=$(echo "$ep" | jq -r '.large_transfer_mbps')
    large_ok=$(echo "$ep" | jq -r '.large_transfer_ok')

    local sites_ok sites_total
    sites_ok=$(echo "$ep" | jq '[.sites[] | select(.http_code == 200)] | length')
    sites_total=$(echo "$ep" | jq '.sites | length')

    local tcp_s vpn_s speed_s large_s sites_s
    [[ "$tcp" == "true" ]] && tcp_s="${GREEN}Y${NC}" || tcp_s="${RED}N${NC}"
    [[ "$vpn" == "true" ]] && vpn_s="${GREEN}Y${NC}" || vpn_s="${RED}N${NC}"

    local speed_num
    speed_num=$(printf "%.1f" "$speed" 2>/dev/null || echo "0.0")
    if awk "BEGIN{exit !($speed > 5)}" 2>/dev/null; then
      speed_s="${GREEN}${speed_num}${NC}"
    elif awk "BEGIN{exit !($speed > 0)}" 2>/dev/null; then
      speed_s="${YELLOW}${speed_num}${NC}"
    else
      speed_s="${RED}0.0${NC}"
    fi

    [[ "$large_ok" == "true" ]] && large_s="${GREEN}${large}${NC}" || large_s="${RED}${large}${NC}"

    if [[ "$sites_ok" == "$sites_total" ]]; then
      sites_s="${GREEN}${sites_ok}/${sites_total}${NC}"
    elif [[ "$sites_ok" -gt 0 ]]; then
      sites_s="${YELLOW}${sites_ok}/${sites_total}${NC}"
    else
      sites_s="${RED}0/${sites_total}${NC}"
    fi

    printf "  %-25s ${tcp_s}      ${vpn_s}      %-16s ${speed_s} Mbps   ${large_s} Mbps   ${sites_s}\n" "$id" "$exit_ip" >&2
  done < <(jq -c '.endpoints[]' "$file")
  echo "" >&2
}

# ─── Main ────────────────────────────────────────────────────────────────────
log "Fetching subscription..."
SUBSCRIPTION_TEXT=$(fetch_subscription)
if [[ -z "$SUBSCRIPTION_TEXT" ]]; then
  fail "Empty subscription"
  exit 1
fi

log "Parsing VLESS links..."
PARSED_ENDPOINTS="[]"
while IFS= read -r line; do
  [[ -z "$line" || "$line" != vless://* ]] && continue
  ep=$(parse_vless_link "$line")
  PARSED_ENDPOINTS=$(echo "$PARSED_ENDPOINTS" | jq --argjson ep "$ep" '. + [$ep]')
done <<< "$SUBSCRIPTION_TEXT"

ep_count=$(echo "$PARSED_ENDPOINTS" | jq 'length')
log "Parsed $ep_count endpoints"

if [[ "$ep_count" -eq 0 ]]; then
  fail "No endpoints found"
  exit 1
fi

NODES=("$NODE")
if [[ "$NODE" == "auto" ]]; then
  NODES=("server-100" "mac" "server-44" "server-88")
fi

for n in "${NODES[@]}"; do
  run_on_node "$n" "$ENGINE"
done

log "All probes complete."

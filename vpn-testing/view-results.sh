#!/usr/bin/env bash
set -euo pipefail

NODE_FILTER=""
MODE="latest"

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
RESULTS_DIR="$SCRIPT_DIR/results"

RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
CYAN='\033[0;36m'
BOLD='\033[1m'
DIM='\033[2m'
NC='\033[0m'

for arg in "$@"; do
  case "$arg" in
    --node=*)    NODE_FILTER="${arg#*=}" ;;
    --compare)   MODE="compare" ;;
    --history)   MODE="history" ;;
    -h|--help)
      cat <<EOF
Usage: $0 [OPTIONS]
  (no args)       Latest run, all nodes
  --node=NODE     Filter by node (server-100, mac, server-44, server-88)
  --compare       Side-by-side comparison across nodes
  --history       List all result files
  -h, --help      Show this help
EOF
      exit 0
      ;;
    *) echo "Unknown option: $arg"; exit 1 ;;
  esac
done

mkdir -p "$RESULTS_DIR"

# ─── History mode ────────────────────────────────────────────────────────────
if [[ "$MODE" == "history" ]]; then
  echo -e "${BOLD}Probe result files:${NC}"
  echo ""
  if ls "$RESULTS_DIR"/probe-*.json 1>/dev/null 2>&1; then
    for f in $(ls -1t "$RESULTS_DIR"/probe-*.json); do
      fname=$(basename "$f")
      fts=$(jq -r '.timestamp // "unknown"' "$f" 2>/dev/null || echo "unknown")
      fnode=$(jq -r '.node // "?"' "$f" 2>/dev/null || echo "?")
      fengine=$(jq -r '.engine // "?"' "$f" 2>/dev/null || echo "?")
      fep=$(jq '.endpoints | length' "$f" 2>/dev/null || echo 0)
      fsize=$(du -h "$f" | awk '{print $1}')
      echo -e "  ${CYAN}$fname${NC}"
      echo -e "    ${DIM}Node: $fnode | Engine: $fengine | Endpoints: $fep | $fts | $fsize${NC}"
    done
  else
    echo -e "  ${DIM}No result files found.${NC}"
  fi
  exit 0
fi

# ─── Helpers ─────────────────────────────────────────────────────────────────
site_color() {
  local code="$1" latency_ms="$2"
  if [[ "$code" == "000" || "$code" == "0" ]]; then
    echo "$RED"
  elif [[ "$code" == "200" ]]; then
    if [[ "$latency_ms" -gt 2000 ]]; then
      echo "$YELLOW"
    else
      echo "$GREEN"
    fi
  else
    echo "$YELLOW"
  fi
}

speed_color() {
  local mbps="$1"
  if awk "BEGIN{exit !($mbps > 5)}" 2>/dev/null; then
    echo "$GREEN"
  elif awk "BEGIN{exit !($mbps > 0)}" 2>/dev/null; then
    echo "$YELLOW"
  else
    echo "$RED"
  fi
}

# ─── Display one result file ─────────────────────────────────────────────────
display_result() {
  local file="$1"
  local node engine ts network_ip
  node=$(jq -r '.node' "$file")
  engine=$(jq -r '.engine' "$file")
  ts=$(jq -r '.timestamp' "$file")
  network_ip=$(jq -r '.network_ip // "unknown"' "$file")

  echo ""
  echo -e "${BOLD}=== Probe: ${CYAN}${node}${NC}${BOLD} (${engine})  ${DIM}${ts}${NC}${BOLD}  IP: ${network_ip}${NC}"
  echo ""

  printf "  ${BOLD}%-28s  %-5s  %-5s  %-16s" "ENDPOINT" "TCP" "VPN" "EXIT_IP"
  for site in chatgpt youtube telegram instagram discord whatsapp; do
    printf "  %-9s" "${site:0:7}"
  done
  printf "  %-8s  %-8s${NC}\n" "SPEED" "10MB"
  echo "  ----------------------------------------------------------------------------------------------------------------------------------------"

  while IFS= read -r ep; do
    local id tcp vpn exit_ip
    id=$(echo "$ep" | jq -r '.id')
    tcp=$(echo "$ep" | jq -r '.tcp_reachable')
    vpn=$(echo "$ep" | jq -r '.tunnel_up')
    exit_ip=$(echo "$ep" | jq -r '.exit_ip // "-"')

    local tcp_c vpn_c
    [[ "$tcp" == "true" ]] && tcp_c="${GREEN}Y${NC}" || tcp_c="${RED}N${NC}"
    [[ "$vpn" == "true" ]] && vpn_c="${GREEN}Y${NC}" || vpn_c="${RED}N${NC}"

    printf "  %-28s  ${tcp_c}      ${vpn_c}      %-16s" "$id" "$exit_ip"

    for site in chatgpt.com youtube.com telegram.org instagram.com discord.com whatsapp.com; do
      local code latency_ms c
      code=$(echo "$ep" | jq -r --arg s "$site" '.sites[] | select(.url==$s) | .http_code // 0')
      latency_ms=$(echo "$ep" | jq -r --arg s "$site" '.sites[] | select(.url==$s) | .latency_ms // 0')
      [[ -z "$code" ]] && code=0
      [[ -z "$latency_ms" ]] && latency_ms=0
      c=$(site_color "$code" "$latency_ms")
      if [[ "$code" == "200" ]]; then
        printf "  ${c}%-4d/%-4d${NC}" "$code" "$latency_ms"
      elif [[ "$code" == "0" || "$code" == "000" ]]; then
        printf "  ${c}  FAIL  ${NC}"
      else
        printf "  ${c}%-4d/%-4d${NC}" "$code" "$latency_ms"
      fi
    done

    local speed_mbps large_mbps large_ok sc lc
    speed_mbps=$(echo "$ep" | jq -r '.speed_mbps // 0')
    large_mbps=$(echo "$ep" | jq -r '.large_transfer_mbps // 0')
    large_ok=$(echo "$ep" | jq -r '.large_transfer_ok // false')

    sc=$(speed_color "$speed_mbps")
    printf "  ${sc}%-8s${NC}" "$speed_mbps"

    [[ "$large_ok" == "true" ]] && lc=$(speed_color "$large_mbps") || lc="$RED"
    printf "  ${lc}%-8s${NC}" "$large_mbps"
    echo ""
  done < <(jq -c '.endpoints[]' "$file")

  echo ""
  echo -e "  ${DIM}Legend: ${GREEN}pass${DIM}  ${YELLOW}slow/warn${DIM}  ${RED}fail${NC}"
  echo -e "  ${DIM}Sites: code/latency_ms | Speed: Mbps${NC}"
  echo ""
}

# ─── Compare mode ────────────────────────────────────────────────────────────
display_compare() {
  local files=("$@")
  if [[ ${#files[@]} -lt 2 ]]; then
    echo -e "${YELLOW}Need at least 2 result files for comparison.${NC}"
    return
  fi

  echo ""
  echo -e "${BOLD}=== Side-by-side comparison ===${NC}"
  echo ""

  local all_ids
  all_ids=$(for f in "${files[@]}"; do jq -r '.endpoints[].id' "$f"; done | sort -u)

  printf "  ${BOLD}%-28s" "ENDPOINT"
  for f in "${files[@]}"; do
    local label
    label="$(jq -r '.node' "$f")/$(jq -r '.engine' "$f")"
    printf "  %-20s" "$label"
  done
  printf "${NC}\n"
  echo "  ----------------------------------------------------------------------------"

  while IFS= read -r ep_id; do
    [[ -z "$ep_id" ]] && continue
    printf "  %-28s" "$ep_id"

    for f in "${files[@]}"; do
      local ep_data
      ep_data=$(jq -c --arg id "$ep_id" '.endpoints[] | select(.id==$id)' "$f" 2>/dev/null || echo "")

      if [[ -z "$ep_data" ]]; then
        printf "  ${DIM}%-20s${NC}" "n/a"
        continue
      fi

      local vpn speed_mbps sites_ok
      vpn=$(echo "$ep_data" | jq -r '.tunnel_up')
      speed_mbps=$(echo "$ep_data" | jq -r '.speed_mbps // 0')
      sites_ok=$(echo "$ep_data" | jq '[.sites[] | select(.http_code==200)] | length')

      if [[ "$vpn" != "true" ]]; then
        printf "  ${RED}%-20s${NC}" "DOWN"
      else
        local sc summary
        sc=$(speed_color "$speed_mbps")
        summary="${speed_mbps} Mbps | ${sites_ok}/6 sites"
        printf "  ${sc}%-20s${NC}" "$summary"
      fi
    done
    echo ""
  done <<< "$all_ids"

  echo ""
}

# ─── Find result files ──────────────────────────────────────────────────────
find_result_files() {
  if [[ -n "$NODE_FILTER" ]]; then
    for f in $(ls -1t "$RESULTS_DIR"/probe-*.json 2>/dev/null); do
      fnode=$(jq -r '.node' "$f" 2>/dev/null || echo "")
      [[ "$fnode" == "$NODE_FILTER" ]] && echo "$f"
    done
  else
    ls -1t "$RESULTS_DIR"/probe-*.json 2>/dev/null
  fi
}

# ─── Main ────────────────────────────────────────────────────────────────────
mapfile -t result_files < <(find_result_files)

if [[ ${#result_files[@]} -eq 0 ]]; then
  echo -e "${RED}No result files found.${NC}"
  [[ -n "$NODE_FILTER" ]] && echo -e "  Filter: node=${NODE_FILTER}"
  echo -e "  Run ${CYAN}./vpn-testing/probe.sh${NC} first."
  exit 1
fi

if [[ "$MODE" == "compare" ]]; then
  display_compare "${result_files[@]}"
else
  declare -A seen
  for f in "${result_files[@]}"; do
    key="$(jq -r '.node' "$f")-$(jq -r '.engine' "$f")"
    if [[ -z "${seen[$key]:-}" ]]; then
      seen[$key]=1
      display_result "$f"
    fi
  done
fi

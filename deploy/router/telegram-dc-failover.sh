#!/bin/sh
set -eu

SET4=telegram_v4
LEGACY_GITHUB_SET4=github_v4
MARK=0x1
MASK=0xff
TABLE=100
PRIMARY=192.168.2.75
BACKUP=192.168.2.5
PORT=12555
HEALTH_IP=149.154.167.51
HEALTH_PORT=80
HEALTH_MARK=0x2
HEALTH_TABLE=101

cleanup_legacy_github() {
  iptables -t mangle -D PREROUTING -i br-lan -m set --match-set "$LEGACY_GITHUB_SET4" dst -j MARK --set-xmark 0x1/0x1 2>/dev/null || true
  ipset destroy "$LEGACY_GITHUB_SET4" 2>/dev/null || true
}

rollback() {
  iptables -t mangle -D PREROUTING -i br-lan -m set --match-set "$SET4" dst -j MARK --set-xmark 0x1/0x1 2>/dev/null || true
  cleanup_legacy_github
  ip rule del priority 1000 fwmark "$MARK/$MASK" table "$TABLE" 2>/dev/null || true
  ip route flush table "$TABLE" 2>/dev/null || true
  ipset destroy "$SET4" 2>/dev/null || true
}

probe() {
  # Route one router-originated Telegram DC connection through the candidate.
  # This exercises the target's nft TPROXY rule, policy routing and Xray
  # outbound, rather than merely accepting a TCP connection on :12555.
  target="$1"
  probe_proxy_outbound "$target" || return 1
  cleanup_probe() {
    iptables -t mangle -D OUTPUT -p tcp -d "$HEALTH_IP" --dport "$HEALTH_PORT" -j MARK --set-xmark "$HEALTH_MARK/$MASK" 2>/dev/null || true
    ip rule del priority 999 fwmark "$HEALTH_MARK/$MASK" table "$HEALTH_TABLE" 2>/dev/null || true
    ip route flush table "$HEALTH_TABLE" 2>/dev/null || true
  }
  cleanup_probe
  ip rule add priority 999 fwmark "$HEALTH_MARK/$MASK" table "$HEALTH_TABLE"
  ip route replace 192.168.2.0/24 dev br-lan scope link table "$HEALTH_TABLE"
  ip route replace default via "$target" dev br-lan table "$HEALTH_TABLE"
  iptables -t mangle -A OUTPUT -p tcp -d "$HEALTH_IP" --dport "$HEALTH_PORT" -j MARK --set-xmark "$HEALTH_MARK/$MASK"
  response="/tmp/telegram-dc-health.$$"
  rm -f "$response"
  # Check the same Telegram DC port that LAN clients use. A generic CONNECT
  # to telegram.org:443 only proves that the HTTP proxy accepted a request;
  # it does not prove the transparent TPROXY path is alive.
  (printf 'GET / HTTP/1.0\r\nHost: %s\r\nConnection: close\r\n\r\n' "$HEALTH_IP"; sleep 2) | nc "$HEALTH_IP" "$HEALTH_PORT" >"$response" 2>/dev/null &
  pid=$!
  sleep 4
  kill "$pid" 2>/dev/null || true
  wait "$pid" 2>/dev/null || true
  if grep -q '^HTTP/' "$response" 2>/dev/null; then
    rm -f "$response"
    cleanup_probe
    return 0
  fi
  rm -f "$response"
  cleanup_probe
  return 1
}
target() { probe "$PRIMARY" && { echo "$PRIMARY"; return; }; probe "$BACKUP" && echo "$BACKUP"; }
active_target() { ip route show table "$TABLE" | awk '/default via/ {print $3; exit}'; }

probe_proxy_outbound() {
  target="$1"
  response="/tmp/telegram-dc-proxy-probe.$$"
  rm -f "$response"
  printf 'CONNECT telegram.org:443 HTTP/1.1\r\nHost: telegram.org:443\r\n\r\n' | nc "$target" 3128 >"$response" 2>/dev/null &
  pid=$!
  sleep 3
  if kill -0 "$pid" 2>/dev/null; then
    kill "$pid" 2>/dev/null || true
    wait "$pid" 2>/dev/null || true
  fi
  grep -q ' 200 ' "$response"
  status=$?
  rm -f "$response"
  return "$status"
}

apply() {
  next="$1"
  cleanup_legacy_github
  ipset create "$SET4" hash:net family inet -exist
  for cidr in 91.108.56.0/22 91.108.4.0/22 91.108.8.0/22 91.108.16.0/22 91.108.12.0/22 149.154.160.0/20 91.105.192.0/23 91.108.20.0/22 185.76.151.0/24; do ipset add "$SET4" "$cidr" -exist; done
  iptables -t mangle -C PREROUTING -i br-lan -m set --match-set "$SET4" dst -j MARK --set-xmark 0x1/0x1 2>/dev/null || iptables -t mangle -A PREROUTING -i br-lan -m set --match-set "$SET4" dst -j MARK --set-xmark 0x1/0x1
  ip rule add priority 1000 fwmark "$MARK/$MASK" table "$TABLE" 2>/dev/null || true
  ip route replace 192.168.2.0/24 dev br-lan scope link table "$TABLE"
  ip route replace default via "$next" dev br-lan table "$TABLE"
}

watchdog() {
  cleanup_legacy_github
  while :; do
    next="$(target || true)"
    if [ -n "$next" ]; then
      [ "$(active_target)" = "$next" ] || apply "$next"
    else
      rollback
    fi
    sleep 5
  done
}

case "${1:---watchdog}" in
  --apply) next="$(target)"; [ -n "$next" ]; apply "$next" ;;
  --watchdog) watchdog ;;
  --rollback) rollback ;;
  --check) sh -n "$0" ;;
  *) exit 2 ;;
esac

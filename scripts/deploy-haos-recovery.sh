#!/usr/bin/env bash
# Deploy the canonical HAOS recovery HAProxy config and non-blocking addon entrypoint.
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"
TOPOLOGY_SOURCE="$REPO_DIR/deploy/public-ingress/topology.json"
DRY_RUN=false
[[ "${1:-}" == "--dry-run" ]] && DRY_RUN=true
command -v jq >/dev/null
node "$SCRIPT_DIR/render-public-ingress.mjs" --check
node "$SCRIPT_DIR/render-nginx-endpoints.mjs" --check
HAOS="${HAOS:-$(jq -er '.haos.sshHost' "$TOPOLOGY_SOURCE")}"
HAOS_PORT="${HAOS_PORT:-$(jq -er '.haos.sshPort' "$TOPOLOGY_SOURCE")}"
SLUG="$(jq -er '.haos.addonSlug' "$TOPOLOGY_SOURCE")"
CONTAINER="$(jq -er '.haos.container' "$TOPOLOGY_SOURCE")"
CONFIG_PATH="$(jq -er '.haos.configPath' "$TOPOLOGY_SOURCE")"
AUTH_PATH="$(jq -er '.haos.authPath' "$TOPOLOGY_SOURCE")"
RECOVERY_NGINX_MAP_PATH="$(jq -er '.haos.recoveryNginxMapPath' "$TOPOLOGY_SOURCE")"
RECOVERY_PROBE_HOSTS="$(jq -er '[.ingressServicePlacement.services[] | select(.recoveryAuth == "anonymous" and (.allowedIngressNodes | index("haos"))) | .hostnames[]] | unique | join(",")' "$TOPOLOGY_SOURCE")"
TIMESTAMP="$(date -u +%Y%m%d_%H%M%S)"
CERT_STAGE_DIR="/tmp/vpn-panel-haos-recovery-certs-$TIMESTAMP"
CONFIG_SOURCE="$REPO_DIR/deploy/haos/recovery-haproxy/haproxy.cfg"
RECOVERY_NGINX_MAP_SOURCE="$REPO_DIR/deploy/public-ingress/nginx-endpoints/haos-recovery-public.map"

ssh_cmd=(ssh -p "$HAOS_PORT" -o BatchMode=yes -o StrictHostKeyChecking=accept-new "$HAOS")
scp_cmd=(scp -P "$HAOS_PORT" -o BatchMode=yes -o StrictHostKeyChecking=accept-new)

# Recovery's anonymous public routes terminate TLS on HAOS. Their certificates
# originate on server-100, so stage the exact PEM bundles with the config rather
# than making a missing asset block an otherwise healthy HAProxy deploy.
IFS=, read -r -a recovery_probe_hosts <<< "$RECOVERY_PROBE_HOSTS"
for host in "${recovery_probe_hosts[@]}"; do
  cert_dir="/etc/letsencrypt/live/$host"
  sudo test -s "$cert_dir/fullchain.pem"
  sudo test -s "$cert_dir/privkey.pem"
done

"${scp_cmd[@]}" "$CONFIG_SOURCE" "$HAOS:/tmp/haproxy.cfg.pending"
"${scp_cmd[@]}" "$RECOVERY_NGINX_MAP_SOURCE" "$HAOS:/tmp/recovery-nginx-public.map.pending"
"${ssh_cmd[@]}" "rm -rf '$CERT_STAGE_DIR'; umask 077; mkdir -p '$CERT_STAGE_DIR'"
for host in "${recovery_probe_hosts[@]}"; do
  cert_dir="/etc/letsencrypt/live/$host"
  sudo sh -c "cat '$cert_dir/fullchain.pem' '$cert_dir/privkey.pem'" | \
    "${ssh_cmd[@]}" "umask 077; cat > '$CERT_STAGE_DIR/$host.pem'"
done

"${ssh_cmd[@]}" "TIMESTAMP='$TIMESTAMP' CONTAINER='$CONTAINER' SLUG='$SLUG' CONFIG_PATH='$CONFIG_PATH' AUTH_PATH='$AUTH_PATH' RECOVERY_NGINX_MAP_PATH='$RECOVERY_NGINX_MAP_PATH' RECOVERY_PROBE_HOSTS='$RECOVERY_PROBE_HOSTS' CERT_STAGE_DIR='$CERT_STAGE_DIR' DRY_RUN='$DRY_RUN' bash -s" <<'REMOTE'
set -euo pipefail
IFS=, read -r -a recovery_probe_hosts <<< "$RECOVERY_PROBE_HOSTS"

check_recovery_certificates() {
    local host
    for host in "${recovery_probe_hosts[@]}"; do
        docker exec "$CONTAINER" test -s "/data/certs/$host.pem"
    done
}

check_staged_recovery_certificates() {
    local host
    for host in "${recovery_probe_hosts[@]}"; do
        test -s "$CERT_STAGE_DIR/$host.pem"
    done
}

install_recovery_certificates() {
    local host
    docker exec "$CONTAINER" mkdir -p /data/certs
    for host in "${recovery_probe_hosts[@]}"; do
        if docker exec "$CONTAINER" test -f "/data/certs/$host.pem"; then
            docker exec "$CONTAINER" cp -a "/data/certs/$host.pem" "/data/certs/$host.pem.bak_$TIMESTAMP"
        fi
        docker cp "$CERT_STAGE_DIR/$host.pem" "$CONTAINER:/data/certs/$host.pem"
        docker exec "$CONTAINER" chmod 644 "/data/certs/$host.pem"
    done
    check_recovery_certificates
}

check_recovery_routes() {
    local host
    for host in "${recovery_probe_hosts[@]}"; do
        docker exec "$CONTAINER" curl -fsS --max-time 5 -H "Host: $host" http://127.0.0.1:18081/ >/dev/null
        echo | timeout 10 openssl s_client -connect 127.0.0.1:8443 -servername "$host" \
            -verify_hostname "$host" -verify_return_error >/dev/null 2>&1
    done
}

docker cp /tmp/haproxy.cfg.pending "$CONTAINER":/tmp/haproxy.cfg.pending
docker cp /tmp/recovery-nginx-public.map.pending "$CONTAINER":/tmp/recovery-nginx-public.map.pending
docker exec "$CONTAINER" haproxy -c -f /tmp/haproxy.cfg.pending -f "$AUTH_PATH"
docker exec "$CONTAINER" nginx -t -c /etc/nginx/recovery-nginx.conf
check_staged_recovery_certificates
if [[ "$DRY_RUN" == true ]]; then
    rm -rf "$CERT_STAGE_DIR"
    rm -f /tmp/haproxy.cfg.pending /tmp/recovery-nginx-public.map.pending
    echo "HAOS recovery dry run complete"
    exit 0
fi

if docker exec "$CONTAINER" cmp -s "$CONFIG_PATH" /tmp/haproxy.cfg.pending; then
    install_recovery_certificates
    docker exec "$CONTAINER" nginx -c /etc/nginx/recovery-nginx.conf -s reload
    check_recovery_routes
    rm -rf "$CERT_STAGE_DIR"
    rm -f /tmp/haproxy.cfg.pending
    rm -f /tmp/recovery-nginx-public.map.pending
    echo "HAOS recovery config is already current; certificates synced and rebuild skipped"
    exit 0
fi

docker exec "$CONTAINER" cp -a "$CONFIG_PATH" "${CONFIG_PATH}.bak_$TIMESTAMP"
if docker exec "$CONTAINER" test -f "$RECOVERY_NGINX_MAP_PATH"; then
    docker exec "$CONTAINER" cp -a "$RECOVERY_NGINX_MAP_PATH" "${RECOVERY_NGINX_MAP_PATH}.bak_$TIMESTAMP"
fi
rollback_needed=true

cleanup() {
    status=$?
    if [[ "$status" -ne 0 && "$rollback_needed" == true ]]; then
        set +e
        docker exec "$CONTAINER" cp -a "${CONFIG_PATH}.bak_$TIMESTAMP" "$CONFIG_PATH"
        if docker exec "$CONTAINER" test -f "${RECOVERY_NGINX_MAP_PATH}.bak_$TIMESTAMP"; then
            docker exec "$CONTAINER" cp -a "${RECOVERY_NGINX_MAP_PATH}.bak_$TIMESTAMP" "$RECOVERY_NGINX_MAP_PATH"
        else
            docker exec "$CONTAINER" rm -f "$RECOVERY_NGINX_MAP_PATH"
        fi
        ha apps rebuild "$SLUG" --force
        echo "HAOS recovery config rollback restored timestamp $TIMESTAMP" >&2
    fi
    rm -rf "$CERT_STAGE_DIR"
    rm -f /tmp/haproxy.cfg.pending /tmp/recovery-nginx-public.map.pending
    exit "$status"
}
trap cleanup EXIT

docker exec "$CONTAINER" sh -c "diff -u '$CONFIG_PATH' /tmp/haproxy.cfg.pending || true"
install_recovery_certificates
docker cp /tmp/haproxy.cfg.pending "$CONTAINER":"$CONFIG_PATH"
docker cp /tmp/recovery-nginx-public.map.pending "$CONTAINER":"$RECOVERY_NGINX_MAP_PATH"
ha apps rebuild "$SLUG" --force
addon_ready=false
for attempt in $(seq 1 120); do
    if [[ "$(ha apps info "$SLUG" --raw-json | jq -r .data.state)" == started ]] && \
        docker exec "$CONTAINER" pgrep -a haproxy >/dev/null 2>&1 && \
        docker exec "$CONTAINER" pgrep -a nginx >/dev/null 2>&1 && \
        docker exec "$CONTAINER" nginx -t -c /etc/nginx/recovery-nginx.conf >/dev/null 2>&1 && \
        docker exec "$CONTAINER" curl -fsS http://127.0.0.1:8404/stats >/dev/null && \
        check_recovery_routes && \
        echo | timeout 10 openssl s_client -connect 127.0.0.1:8443 -servername vpn.bezrabotnyi.com -brief >/dev/null 2>&1; then
        addon_ready=true
        break
    fi
    sleep 1
done
if [[ "$addon_ready" != true ]]; then
    echo "HAOS recovery add-on did not become ready after rebuild" >&2
    exit 1
fi
docker exec "$CONTAINER" haproxy -c -f "$CONFIG_PATH" -f "$AUTH_PATH"
docker exec "$CONTAINER" pgrep -a haproxy
docker exec "$CONTAINER" curl -fsS http://127.0.0.1:8404/stats >/dev/null
curl -sS -o /dev/null --max-time 10 http://127.0.0.1:8080/
check_recovery_routes
echo | timeout 10 openssl s_client -connect 127.0.0.1:8443 -servername vpn.bezrabotnyi.com -brief >/dev/null 2>&1
rollback_needed=false
trap - EXIT
rm -rf "$CERT_STAGE_DIR"
rm -f /tmp/haproxy.cfg.pending /tmp/recovery-nginx-public.map.pending
REMOTE

if $DRY_RUN; then
    exit 0
fi

echo "HAOS recovery deploy complete"
echo "Rollback config: ${CONFIG_PATH}.bak_$TIMESTAMP"

#!/usr/bin/env bash

set -Eeuo pipefail

script_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
panel_dir="$(cd "$script_dir/.." && pwd)"

addon_source="${HAOS_SMART_EDGE_ADDON_SOURCE:-$panel_dir/deploy/haos/transparent-smart-edge-addon}"
haos_target="${HAOS_SMART_EDGE_HOST:-root@192.168.2.101}"
haos_port="${HAOS_SMART_EDGE_PORT:-2228}"
haos_apps_root="${HAOS_SUPERVISOR_APPS_ROOT:-/mnt/data/supervisor/addons/local}"
haos_data_root="${HAOS_SUPERVISOR_DATA_ROOT:-/mnt/data/supervisor/apps/data}"
haos_helper_image="${HAOS_HELPER_IMAGE:-alpine:3.22}"
remote_source_name=transparent_smart_edge
addon_slug=27579e22_bezrabotnyi_transparent_smart_edge
container_name=app_27579e22_bezrabotnyi_transparent_smart_edge

policy_target="${HAOS_SMART_EDGE_POLICY_HOST:-roomhacker@192.168.2.100}"
policy_port="${HAOS_SMART_EDGE_POLICY_PORT:-22}"
policy_path="${HAOS_SMART_EDGE_POLICY_PATH:-/opt/smart-dns/config.json}"
panel_policy_path="${VPN_PANEL_SMART_DNS_POLICY:-/etc/vpn-panel/smart-dns-policy.json}"
server44_target="${HAOS_SMART_EDGE_SERVER44_HOST:-roomhacker@192.168.2.5}"
server44_port="${HAOS_SMART_EDGE_SERVER44_PORT:-22}"
server44_config="${HAOS_SMART_EDGE_SERVER44_CONFIG:-/etc/sing-box/config.json}"
smart_dns_public_edge_ip="${LAN_SMART_DNS_PUBLIC_EDGE_IP:-203.0.113.1}"
transport_renderer="${HAOS_SMART_EDGE_TRANSPORT_RENDERER:-$panel_dir/node_modules/.bin/tsx}"
transport_renderer_source="$panel_dir/src/cli/render-haos-finland-transport.ts"

ssh_bin="${SSH_BIN:-ssh}"
tar_bin="${TAR_BIN:-tar}"
dig_bin="${DIG_BIN:-dig}"
curl_bin="${CURL_BIN:-curl}"
ssh_common=(-o BatchMode=yes -o ConnectTimeout=10)
backup_root="$haos_apps_root/.vpn-panel-backups/transparent-smart-edge"

usage() {
    printf 'Usage: %s --check | --staging | --update-live | --apply-policy | --apply-transport | --rollback RECEIPT | --rollback-transport STAMP\n' "$0" >&2
}

die() {
    printf 'ERROR: %s\n' "$*" >&2
    exit 2
}

valid_ipv4() {
    local value="$1" octet
    local -a octets
    [[ "$value" =~ ^[0-9]+\.[0-9]+\.[0-9]+\.[0-9]+$ ]] || return 1
    IFS=. read -r -a octets <<<"$value"
    for octet in "${octets[@]}"; do
        (( octet >= 0 && octet <= 255 )) || return 1
    done
}

non_local_ipv4() {
    case "$1" in
        0.*|10.*|127.*|169.254.*|192.168.*) return 1 ;;
        172.1[6-9].*|172.2[0-9].*|172.3[0-1].*) return 1 ;;
    esac
}

with_smart_dns_public_edge_ip() {
    jq -c --arg edge_ipv4 "$smart_dns_public_edge_ip" '.edge_ipv4 = $edge_ipv4'
}

validate_inputs() {
    [[ "$haos_port" =~ ^[0-9]+$ ]] || die "invalid HAOS port"
    [[ "$policy_port" =~ ^[0-9]+$ ]] || die "invalid SmartDNS source port"
    [[ "$server44_port" =~ ^[0-9]+$ ]] || die "invalid server-44 port"
    [[ "$haos_target" =~ ^[A-Za-z0-9._@:-]+$ ]] || die "invalid HAOS target"
    [[ "$policy_target" =~ ^[A-Za-z0-9._@:-]+$ ]] || die "invalid SmartDNS source target"
    [[ "$server44_target" =~ ^[A-Za-z0-9._@:-]+$ ]] || die "invalid server-44 target"
    [[ "$haos_apps_root" =~ ^/[A-Za-z0-9._/-]+$ ]] || die "invalid HAOS apps root"
    [[ "$haos_data_root" =~ ^/[A-Za-z0-9._/-]+$ ]] || die "invalid HAOS data root"
    [[ "$policy_path" =~ ^/[A-Za-z0-9._/-]+$ ]] || die "invalid SmartDNS source path"
    [[ "$panel_policy_path" =~ ^/[A-Za-z0-9._/-]+$ ]] || die "invalid panel SmartDNS policy path"
    [[ "$server44_config" =~ ^/[A-Za-z0-9._/-]+$ ]] || die "invalid server-44 config path"
    [[ "$haos_helper_image" =~ ^[A-Za-z0-9._/:@-]+$ ]] || die "invalid helper image"
    valid_ipv4 "$smart_dns_public_edge_ip" || die "invalid public SmartDNS edge IPv4 address"
    non_local_ipv4 "$smart_dns_public_edge_ip" || die "public SmartDNS edge IPv4 address must not be local"
    [[ -x "$transport_renderer" ]] || die "HAOS transport renderer is not executable"
    [[ -s "$transport_renderer_source" ]] || die "HAOS Finland transport renderer is missing"
}

haos_ssh() {
    "$ssh_bin" "${ssh_common[@]}" -p "$haos_port" "$haos_target" "$@"
}

policy_ssh() {
    "$ssh_bin" "${ssh_common[@]}" -p "$policy_port" "$policy_target" "$@"
}

server44_ssh() {
    if [[ "$server44_port" == 22 ]]; then
        "$ssh_bin" "${ssh_common[@]}" "$server44_target" "$@"
    else
        "$ssh_bin" "${ssh_common[@]}" -p "$server44_port" "$server44_target" "$@"
    fi
}

supervisor_options_get() {
    haos_ssh "curl -fsS -H \"Authorization: Bearer \$SUPERVISOR_TOKEN\" 'http://supervisor/addons/$addon_slug/info' | jq -ec '.data.options'"
}

supervisor_options_set() {
    local options="$1"
    local payload
    # WAN DE uses 3128 + 10000; the private loopback must not collide with it.
    payload="$(jq -cn --argjson options "$options" '{options:($options + {singbox_internal_port:23128})}')"
    if [[ "${2:-}" == preserve ]]; then
        payload="$(jq -cn --argjson options "$options" '{options:$options}')"
    fi
    printf '%s\n' "$payload" | haos_ssh "curl -fsS -X POST -H \"Authorization: Bearer \$SUPERVISOR_TOKEN\" -H 'Content-Type: application/json' --data-binary @- 'http://supervisor/addons/$addon_slug/options' | jq -e '.result == \"ok\"' >/dev/null"
}

validate_local_source() {
    for command in "$ssh_bin" "$tar_bin" "$dig_bin" "$curl_bin" jq; do
        command -v "$command" >/dev/null || die "required command not found: $command"
    done
    [[ -d "$addon_source" ]] || die "add-on source missing: $addon_source"
    for file in Dockerfile config.yaml build.yaml rootfs/usr/bin/run.sh rootfs/usr/bin/prepare-singbox-config.sh; do
        [[ -s "$addon_source/$file" ]] || die "add-on source incomplete: $file"
    done
    bash -n "$addon_source/rootfs/usr/bin/"*.sh
    jq -e . "$addon_source/rootfs/etc/transparent-smart-edge/config.default.json" >/dev/null
    "$tar_bin" -C "$addon_source" -czf /dev/null .
}

run_check() {
    validate_inputs
    validate_local_source
    haos_ssh "test -n \"\$SUPERVISOR_TOKEN\" && command -v ha >/dev/null && command -v docker >/dev/null && command -v jq >/dev/null && command -v curl >/dev/null && docker info >/dev/null && ha store --help >/dev/null && ha apps --help >/dev/null"
    policy_ssh "test -s '$policy_path' && test -r '$policy_path' && test -s '$panel_policy_path' && jq -e '(.rules | type == \"array\")' '$panel_policy_path' >/dev/null"
    server44_ssh "sudo -n test -s '$server44_config'"
    printf 'CHECK OK: source, HAOS CLI/Docker, SmartDNS policy, and server-44 transport are readable; no remote state changed.\n'
}

remote_state() {
    haos_ssh "installed=0; running=0; if ha apps info '$addon_slug' >/dev/null 2>&1; then installed=1; if ha apps info '$addon_slug' 2>/dev/null | grep -Eiq 'state[^A-Za-z]+(started|running)'; then running=1; fi; fi; printf '%s %s\\n' \"\$installed\" \"\$running\""
}

remote_container() {
    haos_ssh "docker ps -a --format '{{.Names}}' | grep -Fx '$container_name' | head -n 1"
}

backup_data() {
    local _container="$1"
    local stamp="$2"
    haos_ssh "docker run --rm -i -e ADDON_SLUG='$addon_slug' -v '$haos_data_root:/apps-data' '$haos_helper_image' sh -s -- '$stamp'" <<'REMOTE'
set -eu
stamp="$1"
data="/apps-data/$ADDON_SLUG"
backup="$data/deploy-backups/$stamp"
test -d "$data"
test ! -e "$backup"
mkdir -p "$backup"
chmod 0700 "$backup"
for name in config.json singbox.json runtime-config.json options.json; do
    if [ -e "$data/$name" ]; then
        cp -a "$data/$name" "$backup/$name"
        printf 'present\n' >"$backup/$name.state"
    else
        printf 'absent\n' >"$backup/$name.state"
    fi
done
REMOTE
}

restore_data() {
    local _container="$1"
    local stamp="$2"
    haos_ssh "docker run --rm -i -e ADDON_SLUG='$addon_slug' -v '$haos_data_root:/apps-data' '$haos_helper_image' sh -s -- '$stamp'" <<'REMOTE'
set -eu
stamp="$1"
data="/apps-data/$ADDON_SLUG"
backup="$data/deploy-backups/$stamp"
test -d "$backup"
for name in config.json singbox.json runtime-config.json options.json; do
    state="$(cat "$backup/$name.state")"
    if [ "$state" = present ]; then
        cp -a "$backup/$name" "$data/$name"
    else
        rm -f "$data/$name"
    fi
done
REMOTE
}

install_source() {
    local stamp="$1"
    local installed_before="$2"
    local running_before="$3"
    local command
    command="docker run --rm -i -e DEPLOY_STAMP='$stamp' -e INSTALLED_BEFORE='$installed_before' -e RUNNING_BEFORE='$running_before' -v '$haos_apps_root:/apps' '$haos_helper_image' sh -eu -c '
source=/apps/$remote_source_name
receipt=/apps/.vpn-panel-backups/transparent-smart-edge/\$DEPLOY_STAMP
incoming=/apps/.$remote_source_name.incoming.\$DEPLOY_STAMP
test ! -e \"\$receipt\"
mkdir -p \"\$receipt\"
chmod 0700 \"\$receipt\"
printf "%s\\n" \"\$INSTALLED_BEFORE\" >\"\$receipt/installed.before\"
printf "%s\\n" \"\$RUNNING_BEFORE\" >\"\$receipt/running.before\"
if [ -d \"\$source\" ]; then
  mv \"\$source\" \"\$receipt/source.before\"
  printf "present\\n" >\"\$receipt/source.state\"
else
  printf "absent\\n" >\"\$receipt/source.state\"
fi
rollback_source() {
  [ ! -d \"\$incoming\" ] || mv \"\$incoming\" \"\$receipt/source.incoming.failed\"
  if [ -d \"\$receipt/source.before\" ] && [ ! -e \"\$source\" ]; then mv \"\$receipt/source.before\" \"\$source\"; fi
}
trap rollback_source EXIT INT TERM
mkdir \"\$incoming\"
tar -xzf - -C \"\$incoming\"
test -s \"\$incoming/Dockerfile\"
test -s \"\$incoming/config.yaml\"
test -s \"\$incoming/rootfs/usr/bin/run.sh\"
mv \"\$incoming\" \"\$source\"
trap - EXIT INT TERM
'"
    "$tar_bin" -C "$addon_source" -czf - . | haos_ssh "$command"
}

restore_source() {
    local receipt="$1"
    local command
    command="docker run --rm -i -v '$haos_apps_root:/apps' '$haos_helper_image' sh -eu -c '
source=/apps/$remote_source_name
receipt=/apps/${receipt#"$haos_apps_root/"}
test -d \"\$receipt\"
state=\$(cat \"\$receipt/source.state\")
if [ -d \"\$source\" ]; then mv \"\$source\" \"\$receipt/source.after\"; fi
if [ \"\$state\" = present ]; then
  test -d \"\$receipt/source.before\"
  mv \"\$receipt/source.before\" \"\$source\"
fi
'"
    haos_ssh "$command"
}

stream_policy() {
    local container="$1"
    local stamp="$2"
    policy_ssh "jq -ec --slurpfile panel '$panel_policy_path' '.rules = \$panel[0].rules' '$policy_path'" | haos_ssh "docker exec -i '$container' sh -eu -c '
umask 077
candidate=/data/config.json.candidate.$stamp
trap \"rm -f \\\"\$candidate\\\"\" EXIT INT TERM
cat >\"\$candidate\"
jq -e '\''(.defaultClientId | type == \"string\" and length > 0) and (.clients | type == \"object\") and ([.clients[]? | select(.enabled == true)] | length > 0) and (.rules | type == \"array\")'\'' \"\$candidate\" >/dev/null
chmod 0600 \"\$candidate\"
mv -f \"\$candidate\" /data/config.json
trap - EXIT INT TERM
'"
}

reload_runtime_policy() {
    local container="$1"
    local stamp="$2"
    haos_ssh "docker exec '$container' sh -eu -c '
test -f /run/smartdns-policy-reload
source=/data/config.json
runtime=/data/runtime-config.json
candidate=/data/runtime-config.json.policy.$stamp
test -s \"\$source\"
test -s \"\$runtime\"
trap \"rm -f \\\"\$candidate\\\"\" EXIT INT TERM
jq -e --slurpfile policy \"\$source\" '\''
  .rules = \$policy[0].rules
  | .defaultRoute = (\$policy[0].defaultRoute // .defaultRoute)
  | .localDefaultRoute = (\$policy[0].localDefaultRoute // .localDefaultRoute)
'\'' \"\$runtime\" >\"\$candidate\"
chmod 0600 \"\$candidate\"
mv -f \"\$candidate\" \"\$runtime\"
pid=\"\$(pidof smartdns)\"
test -n \"\$pid\"
kill -HUP \"\$pid\"
sleep 1
kill -0 \"\$pid\"
trap - EXIT INT TERM
'"
}

run_policy_apply() {
    validate_inputs
    local container stamp
    container="$(remote_container)"
    [[ -n "$container" ]] || die "Smart Edge container is absent"
    haos_ssh "docker exec '$container' test -f /run/smartdns-policy-reload"
    stamp="$(date -u +%Y%m%d_%H%M%S)"
    stream_policy "$container" "$stamp"
    reload_runtime_policy "$container" "$stamp"
    haos_ssh "docker exec '$container' /usr/bin/healthcheck.sh"
    printf 'POLICY APPLY OK: canonical panel rules reloaded without an HAOS app restart.\n'
}

wait_transport_ready() {
    local container="$1" attempt
    for attempt in $(seq 1 30); do
        if haos_ssh "docker exec '$container' /usr/bin/healthcheck.sh >/dev/null 2>&1"; then
            return 0
        fi
        sleep 1
    done
    return 1
}

run_transport_apply() {
    run_check
    local stamp container options_before options_after rollback_needed=0 tme_code
    stamp="$(date -u +%Y%m%d_%H%M%S)"
    container="$(remote_container)"
    [[ -n "$container" ]] || die "live add-on container is missing"
    options_before="$(supervisor_options_get)"
    options_after="$(jq -c '.singbox_outbound_tag = "world-auto" | .telegram_outbound_tag = "telegram-auto"' <<<"$options_before")"

    backup_data "$container" "$stamp"
    rollback_needed=1
    rollback_on_error() {
        local status="$?"
        trap - ERR INT TERM
        if [[ "$rollback_needed" == 1 ]]; then
            printf 'Transport apply failed; restoring data receipt %s\n' "$stamp" >&2
            restore_data "$container" "$stamp" >&2
            supervisor_options_set "$options_before" preserve >&2
            haos_ssh "ha apps restart '$addon_slug' >/dev/null" >&2
        fi
        exit "$status"
    }
    trap rollback_on_error ERR INT TERM

    # The installed Store app already owns the runtime schema and binaries.
    # Update only its private transport data/options; this path deliberately
    # avoids StoreManager.reload/AppManager.update when Supervisor blocks them.
    stream_transport "$container" "$stamp"
    supervisor_options_set "$options_after" preserve
    haos_ssh "ha apps restart '$addon_slug' >/dev/null"
    container="$(remote_container)"
    [[ -n "$container" ]] || return 1
    wait_transport_ready "$container"
    haos_ssh "curl -fsS -H \"Authorization: Bearer \$SUPERVISOR_TOKEN\" 'http://supervisor/addons/$addon_slug/info' | jq -e '.data.state == \"started\" and .data.options.singbox_outbound_tag == \"world-auto\" and .data.options.telegram_outbound_tag == \"telegram-auto\"' >/dev/null"
    assert_runtime_groups "$container"

    for ip in 149.154.167.51 149.154.167.35; do
        timeout 5 bash -c "exec 3<>/dev/tcp/$ip/443"
    done
    tme_code="$(server44_ssh "curl --noproxy '*' -4 -sS -o /dev/null -w '%{http_code}' --connect-timeout 4 --max-time 20 'https://t.me/s/durov'" || true)"
    [[ -n "$tme_code" && "$tme_code" != 000 ]]

    trap - ERR INT TERM
    rollback_needed=0
    printf 'TRANSPORT APPLY OK: Smart Edge uses world-auto and Telegram uses target-checked DE/FI/US failover; DC TCP passed and server-44 t.me/s returned HTTP %s.\n' "$tme_code"
    printf 'Data receipt: /data/deploy-backups/%s\nRollback: %s --rollback-transport %q\n' "$stamp" "$0" "$stamp"
}

run_transport_rollback() {
    local stamp="$1" container restored_options
    [[ "$stamp" =~ ^[0-9]{8}_[0-9]{6}$ ]] || die "invalid transport receipt stamp"
    container="$(remote_container)"
    [[ -n "$container" ]] || die "live add-on container is missing"
    restore_data "$container" "$stamp"
    restored_options="$(haos_ssh "docker exec '$container' jq -ec . /data/options.json")"
    supervisor_options_set "$restored_options" preserve
    haos_ssh "ha apps restart '$addon_slug' >/dev/null"
    container="$(remote_container)"
    wait_transport_ready "$container"
    printf 'TRANSPORT ROLLBACK OK: restored data/options from /data/deploy-backups/%s.\n' "$stamp"
}

stream_transport() {
    local container="$1"
    local stamp="$2"
    local importer="${3:-/usr/bin/prepare-singbox-config.sh}"
    local validator="${4:-/usr/bin/validate-singbox-config.sh}"
    server44_ssh "sudo -n cat -- '$server44_config'" | haos_ssh "docker exec -i '$container' sh -eu -c '
umask 077
candidate=/data/server44-source.json.candidate.$stamp
trap \"rm -f \\\"\$candidate\\\"\" EXIT INT TERM
cat >\"\$candidate\"
jq -e '\''
  ([.outbounds[]? | select(.tag == \"de-regional\" and .type == \"urltest\" and (.outbounds | length) > 1)] | length) == 1
  and ([.outbounds[]? | select(.tag == \"us-regional\" and .type == \"urltest\" and (.outbounds | length) > 1)] | length) == 1
'\'' \"\$candidate\" >/dev/null
mv -f \"\$candidate\" /data/server44-source.json
trap - EXIT INT TERM
'"
    haos_ssh "docker exec '$container' sh -eu -c 'trap \"rm -f /data/server44-source.json\" EXIT INT TERM; VALIDATOR_BIN=\"$validator\" \"$importer\" /data/server44-source.json de-regional /data/singbox.json 23128 us-regional'"
    "$transport_renderer" "$transport_renderer_source" < <(haos_ssh "docker exec '$container' cat /data/singbox.json") | haos_ssh "docker exec -i '$container' sh -eu -c '
umask 077
candidate=/data/singbox.json.finland.$stamp
trap \"rm -f \\\"\$candidate\\\"\" EXIT INT TERM
cat >\"\$candidate\"
jq -e '\''([.outbounds[]? | select(.tag == \"fi-helsinki\" and .type == \"vless\" and .tls.reality.enabled == true)] | length) == 1'\'' \"\$candidate\" >/dev/null
/usr/bin/sing-box check -c \"\$candidate\" >/dev/null
chmod 0600 \"\$candidate\"
mv -f \"\$candidate\" /data/singbox.json
trap - EXIT INT TERM
'"
}

install_candidate_transport_helpers() {
    local container="$1" stamp="$2" helper
    haos_ssh "docker exec '$container' install -d -m 0700 '/data/deploy-candidate-$stamp'"
    for helper in prepare-singbox-config.sh validate-singbox-config.sh; do
        cat "$addon_source/rootfs/usr/bin/$helper" | haos_ssh "docker exec -i '$container' sh -eu -c 'umask 077; cat >\"/data/deploy-candidate-$stamp/$helper\"; chmod 0700 \"/data/deploy-candidate-$stamp/$helper\"'"
    done
}

assert_runtime_groups() {
    local container="$1"
    haos_ssh "docker exec '$container' jq -e '
      ([.outbounds[]? | select(.tag == \"de-regional\" and .type == \"urltest\" and (.outbounds | length) > 1)] | length) == 1
      and ([.outbounds[]? | select(.tag == \"us-regional\" and .type == \"urltest\" and (.outbounds | length) > 1)] | length) == 1
      and ([.outbounds[]? | select(.tag == \"fi-helsinki\" and .type == \"vless\" and .tls.reality.enabled == true)] | length) == 1
      and ([.outbounds[]? | select(.tag == \"world-auto\" and .type == \"urltest\" and (.outbounds | length) > 5 and ((.outbounds | index(\"fi-helsinki\")) != null))] | length) == 1
      and ([.outbounds[]? | select(.tag == \"telegram-auto\" and .type == \"urltest\" and (.outbounds | length) > 5 and ((.outbounds | index(\"fi-helsinki\")) != null))] | length) == 1
      and .route.final == \"world-auto\"
      and ([.route.rules[]? | select(.outbound == \"telegram-auto\" and ((.inbound // []) | index(\"telegram-tproxy\")))] | length) == 1
      and ([.route.rules[]? | select(.outbound == \"telegram-auto\" and ((.inbound // []) | index(\"transparent-edge-http\")) and ((.domain_suffix // []) | index(\"t.me\")))] | length) == 1
      and ([.route.rules[]? | select(.outbound == \"fi-helsinki\" and ((.inbound // []) | index(\"lan-fi-http\")))] | length) == 1
      and ([.route.rules[]? | select(.outbound == \"direct\" and ((.inbound // []) | index(\"lan-ru-http\")))] | length) == 1
      and ([.inbounds[]? | select(.tag == \"lan-us-http\" and .listen_port == 3127 and ((.users // []) | length) == 0)] | length) == 1
      and ([.inbounds[]? | select(.tag == \"lan-de-http\" and .listen_port == 3128 and ((.users // []) | length) == 0)] | length) == 1
      and ([.inbounds[]? | select(.tag == \"lan-fi-http\" and .listen_port == 3129 and ((.users // []) | length) == 0)] | length) == 1
      and ([.inbounds[]? | select(.tag == \"lan-ru-http\" and .listen_port == 3130 and ((.users // []) | length) == 0)] | length) == 1
      and ([.inbounds[]? | select(.tag == \"wan-us-http\" and .listen_port == 13127 and (.users | length) > 0)] | length) == 1
      and ([.inbounds[]? | select(.tag == \"wan-de-http\" and .listen_port == 13128 and (.users | length) > 0)] | length) == 1
      and ([.inbounds[]? | select(.tag == \"wan-fi-http\" and .listen_port == 13129 and (.users | length) > 0)] | length) == 1
      and ([.inbounds[]? | select(.tag == \"wan-ru-http\" and .listen_port == 13130 and (.users | length) > 0)] | length) == 1
    ' /data/singbox-runtime.json >/dev/null"
}

restore_transaction() {
    local receipt="$1"
    local installed_before="$2"
    local running_before="$3"
    local stamp="${receipt##*/}"
    local container options_before=""
    container="$(remote_container || true)"
    if [[ -n "$container" ]]; then
        options_before="$(haos_ssh "docker run --rm -v '$haos_data_root:/apps-data' '$haos_helper_image' sh -c 'backup=/apps-data/$addon_slug/deploy-backups/$stamp/options.json; if test -f \"\$backup\"; then cat \"\$backup\"; fi'" || true)"
        restore_data "$container" "$stamp" || true
    fi
    restore_source "$receipt" || true
    haos_ssh "ha store reload >/dev/null" || true
    if [[ "$installed_before" == 1 ]]; then
        haos_ssh "ha apps update '$addon_slug' >/dev/null" || true
        container="$(remote_container || true)"
        if [[ -n "$container" && -n "$options_before" ]]; then
            supervisor_options_set "$options_before" preserve || true
        fi
        if [[ "$running_before" == 1 ]]; then
            haos_ssh "ha apps start '$addon_slug' >/dev/null" || true
        else
            haos_ssh "ha apps stop '$addon_slug' >/dev/null" || true
        fi
    else
        haos_ssh "ha apps stop '$addon_slug' >/dev/null 2>&1 || true"
    fi
}

run_staging() {
    run_check
    local stamp receipt state installed_before running_before container_before container rollback_needed=0
    stamp="$(date -u +%Y%m%d_%H%M%S)"
    receipt="$backup_root/$stamp"
    state="$(remote_state)"
    read -r installed_before running_before <<<"$state"
    [[ "$installed_before" =~ ^[01]$ && "$running_before" =~ ^[01]$ ]] || die "unable to read HAOS add-on state"

    container_before="$(remote_container || true)"
    if [[ -n "$container_before" ]]; then
        backup_data "$container_before" "$stamp"
    fi
    install_source "$stamp" "$installed_before" "$running_before"
    rollback_needed=1
    rollback_on_error() {
        local status="$?"
        trap - ERR INT TERM
        if [[ "$rollback_needed" == 1 ]]; then
            printf 'Staging failed; restoring receipt %s\n' "$receipt" >&2
            restore_transaction "$receipt" "$installed_before" "$running_before" >&2
        fi
        exit "$status"
    }
    trap rollback_on_error ERR INT TERM

    haos_ssh "ha store reload >/dev/null"
    if [[ "$installed_before" == 1 ]]; then
        haos_ssh "ha apps update '$addon_slug' >/dev/null"
    else
        haos_ssh "ha apps install '$addon_slug' >/dev/null"
    fi
    supervisor_options_set "$(printf '%s' '{"dns_listen_host":"0.0.0.0","dns_port":1053,"doh_port":18053,"edge_listen_host":"0.0.0.0","edge_port":10443,"singbox_internal_port":13128,"singbox_outbound_tag":"world-auto","telegram_outbound_tag":"telegram-auto","require_singbox_config":false,"telegram_tproxy_enabled":true,"telegram_tproxy_port":12555,"lan_us_proxy_enabled":true,"lan_us_proxy_port":3127,"lan_us_proxy_outbound_tag":"us-regional","lan_de_proxy_enabled":true,"lan_de_proxy_port":3128,"lan_de_proxy_outbound_tag":"de-regional","lan_fi_proxy_enabled":true,"lan_fi_proxy_port":3129,"lan_fi_proxy_outbound_tag":"fi-helsinki","lan_ru_proxy_enabled":true,"lan_ru_proxy_port":3130,"lan_ru_proxy_outbound_tag":"direct"}' | with_smart_dns_public_edge_ip)"
    haos_ssh "ha apps start '$addon_slug' >/dev/null 2>&1 || ha apps restart '$addon_slug' >/dev/null"
    container="$(remote_container)"
    [[ -n "$container" ]] || return 1
    if [[ -z "$container_before" ]]; then
        backup_data "$container" "$stamp"
    fi

    stream_policy "$container" "$stamp"
    stream_transport "$container" "$stamp"
    supervisor_options_set "$(printf '%s' '{"dns_listen_host":"0.0.0.0","dns_port":1053,"doh_port":18053,"edge_listen_host":"0.0.0.0","edge_port":10443,"singbox_internal_port":13128,"singbox_outbound_tag":"world-auto","telegram_outbound_tag":"telegram-auto","require_singbox_config":true,"telegram_tproxy_enabled":true,"telegram_tproxy_port":12555,"lan_us_proxy_enabled":true,"lan_us_proxy_port":3127,"lan_us_proxy_outbound_tag":"us-regional","lan_de_proxy_enabled":true,"lan_de_proxy_port":3128,"lan_de_proxy_outbound_tag":"de-regional","lan_fi_proxy_enabled":true,"lan_fi_proxy_port":3129,"lan_fi_proxy_outbound_tag":"fi-helsinki","lan_ru_proxy_enabled":true,"lan_ru_proxy_port":3130,"lan_ru_proxy_outbound_tag":"direct"}' | with_smart_dns_public_edge_ip)"
    haos_ssh "ha apps restart '$addon_slug' >/dev/null"
    haos_ssh "curl -fsS -H \"Authorization: Bearer \$SUPERVISOR_TOKEN\" 'http://supervisor/addons/$addon_slug/info' | jq -e '.data.state == \"started\" and .data.options.require_singbox_config == true and .data.options.dns_port == 1053 and .data.options.edge_port == 10443' >/dev/null"

    "$dig_bin" @192.168.2.101 -p 1053 chatgpt.com A +short +time=3 +tries=1 | grep -Fx "$smart_dns_public_edge_ip" >/dev/null
    "$dig_bin" @192.168.2.101 -p 1053 chatgpt.com A +tcp +short +time=3 +tries=1 | grep -Fx "$smart_dns_public_edge_ip" >/dev/null
    local code
    code="$("$curl_bin" --noproxy '*' -4 -sS -o /dev/null -w '%{http_code}' --connect-timeout 4 --max-time 20 --resolve chatgpt.com:10443:192.168.2.101 https://chatgpt.com:10443/ || true)"
    [[ -n "$code" && "$code" != 000 ]]

    trap - ERR INT TERM
    rollback_needed=0
    printf 'STAGING OK: DNS 192.168.2.101:1053 synthesized %s and TLS traversed 192.168.2.101:10443 (HTTP %s).\n' "$smart_dns_public_edge_ip" "$code"
    printf 'Receipt: %s\nRollback: %s --rollback %q\n' "$receipt" "$0" "$receipt"
}

run_live_update() {
    run_check
    local stamp receipt state installed_before running_before container options_before options_after dns_port edge_port rollback_needed=0
    stamp="$(date -u +%Y%m%d_%H%M%S)"
    receipt="$backup_root/$stamp"
    state="$(remote_state)"
    read -r installed_before running_before <<<"$state"
    [[ "$installed_before" == 1 && "$running_before" == 1 ]] || die "live update requires the installed add-on to be running"
    container="$(remote_container)"
    [[ -n "$container" ]] || die "live add-on container is missing"
    options_before="$(supervisor_options_get)"
    dns_port="$(jq -er '.dns_port' <<<"$options_before")"
    edge_port="$(jq -er '.edge_port' <<<"$options_before")"
    options_after="$(jq -c --arg smart_dns_public_edge_ip "$smart_dns_public_edge_ip" '
      .edge_ipv4 = $smart_dns_public_edge_ip
      | .singbox_outbound_tag = "world-auto"
      | .telegram_outbound_tag = "telegram-auto"
      | .require_singbox_config = true
      | .telegram_tproxy_enabled = true
      | .telegram_tproxy_port = 12555
      | .lan_us_proxy_enabled = true
      | .lan_us_proxy_port = 3127
      | .lan_us_proxy_outbound_tag = "us-regional"
      | .lan_de_proxy_enabled = true
      | .lan_de_proxy_port = 3128
      | .lan_de_proxy_outbound_tag = "de-regional"
    ' <<<"$options_before")"

    backup_data "$container" "$stamp"
    install_candidate_transport_helpers "$container" "$stamp"
    stream_transport "$container" "$stamp" "/data/deploy-candidate-$stamp/prepare-singbox-config.sh" "/data/deploy-candidate-$stamp/validate-singbox-config.sh"
    haos_ssh "docker exec '$container' rm -f '/data/deploy-candidate-$stamp/prepare-singbox-config.sh' '/data/deploy-candidate-$stamp/validate-singbox-config.sh' && docker exec '$container' rmdir '/data/deploy-candidate-$stamp'"
    install_source "$stamp" "$installed_before" "$running_before"
    rollback_needed=1
    rollback_on_error() {
        local status="$?"
        trap - ERR INT TERM
        if [[ "$rollback_needed" == 1 ]]; then
            printf 'Live update failed; restoring receipt %s\n' "$receipt" >&2
            restore_transaction "$receipt" "$installed_before" "$running_before" >&2
        fi
        exit "$status"
    }
    trap rollback_on_error ERR INT TERM

    haos_ssh "ha store reload >/dev/null"
    supervisor_options_set "$options_after"
    haos_ssh "ha apps update '$addon_slug' >/dev/null"
    # The pre-update schema may discard newly introduced keys. Re-apply the
    # exact merged options after the new app schema is installed.
    supervisor_options_set "$options_after"
    container="$(remote_container)"
    [[ -n "$container" ]] || return 1
    stream_policy "$container" "$stamp"
    stream_transport "$container" "$stamp"
    haos_ssh "ha apps restart '$addon_slug' >/dev/null"
    haos_ssh "curl -fsS -H \"Authorization: Bearer \$SUPERVISOR_TOKEN\" 'http://supervisor/addons/$addon_slug/info' | jq -e --argjson dns '$dns_port' --argjson edge '$edge_port' '.data.state == \"started\" and .data.options.require_singbox_config == true and .data.options.dns_port == \$dns and .data.options.edge_port == \$edge' >/dev/null"
    assert_runtime_groups "$container"

    "$dig_bin" @192.168.2.101 -p "$dns_port" youtube.com A +short +time=3 +tries=1 | grep -Fx "$smart_dns_public_edge_ip" >/dev/null
    local code
    code="$("$curl_bin" --noproxy '*' -4 -sS -o /dev/null -w '%{http_code}' --connect-timeout 4 --max-time 25 --resolve "youtube.com:$edge_port:192.168.2.101" "https://youtube.com:$edge_port/" || true)"
    [[ -n "$code" && "$code" != 000 ]]
    local lan_code
    lan_code="$(server44_ssh "curl --noproxy '*' -4 -sS -o /dev/null -w '%{http_code}' --connect-timeout 4 --max-time 25 --resolve 'youtube.com:443:$smart_dns_public_edge_ip' 'https://youtube.com/'" || true)"
    [[ -n "$lan_code" && "$lan_code" != 000 ]]

    trap - ERR INT TERM
    rollback_needed=0
    printf 'LIVE UPDATE OK: preserved DNS :%s / edge :%s, SmartDNS alias %s, automatic DE/FI/US Telegram group active, direct-edge HTTP %s, LAN-alias HTTP %s.\n' "$dns_port" "$edge_port" "$smart_dns_public_edge_ip" "$code" "$lan_code"
    printf 'Receipt: %s\nRollback: %s --rollback %q\n' "$receipt" "$0" "$receipt"
}

run_rollback() {
    local receipt="$1"
    [[ "$receipt" =~ ^${backup_root//./\\.}/[0-9]{8}_[0-9]{6}$ ]] || die "invalid rollback receipt"
    local metadata installed_before running_before
    metadata="$(haos_ssh "docker run --rm -v '$haos_apps_root:/apps' '$haos_helper_image' sh -eu -c 'receipt=/apps/${receipt#"$haos_apps_root/"}; printf \"%s %s\\n\" \"\$(cat \"\$receipt/installed.before\")\" \"\$(cat \"\$receipt/running.before\")\"'")"
    read -r installed_before running_before <<<"$metadata"
    restore_transaction "$receipt" "$installed_before" "$running_before"
    printf 'ROLLBACK OK: restored source/data/options/run state from %s; a newly installed add-on is stopped, not uninstalled.\n' "$receipt"
}

case "${1:-}" in
    --check)
        run_check
        ;;
    --staging)
        run_staging
        ;;
    --update-live)
        run_live_update
        ;;
    --apply-policy)
        run_policy_apply
        ;;
    --apply-transport)
        run_transport_apply
        ;;
    --rollback)
        [[ -n "${2:-}" ]] || { usage; exit 2; }
        run_rollback "$2"
        ;;
    --rollback-transport)
        [[ -n "${2:-}" ]] || { usage; exit 2; }
        run_transport_rollback "$2"
        ;;
    *)
        usage
        exit 2
        ;;
esac

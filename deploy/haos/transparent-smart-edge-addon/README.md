# Transparent Smart Edge add-on

This repository is the single source of truth for the add-on **code**: Go
sources under `smartdns/` and `smartedge/`, `rootfs/`, `Dockerfile`, and the
tests all live here and are edited here. The separate public repository
`https://github.com/megamen32/haos-smart-edge-addons` is packaging and release
only; it consumes this tree and never carries add-on code of its own. If a fix
or a feature looks like it belongs only in that repository, it belongs here.

This local HAOS add-on runs the existing VPN Panel `smartdns-go` resolver,
Smart Edge, and a pinned statically linked sing-box `1.13.14` together.
SmartDNS selects configured domains and synthesizes the router LAN address;
the TCP edge reads TLS SNI and opens an HTTP `CONNECT` tunnel through the
add-on's loopback-only sing-box listener.

`/data/config.json` is the durable, panel-rendered SmartDNS policy. On first
boot only, a direct-only safe default is created there. Each start writes
listener/proxy overrides to `/data/runtime-config.json` without modifying the
durable policy.

After an atomic policy update, send `SIGHUP` to `smartdns` to reload its routing
rules without restarting the add-on or interrupting the TLS edge, sing-box, or
active consumer sessions. Only the policy-owned routing fields are refreshed;
listener addresses, upstream transports, and transient edge authorizations stay
with the running runtime. A running add-on exposes `/run/smartdns-policy-reload`;
deployment tooling must require that marker before sending the signal.

The transport is intentionally not bundled: `/data/singbox.json` contains the
real VLESS leaves plus the `de-regional` and `us-regional` sing-box `urltest`
groups. Each group probes its members and automatically selects a reachable,
low-latency transport. To import both complete groups from the server-44
config without printing credentials:

```bash
/usr/bin/prepare-singbox-config.sh /data/server44-source.json de-regional /data/singbox.json 13128 us-regional
```

The importer writes mode `0600` and runs `sing-box check` before replacing the
destination. With the default staging ports, an absent file produces an
explicit `staging-no-transport` health state while DNS/edge listeners remain
testable. `require_singbox_config: true`, DNS port `53`, or edge port `443`
turns absence into a startup/health failure.

Normal Smart Edge traffic uses `world-auto`, a 30-second health-checked group
flattened from all VPN2/DE, Finland, and VUSA/US transports. The transparent
Telegram TPROXY inbound uses the same members through `telegram-auto`, with a
Telegram-specific `t.me/s/telegram` probe; the validator rejects a
TPROXY-enabled runtime that lacks that explicit route. Telegram web domains
arriving through `transparent-edge-http` use the same group, so `t.me/s` does
not remain pinned to the normal DE default route.

The shipped options use staging ports `1053` and `10443`. The default
`edge_ipv4` remains `192.168.2.1`, so clients keep connecting to the router.
After AdGuard and
Nginx Proxy Manager release their listeners, change `dns_port` to `53` and
`edge_port` to `443`. The router can then keep advertising `192.168.2.1` for
DNS and statically forward DNS/TCP edge traffic to `192.168.2.101`.

For an already active final-port local add-on, use
`scripts/deploy-haos-transparent-smart-edge.sh --update-live`. It preserves the
current listener ports, pre-validates the new transport before rebuilding,
checks the runtime group shape and YouTube path, and prints its rollback
receipt. `--staging` remains for a not-yet-cut-over installation.

## SmartDNS cache improvements

The HAOS SmartDNS cache holds up to 50,000 entries and 64 MiB of stored DNS
payload/key data. Individual replies over 8 KiB bypass the cache. LRU eviction,
in-flight request coalescing, RFC 2308 SOA-bounded negative caching, and
refresh-ahead for frequently used entries are enabled. Statistics (`entries`,
`bytes`, `hits`, `misses`, `coalesced`, `refreshes`, `evictions`) are logged every
five minutes without query names. Cache snapshots are written atomically to
`/data/smartdns-cache-v1.json` with `0600` permissions; records and their
remaining TTLs survive restarts only when the complete config fingerprint
matches. Policy reloads invalidate the in-memory cache, and responses from an
earlier policy generation cannot refill it.

The snapshot location is configurable through `SMARTDNS_CACHE_FILE`; the
config path itself remains configurable through `SMART_DNS_CONFIG`.

## DoH upstream circuit breaker

After three consecutive DoH transport failures, the failed upstream is bypassed
for 30 seconds. Queries continue through the backup DoH resolver and then the
direct UDP fallback; one retry after the cooldown checks for recovery. This
reduces repeated delays caused by upstream transport errors such as unexpected
EOF.

## Building on a plain machine

The add-on builds with nothing but a Go toolchain, so code changes can be
verified without HAOS or Docker:

```bash
(cd smartdns && CGO_ENABLED=0 go build -trimpath -ldflags "-s -w" -o /tmp/smartdns .)
(cd smartedge && CGO_ENABLED=0 go build -trimpath -ldflags "-s -w" -o /tmp/smart-edge .)
(cd smartdns && go vet ./... && go test -race ./...)
(cd smartdns && gofmt -l .)
./tests/options-false.test.sh
```

Both binaries stay environment-configured: no HAOS-only path is compiled in.
`Dockerfile` remains the release build and pulls a pinned Go builder stage.

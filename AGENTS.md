# AGENTS.md — VPN / SmartRelay / Recovery Infrastructure

## Shared PostgreSQL project quota (2026-09-17)

- Runtime `DATABASE_URL` comes from the protected project `.env`, loaded by
  `autovpnallowip.service`. Endpoint: `127.0.0.1:6432/vpn_panel` through PgBouncer;
  user: `vpn_panel_runtime` (non-superuser). Never substitute `roomhacker` or
  hardcode a password. Preserve the URL when deploying or rewriting `.env`.
- VPN uses a session-mode pool to retain migration/session semantics. Project
  database limit: 16; pool/runtime role: 12; application `pg.Pool`: 10.
  Do not increase app workers or pool sizes without recalculating this budget.
- Canonical quota policy and rollout scripts live in
  `/home/roomhacker/ServersAdministartion/ops/postgres-quotas/`. Database roles,
  PgBouncer and protected environment changes are managed there; `.env` is the
  runtime source, never a checked-in credential file. Systemd config-only
  restart activates an endpoint change; no source rebuild is required for it.
- Runtime owns only VPN tables and may run this application's idempotent
  startup migrations. Shared cluster administration uses OS `postgres` access,
  never the runtime credential. Back up config before a DB endpoint change;
  verify migration startup and an authenticated subscription/admin read after it.
- Other projects share PostgreSQL but have distinct budgets. Do not raise the
  cluster ceiling to conceal a pool leak or bypass PgBouncer under a superuser.

This project is the VPN Panel service behind `vpn.bezrabotnyi.com`.
It runs on `roomhacker-server-100` and must be treated as part of the VPN/recovery control plane.

## Codebase / dev workflow

TypeScript ESM + Fastify. Source in `src/`, compiled to `dist/` (`tsc`). Node 22+, PostgreSQL 18+.

- Imports use `.js` extensions even for `.ts` files (NodeNext). Keep this when adding imports.
- No lint/format/typecheck step exists beyond `tsc`. After source changes run `npm run build` to typecheck.
- Tests: `npm test` runs `tsx --test tests/*.test.ts` (node test runner, no jest/vitest). `tsconfig.json` excludes `tests/`, so tests are typechecked only at runtime.
- `git push` runs the local `test2git` hook: `npm test` and `npm run build` write a full raw log plus JSON summary to `.test2git/`. It is non-blocking by default; use `TEST2GIT_BLOCK=1 git push` to block a push on failures.
- CLIs run via `tsx src/cli/*.ts`; the `dist/` build (and prod `npm start`) uses compiled JS. The systemd unit runs `dist/server.js`, so source edits need a `npm run build` + service restart to take effect in prod.
- Env: `DATABASE_URL` is required (process throws without it). `secure.json` (default `/etc/vpn-panel/secure.json`, override `VPN_PANEL_SECURE_CONFIG`) holds UUIDs, tokens, Reality keys — never commit. Local `.env` is gitignored.
- `*.bak_*` files are gitignored local backups (the operational backup rule below). Ignore them; do not edit or treat as source.
- Xray/Happ routing logic lives in `src/subscriptions.ts` (`happRoutingLink()`) and `src/xray-configs.ts` (`serverConfig()`). Validate routing changes with `npm run validate:xray` (uses Docker `ghcr.io/xtls/xray-core:latest`).

## Infrastructure source-of-truth contract

- Before any task that affects ingress, nginx, DNS, DHCP, firewall, OpenWrt,
  HAOS, SmartDNS, Xray, sing-box, systemd, or host access, read this file plus
  `/home/roomhacker/ServersAdministartion/AGENTS.md` and the relevant
  `/home/roomhacker/ServersAdministartion/infra/*.md` and `nginx-dev/AGENTS.md`
  sources. Repeat the read-only source-of-truth check immediately before a live
  deploy.
- This `vpn-panel` repository owns product routing policy, SmartDNS/Xray/
  sing-box configurations, their generators, and deploy logic, including the
  product topology in `deploy/public-ingress/topology.json`.
- `https://github.com/megamen32/haos-smart-edge-addons` owns the packaged HAOS
  app source, `repository.yaml`, GitHub Actions build, and public GHCR release
  `ghcr.io/megamen32/haos-smart-edge`. Runtime policy and transport credentials
  remain private HAOS app data. The copy under
  `deploy/haos/transparent-smart-edge-addon` is a compatibility snapshot for
  the legacy local deploy script, not the release source of truth; do not make
  release-only edits there.
- `/home/roomhacker/ServersAdministartion` owns physical host and LAN topology,
  port/access maps, HAOS/OpenWrt/recovery configuration, `nginx-dev`, and
  controller configuration. `/etc/nginx` and other live host state are
  deployment targets, not source of truth.
- When the ownership boundary or shared topology changes, update both
  repositories, run the scope-matching validations in each repository, and
  report both commit SHAs. VPN Panel changes normally require the relevant
  config validator plus `npm test` and `npm run build`; infrastructure changes
  require the relevant repository verifier and `git diff --check`.
- For application-only tasks that do not affect the infrastructure surfaces above, the `ServersAdministartion` repository does not need to be read.

### Transparent HAOS Smart Edge current LAN topology

Для обычного доступа между server-100/server-44/server-88 использовать LAN:
`192.168.2.100`, `192.168.2.5`, `192.168.2.75`. Tailscale — резерв после
подтверждённого сбоя LAN. Правило и актуальная физическая топология находятся в
`/home/roomhacker/ServersAdministartion/AGENTS.md` и
`/home/roomhacker/ServersAdministartion/docs/inventory/devices/haos.md`.

Следующее описание — исторический снимок 2026-09-01. Оно не подтверждает
актуальный slug, версию и активность HAOS app. Перед операцией сверять их с
документом владельца и реальным Supervisor; не запускать legacy app по этому
старому примеру и не считать установленный пакет остановленным без проверки.

HAOS runtime host: Home Assistant OS appliance `homeassistant` at LAN
`192.168.2.101` (Wi-Fi fallback `192.168.2.102`), UI `:8123`, SSH add-on
`ssh -p 2228 root@192.168.2.101` — that shell has `docker` and the `ha` CLI
but no `nft`/`iptables` binaries; verify firewall policy with
`docker exec app_local_bezrabotnyi_transparent_smart_edge nft list ruleset`.
The Smart Edge app runs there as Supervisor app
`local_bezrabotnyi_transparent_smart_edge` from image
`ghcr.io/megamen32/haos-smart-edge` (since 0.1.9 it self-heals the Telegram
TPROXY nft policy every 15 s); local metadata lives in
`/addons/transparent_smart_edge`; deploy = sync source → `ha store reload` →
`ha apps update local_bezrabotnyi_transparent_smart_edge`. HAOS physical
host and LAN topology are owned by `/home/roomhacker/ServersAdministartion`
(`docs/inventory/devices/haos.md`); this repo owns the product transport and
deploy logic only.

This topology is active and was proven by Mac/44/88 DNS/HTTPS plus native
Codex canaries on 2026-09-01:

- OpenWrt retains the client-facing DHCP/DNS endpoint `192.168.2.1`, forwards
  DNS to HAOS, and uses only a simple hairpin DNAT for TCP
  `192.168.2.1:443 -> 192.168.2.101:443`. Do not preserve or extend router
  HAProxy as the intended LAN Smart Edge.
- One HAOS add-on owns SmartDNS on TCP/UDP `:53` and the transparent TCP
  Smart Edge on `:443`. It bundles pinned sing-box `1.13.14` and reaches it only
  through the add-on-private HTTP listener `127.0.0.1:13128`; it must not depend
  on the old external `local_singbox_proxy :3128`. Do not add a separate Xray.
- HAOS AdGuard, HAOS Nginx Proxy Manager, external `local_singbox_proxy`, and
  router HAProxy remain retired rollback assets. The server-100 SmartDNS process
  serves public DoH/DoT and keeps its LAN DNS listener on `192.168.2.100:53`
  ready as an independent DNS-only standby. OpenWrt uses HAOS `192.168.2.101`
  as its sole normal upstream and changes to `.100` only after health-check
  failure; this does not duplicate HAOS's TLS edge or Telegram TPROXY lane.
- Preserve the independent recovery HAProxy on `:8080`/`:8443` and the
  Telegram IP TPROXY lane; neither is part of this retirement. The HAOS `:443`
  target here is LAN-only and does not change the separate public/recovery
  ingress contract.
- The standalone repository is registered in the HAOS Store as repository
  `27579e22`; app `27579e22_bezrabotnyi_transparent_smart_edge` version `0.1.0`
  is installed from the pre-built GHCR image and intentionally stopped. The
  active runtime remains `local_bezrabotnyi_transparent_smart_edge` until a
  separate data-and-port migration canary transfers `/data/config.json` and
  `/data/singbox.json` without running both final-port instances together.

## Project location

```text
Host: roomhacker-server-100
Path: /home/roomhacker/apps/vpn-panel
Systemd unit: autovpnallowip.service
Command: /usr/local/bin/node /home/roomhacker/apps/vpn-panel/dist/server.js
WorkingDirectory: /home/roomhacker/apps/vpn-panel
User: roomhacker
Public URL: https://vpn.bezrabotnyi.com
Local listen: 127.0.0.1:30129
Nginx vhost: /etc/nginx/sites-enabled/vpn.bezrabotnyi.com
```

## Mac (user@localhost:2222)

```text
Host: MacBook-Pro-User.local
OS: macOS 26.4 (Darwin 25.4.0, arm64)
SSH: user@localhost:2222 (proxied via server-100, 127.0.0.1:2222)
Tools: xray 26.3.27 (homebrew), docker (colima, often stopped), python3, curl
Use: End-to-end test VPN endpoints (US-* and DE-*) with native xray. Pull
     subscription from `https://vpn.bezrabotnyi.com/sub/<token>/plain`,
     import the VLESS links into a test xray config (SOCKS inbound on 11080),
     then `curl --socks5-hostname 127.0.0.1:11080 https://api.ipify.org` to
     verify exit IP.
```

Current nginx mapping on `roomhacker-server-100`:

```nginx
server_name vpn.bezrabotnyi.com;
location / {
    proxy_pass http://127.0.0.1:30129;
}
```

## Physical / LAN topology

```text
OpenWrt router: 192.168.2.1
  Current roles: legacy HAProxy 3.0.16-r1 (mipsel), DNS, NAT, firewall
  OpenWrt 24.10.2 on ramips/mt7621
  Migration target: DHCP/DNS endpoint plus simple TCP/443 hairpin DNAT to HAOS
  Legacy service: haproxy (rollback-only after HAOS Smart Edge cutover)

roomhacker-server-100 (this host):
  LAN MGTS: 192.168.2.100
  LAN Beeline path: 192.168.1.100
  Public MGTS: 95.165.165.65
  Public Beeline: 95.31.7.115
  Roles: main nginx reverse proxy, vpn panel endpoint, webhook endpoint,
         central config source for all 4 backends (deploy-all.sh)
  Xray: 26.6.1 (Docker `xray-ru-relays` — RU relays)

server-44 (192.168.2.5):
  LAN MGTS: 192.168.2.5
  LAN Beeline path: 192.168.1.5
  Roles: Ollama/Open WebUI, rootd proxy to HAOS, SING-BOX HTTP/SOCKS proxy
  sing-box: 1.13.14 (systemd sing-box.service; bound to 0.0.0.0:3128/1080/3129)

roomhacker-server-88 (192.168.2.75):
  LAN MGTS: 192.168.2.75
  LAN Beeline path: 192.168.1.75
  Roles: dev deployments, LiteraryIDE, EquaFlow, XRAY HTTP/SOCKS proxy
  Xray: 26.6.1 (systemd xray.service; bound to 0.0.0.0:3128/3129 + 192.168.2.75:1080/1081)

Home Assistant OS (192.168.2.101):
  SSH addon: root@192.168.2.101:2228
  Role: HAOS, independent recovery HAProxy, unified SmartDNS/TCP-edge target

vpn2 (212.192.31.128, **DE** — primary VPN upstream):
  DNS: vpn2.bezrabotnyi.com
  Role: remote Xray/VPN upstream, Germany
  Xray: 26.6.1, 11 inbounds (9 de-server + auth-http + auth-socks)
  Endpoints:
    de-reality       0.0.0.0:23443 (Reality, SNI=ya.ru)
    de-xhttp         127.0.0.1:20080 (XHTTP, nginx SNI -> :443)
    de-cdn           127.0.0.1:20081 (WS via CF DNS-only cdn.demiurge.space)
    de-cdn2          127.0.0.1:20084 (WS via CF DNS-only cdn2.demiurge.space)
    de-grpc          127.0.0.1:20082 (gRPC, nginx SNI -> :443/grpc)
    de-httpupgrade   127.0.0.1:20083 (HTTPUpgrade, nginx SNI -> :443/hup)
    de-direct-ws     127.0.0.1:20085 (WS direct, nginx SNI -> :443/direct-ws)
    de-xhttp-h2      0.0.0.0:28443  (XHTTP H2 stream-up, direct TLS — no nginx)
    api              127.0.0.1:10085 (dokodemo-door for stats)
    auth-http        0.0.0.0:3128   (HTTP+TLS+basic auth; credentials from secure config)
    auth-socks       212.192.31.128:1080 (SOCKS5+TLS; credentials from secure config)

vpn3 (185.240.120.152, **USA** — secondary VPN upstream):
  DNS: (none yet — IP only, point via /etc/hosts or future DNS)
  Role: remote Xray/VPN upstream, USA (Virginia region, E5-2697A v4)
  OS: Ubuntu 22.04.1 LTS, x86_64
  Status: registered in panel `secure.json` `vps_list`, SSH key auth via
          `/home/roomhacker/.ssh/id_rsa`, panel API verified reachable
  To onboard: install Xray, set up vless endpoints, add to DNS, configure
              nginx stream SNI routing. See `scripts/deploy-reality-443.sh`
              (vpn2) for the playbook — replicate on vpn3.

### Both DE (vpn2) and USA (vpn3) are critical

The panel tracks them in `secure.json` `vps_list`:
```json
"vps_list": [
  { "id": "vpn2-bezrabotnyi-com", "host": "vpn2.bezrabotnyi.com", "label": "DE VPN Server", ... },
  { "id": "185-240-120-152",      "host": "185.240.120.152",       "label": "USA VPN Server", ... }
]
```

Legacy single `vps` object has been removed (auto-migrated to `vps_list`).
Panel API accepts `?vps=vpn2-bezrabotnyi-com` or `?vps=185-240-120-152` query param
to target a specific VPS. Without the param, defaults to `vps_list[0]` (currently DE).

Deploy script targets vpn2 only (no vpn3 deploy yet). To add vpn3, set up Xray
on vpn3 with the same endpoint structure and add a `vpn3` target to
`scripts/deploy-all.sh`.
```

### Auth proxy on vpn2 (credentials in secure config)

External clients can use:
- **HTTPS proxy** `https://vpn2.bezrabotnyi.com:3128`
- **SOCKS5+TLS** `vpn2.bezrabotnyi.com:1080` (client must support SOCKS5 over TLS)

Both use the Let's Encrypt cert for `vpn2.bezrabotnyi.com`. For SOCKS, the client connects
with TLS, then does SOCKS5 username/password auth. The SOCKS port binds only to
`212.192.31.128` (not 127.0.0.1) to avoid clash with `whitetransportd` on 127.0.0.1:1080.

Read credentials at runtime from `VPN_PANEL_SECURE_CONFIG`; never place them in
URLs, command arguments, logs, examples, or documentation.

## Current VPN / recovery services

### vpn.bezrabotnyi.com

```text
DNS: vpn.bezrabotnyi.com -> 95.165.165.65
Nginx host: roomhacker-server-100
Backend: 127.0.0.1:30129
Process: node /home/roomhacker/apps/vpn-panel/dist/server.js
Systemd: autovpnallowip.service
```

This is the public VPN Panel endpoint.
Do not confuse it with `vpn2.bezrabotnyi.com`.

### vpn2.bezrabotnyi.com

```text
DNS: vpn2.bezrabotnyi.com -> 212.192.31.128
Purpose: remote Xray/VPN upstream
Reality endpoint: port 443 (via nginx stream SNI routing)
Internal Reality port: 23443 (Xray listens here, behind nginx stream)
Old port (blocked by MGTS): 23443
```

nginx stream on port 443 does SNI-based TCP routing. The included config is
`/etc/nginx/stream-smart-edge.conf` (`stream-reality.conf` is an orphaned
duplicate that is NOT included):

```text
Public 443 → nginx stream (ssl_preread):
  .t.gptadmin.bezrabotnyi.com  → 127.0.0.1:8446
  .v.gptadmin.bezrabotnyi.com  → 127.0.0.1:8445
  ya.ru                        → Xray Reality on 127.0.0.1:23443
  smart/full-us.runet…         → 95.165.165.65:443
  vpn2/cdn/cdn2.bezrabotnyi…   → nginx HTTPS on 127.0.0.1:8444 (vpn2-front)
  default                      → smart-edge.service on 127.0.0.1:9443
```

The default backend is `smart-edge` ("Smart DNS SNI TCP edge proxy", Go; also
`smart-udp-edge` for QUIC/UDP 443), which transparently forwards the TLS
stream to the real destination of the announced SNI. This enables a
hosts-pinning scheme on RU clients: pin a blocked domain to `212.192.31.128`
and the TLS passes end-to-end through vpn2 (verified 2026-09-10 from MGTS for
chatgpt.com, openai.com/auth/api, cdn.oaistatic.com, claude.ai and
anthropic.com hosts). Exception: `proton.me` is SNI-blocked by TSPU on the
RU→vpn2 leg (ClientHello with SNI=proton.me is dropped regardless of
destination IP), so Proton must ride the VPN tunnel, not hosts pinning.

Deploy script: `scripts/deploy-reality-443.sh` (auto-tries ports 443, 4443, 8443 with rollback).

This is the remote tunnel destination used by recovery HAProxy and/or SmartRelay flows.

### HAOS recovery HAProxy addon

```text
Host: homeassistant / 192.168.2.101
Addon/container: app_local_bezrabotnyi_recovery_haproxy
Config path in container: /data/haproxy.cfg
Stats: :8404 /stats
Published ports: 8080, 8404, 8443
```

Important backends from HAProxy:

```haproxy
backend be_runet_vpn
    mode tcp
    server vpn2_xray vpn2.bezrabotnyi.com:443 check inter 5s fall 2 rise 1

backend be_runet_smart
    mode tcp
    server relay_smart 192.168.2.100:23445 check inter 5s fall 2 rise 1

backend be_runet_full
    mode tcp
    server relay_full 192.168.2.100:23444 check inter 5s fall 2 rise 1
```

Known local/recovery backends in HAProxy:

```text
be_router_http      -> 192.168.2.1:80
be_home_http        -> 172.30.32.1:8123
be_remote100_http   -> 192.168.2.98:80
be_remote88_http    -> 192.168.2.87:80
be_remote44_http    -> 192.168.2.43:80
be_cockpit88_https  -> 192.168.2.75:9090 ssl verify none
be_cockpit44_https  -> 192.168.2.5:9090 ssl verify none
be_100_http         -> 192.168.2.100:80
be_100_https        -> 192.168.2.100:443
be_runet_vpn        -> vpn2.bezrabotnyi.com:443 (SNI-routed via nginx stream)
be_runet_smart      -> 192.168.2.100:23445 (smart.runet.bezrabotnyi.com SNI)
be_runet_full       -> 192.168.2.100:23444 (full.runet.bezrabotnyi.com SNI)
```

Ingress path for public :443:

```text
Primary public 443 → OpenWrt port forward → server-100 HAProxy SNI routing:
  smart/full DE/US SNI → local relay ports 23444-23447
  everything else     → nginx on 127.0.0.1:8444

Reserve only → HAOS:8443 → recovery HAProxy with the same four product routes.
The primary/reserve policy and product map live in
`deploy/public-ingress/topology.json`. Do not point normal ingress at HAOS.
After topology edits run `npm run render:public-ingress`; both deploy paths
reject stale generated HAProxy blocks.
```

## LAN proxies (server-100 ↔ router ↔ LAN clients)

```text
192.168.2.1:3128 (HTTP)  → haproxy → 192.168.2.5:3128  (server-44 sing-box)
                                     → 192.168.2.75:3128 (server-88 Xray)
                                     → 212.192.31.128:3128 (vpn2, down — no 3128)
                                     → 192.168.2.101:3128 (HAOS, disabled)

192.168.2.1:1080 (SOCKS) → haproxy → 192.168.2.5:1080   (server-44 sing-box SOCKS)
                                     → 192.168.2.75:1080  (server-88 Xray SOCKS)

192.168.2.1:3127 (HTTP US lane)
  → primary 192.168.2.75:3127 (server-88 Xray)
      → leastPing over VUSA Reality/XHTTP/HUP/WS/gRPC/CDN/CDN2 on public :443
      → direct XHTTP-H2 :28443 as the cold-start fallback
  → backup 192.168.2.5:3128 (DE lane) only if the US proxy health check fails

Both server-44 and server-88 use multi-outbound with auto-balancer (leastPing
via Xray observatory / sing-box selector default) over the panel's endpointOrder:
de-xhttp-h2 → de-xhttp → de-direct-ws → de-grpc → de-httpupgrade → de-cdn → de-reality
```

### Mandatory Telegram DC transparent lane

This is a required production feature, not an experimental alternative to
Bez: LAN Telegram Desktop clients must work with **Bez off**, no macOS
system-wide proxy, and Telegram's own proxy disabled. Telegram uses hard-coded
DC IPs, so SmartDNS/domain routing does not satisfy this contract.

```text
LAN client → OpenWrt br-lan
  Telegram official CIDRs → mangle mark 0x1 / policy table 100 → 192.168.2.101
  → HAOS sing-box TPROXY :12555 (Smart Edge add-on, host netns)
  → selected non-RU outbound (vless us-cdn/de-cdn/…)
```

The edge is the HAOS Smart Edge (2026-09-01 remediation). server-88 is NOT a
Telegram lane dependency; do not point table 100 at `192.168.2.75`, and keep
the legacy `telegram-dc-failover` procd service disabled (it rewrites table 100
back to server-88).

- CIDRs: the official `https://core.telegram.org/resources/cidr.txt` IPv4 set
  is installed as router ipset `telegram_v4` (IPv6 steering is intentionally
  deferred — the LAN has no global v6 route). Never infer Telegram only from
  domain DNS.
- The route is a coupled deployment: router mark/ipset/policy routing **and**
  the HAOS Smart Edge TPROXY listener on `192.168.2.101:12555` must both be
  active. A router `telegram_v4` set with zero references is a broken lane.
- Immediate restore after router drift/reboot (uses the already-deployed
  watchdog script, idempotent): `ssh root@192.168.2.1
  'TELEGRAM_TPROXY_LIVE_APPROVED=1 /usr/sbin/telegram-transparent-lane --apply'`.
  Staged repo changes go through
  `scripts/deploy-telegram-transparent-lane.sh --dry-run` and, with
  `TELEGRAM_TPROXY_LIVE_APPROVED=1 … --apply`; note its edge target is still
  the portable server-88 xray contract (rollback asset), while the live edge
  is HAOS.
- Persistence: OpenWrt `telegram-transparent-lane` is a procd watchdog
  (probes the edge and re-applies when missing; its `probe_edge` must stay
  BusyBox-nc compatible — plain `nc host port </dev/null`, no `-z/-w`, and
  there is no `timeout` applet on the router).
- Acceptance requires live evidence: `iptables -t mangle -vnL PREROUTING`
  shows a counted `telegram_v4` mark; HAOS Smart Edge container healthy with
  `sing-box` listening TCP+UDP on `:12555`; a TCP connect from a LAN host to a
  Telegram DC IP succeeds while the same connect from HAOS itself fails
  (RU path blocks DC IPs); and a real LAN client connects with Bez/system
  proxy off. An explicit `192.168.2.1:1080` Telegram-only SOCKS setting is an
  outage fallback, not the normal architecture.

### SOCKS UDP support

Both server-44 (sing-box) and server-88 (Xray) in-socks-lan inbounds have UDP
support enabled. SOCKS5 is the right tool for UDP — HTTP CONNECT is TCP-only.

For UDP test, use `proxychains4` or `socat` to forward UDP through SOCKS5:
```bash
# Forward local UDP 5353 to a remote UDP target via SOCKS5
socat - SOCKS5:192.168.2.75:1080:remote.example.com:53,sourceport=5353
```

The HAProxy addon is currently a recovery/reverse-proxy component. It is not a good long-term tool for smart geo-routing of arbitrary traffic.

## Unified SmartDNS deployment (legacy until HAOS cutover)

The currently deployed SmartDNS is one Go process on
`roomhacker-server-100`; this is the rollback baseline, not the target host:

```text
systemd: smart-dns.service
binary: /usr/local/bin/smartdns
config: /opt/smart-dns/config.json
public DoH backend: 127.0.0.1:8053 (profile=public)
public DoT backend: 127.0.0.1:8853 (profile=public)
LAN DNS: 192.168.2.100:53 UDP+TCP (profile=local)
LAN Xray SNI edge: 192.168.2.75:80/443
```

Before cutover, OpenWrt forwards DNS to `192.168.2.100`. The selected target
keeps `192.168.2.1` as the client-facing DHCP/DNS endpoint and changes only its
upstream to HAOS `192.168.2.101:53`. UFW permits TCP/UDP 53 only from
`192.168.2.0/24`. The old
`smart-dns.service` on server-44 and `lan-smart-dns.service` on server-88 are
disabled; their timestamped configs remain only for rollback.

The `local-proxy` policy class is intentionally different by listener:
Telegram, Discord, YouTube, Instagram, and their configured CDN domains point
to `192.168.2.75` on the LAN, but resolve directly through public DoH/DoT.
Remote Smart Edge cannot hide the blocked SNI, so these LAN-only routes must
not be advertised as a public DPI bypass. OpenAI/ChatGPT remain normal
profile-aware `proxy` rules.

The old `scripts/deploy-smartdns-unified.sh` and `smartdns` target in
`scripts/deploy-all.sh` preserve the server-100 rollback implementation. They
are retired for the selected HAOS path and must not be run as forward deploys.

## Rootd access to Home Assistant

There is no direct normal rootd on HAOS. Access is proxied through `server-44`.

```text
Host running proxy-rootd: server-44 / 192.168.2.5
Systemd unit: rootd-homeassistant.service
Rootd port on 44: 25901
SSH target: root@192.168.2.101:2228
SSH key: /home/roomhacker/.ssh/id_rsa on server-44
```

Current working unit values:

```ini
Environment=SSH_HOST=192.168.2.101
Environment=SSH_PORT=2228
Environment=SSH_USER=root
Environment=SSH_KEY=/home/roomhacker/.ssh/id_rsa
```

The public key from `server-44:/home/roomhacker/.ssh/id_rsa.pub` is installed into HAOS `/root/.ssh/authorized_keys`.

## Proposed SmartRelay architecture

Goal:

```text
Russian traffic -> direct, no VPN
Non-Russian traffic -> proxy via vpn2.bezrabotnyi.com / Xray
LAN/private traffic -> direct
```

Recommended implementation:

```text
VPN Panel / clients
  -> local smartrelay on HAOS or server-100/server-44
      -> direct outbound for LAN/private/RU
      -> Xray outbound to vpn2.bezrabotnyi.com:443 for everything else
```

Recommended smartrelay engine: `Xray` (client/server routing), not sing-box for this panel.

Reasoning:

- HAProxy is excellent for reverse-proxy and TCP/SNI dispatch, but weak for full smart routing.
- SNI-only routing is not enough for all traffic: DNS, CDN, IP-only destinations, QUIC, and non-HTTP traffic can break assumptions.
- Xray is already the project model: VLESS+Reality endpoints, generated Xray configs, and Happ routing links.
- Keep HAProxy for recovery/admin domains. Use Xray routing for SmartRelay/split-tunnel.

Suggested routing policy:

```text
private / LAN CIDRs       -> direct
geoip:ru                  -> direct
geosite:category-ru       -> direct
.ru / .рф domains         -> direct
final                     -> vpn2_xray outbound
```

Suggested inbound ports for smartrelay:

```text
SOCKS: 1080
HTTP proxy: 3128 or 3129
Mixed: 7890, if needed
```

Avoid binding SmartRelay publicly without authentication.

## Legacy external sing-box addon on HAOS

Observed container:

```text
addon_local_singbox_proxy
Published ports: 1080, 3128, 3129
```

This external add-on is a rollback asset only. The unified HAOS Smart Edge
bundles its own pinned sing-box `1.13.14` and reaches it only on private HTTP
`127.0.0.1:13128`; it must not call or depend on these published ports. Retire
`addon_local_singbox_proxy` only after the unified add-on passes the final LAN
canary.

## Operational rules

When changing nginx, systemd, HAProxy, sing-box, Xray, or routing:

1. Read and save current config first.
2. Create a timestamped backup.
3. Apply the minimal change.
4. Show a diff.
5. Validate config before reload/restart.
6. Reload/restart service.
7. Run functional checks.
8. Keep rollback command obvious.

Examples:

```bash
systemctl cat autovpnallowip.service
systemctl status autovpnallowip.service
journalctl -u autovpnallowip.service -n 100 --no-pager
curl -I http://127.0.0.1:30129
```

For HAProxy on HAOS:

```bash
docker exec app_local_bezrabotnyi_recovery_haproxy sed -n '1,260p' /data/haproxy.cfg
docker exec app_local_bezrabotnyi_recovery_haproxy haproxy -c -f /data/haproxy.cfg -f /data/router-users.cfg
docker restart app_local_bezrabotnyi_recovery_haproxy
docker logs --tail 100 app_local_bezrabotnyi_recovery_haproxy
```

For rootd proxy to HAOS:

```bash
systemctl cat rootd-homeassistant.service
systemctl restart rootd-homeassistant.service
journalctl -u rootd-homeassistant.service -n 100 --no-pager
ssh -i /home/roomhacker/.ssh/id_rsa -p 2228 root@192.168.2.101 'hostname; whoami'
```

## Centralized config + auto-deploy

All product-routing backend configs (vpn2 Xray, server-44 sing-box, server-88
Xray, SmartDNS, and the legacy router HAProxy rollback config) are stored in
`deploy/` on server-100 as the single source of truth. Router HAProxy must not
receive new LAN Smart Edge behavior; after the HAOS cutover its config remains
only as a rollback artifact until retirement. The
`scripts/deploy-all.sh` remains valid only for explicit remote backend targets;
it regenerates their configs, validates, pushes via SSH, and restarts the
service. Rollback uses per-target timestamped backups. Its default/`all`,
`smartdns`, `router-dns`, and `router` forms are retired for LAN migration and
must not be run.

```text
deploy/
  vpn2/xray/config.json        # generated from panel + auth proxy
  server-44/sing-box/config.json  # static (committed to repo)
  server-88/xray/config.json     # static (committed to repo)
  router/haproxy/haproxy.cfg     # legacy rollback only during HAOS migration
```

### Deploy via CLI

```bash
scripts/deploy-all.sh vpn2           # specific target
scripts/deploy-all.sh server-44 server-88
```

Active explicit backend targets: `vpn2`, `vusa`, `server-44`, `server-88`.
`scripts/deploy-smartdns-unified.sh`, router-HAProxy deploy scripts, and
router-HAProxy watchdog install/deploy routes are also retired and must not be
run for the selected HAOS path.

### Deploy via panel API (admin only)

```bash
# Explicit remote backend deploy
curl -X POST -b cookies.txt 'http://127.0.0.1:30129/api/admin/deploy/vpn2'

# Last 100 log lines
curl -b cookies.txt 'http://127.0.0.1:30129/api/admin/deploy/status'
```

Logs: `logs/deploy/deploy.log` (also `panel_health` log dir).

### Per-target flow

For each active explicit backend target, deploy-all.sh:
1. Reads canonical config from `deploy/<target>/...`
2. Validates JSON syntax locally; for sing-box/xray, also runs `check`/`run -test` on the remote (cert paths are remote-only)
3. Backs up current config on remote with timestamp
4. Pushes via SSH (base64 + python3 on remote)
5. Replaces config + restarts the target service
6. Smoke test (curl/HTTP through the relevant proxy path)
7. On failure: leaves pending file, doesn't replace, returns non-zero

### vpn2 cert perms (one-time setup)

Xray on vpn2 runs as `nobody` (uid 65534). For it to read the Let's Encrypt
cert + key, the following was applied:
- `usermod -aG proxy nobody` — add nobody to proxy group
- `chgrp proxy /etc/letsencrypt/{live,archive}` — group ownership
- `chmod 750 /etc/letsencrypt/{live,archive}` — group can traverse
- Drop-in `/etc/systemd/system/xray.service.d/20-supplementary-proxy.conf`:
  ```ini
  [Service]
  SupplementaryGroups=proxy
  ```
- `systemctl daemon-reload && systemctl restart xray`

Without this, Xray fails with: `permission denied` on
`/etc/letsencrypt/live/vpn2.bezrabotnyi.com/fullchain.pem`.

## Important warnings

- `vpn.bezrabotnyi.com` and `vpn2.bezrabotnyi.com` are different systems.
- `vpn.bezrabotnyi.com` is the panel endpoint on server-100.
- `vpn2.bezrabotnyi.com` is the remote VPN/Xray upstream.
- Do not route LAN/private/admin domains through remote VPN unless explicitly intended.
- Be careful with HAOS: addon configs live under `/addon_configs/...`, and changes should be validated inside the target container when possible.
- The LAN is dual-homed. Always consider `192.168.2.x` default MGTS path and `192.168.1.x` Beeline path.


## Happ routing link policy

The VPN Panel sends a `routing` HTTP header on subscription endpoints:

```text
/sub/:token/plain
/sub/:token/v2ray
/sub/:token/happ
```

The header value is generated by `happRoutingLink()` in `src/subscriptions.ts` and imports routing into Happ:

```text
happ://routing/onadd/<base64-json>
```

Current intended routing logic (policy 2026-08-16): SmartDNS-like selective
proxy — the VPN carries only the OpenAI, Telegram, and WhatsApp families,
everything else is strictly direct:

```text
GlobalProxy: false  (default route is DIRECT)
DIRECT:  vpn.bezrabotnyi.com, geosite:ru-inside, geoip:private, geoip:ru
PROXY:   OpenAI family (openai.com, chatgpt.com, oaistatic.com, oaiusercontent.com,
         oaistatsig.com, openaimerge.com, workos.com, workoscdn.com),
         Telegram family (telegram.org, telegram.me, t.me, tdesktop.com,
         telesco.pe, telegra.ph),
         WhatsApp family (whatsapp.com, whatsapp.net, wa.me)
PROXY-IP: official Telegram DC CIDRs (core.telegram.org/resources/cidr.txt) —
          Telegram apps use hardcoded DC IPs, domain rules alone miss them
Geo DB: golukon russia-only-geoip / russia-only-geosite (compact, RU + private only)
DNS RU/direct: 77.88.8.8
DNS remote/proxy: https://dns.google/dns-query
DomainStrategy: IPIfNonMatch
```

Smart/Full regional products now differ only in exit region for the proxied
families; the RU/direct split happens client-side. Do not add `geoip:`-tag
entries to ProxyIp — the compact russia-only geoip has no telegram/openai
categories, so proxy IP rules must stay literal CIDRs. Other SmartDNS families
(youtube, discord, instagram, facebook, x, spotify, notion, claude, and the
protected `ua`/`hailuo.ai` suffixes) are intentionally NOT proxied here; the
whitelist is exactly the three families above unless the user says otherwise.

## Current four-product regional relay override

The canonical user catalog is exactly `smart-de-relay`, `full-de-relay`,
`smart-us-relay`, and `full-us-relay`. Public clients use `95.165.165.65:443`
with distinct Reality SNI values. Server-100 is the primary SNI ingress and
dispatches to local ports 23444-23447; HAOS provides reserve dispatch to the
same ports. The relay ports have no WAN forwards.
DE and US use separate balancers and same-region fallbacks. The 11 previously
advertised direct transports are appended after the four products as client
fallbacks; `us-xhttp` remains admin-only. Deploy
with `scripts/deploy-regional-relays.sh`; validate/stage primary ingress with
`scripts/deploy-server100-public-ingress.sh` and deploy the HAOS reserve only
with `scripts/deploy-haos-recovery.sh`.

The older two-RU-relay/high-port notes below are deprecated historical context
and must not override this section.

## Deprecated Xray RU relay deployment on roomhacker-server-100

Two real RU relay endpoints are deployed locally on `roomhacker-server-100` using Xray Docker image:

```text
Systemd unit: xray-ru-relays.service
Docker container: xray-ru-relays
Image: teddysun/xray:26.5.9
Generated config: /etc/vpn-panel/xray-relay/config.json
Geo DB dir: /etc/vpn-panel/xray-geo
```

Endpoints generated into VPN Panel subscriptions:

```text
RU-full-relay  -> 95.165.165.65:23444 (direct port, UFW allowed)
RU-smart-relay -> 95.165.165.65:23445 (direct port, UFW allowed)
```

Note: relay endpoints previously used `full.runet.bezrabotnyi.com:443` / `smart.runet.bezrabotnyi.com:443` via HAProxy SNI routing on HAOS. This was replaced with direct IP:port access because HAOS Supervisor kept overwriting HAProxy config, making HAProxy unreliable as a long-term relay frontend. UFW on server-100 allows inbound TCP 23444 and 23445 from anywhere. OpenWrt forwards WAN ports 23444/23445 to 192.168.2.100.

Relay behavior:

```text
ru-full-relay:
  all tcp/udp -> to-de -> vpn2.bezrabotnyi.com:443/xhttp (XHTTP)

ru-smart-relay:
  geoip:private -> direct-ru
  geoip:cn      -> direct-ru
  geoip:by      -> direct-ru
  geosite:category-ru -> direct-ru
  geoip:ru      -> direct-ru
  all other tcp/udp -> to-de -> vpn2.bezrabotnyi.com:443/xhttp (XHTTP)
```

Note: with Loyalsoldier `geosite.dat`, same tags apply: `geosite:category-ru`, `geosite:category-ads-all`, `geoip:ru`, `geoip:cn`, `geoip:by`, `geoip:private`. `geosite:ru` does not validate.

### MGTS ISP blocks Xray Reality port 23443 to vpn2

**MGTS (primary ISP, 95.165.165.65) blocks port 23443 specifically** — not Reality protocol via DPI. Reality on port 443 or 4443 works perfectly from MGTS. The fix was to move Reality to port 443 via nginx stream SNI routing (`scripts/deploy-reality-443.sh`).

The fix: route the relay's `to-de` outbound through **XHTTP (SplitHTTP) over TLS** on port 443 behind nginx:

- `to-de` uses `network: "xhttp"` with `h2: false` (forces HTTP/1.1) and `security: "tls"`
- nginx on vpn2 receives TLS, proxies POST /xhttp to Xray backend at 127.0.0.1:20080
- All Xray versions upgraded to **26.5.9** to avoid client-side Reality handshake bugs

### Configurable to-de transport (`de_transport`)

The relay's Germany outbound transport is configurable per-server in `secure.json` via `server_configs.*.de_transport`:

- `"reality"` — VLESS+Reality to vpn2:23443 (blocked by MGTS)
- `"xhttp"` (current) — VLESS+XHTTP with `h2:false` via nginx on vpn2:443/xhttp
- `"ws"` — VLESS+WebSocket via nginx on vpn2:443/cdn-ws
- `"grpc"` — VLESS+gRPC via nginx on vpn2:443/grpc (deprecated in Xray 26.5.9)
- `"httpupgrade"` — VLESS+HTTPUpgrade via nginx on vpn2:443/hup

Other config keys: `de_path`, `de_mode`, `de_address`, `relay_uuid`, `de_fingerprint`.

### Relay Reality serverNames

The relay's Reality inbound validates SNI from clients. The `server_names` in `secure.json.server_configs.*` must include all SNI values clients may send:

```text
Current: ["vk.ru", "smart.runet.bezrabotnyi.com", "ya.ru", "runet.bezrabotnyi.com", "full.runet.bezrabotnyi.com"]
```

### mux incompatibility with relay

**Xray mux (multiplexing) is incompatible with the relay's `to-de` outbound when using XHTTP or gRPC transport.** If a client enables mux, the relay cannot properly route demuxed connections through non-Reality outbounds (`common/mux: unexpected network TCP` error). Solution: client subscription configs for relay endpoints must NOT use mux. The generated subscription configs (`xrayClientSubscription()`) do not enable mux by default.

### New DE fallback endpoints on vpn2

In addition to the primary `de-direct` Reality endpoint (vpn2:23443):

| Tag | Port | Transport | Path/ServiceName |
|-----|------|-----------|-----------------|
| de-xhttp | 20080 | XHTTP | /xhttp |
| de-cdn | 20081 | WebSocket via CF DNS-only `cdn.demiurge.space` | /cdn-ws |
| de-cdn2 | 20084 | WebSocket via CF DNS-only `cdn2.demiurge.space` | /cdn2-ws |
| de-grpc | 20082 | gRPC | /grpc |
| de-httpupgrade | 20083 | HTTPUpgrade | /hup |
| de-cdn-xhttp | 20080 | XHTTP via Cloudflare `cdn.demiurge.space` | /xhttp (DISABLED) |

All use TLS via nginx on vpn2:443 with corresponding location blocks. gRPC is deprecated in Xray 26.5.9 ("Please migrate to XHTTP stream-up H2"). HTTPUpgrade is also deprecated in Xray 26.5.9.

**de-cdn-xhttp is disabled**: XHTTP transport uses HTTP/2 bidirectional streaming that CloudFlare CDN proxy does not support. The endpoint is set to `enabled: false` in `secure.json`.

### gRPC deprecation in Xray 26.5.9

Xray 26.5.9 deprecates gRPC transport:

```text
"The feature gRPC transport (with unnecessary costs, etc.) is deprecated,
not recommended for using and might be removed. Please migrate to XHTTP
stream-up H2 as soon as possible."
```

Preferred to-de transports: XHTTP (h2:false) > WS > HTTPUpgrade (deprecated) > Reality > gRPC (deprecated).

Note: WS transport is also deprecated in Xray 26.5.9 ("Please migrate to XHTTP H2 & H3"), but still functional and widely supported.

### RU transport matrix (MGTS ISP, server-100 → vpn2)

All transports tested from server-100 behind MGTS (95.165.165.65) with real Xray VLESS client:

| Transport | Works? | Notes |
|-----------|--------|-------|
| de-xhttp (XHTTP h2:false) | ✓ | Fastest working, ~3.8s |
| de-direct (Reality 443) | ✓ | Works! SNI-routed via nginx stream, ~0.3s |
| de-httpupgrade (HTTPUpgrade TLS) | ✓ | ~3.8s |
| de-direct-ws (WS direct) | ✓ | Works through nginx TLS, requires `alpn: ["http/1.1"]` |
| de-grpc (gRPC TLS) | ✓ | Deprecated in 26.5.9 |
| ru-smart-relay → XHTTP → vpn2 | ✓ | ~3.8s |
| ru-full-relay → XHTTP → vpn2 | ✓ | ~7s (cold Docker start) |
| de-reality (Reality 23443) | ✗ | BLOCKED by MGTS (port 23443 specifically, not DPI) |
| de-cdn (WS DNS-only) | ✓ | CF DNS set to DNS-only (proxy disabled); direct TLS to vpn2 |
| de-cdn2 (WS DNS-only) | ✓ | CF DNS set to DNS-only (proxy disabled); direct TLS to vpn2 |
| de-cdn-xhttp (XHTTP via CF CDN) | ✗ | DISABLED — XHTTP incompatible with CloudFlare CDN proxy |

### WebSocket transport requirements

**WS clients MUST set `alpn: ["http/1.1"]` in tlsSettings.** Without it, TLS may negotiate HTTP/2 ALPN, and nginx responds with HTTP/2 which breaks the WebSocket upgrade (returns `400 Bad Request`). This is enforced in `xrayStreamSettings()` in `src/subscriptions.ts` and `deOutboundBase()` in `src/xray-configs.ts`.

**WS config format for Xray 26.x:** Use top-level `host` field in wsSettings (not deprecated `headers: { Host: ... }`):
```json
"wsSettings": { "path": "/cdn-ws", "host": "vpn2.bezrabotnyi.com" }
```

**vpn2 client list sync:** All Xray inbounds on vpn2 must have the same client UUID list. When adding/removing clients, update ALL inbounds (not just some). The WS inbounds (de-cdn, de-cdn2, de-direct-ws) were previously missing clients, causing `websocket: close 1000` errors.

**Cloudflare DNS-only + WS:** CF CDN proxy blocks Xray's Go TLS WS connections (EOF error). Fix: set CF DNS records for `cdn.demiurge.space` and `cdn2.demiurge.space` to DNS-only (`proxied: false`), bypassing CF proxy entirely. The domains still resolve to vpn2's IP but traffic goes directly to vpn2's nginx, not through CF. SNI in endpoint `query.sni` must be `vpn2.bezrabotnyi.com` (the Let's Encrypt cert covers this domain, not the cdn subdomains).

### Subscription endpoint order

`endpointOrder` in `src/secure-config.ts:61` controls which endpoints appear in subscriptions and their priority:

```js
["de-direct", "de-xhttp", "de-direct-ws", "de-httpupgrade", "de-cdn", "de-cdn-xhttp", "de-cdn2", "de-grpc", "ru-smart-relay", "ru-full-relay"]
```

- de-direct first: Reality on port 443 via SNI routing (~0.3s), fastest transport
- de-xhttp: XHTTP via nginx TLS (~3.8s), reliable fallback
- de-direct-ws: WS via nginx TLS, another reliable fallback
- de-cdn/de-cdn-xhttp/de-cdn2/de-grpc: CDN/HTTP fallbacks (CDN endpoints have high latency)
- Relays last: useful for RU-side split/full relay behavior

### Relay test commands

```text
# Local test (requires correct keypair for server-100 relay):
fingerprint=safari  # chrome fails on some ISPs/ports
Docker test: run Xray client with SOCKS inbound, VLESS+Reality → 127.0.0.1:23445
  - RU (2ip.ru)       → 95.165.165.65
  - World (ipify.org) → 212.192.31.128
  - Do NOT use mux on client side
Docker test: run Xray client with SOCKS inbound, VLESS+Reality → 127.0.0.1:23444
  - All traffic (both RU and World) → 212.192.31.128
```

Public access to relay endpoints:

```text
runet.bezrabotnyi.com resolves to 95.165.165.65.
Ports 23444/23445 are open on server-100 via UFW rules:
  ufw allow 23444/tcp  # VPN relay full
  ufw allow 23445/tcp  # VPN relay smart
OpenWrt forwards WAN TCP 23444/23445 to 192.168.2.100.

HAProxy SNI routing on HAOS:8443 still exists as a backup path:
  full.runet.bezrabotnyi.com  → relay:23444
  smart.runet.bezrabotnyi.com → relay:23445
but is NOT used by VPN Panel subscriptions (direct IP:port preferred).
```

## Auto endpoint health check

Hourly health check running on `server-44` to determine working endpoints.

### Systemd units

| Unit | Type | Description |
|------|------|-------------|
| `vpn-endpoint-check.service` | oneshot | Runs health check script |
| `vpn-endpoint-check.timer` | timer | `OnCalendar=hourly`, `Persistent=true` |

### Script: `scripts/auto-endpoint-check.sh`

Runs on `server-100`, SSHes to `server-44` (192.168.2.5), tests each endpoint via Docker Xray.

Flow:
1. Fetch subscription (`xray-json`) using Dasha/Nikita token (has all 9 endpoints)
2. For each endpoint:
   - Generate minimal Xray config (only SOCKS inbound, route all via one outbound)
   - SCP config to server-44
   - Start Docker Xray (`teddysun/xray:26.5.9`, `--network host`, unique container name `vpn-check-{ep}`)
   - Wait for SOCKS port (10809) to answer
   - Test **only `https://telegram.org`** via SOCKS (8s timeout; 20s for CDN endpoints `de-cdn*`)
   - Cleanup container
3. Parse results → working = Telegram returns 2xx/3xx
4. Update DB `client_profiles`:
   - Dasha (`geier25`) + Nikita (`Nikita`) → **all 9 endpoints always**
   - Everyone else → **only working endpoints**
4. If working set changed → restart `autovpnallowip.service`
5. Log to `/home/roomhacker/apps/vpn-panel/logs/endpoint-check.log`
6. State hash in `logs/last-working-hash` (avoids unnecessary restarts)

### Safety fallback

If **0 endpoints pass** (all fail) → enable **all 9 endpoints for all users** (safety net).

### Logs

- `/home/roomhacker/apps/vpn-panel/logs/endpoint-check.log`
- Systemd journal: `journalctl -u vpn-endpoint-check.service -f`

---

## Benchmark scripts

| Script | Purpose |
|--------|---------|
| `scripts/vpn-bench.sh` | Cross-platform benchmark (Mac native Xray / Linux Docker `--network host`). Tests 12 sites + speed test. |
| `scripts/run-bench-everywhere.sh` | Deploys & runs `vpn-bench.sh` on Mac (native) + server-44 (Docker) in parallel. Results in `bench-results/`. |
| `scripts/_parse_bench_results.py` | Parses benchmark JSON, extracts working endpoints by critical site checks. |

### Usage

```bash
# Full benchmark on both hosts
VPN_TOKEN=xxx scripts/run-bench-everywhere.sh

# Only server-44
VPN_TOKEN=xxx HOSTS=s44 scripts/run-bench-everywhere.sh

# Local quick test (single endpoint)
scripts/vpn-bench.sh ENDPOINTS="de-xhttp"
```

### Critical sites tested

- RU: VK, Yandex, 2ip, Ozon, Wildberries
- World: Telegram, YouTube, X, ChatGPT, Reddit, Wikipedia, t.me

---

## Personalized announce (Happ)

Generated by `personalizedAnnounce(displayName, login)` in `src/subscriptions.ts`.

Returned as `announce` header (base64-encoded for HTTP/2):

```
announce: base64:<utf8-greeting>
```

### Logic

- Base name from `nameOverrides`: Маха → `Махмуд`, Ольга → `мама Ольга`
- Greeting pools:
  - Time of day: morning (<10), day (10-17), evening (17-22), night (22+)
  - Day of week: Monday (40%), Friday (40%), weekend (60%)
  - Random fallback (~50 variants)
- Base64 encoded via `announceHeader()` for HTTP/2 header safety

### Example outputs

```
Хорошего уикенда, Никита!
С пятницей, Махмуд!
Доброе утро, мама Ольга!
Удачного понедельника, Дарья!
```

---

## Per-client endpoint assignment

Stored in `client_profiles` (M:N join: `client_id` + `endpoint_id`).

| User group | Endpoints |
|------------|-----------|
| Даша (`geier25`) + Никита (`Nikita`) | All 9 (always) |
| Others | Only working from last auto-check |

Admin UI (`/admin`) → checkboxes per user → updates `client_profiles`.

### Current `endpointOrder` (src/secure-config.ts)

```js
["de-direct", "de-xhttp", "de-direct-ws", "de-httpupgrade", "de-cdn", "de-cdn-xhttp", "de-cdn2", "de-grpc", "ru-smart-relay", "ru-full-relay"]
```

Order controls subscription link priority and slot order in admin UI.

---

## DNS-01 Let's Encrypt cert for VPN servers

All VPN server certs are issued via Let's Encrypt **DNS-01** challenge through the
reg.ru API. This is more reliable than HTTP-01 because:

- No port 80 / nginx required
- Renewal works even if Xray/nginx is down
- LE certs are 90 days max, but DNS-01 + systemd timer = automatic renewal
  every ~60 days → certs are effectively "long-period"

### Architecture

```
certbot on VPS  →  HTTP POST to https://vpn.bezrabotnyi.com/api/admin/cert/regru
                  (uses panel HEALTH_API_KEY as Bearer token)
                         ↓
              panel runs scripts/cert-hooks/regru_api.py
                         ↓
              reg.ru API (whitelisted for 95.165.165.65 / server-100)
                         ↓
              _acme-challenge.{vpn2|vusa}.bezrabotnyi.com TXT record added/removed
                         ↓
              LE validates DNS-01, issues cert
```

The VPSes (vpn2, vusa) call back through `vpn.bezrabotnyi.com` (publicly reachable
via OpenWrt forwarding) instead of the LAN-only server-100, so the same
mechanism works for VPSes on any network.

### Single script for all VPSes

```bash
# On server-100
scripts/issue-vps-cert.sh --list                # list known VPSes
scripts/issue-vps-cert.sh vpn2                  # issue/renew vpn2 cert
scripts/issue-vps-cert.sh vusa                  # issue/renew vusa cert
scripts/issue-vps-cert.sh vpn2 --dry-run        # test mode (certbot --dry-run)
```

The script:
1. Reads the VPS list (currently `vpn2` and `vusa`) and pushes
   granted auth/cleanup hooks to `/opt/cert-hooks/` on the VPS
2. Ensures `certbot` is installed
3. Runs `certbot certonly --manual --preferred-challenges dns`
   with the hooks
4. Sets up `certbot.timer` for automatic renewal

The panel endpoint `POST /api/admin/cert/regru` (auth: Bearer HEALTH_API_KEY)
takes `{action: "auth"|"cleanup", subdomain, value, zone}` and proxies to reg.ru.

### reg.ru DNS quirk (important!)

reg.ru's DNS API accepts TXT records but the nameserver takes **~30 seconds
to start serving them**. Certbot's default 60s wait is enough for issuance.
For cleanup, the hook is called immediately after auth (before validation
succeeds), so the stale TXT can leak briefly. Always clean up after
cancelled/failed runs:

```bash
# Manual cleanup if a cert run fails
python3 scripts/cert-hooks/regru_api.py  # set REGRU_ACTION=cleanup, etc. in env
```

### Let's Encrypt rate limit

LE has a `5 failed authorizations per identifier per 1h` limit. If a run
fails repeatedly (e.g. certbot is killed mid-run), wait ~1h before retrying.
The error message includes `retry after YYYY-MM-DD HH:MM:SS UTC`.

### Auto-renewal

After the first successful run, `certbot.timer` is enabled on the VPS:

```bash
systemctl list-timers certbot.timer
# NEXT: e.g. Tue 2026-06-23 07:10:33 MSK (12h-2d before expiry)
```

Certbot will automatically renew 30 days before expiry using the same DNS-01
chain. No manual intervention needed.

### Renewal in progress (vpn2, 2026-06-22)

vpn2 cert was renewed via DNS-01 (new serial `5dfb...24b76a`, expiry
`2026-09-20`, +7 days from old expiry). Confirms the full DNS-01 chain works.

### Issue in progress (vusa, 2026-06-22, rate-limited)

vusa cert: hooks deployed on vusa, but LE rate-limited (5 failed attempts
during initial setup). Retry after ~17:02 MSK. Once issued, the same
DNS-01 chain handles renewals automatically.

---

## Safety fallback

If health check finds **0 working endpoints** → enable **all 9 endpoints for ALL users**.
Prevents total VPN outage if check is broken or all endpoints temporarily down.

---

## Happ subscription headers

| Header | Value |
|--------|-------|
| `profile-title` | `BezVPN` |
| `profile-update-interval` | `1` (hourly) |
| `routing-enable` | `1` |
| `routing` | `happ://routing/onadd/<base64-json>` |
| `providerid` | `IDdS75kg` |
| `announce` | `base64:<personalized-greeting>` |

See `docs/happ-headers.md` for full reference.

---


## Happ routing header format

Happ routing links must use the documented `onadd` form so the profile is added and activated automatically:

```text
happ://routing/onadd/<base64-json>
```

The generated profile intentionally uses Happ's documented field names/casing:

```text
GlobalProxy, RemoteDNSType, RemoteDNSDomain, RemoteDNSIP,
DomesticDNSType, DomesticDNSDomain, DomesticDNSIP,
Geoipurl, Geositeurl, FakeDNS
```

Server names in subscription links are prefixed with flag emojis so Happ shows proper icons:

```text
🇩🇪 DE-...
🇷🇺 RU-...
```

For URL fragments this is URL-encoded automatically. For subscription headers, raw emoji are used in the routing profile name.

## vusa (USA, 185.240.120.152) nginx 443 SNI + path routing

Mirror of vpn2 setup. vusa runs nginx stream on :443 that does SNI routing:

```text
SNI = www.google.com  ->  Reality (port 23443)
SNI = default         ->  HTTPS backend (port 8444, path-routed to xray inbounds)
```

8444 is a nginx HTTPS server with `server_name vusa.bezrabotnyi.com`. It has
location blocks for each transport, proxying to local xray inbounds (security=none,
nginx terminates TLS):

```text
/xhttp       -> 127.0.0.1:20080  (xhttp auto)
/xhttp-h2-443 -> 127.0.0.1:20087 (public H2, nginx HTTP/1.1 upstream)
/cdn-ws      -> 127.0.0.1:20081  (WS)
/cdn2-ws     -> 127.0.0.1:20084  (WS)
/grpc        -> 127.0.0.1:20082  (gRPC)
/hup         -> 127.0.0.1:20083  (HTTPUpgrade)
/relay-ws    -> 127.0.0.1:20086  (WS)
/direct-ws   -> 127.0.0.1:20085  (WS)
default      -> 404
```

Deploy: `scripts/deploy-all.sh vusa` (validates both Xray and nginx, creates backups).

`us-cdn.demiurge.space` and `us-cdn2.demiurge.space` are Cloudflare
DNS-only records (`proxied: false`). This bypasses the Cloudflare proxy: TLS
and WebSocket traffic go directly to VUSA. The names provide independent DNS
handles, not independent Cloudflare CDN paths or nearest-POP selection.

### Critical bug: flow=xtls-rprx-vision on non-Reality inbounds

When copying clients from `de-reality` (Vision flow enabled) to XHTTP/WS/gRPC
inbounds, the `flow: "xtls-rprx-vision"` setting is silently invalid for those
transports. Vision only works with TCP+Reality.

Symptom: all requests to /xhttp via nginx return 404 (path matching broken even
though `location ^~ /xhttp` is matched and `proxy_pass http://127.0.0.1:20080` is
called). Other paths (/cdn-ws, /grpc, etc.) return 400 (xray rejecting unknown
request format).

Fix: `flow: ""` on all non-Reality clients (same as vpn2 setup).
The deploy script now strips Vision flow on copy. For existing vusa inbounds
that have the bug, run `scripts/vusa-fix-flow.sh` to retroactively fix.

### MGTS (95.165.165.65) → vusa network quirks

From MGTS, only direct TLS to vusa works reliably:

```text
vusa:23443 Reality   (SNI=www.google.com)  ✓ works
vusa:28443 xhttp-h2 (SNI=vusa.bezrabotnyi.com)  ✓ works
vusa:443  via nginx stream  (xhttp, ws, hup)  ✗ HANG from MGTS
```

The 443-via-nginx path works from other networks (Mac/Happ tested) but
hangs from MGTS due to MTU/ALPN/TLS issues specific to the MGTS→vusa
path. Direct TLS (23443, 28443) terminates on xray itself, bypassing nginx,
and works from MGTS. Subscription includes both via the `endpointOrder` —
auto-endpoint-check (`scripts/auto-endpoint-check.sh`) will strip the
non-working 443 paths from each user's profile based on hourly health checks.

## vpn2 gptadmin vhost moved to 8445

The gptadmin vhost (`.v.gptadmin.bezrabotnyi.com`) was sharing port 8444
with `vpn2-front`. Two vhosts on the same port with different server_names
worked via SNI, but caused nginx warnings about duplicate server_name on
port 80 and made the stream map ambiguous.

Moved gptadmin to port 8445 (`/etc/nginx/sites-enabled/v-gptadmin-frp`).
Added explicit stream map entry: `*.v.gptadmin.bezrabotnyi.com -> gptadmin_backend`
in `/etc/nginx/stream-reality.conf` so the gptadmin traffic still arrives
on 443. vpn2-front is now the only vhost on 8444.

Backups: `/etc/nginx/sites-enabled/v-gptadmin-frp.bak_move` removed after
verification. Stream map backups: `/etc/nginx/stream-reality.conf.bak`.

## LAN US proxy (3127)

Новый HTTP proxy на LAN: `192.168.2.1:3127` для выхода в интернет через US (vusa) с fallback на DE (vpn2).

### Архитектура

```text
LAN client → 192.168.2.1:3127 (OpenWrt haproxy TCP)
           ├─ s100  192.168.2.100:3127 (server-100 xray-lan-us → vusa:28443 XHTTP-H2) — primary
           └─ s44/88 192.168.2.5/75:3128 (sing-box/xray → vpn2) — fallback
```

Если s100 (vusa) упал — haproxy автоматически переключается на s44/s88 (vpn2). Если упадут и они — нет fallback (на клиенте будет error, retry).

### Что есть

**server-100 (xray-lan-us):**
- xray в Docker-контейнере, слушает на `0.0.0.0:3127` (HTTP proxy)
- Outbound: VLESS+XHTTP к `vusa.bezrabotnyi.com:28443` (mode=stream-up, alpn=h2, fingerprint=chrome)
- Routing: `geoip:ru/cn/by/private` → `direct` (выходит напрямую с server-100, без VPN)
- Создаётся через `scripts/xray-lan-us.sh`
- UFW: разрешён вход `from 192.168.2.0/24 to any port 3127` (только LAN, не публичный)

**OpenWrt haproxy:**
- `frontend us_proxy_in` listen `0.0.0.0:3127` → `backend us_backends`
- `balance first` — s100 проверяется первым, fallback на s44/s88
- Health check каждые 5 сек, fall=2 (2 failed = backend out)

**server-100 xray-ru-relays (для клиентов которые коннектятся напрямую к 23444/23445):**
- Добавлен outbound `to-us-xhttp-h2` (vless+xhttp → vusa:28443)
- Добавлен в observatory.subjectSelector для health-check
- Добавлен в `routing.balancers[de-auto].selector`
- leastPing стратегия: если все to-de-* упали, переключается на vusa

### Важно

- **haproxy backend = LAN IP (192.168.2.100), не public (95.165.165.65)**
  Иначе hairpin NAT на OpenWrt: client → OpenWrt → public IP (роутер) → server-100
  = connection fails, UFW блокирует порт.
- **Без SOCKS** — только HTTP CONNECT на 3127. SOCKS на server-100 был убран из конфига
  (если нужен — вернуть через `socks` inbound на другом порту, см. `scripts/xray-lan-us.sh`).

### Применение на server-44 и server-88

На каждом LAN-сервере:
```bash
# server-44 (где уже sing-box) — добавить fallback в sing-box на vusa:28443 (XHTTP-H2)
# server-88 (где уже xray на 3128 → vpn2) — добавить vusa outbound
# Также запустить xray-lan-us (если хочется primary vusa на каждом узле)
scp scripts/xray-lan-us.sh <host>:/tmp/
ssh <host> 'USER_UUID=c03d331a-d35c-446e-9cbc-0f2a5b0417d8 bash /tmp/xray-lan-us.sh'
```


## LAN US proxy (3127) — все 3 бэкенда на 3127

Исправленная архитектура: все 3 LAN-сервера делают одно и то же — primary vusa через 3127.

### Архитектура

```text
LAN client → 192.168.2.1:3127 (OpenWrt haproxy 'first' balance)
           ├─ s100  192.168.2.100:3127 (xray-lan-us → vusa:28443) — primary
           ├─ s44   192.168.2.5:3127  (singbox → vusa+vpn2 selector) — primary
           └─ s88   192.168.2.75:3127 (xray → vusa) — primary
           fallback → :3128 (vpn2-only backends) — если все 3 упали
```

### Per-server: каждый делает одно и то же (primary vusa)

| Server | Port 3127 outbound | Внутренний fallback |
|--------|---------------------|---------------------|
| s100 (xray-lan-us) | vusa:28443 XHTTP-H2 | OpenWrt haproxy на 3128 (vpn2) |
| s44 (singbox) | vusa:28443 XHTTP-H2 (через selector с url-test) | **vpn2:28443** (внутри singbox!) |
| s88 (xray) | vusa:28443 XHTTP-H2 | OpenWrt haproxy на 3128 (vpn2) |

### Что есть

**server-100 (xray-lan-us):**
- xray в Docker-контейнере, слушает `0.0.0.0:3127` (HTTP)
- outbound: VLESS+XHTTP → vusa:28443
- routing: `geoip:ru/cn/by/private` → direct
- Создаётся через `scripts/xray-lan-us.sh`
- UFW: `from 192.168.2.0/24 to any port 3127` (LAN only)

**server-44 (singbox) — нужно настроить:**
- singbox на 3127: vless-vusa + vless-vpn2 через **selector с url-test**
  (автоматический failover внутри singbox: vusa alive → vusa, dead → vpn2)
- Создаётся через `scripts/singbox-lan-us.sh`

**server-88 (xray) — нужно настроить:**
- xray на 3127: vless+xhttp → vusa:28443 (только vusa, без fallback)
- 3128 остаётся с vpn2 (для LAN backup)
- Создаётся через `scripts/xray-server88-lan-us.sh`

**OpenWrt haproxy (192.168.2.1):**
- `frontend us_proxy_in` listen 0.0.0.0:3127
- `backend us_backends` с 3 серверами, `balance first` (s100 проверяется первым)
- `fall 5` для s44/s88 (терпит 5 failed health checks)
- 3128 backup (если все 3 бэкенда на 3127 упали)

### Почему `balance first` (не roundrobin)

Roundrobin отправляет 1/3 трафика на s44 и s88 даже когда s100 жив. Это плохо для latency.
`first` отправляет ВЕСЬ трафик на s100 пока s100 жив — намного быстрее для большинства случаев.

### Сценарии failover

| Сценарий | Куда идёт трафик |
|----------|------------------|
| s100 жив (норма) | 100% → s100 (vusa) |
| s100 down, s44/s88 живы | fallback к s44/s88 (vusa через singbox/xray) |
| Все 3 на 3127 down | fallback к 3128 (s44/s88 с vpn2) |
| s100 жив, singbox vusa fails | singbox url-test → vpn2 (только на s44) |

### Деплой

```bash
# server-100 (xray-lan-us) — уже работает
./scripts/xray-lan-us.sh

# server-44 (singbox) — нужно запустить
scp scripts/singbox-lan-us.sh user@192.168.2.5:/tmp/
ssh user@192.168.2.5 'sudo bash /tmp/singbox-lan-us.sh'

# server-88 (xray) — нужно запустить
scp scripts/xray-server88-lan-us.sh user@192.168.2.75:/tmp/
ssh user@192.168.2.75 'sudo bash /tmp/xray-server88-lan-us.sh'

# OpenWrt haproxy — уже обновлён (balance first, 3 backends)
ssh root@192.168.2.1 'cat /etc/haproxy.cfg | grep -A 20 us_proxy_in'
```

## Relay infrastructure status (2026-07-05)

The RU relay on server-100 (`xray-ru-relays`, ports 23444/23445) is the public
front-end for all clients connecting from inside Russia. It uses an Xray
balancer (`world-auto`, `leastPing` strategy) to pick the best working
outbound. Observatory auto-rejects dead outbounds.

### Outbounds in the relay balancer

| Tag | Target | Notes |
|-----|--------|-------|
| to-de-xhttp | vpn2:443/xhttp | mode=auto, h2=false. **DEGRADED** — port 443 path is unreliable. |
| to-de-xhttp-h2 | vpn2:28443 | XHTTP H2 stream-up, direct TLS (no nginx), alpn=h2. **Reliable DE fallback** added 2026-07-05. |
| to-de-httpupgrade | vpn2:443/hup | nginx TLS path |
| to-de-grpc | vpn2:443/grpc | nginx TLS path, **DEPRECATED in Xray 26.5.9+** |
| to-de-ws | vpn2:443/cdn-ws | CDN path via cdn.demiurge.space (DNS-only) |
| to-de-reality-chrome | vpn2:23443 | Reality, SNI=ya.ru |
| to-de-reality-firefox | vpn2:23443 | Reality, fingerprint=firefox |
| to-us-xhttp-h2 | vusa:28443 | XHTTP H2 stream-up direct TLS, **preferred USA path** |
| to-us-xhttp-h2-443 | vusa:443/xhttp-h2-443 | XHTTP H2 stream-up via nginx, mobile-safe public port |
| to-us-httpupgrade | vusa:443/hup | nginx TLS via 8444 |
| to-us-ws | vusa:443/direct-ws | WS direct via nginx 8444 |

`REALITY_FINGERPRINTS = ["chrome", "firefox"]` — only 2 fingerprint variants
are generated (was previously 5: chrome, firefox, safari, ios, randomized).

### Image and Reality status

- Xray image: `teddysun/xray:26.6.1` (was 26.5.9 in older docs)
- Reality fingerprint variants: chrome, firefox (was 5 variants)
- Reality is **NOT** removed from the balancer — diversity matters and it
  sometimes works. Observatory auto-rejects it when it fails.

### MGTS ISP quirks (TCP open, handshake fails)

- **vpn2:23443 Reality** — TCP open, Reality handshake fails (DPI/active
  probing). The fix is to use vpn2:443 (Reality via nginx SNI stream) or
  XHTTP on 443/28443.
- **vusa:23443 Reality** — same DPI pattern from MGTS, but works from
  server-100 directly.
- **vpn2:443/xhttp** — fails from server-100 too. Use 28443 (de-xhttp-h2)
  or other transports.
- **vusa:443 via nginx stream** — hangs from MGTS. Use direct TLS to
  vusa:28443 (XHTTP H2) or vusa:23443 (Reality).

### us-full-relay runs as a native relay inbound

`us-full-relay` is NOT a separate Xray deployment anymore. It is an inbound of
the native `xray-ru-relays.service` on server-100 (port 23446; the unit's
`90-native-recovery.conf` drop-in replaced the original docker ExecStart with
`/usr/local/bin/xray run -config /etc/vpn-panel/xray-relay/config.json`),
whose US outbound forwards to `vusa:28443` (XHTTP H2). haproxy only fronts it
(`be_full_us → 127.0.0.1:23446`).

```text
client → server-100:23446 (native xray relay inbound)
        → to-us-xhttp-h2 → vusa:28443 (xray vless+xhttp)
```

HAProxy config (`/etc/haproxy/haproxy.cfg`):

```haproxy
frontend fe-us-relay
    bind *:23446
    default_backend be-vusa-xhttp-h2

backend be-vusa-xhttp-h2
    server vusa vusa.bezrabotnyi.com:28443 check inter 30s fall 3 rise 2
```

UFW: `23446/tcp ALLOW Anywhere` (publicly reachable).

### auto-endpoint-check.sh always-include list

Endpoints that must be present in every subscription regardless of working
state. Configurable at the top of `scripts/auto-endpoint-check.sh`:

```bash
ALWAYS_INCLUDE_ENDPOINTS="${ALWAYS_INCLUDE_ENDPOINTS:-ru-full-relay}"
```

Currently: `ru-full-relay` only. `us-full-relay` is NOT in this list — the
working-set filter handles it via the auto-check (since the upstream
`vusa:28443` path is reliable, the working set includes it for all users
once it's observed working).

### Endpoint order (subscription priority)

Defined in `src/secure-config.ts` `endpointOrder`:

```text
Relays (server-100):
  ru-smart-relay, ru-full-relay
DE (vpn2):
  de-httpupgrade, de-direct-ws, de-xhttp, de-grpc, de-cdn, de-cdn2,
  de-direct, de-xhttp-h2
US (vusa + HAProxy pass-through):
  us-full-relay, us-xhttp-h2, us-httpupgrade, us-direct-ws
```

`us-reality` is NOT in this list — Reality on vusa:23443 fails DPI from MGTS,
and the node was never added to `secure.json` `nodes[]`. The DB row was
cleaned up after this change.

### us-xhttp-h2 in subscriptions but no relay outbound — fixed

Previously, `us-xhttp-h2` was in subscriptions (so clients could connect
directly to vusa:28443) but the RU relay had no matching `to-us-xhttp-h2`
outbound. If a client connected via the relay and the only DE outbounds were
dead, the relay would fail even though the US path was fine.

Fix: added `"xhttp-h2"` to `US_RELAY_TRANSPORTS` in `src/xray-configs.ts`
and added a case in `usOutboundBase()` that produces a VLESS+XHTTP outbound
with `port: 28443, mode: "stream-up", h2: true, alpn: ["h2"]`. The
`world-auto` balancer now picks `to-us-xhttp-h2` automatically.

### de-xhttp-h2 in subscriptions but no relay outbound — fixed (2026-07-05)

Previously, `de-xhttp-h2` was in subscriptions (so clients could connect
directly to vpn2:28443, bypassing nginx) but the RU relay had no matching
`to-de-xhttp-h2` outbound. This made `ru-full-relay` show `tunnel_up:false`
in the screenshot even though the client-facing endpoint worked — the relay's
`world-auto` balancer had no DE path that was reliable from server-100
through MGTS.

Fix: added `"xhttp-h2"` to `DeOutboundTransport` and to `RELAY_TRANSPORTS` in
`src/xray-configs.ts:548-553`, and added a case in `deOutboundBase()` that
produces a VLESS+XHTTP outbound with `port: 28443, mode: "stream-up", h2: true,
alpn: ["h2"]`, mirroring the existing `usOutboundBase("xhttp-h2")` shape.
Direct TLS to vpn2:28443 (Xray terminates TLS with Let's Encrypt cert, no
nginx) avoids the MGTS DPI/ALPN/MTU issues that made `to-de-xhttp` (vpn2:443/xhttp
via nginx) unreliable. After this change, `ru-full-relay` probes show
`tunnel_up:true` with ~7 Mbps / 29 Mbps large-transfer throughput.

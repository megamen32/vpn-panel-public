# VPN Panel — Self-Hosted Smart DNS, Router VPN & VDS Control Panel

[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](LICENSE)

> Ownership: VPN Panel owns product routing policy, SmartDNS/Xray/sing-box
> configs, generators, and deploy logic; see [AGENTS.md](AGENTS.md).
> `/home/roomhacker/ServersAdministartion` owns physical host/LAN topology,
> port/access maps, HAOS/OpenWrt/recovery, and controller configuration. Read
> both contracts before changing their shared network boundary.

The distributable HAOS app lives in the public
[`megamen32/haos-smart-edge-addons`](https://github.com/megamen32/haos-smart-edge-addons)
repository and is automatically built as
`ghcr.io/megamen32/haos-smart-edge`. VPN Panel remains the owner of routing
policy and generators; no runtime transport credentials are published with the
app.

VPN Panel is an open-source, self-hosted control plane for **Smart DNS**,
**router-wide VPN routing**, **Xray/sing-box subscriptions**, and **remote VDS
management**. It combines a VPN/SmartRelay service, a policy-driven SmartDNS
and router layer, and a web panel for clients, endpoints, health checks, and
deployments.

It is designed for people who already have compatible VLESS/Xray or sing-box
endpoints and want one subscription to serve phones, computers, smart TVs,
game consoles, and other LAN devices. The goal is not just to generate a VPN
link, but to keep routing useful when networks, ISPs, devices, and transports
behave differently.

## At a glance

| Question | Short answer |
|---|---|
| What is it? | A self-hosted Smart DNS, router VPN, endpoint monitoring, and VDS control panel. |
| What does it replace? | A separate Smart DNS subscription, paid router-VPN gateway, and manual multi-VPS command workflow. |
| What does it use? | Compatible Xray/sing-box endpoints, VLESS/Reality transports, SmartDNS policy, and OpenWrt or another supported router. |
| Who is it for? | Self-hosters, VPN operators, families, small teams, and anyone who needs per-client or per-domain routing. |
| Does DNS hide DPI/SNI? | No. DPI-sensitive traffic needs the LAN TCP edge or a suitable VPN transport; DNS steering alone is not a tunnel. |

```mermaid
flowchart LR
    C[Phones, laptops, TVs, IoT] --> R[Router + SmartDNS]
    R --> P{Per-client policy}
    P --> D[Direct route]
    P --> S[Smart or Full VPN]
    P --> L[HAOS LAN TCP edge with bundled sing-box]
    S --> E[Endpoint pool]
    E --> H[Recurring checks across networks and engines]
    A[Web control plane] --> P
    A --> E
    A --> V[Remote VDS nodes]
```

In a compatible router setup, one policy can cover every device on the LAN:
devices do not need a separate VPN application or manual proxy configuration.
The same policy engine can also serve external SmartDNS clients with
per-client access control.

## Three systems in one

- **VPN and SmartRelay:** Smart/Full regional products, generated client
  subscriptions, Xray transports, and fallback endpoints.
- **Smart routing:** router-wide DNS and traffic steering with direct, proxy,
  and LAN-only routes selected by domain, destination, and client policy.
- **Operations control plane:** a web panel for users, endpoint assignments,
  health evidence, remote VDS configuration, and deployment workflows.

The important boundary is DPI: public SmartDNS changes where a hostname
resolves, but it does not hide TLS SNI or turn DNS into a general-purpose
tunnel. DPI-sensitive services therefore need the LAN/Xray edge or a VPN
transport that is appropriate for that network. A route that works on wired
internet may fail on 4G, and a result from sing-box does not automatically
prove that the same transport works in Xray. The panel records these facts
instead of treating one successful probe as universal availability.

## Stop paying twice for Smart DNS

Already using [**Happ**](https://happ.info/),
[**V2Box**](https://apps.apple.com/us/app/v2box-v2ray-client/id6446814690),
[**Streisand**](https://apps.apple.com/us/app/streisand/id6450534064),
[**v2rayNG**](https://github.com/2dust/v2rayNG),
[**NekoBox**](https://github.com/MatsuriDayo/NekoBoxForAndroid), or another
[Xray](https://github.com/XTLS/Xray-core)/[sing-box](https://github.com/SagerNet/sing-box)
client? If your subscription exposes compatible VPN endpoints,
you probably already have the transport needed for SmartDNS.

This project turns the VPN infrastructure you already pay for into a
self-hosted routing layer:

- **An [AETERNIA](https://aeternia.space/en) killer:** use your existing VPN as a personal SmartDNS service.
- **A [Smart DNS Proxy](https://www.smartdnsproxy.com/) killer:** send selected services through the VPN while everything else stays direct.
- **A [Control D](https://controld.com/personal) proxy-routing killer:** choose which domains use which country or endpoint.
- **A paid router-VPN killer:** route every device on your network automatically, including devices that cannot run a VPN app.
- **A VPN monitoring service killer:** test endpoints across different networks and client engines instead of trusting one successful connection.
- **A commercial VPN-panel killer:** manage users, subscriptions, remote VDS nodes, routing, deployment, and failover from one web interface.

You do not need a separate SmartDNS subscription. Connect a compatible VPN
profile once, define the domain policy, and let every device use the correct
route automatically.

**No additional subscription. No vendor lock-in. Open source and self-hosted.**

You continue paying only for the VPN or VPS infrastructure you already use.

Do not want to pay for somebody else’s VPN? Rent a supported Linux VPS, add an
SSH path to it, and let the panel generate, validate, and deploy the supported
VPN configuration. The catch is important: this project was written by me for
my own infrastructure and has limited external testing. Treat it as a
self-hosted engineering project, review the code and security model, and test
it on your own networks before relying on it.

## Frequently asked questions

### Do I need a separate Smart DNS subscription?

No. If you already have compatible Xray or sing-box VPN endpoints, VPN Panel
can apply SmartDNS and routing policy on top of that infrastructure. You still
pay for the VPN subscription or VPS servers that provide the endpoints.

### Can one router protect or route every device?

Yes, on a supported router. The router can provide DNS and policy-based
direct/VPN routing to phones, laptops, TVs, consoles, and IoT devices without
installing a VPN app on each device. Compatibility depends on router firmware,
available RAM, connection count, and the selected routing mode.

### Does SmartDNS bypass DPI and TLS blocking?

Not by itself. SmartDNS changes DNS answers and selects a route, but public DNS
steering does not hide TLS SNI or create a general VPN tunnel. DPI-sensitive
services need the LAN TCP edge or a VPN transport that works on the current
ISP and network type.

### Does every Xray or sing-box endpoint work everywhere?

No. Endpoint availability is network- and client-dependent. Wired internet,
4G, Xray, and sing-box can produce different results, which is why the project
keeps endpoint health evidence and fallback paths instead of assuming that one
successful test proves universal availability.

### Can I manage my own VPS instead of buying a VPN subscription?

Yes, with a supported Linux VDS and SSH access. The panel can generate, validate,
and deploy supported VPN configurations, synchronize clients, and expose the
result through subscriptions and routing policy. Review the deployment scripts
and secure your SSH credentials before using it in production.

## Runtime

- Node.js 22+
- PostgreSQL 18+
- Nginx proxy to `127.0.0.1:3129`

## Environment

```bash
DATABASE_URL=postgres://roomhacker:...@127.0.0.1:5432/vpn_panel
VPN_PANEL_SESSION_SECRET=...
VPN_PANEL_ADMIN_LOGIN=admin
VPN_PANEL_ADMIN_PASSWORD=...
VPN_PANEL_SECURE_CONFIG=/etc/vpn-panel/secure.json
VPN_PANEL_PUBLIC_BASE_URL=https://vpn.bezrabotnyi.com
PORT=3129
```

`secure.json` stores node/server parameters and must not be committed. UUIDs, subscription tokens,
Reality keys and short IDs stay outside the repository.

## Commands

```bash
npm install
npm run build
npm test
npm run migrate
npm run import:xray -- /path/to/xray-config.json
npm start
```

## Rootless macOS client

The fixed `vpn2-07` profile can install a user-only Xray client on macOS:

```bash
curl -fsSL https://vpn.bezrabotnyi.com/install/bez | bash
bez install
bez smart       # SmartDNS policy: selected services through VPN, the rest direct
bez all         # external traffic through the VPN for apps honoring macOS proxy
bez custom edit # opens the local Custom policy as a JSON file
bez custom global # applies Custom policy to the whole Mac
bez off         # stop Xray and restore previous proxy settings
bez update
bez status
bez logs
```

Installation stores the VPN password only in the user Keychain and installs Xray
under `~/Library/Application Support/BezVPN` with a per-user LaunchAgent. It does
not call `sudo`, create a GUI VPN profile, change DNS, or require administrator
rights. `smart` and `all` configure macOS HTTP/HTTPS proxy settings on active
network services; `bez proxy` and `bez unproxy` print HTTP/SOCKS environment
commands for terminals and app-specific settings.

This is intentionally a rootless MVP: applications that ignore macOS system
proxy settings, and system-level UDP/QUIC flows that do not use SOCKS5, cannot be
captured without a privileged TUN or an app-specific proxy setting.

`bez` without arguments opens a status-first menu with three profiles, each
available as `Local` (only apps configured for the proxy) or `Global` (macOS
system proxy):

- `Smart`: the shared Smart policy routes selected domains through Xray.
- `Full`: all external traffic supported by the app proxy goes through Xray.
- `Custom`: local rules from
  `~/Library/Application Support/BezVPN/custom-policy.json` take priority over
  Smart. Use `bez custom edit` to open the file in TextEdit or `bez custom web`
  for the shared policy editor at `/admin/smart-dns`.

The local Custom file is deliberately limited to four domain lists. It cannot
add arbitrary Xray outbounds, alter credentials, or route LAN hosts through the
VPN. See [the macOS Bez guide](docs/17-macos-bez.md) for the complete schema.

The macOS transport uses IP addresses for Xray `vnext.address` values, so the
client does not perform DNS lookups for the configured VPN hosts. TLS SNI and
transport host fields remain where the server requires them for certificate or
Reality validation; IP-only addressing is not the same as invisible TLS.

The fixed macOS API capability is a non-rotating Bearer token embedded in the
generated client. Treat the installer/release asset as a credential and do not
publish modified copies with a different token.

## Rootless Windows client

The same fixed `vpn2-07` profile installs a user-only Xray client on Windows
10/11 (built-in Windows PowerShell 5.1, no administrator rights):

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -Command "iex (irm https://vpn.bezrabotnyi.com/install/bez-windows)"
```

Then, in a new terminal:

```text
bez install
bez smart       # SmartDNS policy: selected services through VPN, the rest direct
bez all         # external traffic through the VPN for apps honoring the user proxy
bez off         # stop Xray, remove autostart, restore previous proxy settings
bez update
bez status
bez logs
```

The Windows client installs Xray under `%LOCALAPPDATA%\BezVPN` with SHA-256
verification, keeps it running through a per-user Run key (a hidden daemon
restarts Xray if it exits), and toggles the per-user WinINET proxy in
`HKCU\Software\Microsoft\Windows\CurrentVersion\Internet Settings` refreshed via
`InternetSetOption`. `bez off` removes the Run key, stops only the Xray copied
under `BezVPN\bin`, and restores the previous proxy values from a local
snapshot. It never writes HKLM, creates scheduled tasks, or elevates. The
generated script reuses the platform-independent
`/api/user/macos-xray-config` endpoint and the same fixed Bearer token as the
macOS client, with the same rootless limitation: apps that ignore the Windows
user proxy need app-specific setup.

`bez web` opens a local Russian-language dashboard at
`http://127.0.0.1:28110/` (same port as macOS) served by a rootless PowerShell
TCP listener: live status and mode, Smart/Full/off switching, config update, a
Telegram connectivity check, and a PAC file at `http://127.0.0.1:28110/proxy.pac`
for apps without system-proxy support. Dashboard actions are guarded by a
per-session CSRF token, and the listener binds to loopback only. The macOS
dashboard's endpoint picker, Smart rule editor, auto-heal, and TUN tunnel are
not part of the Windows MVP.

## Scripts

```bash
# Auto endpoint health check (runs hourly via systemd timer)
scripts/auto-endpoint-check.sh

# Refresh the six-lane direct/LAN/VPN2/VUSA/US-proxy/DE-proxy service matrix
npm run probe:restricted-services

# Full local benchmark using the shared staged plan
scripts/vpn-bench.sh

# Run LAN + external wired + Android wireless in parallel
scripts/run-bench-everywhere.sh

# Show the independently configured cadence for every measurement target
scripts/run-target-probe-scheduler.py --list

# Run one target now without postponing its next scheduled measurement
scripts/run-target-probe-scheduler.py --target external-wireless-android

# Import historical JSON runs into the filterable DB history
npm run import:test-history

# Quick routing test (local)
scripts/test-routing.sh
```

## Features

The user-facing VPN catalog is intentionally limited to four products:
`Smart DE`, `Full DE`, `Smart US`, and `Full US`. All enter through public
TCP/443 with distinct Reality SNI values. The previous direct DE/US transports
are appended to subscriptions as compatibility fallbacks, but remain secondary
options rather than separate products.

`deploy/public-ingress/topology.json` is the topology contract. The intended
primary SNI ingress is HAProxy on server-100; HAOS is reserve-only. The primary
router sends the four product SNI values to local Xray ports `23444`-`23447`
and sends every other hostname to nginx on `127.0.0.1:8444`.
After changing the topology, regenerate both HAProxy route blocks with
`npm run render:public-ingress`; deploy scripts refuse stale generated files.
This paragraph describes the public four-product ingress only. It is separate
from the LAN SmartDNS/Smart Edge migration: public DoH/DoT and the independent
HAOS recovery HAProxy on `:8080`/`:8443` remain unchanged unless separately
migrated.

- **Per-client endpoint assignment**: Admin UI assigns specific VPN endpoints to each client
- **Endpoint resilience:** recurring checks exercise endpoints through different network lanes and client engines; broken endpoints can be removed from ordinary client assignments while privileged/test profiles retain the full catalog
- **Unified staged testing**: quick, health, and benchmark profiles share `vpn-testing/test-plan.json`
- **Per-target measurement cadence**: every `testTargets[]` entry owns an explicit `probeSchedule` (`enabled`, `everyMinutes`, `profile`). The generic systemd dispatcher wakes every five minutes, starts due targets independently, and measures each target no more often than its configured interval even after a failed run; manual `--target` runs do not alter the scheduled clock. The physical S21 target is set to `180` minutes.
- **Incremental test history**: every stage is posted to the public telemetry endpoint and indexed in PostgreSQL; failed posts remain in the durable spool (by run UUID under `TELEMETRY_SPOOL_DIR`, default `vpn-testing/results/spool`) and are replayed across all run roots on the next runner start, with optional S3 upload
- **Telemetry score semantics**: an endpoint with no effective observations has `score: null`, not `0`; the admin UI renders it as `—`/unknown and subscription ordering does not coerce it to a numeric failure score
- **Android wireless agent**: installs a test APK and Xray on the ADB-connected phone without changing its system VPN settings
- **Router-wide SmartDNS:** one router policy can give all LAN devices automatic direct/VPN routing, while external SmartDNS clients receive their own access-controlled policy
- **DPI-aware routing:** public SmartDNS is not a tunnel; SNI/DPI-affected services use the LAN-only TCP edge or a suitable VPN transport
- **Web-based VDS management:** manage multiple remote VPN nodes, generate and validate their configs, synchronize clients, inspect status, and deploy from the panel instead of manually repeating SSH command sequences on every host
- **Personalized announce**: Happ subscription headers include time-aware greetings per user (ru)
- **Happ subscription headers**: `profile-title`, `profile-update-interval: 1`, `routing`, `announce`
- **Happ deeplink**: `happ://add/<base64-subscription-url>`
- **Xray configs**: Auto-generated upstream and four-product regional relay configs via `/api/admin/xray-config/:serverId`

Happ and the server-side Smart relays use the compact daily
`golukon/russia-only-geoip` and `golukon/russia-only-geosite` artifacts. Smart
relays send only private/Russian IPs and `geosite:ru-inside` direct, with the
selected DE/US balancer as the default; Full relays remain full-tunnel. Deploy
the compact databases and matching relay config as one rollback-safe unit with
`scripts/deploy-compact-xray-geo.sh`.

### A real low-resource router case

One production setup had only about **14 MB of free RAM** on the router and
around **16,000 active connections**. Router-wide automatic VPN was enabled for
all devices, and the observed result was **no measurable performance loss**.
This is an operational case study, not a universal hardware benchmark: the
result depends on the router firmware, ruleset, connection mix, and available
VPN paths.

## Restricted-service policy and evidence

The reviewed catalog in `vpn-testing/restricted-services.json` classifies
service domain families as LAN-only TCP edge (`local-proxy`), LAN/public Smart Edge
(`proxy`), or observation-only (`monitor`). DNS steering does not hide TLS SNI:
Telegram, Discord, WhatsApp, Facebook, Instagram, YouTube, X/Twitter, Grok,
Viber, LinkedIn, and similar DPI/SNI-sensitive routes require the LAN edge, not
a public Smart Edge bypass. The current rollback edge is server-88 at
`192.168.2.75`; the selected target is the HAOS add-on at `192.168.2.101`.
ChatGPT/OpenAI and other provider-geo routes may use normal Smart Edge proxying.

LAN clients continue to receive DNS `192.168.2.1` from OpenWrt. The active
topology forwards DNS to the HAOS add-on on
`192.168.2.101:53` and hairpin-DNATs TCP `192.168.2.1:443` directly to
`192.168.2.101:443`. The add-on bundles sing-box `1.13.14` and uses only its
private HTTP listener `127.0.0.1:13128`; it does not use the old external
`local_singbox_proxy :3128`.
The server-100 LAN resolver at `192.168.2.100`, server-88 edge, and router
HAProxy are rollback assets and no longer serve the active LAN path. Catalog policy
is merged with
`npm run sync:restricted-service-policy`, reviewed, and rendered into generated
router rules. The admin page is intentionally read-only for this workflow.

This LAN migration does not retire or replace the separate Telegram IP TPROXY
lane. AdGuard, Nginx Proxy Manager, and external `local_singbox_proxy` on HAOS
are stopped with boot set to manual after the successful staged cutover.

`npm run probe:restricted-services` refreshes advisory RunetFreedom feed counts
and repeated live evidence for direct, LAN SNI, VPN2/VUSA SNI, and the separate
LAN `:3127`/`:3128` HTTP proxy lanes. Feed membership and policy matches do not prove service
availability. A probe HTTP response, including 403, means the selected TCP/TLS
web front was reachable; it does not prove the full app, calls, MTProto, CDN
media, QUIC, or push. Missing/stale probe status is shown explicitly while the
catalog remains visible. See `docs/15-smartdns.md` for the complete contract.

## Subscription Endpoints

| Path | Format |
|------|--------|
| `/sub/:token/plain` | Plain VLESS links (one per line) |
| `/sub/:token/v2ray` | Base64-encoded plain |
| `/sub/:token/happ` | Routing link + plain (Happ native) |
| `/sub/:token/sing-box` | sing-box JSON |
| `/sub/:token/xray-json` | Xray client JSON |

## Admin Panel

- URL: `https://vpn.bezrabotnyi.com/admin` (login: `admin`)
- User management, endpoint assignment, token rotation
- User self-service: `https://vpn.bezrabotnyi.com/login` → `/account`

## Files

- `secure.json` — endpoint/server config (not in git)
- `secure.json` → synced to DB `endpoints` table on startup
- `client_profiles` table — per-client endpoint assignment (M:N)

## License

VPN Panel is released under the [MIT License](LICENSE).

# Smart DNS DoH/DoT gateway

Self-hosted Aeternia-like DNS gateway for VPN Panel.

> Ownership: VPN Panel owns this policy/runtime and its deploy logic; see
> [../../AGENTS.md](../../AGENTS.md).
> `/home/roomhacker/ServersAdministartion` owns physical LAN, HAOS/OpenWrt,
> recovery, and port/access topology. Read both contracts before changing the
> shared boundary.

## Operational boundary

This service controls DNS resolution and, for selected A records, sends a
client to Smart Edge. It is effective against DNS-level interference and for
sites whose subsequent TCP/TLS traffic is not blocked by DPI. It is not a
general-purpose VPN and does not conceal the client's TLS or QUIC protocol.

Telegram, Discord, YouTube, and Instagram are therefore a separate
`local-proxy` class. On public DoH/DoT they resolve directly. The current LAN
rollback path resolves them to the Xray SNI gateway on server-88; the selected
target resolves them through the router address to the HAOS TCP Smart Edge.
Advertising the remote
Smart Edge for these names would add a hop without hiding the SNI that the ISP
filters. A correct DNS answer is still only a routing-stage success, so validate
these services end to end.

Active LAN topology (canaried 2026-09-01):
- OpenWrt remains the client DNS/DHCP endpoint at `192.168.2.1`.
- OpenWrt forwards DNS to the HAOS add-on at `192.168.2.101:53` and applies a
  simple TCP/443 hairpin DNAT from `192.168.2.1` to `192.168.2.101:443`.
- The HAOS add-on owns SmartDNS `:53` and TCP Smart Edge `:443`, bundles
  sing-box `1.13.14`, and uses only its private HTTP listener
  `127.0.0.1:13128`.
- AdGuard, Nginx Proxy Manager, external `local_singbox_proxy :3128`, router
  HAProxy, and server-100 LAN DNS are stopped/retired rollback paths. The
  server-100 process remains only for public DoH/DoT. The unified add-on never
  depends on the external proxy add-on.

Retained public/rollback runtime:
- server-100: `/usr/local/bin/smartdns`, `smart-dns.service`
- config: `/opt/smart-dns/config.json`
- canonical Go implementation/unit: `scripts/smartdns-go/`
- `infra/smart-dns/server.js` is deprecated and is not the live production process
- public DoH backend: `http://127.0.0.1:8053/dns-query/<client_id>` (`public` profile)
- public DoT backend: `127.0.0.1:8853` (`public` profile), client id from SNI `<client_id>.dns.bezrabotnyi.com`
- LAN DNS: `192.168.2.100:53` over UDP and TCP (`local` profile)
- UFW permits port 53 only from `192.168.2.0/24`; it is not a public resolver
- proxied upstream DNS: persistent HTTP/2 DoH through `192.168.2.75:3128`
  (current rollback runtime only)
- server-88 is only the local Xray HTTP/TLS gateway at `192.168.2.75`; its old dnsmasq resolver is deprecated and disabled
- server-44 no longer runs a second SmartDNS instance

Public frontend on roomhacker-server-100:
- DoH: `https://dns.bezrabotnyi.com/dns-query/<client_id>` -> `127.0.0.1:8053`
- DoT: `853/tcp` stream proxy -> `127.0.0.1:8853`

The LAN migration does not implicitly move these public DoH/DoT frontends.
It also preserves the independent HAOS recovery HAProxy on `:8080`/`:8443`
and the Telegram IP TPROXY lane on server-88.

Policy (route selection, not an end-to-end availability guarantee):
- direct: `.ru`, `.su`, `.рф` (`xn--p1ai`), LAN/local, `bezrabotnyi.com`
- proxy: OpenAI/ChatGPT and explicit/global public proxy policy
- local-proxy: Telegram, Discord, YouTube, Instagram and their configured CDN domains; target local profile -> router/HAOS edge, current rollback -> `192.168.2.75`, public profile -> direct
- unmatched local names default to direct, so ordinary LAN browsing has no synthetic edge hop

Security:
- keep `defaultClientId: null`
- never expose short ids like `XYZ123`
- issue long random client ids from the panel
- DoT needs wildcard certificate for `*.dns.bezrabotnyi.com` because client id is encoded in SNI
- reg.ru wildcard behavior is problematic; use existing reg.ru DNS-01 hooks and verify TXT propagation

Runtime sync:
- VPN Panel exposes enabled per-user clients at `GET /api/internal/smart-dns/clients`.
- Auth: `Authorization: Bearer $VPN_PANEL_HEALTH_API_KEY`.
- server-100 reads `sync.url` and `sync.token` from `/opt/smart-dns/config.json`.
- Local `clients` in config are kept as emergency fallback and merged with DB clients.
- New/rotated/disabled client ids from the panel are picked up on the next sync interval, no service restart needed.

Smart edge mode:
- Listener profiles select independent `edgeProfiles.local` and `edgeProfiles.public` targets.
- For proxy-routed domains Smart DNS can synthesize the selected profile's IPv4 instead of returning the real target IP.
- `AAAA` and `HTTPS/SVCB` queries for proxy-routed domains return NOERROR/NODATA to force IPv4 TCP fallback and avoid HTTP/3/ECH shortcuts.
- Positive upstream DNS responses are cached in-process with their original TTLs; transaction IDs and remaining TTLs are rewritten per response.
- The public edge profile is a configurable DE/USA pool; the active primary is
  selected from the panel and must be read from live `edgeProfiles.public`
  rather than assumed from this document.
- vusa nginx stream routes `vusa.bezrabotnyi.com` to its local HTTPS backend, `www.google.com` to Reality, and unknown SNI to `smart-edge` on `127.0.0.1:9443`.
- `smart-edge` reads TLS SNI and opens a TCP connection to `<sni>:443`; TLS remains end-to-end with the origin.
- Smart Edge handles the selected TCP+TLS connection only. It does not cover
  arbitrary QUIC/UDP, all auxiliary app domains, or active protocol filtering.

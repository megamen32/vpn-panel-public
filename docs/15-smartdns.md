# SmartDNS Architecture and Limits

> Ownership: VPN Panel owns SmartDNS policy, implementation, generators, and
> deploy logic; see [../AGENTS.md](../AGENTS.md).
> `/home/roomhacker/ServersAdministartion` owns physical LAN, OpenWrt, HAOS,
> recovery, and port/access topology. Read both contracts before changing the
> shared boundary.

> Packaging boundary: the public
> `https://github.com/megamen32/haos-smart-edge-addons` repository owns the
> installable HAOS app and GHCR build. VPN Panel owns the SmartDNS policy and
> generators; HAOS keeps the generated policy and `singbox.json` privately in
> the app data volume.

## Purpose

SmartDNS is selective DNS steering, not a VPN. It is useful when access is
limited by poisoned DNS answers, destination-IP selection, or geolocation and
the ISP does not subsequently block the application protocol.

## Do not conflate Smart Proxy with VPN transport

There are three separate routing layers:

- `direct` returns the origin DNS answer and does not use a proxy;
- a remote Smart Proxy is the public SNI edge on a VPS: the client connects
  directly to that VPS and `smart-edge` forwards the original TLS stream. This
  works only while the ISP permits that ClientHello/SNI;
- an encrypted VPN transport (VLESS/Reality/WS/HTTPUpgrade) is required for
  Telegram DCs and other DPI-blocked traffic.

Live remote Smart Proxy targets are currently VPN2 and VUSA. Both run
`smart-edge.service` behind nginx stream `:443` and accept a direct SNI canary.
The Finland host is a third VPN exit, but it is not yet a third Smart Proxy:
its public `:443` is owned directly by Xray and `smart-edge.service` is absent.
Do not describe the remote Smart Proxy pool as three-way until Finland gets a
separately reviewed nginx-stream/Smart Edge migration that preserves its
existing Xray endpoint.

HAOS keeps the class boundary explicit. `direct`/RU/private traffic bypasses
VPN. Traffic already classified as VPN-required uses `world-auto` across the
DE, FI, and US VPN transports; Telegram uses the same members through
`telegram-auto`, whose health probe targets `t.me`. The explicit DE/US/FI
proxy listeners remain region-pinned products.

For a domain classified as `proxy`, the resolver returns a Smart Edge IPv4
address instead of the origin address and suppresses `AAAA` and `HTTPS/SVCB`
answers. For `direct`, it returns the normal upstream DNS answer. A third
policy class, `local-proxy`, deliberately resolves through the LAN TCP edge
only for queries arriving on the local listener profile. In the selected
target that edge is the HAOS add-on with bundled sing-box, not a separate Xray
service.

## Active LAN data path

Current topology, activated and canaried on 2026-09-01:

```text
public client DoH/DoT query             LAN client UDP/TCP query
  -> dns.bezrabotnyi.com                  -> DHCP DNS 192.168.2.1 (OpenWrt)
  -> current public frontend               -> DNS forward: HAOS 192.168.2.101:53
                     \                      -> HAOS SmartDNS policy
  -> policy from VPN Panel
     -> direct: upstream DNS answer
     -> proxy: synthesized profile-specific Smart Edge IPv4
     -> local-proxy: router 192.168.2.1 locally, direct publicly
  -> client connects to the selected address
     -> router TCP/443 hairpin DNAT -> HAOS 192.168.2.101:443
     -> HAOS Smart Edge -> bundled sing-box 1.13.14 at 127.0.0.1:13128
     -> UDP/443: UDP Edge uses a short-lived client-IP-to-domain mapping
  -> explicit US HTTP proxy: router 192.168.2.1:3127 hairpin DNAT
     -> HAOS 192.168.2.101:3127 -> bundled sing-box `us-regional`
```

The active final-port runtime is the GitHub Store app
`27579e22_bezrabotnyi_transparent_smart_edge` on image `0.1.12`; its private
policy and transport data were migrated and canaried on 2026-09-13. The former
local app is retired and is not a fallback DNS source.

The rollback baseline has a Go resolver as `smart-dns.service` on server-100
(`192.168.2.100:53`), a server-88 edge (`192.168.2.75`), and old router HAProxy
configuration for `192.168.2.1:443`. Those are rollback assets, not active LAN
architecture. HAOS AdGuard, Nginx Proxy Manager, the external
`local_singbox_proxy :3128`, router HAProxy, and server-100 LAN SmartDNS are
retired. The
unified add-on never depends on the external proxy add-on. It owns the
dedicated LAN US HTTP listener on `:3127`; OpenWrt exposes the same port with a
scoped DNAT/SNAT pair so the return path remains symmetric.

The panel owns per-client policy through
`GET /api/internal/smart-dns/clients`; `scripts/smartdns-go/` remains the
canonical implementation. Public DoH/DoT currently remain loopback-only on
server-100 ports 8053/8853 and are not implicitly moved by the LAN cutover.
LAN clients keep `192.168.2.1` in DHCP option 6. The old
`192.168.2.75:53` compatibility forwarder is rollback-only and is not a second
policy source.

OpenWrt keeps `rebind_protection=1`. Its generated dnsmasq conf-dir file has
only `rebind-domain-ok=/domain/` entries for the effective non-direct LAN
policy; it must not render `local=/domain/` or `address=/domain/...` pairs.
That lets HAOS remain the one DNS policy/answer producer while allowing its
intentional private `192.168.2.1` Smart Edge answers through the router's
rebind guard.

Preserve the independent HAOS recovery HAProxy on `:8080`/`:8443`. The
Telegram IP TPROXY lane on server-88 is also separate from the DNS/TCP edge and
must not be retired by this migration.

`src/smart-dns-policy.ts` classifies names as `direct`, `proxy`, or
`local-proxy`.
`scripts/smartdns-go/main.go` implements DNS and synthesis. The server-100/
server-88 TCP Smart Edge deployed by `scripts/smart-edge-deploy.mjs` from
`infra/smart-edge/smart-edge.py` is the current rollback implementation; the
selected target packages DNS and TCP edge together as the HAOS add-on. UDP/443
support remains in `infra/smart-udp-edge/`.

Smart Edge's `127.0.0.1:9443` is an internal loopback hop. It is never a public
VPN/client port; external SmartDNS and VPN ingress remains TCP/UDP 443.

## What it does not do

On TCP/443 the edge reads the plaintext TLS SNI and relays the original TLS
stream byte-for-byte to that hostname. Encryption remains end-to-end, but the
requested hostname is still visible to the access provider. SmartDNS does not
obfuscate traffic shape, terminate TLS, or create a general tunnel, so it does
not bypass DPI rules based on SNI or protocol behavior.

It also does not cover connections made to literal or cached IP addresses,
application-owned DNS, non-TLS protocols, or ports other than 443. UDP support
is limited to UDP/443 and maps one public client IP to the most recently queried
domain for a short time. This is inherently fragile for concurrent multi-domain
applications and clients behind shared NAT; it is not a general UDP tunnel.

## Current service expectations

| Service class | SmartDNS expectation |
|---|---|
| Simple HTTPS affected only by DNS/IP selection | Often works |
| ChatGPT and similar single-site HTTPS flows | Often works; still require an end-to-end check |
| Telegram | LAN-only TCP edge; public SmartDNS stays direct |
| Discord | LAN-only TCP edge; public SmartDNS stays direct |
| YouTube | LAN-only TCP edge; public SmartDNS stays direct |
| Instagram | LAN-only TCP edge including Instagram/CDN domains; public SmartDNS stays direct |
| WhatsApp, Facebook/Messenger/Threads | LAN-only TCP edge; public SmartDNS stays direct |
| X/Twitter, Grok/xAI | LAN-only TCP edge; public SmartDNS stays direct |
| Signal, Viber, LinkedIn | LAN-only TCP edge; public SmartDNS stays direct |
| ChatGPT/OpenAI, Spotify | Proxy in both LAN and public profiles for provider geo restrictions |
| TikTok | Monitor only until a live failure justifies an explicit route |

The LAN route works because the connection reaches the local TCP edge
before leaving the network. Public SmartDNS cannot hide the subsequent SNI, so
it must not advertise those LAN-only applications as remotely bypassed. Away
from the LAN, use an Xray/sing-box VPN, SmartRelay, or full proxy.

## Active restricted-service catalog

`vpn-testing/restricted-services.json` is the small service-level source of
truth. It records routing intent, a representative HTTPS probe, and the domain
families required by each product. Its reviewed `local-proxy` and `proxy`
entries merge additively into the canonical panel policy. That policy is then
rendered by `src/cli/render-openwrt-smart-dns.ts` into the generated OpenWrt
domain rules consumed by `deploy/router/dhcp/configure-smart-dns.sh`; OpenWrt
must not grow a separately maintained domain list.

The probe command downloads the current
`ru-blocked`, `discord`, and `youtube` release text files from the
RunetFreedom generator repositories linked to
`runetfreedom/russia-v2ray-rules-dat`, then checks every service through:

1. normal Russian egress;
2. the active HAOS Smart Edge through router `192.168.2.1:443`;
3. the public VPN2 Smart Edge;
4. the public VUSA Smart Edge;
5. the dedicated LAN US HTTP proxy on `192.168.2.1:3127`;
6. the separate LAN DE HTTP proxy on `192.168.2.1:3128`.

Each lane is sequential and independent. A maximum of two lanes run together,
and every target is attempted three times by the scheduled job. The two HTTP
proxy paths are not inferred from SNI-edge results.

Run the read-only evidence refresh manually with:

```bash
npm run probe:restricted-services
```

After reviewing a catalog route or domain-family change, merge it additively
into the persisted policy with `npm run sync:restricted-service-policy`, review
the resulting policy and generated router rules, and only then use the normal
OpenWrt deployment workflow. There is deliberately no panel button that syncs
or deploys these policy changes automatically. The canonical
systemd unit and hourly timer are stored in
`deploy/server-100/systemd/restricted-services-probe.{service,timer}`. Results
are written atomically to `data/restricted-services-status.json` and rendered
on `/admin/smart-dns`.

RunetFreedom feeds are advisory domain evidence, not an availability oracle.
Likewise, `policy match != availability`: a route assignment describes intent,
not a successful request. Live probe attempts are health evidence for one URL
and lane. The UI distinguishes `stable` (all attempts succeeded), `flaky`
(mixed attempts), `down` (attempts failed), `skipped`, and `нет измерения`.
Status older than 90 minutes, generated for an older catalog, or carrying an
invalid timestamp is marked stale; a missing or unreadable status file never
hides the reviewed catalog.

An HTTP response, including 403 and other 4xx responses, proves only that the
selected TCP/TLS web front is reachable. It does not prove Telegram MTProto,
calls, YouTube media CDNs, QUIC, push notifications, or the complete mobile
application flow.

## Correct health semantics

Keep these outcomes separate:

1. DNS transport succeeded: DoH/DoT/UDP returned a valid response.
2. Policy matched: the domain was classified as `direct`, `proxy`, or `local-proxy`.
3. Edge was selected: the synthesized address was returned and is reachable.
4. Application succeeded: the real site request or app flow completed.

Only stage 4 proves user-visible availability. In particular, `proxy` in the
admin policy checker means “Smart Edge candidate”; `local-proxy` means the LAN
gateway only. Neither proves that the application works or that DPI was
bypassed. HTTP authorization/challenge responses can still prove connectivity,
while a connect/TLS timeout is a fatal transport failure.

## Related references

- [VPN Panel ownership and migration contract](../AGENTS.md)
- `/home/roomhacker/ServersAdministartion/AGENTS.md` — physical topology owner
- `scripts/smartdns-go/README.md` — resolver build, configuration, and deploy
- `infra/smart-dns/README.md` — infrastructure notes and the deprecated Node implementation
- `infra/smart-edge/` — currently deployed TCP Smart Edge
- `infra/smart-udp-edge/` — constrained UDP/443 edge
- Admin UI: `/admin/smart-dns`

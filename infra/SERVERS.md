# Server States (as of 2026-06-22)

> Current client contract: Smart DE, Full DE, Smart US, and Full US enter on
> `95.165.165.65:443`; server-100 ports 23444-23447 are HAOS-only internal
> relay inbounds.

## roomhacker-server-100 (this host, panel)

- **OS**: Ubuntu 22.04
- **LAN**: 192.168.2.100 (MGTS), 192.168.1.100 (Beeline)
- **Public**: 95.165.165.65
- **Panel**: autovpnallowip.service → `node /home/roomhacker/apps/vpn-panel/dist/server.js`
- **Local listen**: 127.0.0.1:3129
- **Public**: `vpn.bezrabotnyi.com` (nginx vhost on 443)
- **OpenWrt DNS hijack** for `*.bezrabotnyi.com` → 95.165.165.65
- **SSH**: port 22104 (key: `/home/roomhacker/.ssh/id_rsa`)
- **Pinned**: WHITELISTED in reg.ru DNS API
- **Scripts**:
  - `scripts/deploy-all.sh` — push configs to all 4 backends
  - `scripts/issue-vps-cert.sh` — issue/renew LE certs (DNS-01) for all VPSes
  - `scripts/cert-hooks/regru_api.py` — reg.ru DNS API client
- **Endpoints**:
  - `POST /api/admin/deploy/{vpn2|server-44|server-88|router|all}`
  - `GET /api/admin/deploy/status`
  - `POST /api/admin/cert/regru` (auth: Bearer HEALTH_API_KEY)

## OpenWrt router (192.168.2.1)

- **OS**: OpenWrt 24.10.2 on ramips/mt7621 (mipsel_24kc)
- **Services**:
  - haproxy 3.0.16-r1 (TCP load balancer on LAN)
    - `proxy_in` frontend: 0.0.0.0:3128 → backends (s1=192.168.2.5:3128, s2=192.168.2.75:3128, s4=192.168.2.101:3128 [disabled], s3=212.192.31.128:3128 [down])
    - `socks_in` frontend: 0.0.0.0:1080 → backends (s1=192.168.2.5:1080, s2=192.168.2.75:1080)
  - dnsmasq: DNS hijack for `*.bezrabotnyi.com` → 95.165.165.65
- **Config**: `/etc/haproxy.cfg` (canonical copy: `deploy/router/haproxy/haproxy.cfg`)

## server-44 (192.168.2.5)

- **OS**: Ubuntu 22.04 (assumed, wasn't directly checked)
- **sing-box**: 1.13.14 (`/usr/local/bin/sing-box`)
- **Service**: `sing-box.service` (active, systemd)
- **Inbounds**:
  - `in-http-all`: 0.0.0.0:3128 (HTTP proxy)
  - `in-socks-local`: 127.0.0.1:1080 (SOCKS, internal)
  - `in-socks-lan`: 0.0.0.0:1080 (SOCKS, LAN)
  - `in-http-smart`: 0.0.0.0:3129 (HTTP, smart proxy)
- **Multi-outbound**: 5x vless (reality, ws, httpupgrade, grpc, cdn-ws) + selector "proxy" (default: de-reality)
- **Cert**: NO TLS (backends are 127.0.0.1, behind server-88 nginx/HAProxy)
- **Config**: `/etc/sing-box/config.json` (canonical: `deploy/server-44/sing-box/config.json`)

## server-88 (192.168.2.75)

- **OS**: Ubuntu 22.04
- **Xray**: 26.6.1 (`/usr/local/bin/xray`)
- **Service**: `xray.service` (active, systemd)
- **Inbounds**:
  - `in-http-all`: 0.0.0.0:3128 (HTTP proxy)
  - `in-socks-local`: 127.0.0.1:1080 (SOCKS, internal)
  - `in-socks-lan`: 192.168.2.75:1080 (SOCKS, LAN) [UDP enabled]
  - `in-http-smart`: 0.0.0.0:3129 (HTTP, smart proxy)
  - `in-socks-discord-udp`: 192.168.2.75:1081 (SOCKS, UDP for discord bot)
- **Multi-outbound**: 7x vless (xhttp-h2, xhttp, direct-ws, httpupgrade, grpc, cdn-ws, reality) + balancer "proxy" (leastPing) + vpn-xudp for UDP
- **Config**: `/usr/local/etc/xray/config.json` (canonical: `deploy/server-88/xray/config.json`)

## vpn2 (212.192.31.128, **DE primary**)

- **OS**: Ubuntu 22.04.5
- **DNS**: `vpn2.bezrabotnyi.com`
- **Hostname**: `vpn2.bezrabotnyi.com` (set 2026-06-22)
- **Xray**: 26.6.1 (`/usr/local/bin/xray`)
- **Service**: `xray.service` (active, systemd, with `SupplementaryGroups=proxy`)
- **Cert**: `/etc/letsencrypt/live/vpn2.bezrabotnyi.com/` (LE DNS-01, renewed 2026-06-22, expiry 2026-09-20, serial `5dfb...24b76a`)
- **Inbounds (11)**:
  | tag | listen | port | proto | sec | notes |
  |-----|--------|------|-------|-----|-------|
  | de-reality | 0.0.0.0 | 23443 | vless | reality | SNI=ya.ru, publicKey=wtiGwXE8... |
  | de-xhttp | 127.0.0.1 | 20080 | vless | none | via nginx on 443 |
  | de-cdn | 127.0.0.1 | 20081 | vless | none | via nginx, CF DNS-only cdn.demiurge.space |
  | de-cdn2 | 127.0.0.1 | 20084 | vless | none | via nginx, CF DNS-only cdn2.demiurge.space |
  | de-grpc | 127.0.0.1 | 20082 | vless | none | via nginx, gRPC |
  | de-httpupgrade | 127.0.0.1 | 20083 | vless | none | via nginx, HTTPUpgrade |
  | de-direct-ws | 127.0.0.1 | 20085 | vless | none | via nginx, direct WS |
  | de-xhttp-h2 | 0.0.0.0 | 28443 | vless | tls | XHTTP stream-up H2, direct TLS, cert=LE |
  | api | 127.0.0.1 | 10085 | dokodemo | - | Xray stats API |
  | auth-http | 0.0.0.0 | 3128 | http | tls | TLS + basic auth, root/<redacted> |
  | auth-socks | 212.192.31.128 | 1080 | socks | tls | TLS + password auth, same creds, UDP |
- **Cert perms**: `/etc/letsencrypt/{live,archive}` owned by root:proxy (mode 750), Xray runs as `nobody` with `SupplementaryGroups=proxy` for read access
- **Cert renewal**: `certbot.timer` (every ~12h check, renews at 30d before expiry)
- **Config**: `/usr/local/etc/xray/config.json` (canonical: `deploy/vpn2/xray/config.json`)

## vusa (185.240.120.152, **USA secondary** — NEW 2026-06-22)

- **OS**: Ubuntu 22.04.1 LTS, kernel 5.15.0-43-generic
- **DNS**: `vusa.bezrabotnyi.com` (A record added via reg.ru)
- **Hostname**: `vusa.bezrabotnyi.com` (set 2026-06-22)
- **Root password**: `<redacted>` (set 2026-06-22)
- **Xray**: 26.6.1 (`/usr/local/bin/xray`)
- **Service**: `xray.service` (active, systemd, with default `User=nobody`)
- **Cert**: `/etc/letsencrypt/live/vusa.bezrabotnyi.com/` (LE cert via HTTP-01, valid until 2026-09-20, serial 5fa8...)
- **Inbounds (5, subset of vpn2)**:
  | tag | listen | port | proto | sec | notes |
  |-----|--------|------|-------|-----|-------|
  | de-reality | 0.0.0.0 | 23443 | vless | reality | SNI=www.google.com (US site), publicKey=2W3BxIHQHEM5DtpLj57K7NUn4rdfUPI7QTkMFiFmMEU |
  | api | 127.0.0.1 | 10085 | dokodemo | - | Xray stats API |
  | de-xhttp-h2 | 0.0.0.0 | 28443 | vless | tls | XHTTP stream-up H2, direct TLS, cert=LE |
  | auth-http | 0.0.0.0 | 3128 | http | tls | TLS + basic auth, root/<redacted> |
  | auth-socks | 185.240.120.152 | 1080 | socks | tls | TLS + password auth, same creds, UDP, bound to public IP only (avoid clash with whitetransportd on 127.0.0.1:1080) |
- **Not yet on vusa (skipping for simplicity, can add later)**:
  - de-xhttp, de-cdn, de-cdn2, de-grpc, de-httpupgrade, de-direct-ws (all require nginx with SNI routing)
- **Cert perms**: cert owned by root:proxy (vpn2 pattern), key mode 0640, fullchain 0644; nobody user in proxy group via `SupplementaryGroups=proxy` systemd drop-in
- **Hook setup**: `/opt/cert-hooks/regru-{auth,cleanup}-hook.sh` (deployed by `issue-vps-cert.sh`, used by DNS-01 method)
- **Cert renewal**: `certbot.timer` (auto-renews 30d before expiry; uses HTTP-01 since DNS-01 broken by reg.ru NS wildcard bug — see [CERTIFICATES.md](CERTIFICATES.md))
- **Config**: `/usr/local/etc/xray/config.json`
- **Reality public key (NEW, not in panel)**: `2W3BxIHQHEM5DtpLj57K7NUn4rdfUPI7QTkMFiFmMEU`
- **Reality private key (NEW, on vusa only)**: `<redacted>`

## Server comparison

| Feature | vpn2 (DE) | vusa (USA) |
|---------|-----------|------------|
| Hostname | vpn2.bezrabotnyi.com | vusa.bezrabotnyi.com |
| Cert | LE DNS-01 (renewed) | LE HTTP-01 (DNS-01 broken by reg.ru NS wildcard) |
| Reality SNI | ya.ru (RU site) | www.google.com (US site) |
| Reality keys | wtiGwXE8... (old) | 2W3BxIHQHEM... (new, separate) |
| Public ports | 23443, 28443, 3128, 1080 | 23443, 28443, 3128, 1080 |
| Backend ports (127.0.0.1) | 10085 (api), 20080-20085 (nginx) | 10085 (api) only |
| Nginx | Yes (vpn2-front) | No |
| Auth proxy creds | root / <redacted> | root / <redacted> |
| Panel secure.json | server_configs.de.* | (not in panel yet) |

# Infrastructure & Deployment

> Ownership: VPN Panel owns product routing, SmartDNS/sing-box configuration,
> generators, and deploy logic; see [../AGENTS.md](../AGENTS.md). Physical
> HAOS/OpenWrt/recovery topology belongs to
> `/home/roomhacker/ServersAdministartion`. Read both contracts before changing
> their shared boundary.

## Canonical regional relay products

| Product | Public ingress | Policy | Pinned exit |
|---------|----------------|--------|-------------|
| Smart DE | `95.165.165.65:443`, SNI `smart-de.runet.bezrabotnyi.com` | RU/private direct, remainder proxied | DE |
| Full DE | `95.165.165.65:443`, SNI `full-de.runet.bezrabotnyi.com` | all traffic proxied | DE |
| Smart US | `95.165.165.65:443`, SNI `smart-us.runet.bezrabotnyi.com` | RU/private direct, remainder proxied | US |
| Full US | `95.165.165.65:443`, SNI `full-us.runet.bezrabotnyi.com` | all traffic proxied | US |

`deploy/public-ingress/topology.json` is the topology source of truth.
Server-100 is primary: its HAProxy SNI router dispatches the four product names
to local Xray inbounds on ports `23444`-`23447` and sends all other TLS traffic
to nginx on `127.0.0.1:8444`. HAOS keeps the same SNI routes as a reserve path;
it is not the normal ingress. The high Xray ports have no WAN forwards. The DE
and US balancers have separate selectors and same-region fallback tags, so a
cold or failed US pool cannot spill into DE.

Validate the primary config with `scripts/deploy-server100-public-ingress.sh`
(safe dry-run by default; `--apply` requires the nginx loopback listener and
free public `:443`). Deploy the reserve config explicitly with
`scripts/deploy-haos-recovery.sh`.

Edit product SNI/port mappings only in `deploy/public-ingress/topology.json`,
then run `npm run render:public-ingress`. Both primary and reserve deploy paths
run the renderer in `--check` mode and reject drift.

## Server Inventory

### server-100 (roomhacker-server-100)

**Role**: Main panel server, nginx reverse proxy, central config source

| Property | Value |
|----------|-------|
| LAN MGTS | 192.168.2.100 |
| LAN Beeline | 192.168.1.100 |
| Public MGTS | 95.165.165.65 |
| Public Beeline | 95.31.7.115 |

**Services**:
- VPN Panel (Node.js, systemd: `autovpnallowip.service`, production port 30129)
- Nginx (reverse proxy `vpn.bezrabotnyi.com` → 127.0.0.1:30129)
- PostgreSQL 18+ (`vpn_panel` database)
- Xray (RU relays, Docker: `xray-ru-relays`)

**Key paths**:
- Panel: `/home/roomhacker/apps/vpn-panel`
- Config: `/etc/vpn-panel/secure.json`
- Deploy configs: `deploy/` (single source of truth for all backends)
- Nginx vhost: `/etc/nginx/sites-enabled/vpn.bezrabotnyi.com`

### vpn2 (vpn2.bezrabotnyi.com, DE)

**Role**: Remote Xray/VPN upstream, Germany

| Property | Value |
|----------|-------|
| Public IP | 212.192.31.128 |
| DNS | vpn2.bezrabotnyi.com |
| Xray | 26.6.1, 11 inbounds |

**Endpoints**:

| Tag | Address | Transport | Notes |
|-----|---------|-----------|-------|
| de-reality | 0.0.0.0:23443 | Reality (SNI=ya.ru) | Direct, no nginx |
| de-xhttp | 127.0.0.1:20080 | XHTTP | nginx SNI → :443 |
| de-cdn | 127.0.0.1:20081 | WS | CF DNS-only cdn.demiurge.space |
| de-grpc | 127.0.0.1:20082 | gRPC | nginx SNI → :443/grpc |
| de-httpupgrade | 127.0.0.1:20083 | HTTPUpgrade | nginx SNI → :443/hup |
| de-cdn2 | 127.0.0.1:20084 | WS | CF DNS-only cdn2.demiurge.space |
| de-direct-ws | 127.0.0.1:20085 | WS direct | nginx SNI → :443/direct-ws |
| de-xhttp-h2 | 0.0.0.0:28443 | XHTTP H2 | Direct TLS, no nginx |
| api | 127.0.0.1:10085 | dokodemo-door | Stats API |
| auth-http | 0.0.0.0:3128 | HTTP+TLS | Basic auth from secure runtime config |
| auth-socks | 212.192.31.128:1080 | SOCKS5+TLS | Password auth (same creds) |

**nginx stream SNI routing** (port 443):
```
Public 443 → nginx stream (ssl_preread):
  ya.ru   → Xray Reality on 127.0.0.1:24443
  default → nginx HTTPS on 127.0.0.1:8444 (vpn2-front)
```

**Cert permissions**: Xray runs as `nobody` (uid 65534). Requires supplementary `proxy` group to read Let's Encrypt certs.

### vusa (vusa.bezrabotnyi.com, USA)

**Role**: Remote Xray/VPN upstream, USA (Virginia)

| Property | Value |
|----------|-------|
| Public IP | 185.240.120.152 |
| DNS | vusa.bezrabotnyi.com |
| Xray | 26.6.1, 10 inbounds |

**Endpoints**:

| Tag | Address | Transport | Notes |
|-----|---------|-----------|-------|
| us-reality | 127.0.0.1:23443 | Reality (SNI=www.google.com) | nginx stream SNI → public :443 |
| us-xhttp | 127.0.0.1:20080 | XHTTP | nginx SNI → :443/xhttp |
| us-xhttp-h2-443 | 127.0.0.1:20087 | XHTTP H2 | TLS/H2 on :443/xhttp-h2-443 → nginx → HTTP/1.1 loopback |
| us-cdn | 127.0.0.1:20081 | WS | `us-cdn.demiurge.space`, DNS-only |
| us-grpc | 127.0.0.1:20082 | gRPC | nginx SNI → :443/grpc |
| us-httpupgrade | 127.0.0.1:20083 | HTTPUpgrade | nginx SNI → :443/hup |
| us-cdn2 | 127.0.0.1:20084 | WS | `us-cdn2.demiurge.space`, DNS-only |
| us-direct-ws | 127.0.0.1:20085 | WS direct | nginx SNI → :443/direct-ws |
| us-xhttp-h2 | 0.0.0.0:28443 | XHTTP H2 | Direct TLS, no nginx |
| api | 127.0.0.1:10085 | dokodemo-door | Stats API |

`us-cdn.demiurge.space` and `us-cdn2.demiurge.space` are Cloudflare
**DNS-only** records (`proxied: false`). They resolve directly to VUSA; no
Cloudflare CDN POP proxies the WebSocket traffic.

Public `:443` is owned by nginx `stream` with `ssl_preread`: Google SNI goes to
the loopback Reality listener, while `vusa.bezrabotnyi.com` goes to the TLS/path
router on `127.0.0.1:8444`. The canonical path router is stored in
`deploy/vusa/nginx/edge-https.conf` and deployed together with VUSA Xray by
`scripts/deploy-all.sh vusa`.

**Access**: SSH from server-100 (root, key-based)

**Note**: vpn3 is a separate project for whitetransport, not related to this VPN infrastructure.

### server-44 (192.168.2.5)

**Role**: sing-box HTTP/SOCKS proxy for LAN clients

| Property | Value |
|----------|-------|
| LAN MGTS | 192.168.2.5 |
| sing-box | 1.13.14 (systemd: `sing-box.service`) |
| HTTP proxy | 0.0.0.0:3128 |
| SOCKS proxy | 0.0.0.0:1080 |

Multi-outbound auto-balancer (leastPing) over endpointOrder.

### server-88 (192.168.2.75)

**Role**: Xray HTTP/SOCKS proxy for LAN clients

| Property | Value |
|----------|-------|
| LAN MGTS | 192.168.2.75 |
| Xray | 26.6.1 (systemd: `xray.service`) |
| HTTP proxy | 0.0.0.0:3128 |
| SOCKS proxy | 192.168.2.75:1080 |

### HAOS (192.168.2.101)

**Role**: Home Assistant OS, recovery HAProxy addon

| Property | Value |
|----------|-------|
| LAN | 192.168.2.101 |
| SSH | root@192.168.2.101:2228 |
| HAProxy addon | app_local_bezrabotnyi_recovery_haproxy |
| Ports | 8080, 8404 (stats), 8443 |

### OpenWrt router (192.168.2.1)

**Role**: HAProxy LAN proxy, DNS, NAT, firewall

| Property | Value |
|----------|-------|
| LAN | 192.168.2.1 |
| HAProxy | 3.0.16-r1 (mipsel) |
| HTTP proxy | :3128 |
| SOCKS proxy | :1080 |
| OpenWrt | 24.10.2 on ramips/mt7621 |

## Network Topology

```
Internet
    │
    ├── 95.165.165.65:443 → OpenWrt → server-100 HAProxy SNI:
    │       smart/full DE/US → local Xray relay ports 23444-23447
    │       default          → nginx 127.0.0.1:8444 → normal HTTPS vhosts
    ├── vpn2.bezrabotnyi.com (212.192.31.128) → nginx stream SNI :443
    │
    ├── reserve only: OpenWrt cutover → HAOS:8443 → HAProxy SNI
    │       smart/full DE/US → server-100 relay ports 23444-23447
    │       default          → server-100 HTTPS
    │
    └── LAN 192.168.2.x:
        :3128 (HTTP)  → router haproxy → server-44:3128 / server-88:3128
        :1080 (SOCKS) → router haproxy → server-44:1080  / server-88:1080
```

### Telegram without a system VPN

The intended LAN experience is that Telegram Desktop works with Bez and the
macOS system proxy disabled. Telegram connects to hard-coded DC IPs, so this
requires a router-side transparent route for the official Telegram CIDRs, not
just SmartDNS. The transparent inbound must preserve the original destination;
raw TCP must never be DNATed to the SOCKS listener on `192.168.2.1:1080`.

The coupled implementation is deployed by
`scripts/deploy-telegram-transparent-lane.sh`: it validates the generated
Xray config, backs up the server-88 config, enables its TPROXY policy, then
installs/enables the router lane and DC-failover watchdogs. Use its dry run
first; live application requires the explicit
`TELEGRAM_TPROXY_LIVE_APPROVED=1` guard. It must be deployed as one unit — the
router watchdog alone cannot restore the server-88 TPROXY policy after it has
been disabled.

`192.168.2.1:1080` remains a Telegram Desktop-only fallback during a lane
outage. It is not a reason to enable Bez or a macOS-wide proxy.

## Deploy Workflow

### deploy-all.sh

Located at `scripts/deploy-all.sh`. It remains valid only for explicit remote
VPN/backend targets; it is not the selected LAN SmartDNS/Smart Edge deploy
path.

**Usage**:
```bash
scripts/deploy-all.sh vpn2           # specific target
scripts/deploy-all.sh vusa           # USA server
scripts/deploy-all.sh server-44 server-88  # multiple targets
```

Do not run the no-argument/`all`, `smartdns`, `router-dns`, or `router` forms
for LAN migration. They still encode server-100 SmartDNS/router HAProxy and are
retired. `scripts/deploy-smartdns-unified.sh`, router-HAProxy deploy scripts,
and router-HAProxy watchdog install/deploy routes are also retired and must not
be run.

Active explicit backend targets remain `vpn2`, `vusa`, `server-44`, and
`server-88`. The selected LAN path is the unified HAOS add-on with bundled
sing-box `1.13.14` on private HTTP `127.0.0.1:13128`, SmartDNS `:53`, TCP edge
`:443`, and simple OpenWrt forwarding. It has no dependency on external
`local_singbox_proxy :3128`.
Public DoH/DoT, recovery HAProxy `:8080`/`:8443`, and Telegram IP TPROXY remain
separate and are not retired by this change.

The packaged app is released from
`https://github.com/megamen32/haos-smart-edge-addons` and pre-built as
`ghcr.io/megamen32/haos-smart-edge`. Repository slug `27579e22` is registered
in the HAOS Store. Its installed app is currently stopped; the local app stays
active on `:53`/`:443` until an explicit private-data migration and final
network canary.

### Per-Target Flow

For each target:

1. **Generate canonical config** from panel + extras
   - vpn2: `npx tsx src/cli/_gen-de-config.ts` + inject auth proxy inbounds
   - server-44 and server-88: static configs committed to repo
2. **Validate locally** (JSON syntax, sing-box check, xray run -test, haproxy -c)
3. **Backup on remote** with timestamp (`config.bak_20260624_120000`)
4. **Push via SSH** (base64 + python3 write for vpn2, SCP for others)
5. **Validate on remote** (xray run -test, sing-box check, haproxy -c)
6. **Replace + restart** (or soft-reload via USR2 for haproxy)
7. **Smoke test** (curl through the relevant proxy path)
8. **On failure**: pending file left, original config untouched, non-zero exit

### Config Sources

```
deploy/
  vpn2/xray/config.json        # generated from panel + auth proxy
  server-44/sing-box/config.json  # static (committed to repo)
  server-88/xray/config.json     # static (committed to repo)
  router/haproxy/haproxy.cfg     # retired LAN path; rollback artifact only
```

### Deploy via Panel API

```bash
# Explicit backend deploy
curl -X POST -b cookies.txt 'http://127.0.0.1:30129/api/admin/deploy/vpn2'

# Last 100 log lines
curl -b cookies.txt 'http://127.0.0.1:30129/api/admin/deploy/status'
```

## Rollback Procedures

### vpn2

```bash
# List backups
ssh root@vpn2.bezrabotnyi.com 'ls -la /usr/local/etc/xray/config.json.bak_*'

# Rollback to specific backup
ssh root@vpn2.bezrabotnyi.com 'cp /usr/local/etc/xray/config.json.bak_20260624_120000 /usr/local/etc/xray/config.json && systemctl restart xray'
```

### server-44

```bash
ssh server-44 'sudo ls -la /etc/sing-box/config.json.bak_*'
ssh server-44 'sudo cp /etc/sing-box/config.json.bak_20260624_120000 /etc/sing-box/config.json && sudo systemctl restart sing-box'
```

### server-88

```bash
ssh roomhacker-server-88 'sudo ls -la /usr/local/etc/xray/config.json.bak_*'
ssh roomhacker-server-88 'sudo cp /usr/local/etc/xray/config.json.bak_20260624_120000 /usr/local/etc/xray/config.json && sudo systemctl restart xray'
```

### router

Rollback only. Do not use the router deploy API or reload HAProxy as a forward
deployment step for the HAOS migration.

```bash
ssh root@192.168.2.1 'ls -la /etc/haproxy.cfg.bak_*'
ssh root@192.168.2.1 'cp /etc/haproxy.cfg.bak_20260624_120000 /etc/haproxy.cfg && /etc/init.d/haproxy reload'
```

## Service Management

### VPN Panel (server-100)

```bash
systemctl cat autovpnallowip.service
systemctl status autovpnallowip.service
journalctl -u autovpnallowip.service -n 100 --no-pager
curl -I http://127.0.0.1:30129
```

### Xray on vpn2

```bash
ssh root@vpn2.bezrabotnyi.com 'systemctl status xray'
ssh root@vpn2.bezrabotnyi.com 'journalctl -u xray -n 50 --no-pager'
ssh root@vpn2.bezrabotnyi.com '/usr/local/bin/xray run -test -config /usr/local/etc/xray/config.json'
```

### sing-box on server-44

```bash
ssh server-44 'sudo systemctl status sing-box'
ssh server-44 'sudo journalctl -u sing-box -n 50 --no-pager'
```

### Xray on server-88

```bash
ssh roomhacker-server-88 'sudo systemctl status xray'
ssh roomhacker-server-88 'sudo journalctl -u xray -n 50 --no-pager'
```

### HAProxy on HAOS

```bash
ssh root@192.168.2.101 -p 2228 'docker exec app_local_bezrabotnyi_recovery_haproxy haproxy -c -f /data/haproxy.cfg -f /data/router-users.cfg'
ssh root@192.168.2.101 -p 2228 'docker restart app_local_bezrabotnyi_recovery_haproxy'
ssh root@192.168.2.101 -p 2228 'docker logs --tail 100 app_local_bezrabotnyi_recovery_haproxy'
```

### HAProxy on router (retired LAN path)

Router HAProxy is rollback evidence only and must not be reloaded or extended
for the selected LAN architecture. OpenWrt keeps DHCP/DNS `192.168.2.1` and a
simple TCP/443 hairpin DNAT to HAOS. The independent HAOS recovery HAProxy on
`:8080`/`:8443` remains active and is not part of this retirement.

### rootd proxy to HAOS (on server-44)

```bash
systemctl cat rootd-homeassistant.service
systemctl restart rootd-homeassistant.service
journalctl -u rootd-homeassistant.service -n 100 --no-pager
ssh -i /home/roomhacker/.ssh/id_rsa -p 2228 root@192.168.2.101 'hostname; whoami'
```

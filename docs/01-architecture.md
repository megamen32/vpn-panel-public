# Architecture Overview

> Current routing entrypoint is the four-product regional relay described in
> `07-infrastructure-deployment.md`. Smart routes RU/private directly; Full
> proxies everything. Both DE and US products use public port 443. The
> canonical policy is server-100 primary and HAOS reserve.

## System Context

VPN Panel is a production control plane for managing a multi-server VPN infrastructure. It provides:

- **Centralized VPN client management** — create users, assign endpoints, rotate tokens
- **Per-client endpoint assignment** — each user gets specific VLESS endpoints (DE, US, RU relays)
- **Multi-format subscription delivery** — plain, v2ray, happ, sing-box, xray-json formats
- **Smart routing policies** — RU/CN/BY direct, everything else via VPN proxy
- **Remote VPS management** — push Xray configs, sync clients, monitor traffic via SSH
- **Admin web interface** — user management, endpoint assignment, health monitoring
- **Automated deployment** — push configs to vpn2 (DE), server-44, server-88, router

The system serves individual users who need VPN access to bypass geo-restrictions, with automatic routing for Russian traffic (direct) and international traffic (via VPN).

## Component Diagram

```
┌─────────────────────────────────────────────────────────────┐
│                      VPN Panel (server-100)                  │
│  ┌──────────────────────────────────────────────────────┐   │
│  │  Fastify Server (src/server.ts)                      │   │
│  │  - HTTP API on 127.0.0.1:30129                       │   │
│  │  - Admin UI on /admin                                │   │
│  │  - User UI on /login, /account                       │   │
│  │  - Subscription endpoints on /sub/:token/*           │   │
│  └──────────────────────────────────────────────────────┘   │
│                          │                                   │
│  ┌──────────────┬────────┴────────┬──────────────┐          │
│  │   Auth       │  Subscriptions  │  Repository  │          │
│  │   (auth.ts)  │  (subscriptions.ts) (repository.ts)       │
│  └──────────────┴─────────────────┴──────────────┘          │
│                          │                                   │
│  ┌──────────────────────┴───────────────────────┐           │
│  │  PostgreSQL (vpn_panel DB)                   │           │
│  │  - accounts, vpn_clients, endpoints          │           │
│  │  - sessions, subscription_tokens             │           │
│  │  - happ_hwids, happ_installs                 │           │
│  └──────────────────────────────────────────────┘           │
│                          │                                   │
│  ┌──────────────────────┴───────────────────────┐           │
│  │  Secure Config (/etc/vpn-panel/secure.json)  │           │
│  │  - VPS credentials, endpoint definitions     │           │
│  │  - Reality keys, tokens, UUIDs               │           │
│  └──────────────────────────────────────────────┘           │
└─────────────────────────────────────────────────────────────┘
                          │
                          │ SSH / API calls
                          ▼
        ┌─────────────────────────────────────────┐
        │         Remote VPS Servers              │
        │  ┌──────────────────────────────────┐   │
        │  │ vpn2 (212.192.31.128, DE)        │   │
        │  │ - Xray 26.6.1, 11 inbounds       │   │
        │  │ - Reality, XHTTP, WS, gRPC       │   │
        │  └──────────────────────────────────┘   │
        │  ┌──────────────────────────────────┐   │
        │  │ vusa (185.240.120.152, USA)      │   │
        │  │ - Xray 26.6.1, 10 inbounds       │   │
        │  │ - Reality + 7 paths on :443      │   │
        │  │ - Direct XHTTP H2 + loopback API │   │
        │  └──────────────────────────────────┘   │
        │  (vpn3 is separate whitetransport project)
        │  ┌──────────────────────────────────┐   │
        │  │ server-44 (192.168.2.5)          │   │
        │  │ - sing-box proxy (LAN clients)   │   │
        │  └──────────────────────────────────┘   │
        │  ┌──────────────────────────────────┐   │
        │  │ server-88 (192.168.2.75)         │   │
        │  │ - Xray proxy (LAN clients)       │   │
        │  └──────────────────────────────────┘   │
        └─────────────────────────────────────────┘
```

## Data Flow

### Subscription Flow

1. **Client requests subscription**: `GET /sub/:token/plain` (or other format)
2. **Token validation**: Look up `subscription_tokens` → `vpn_clients` → `accounts`
3. **Load client bundle**: Fetch assigned endpoints from `client_profiles` + `endpoints`
4. **Generate VLESS links**: For each assigned endpoint, build VLESS URL with client UUID
5. **Apply routing policy**: Attach `happ://routing/onadd/...` header with geo-routing rules
6. **Return response**: Plain text (one link per line), base64, or JSON depending on format

### Admin User Creation Flow

1. **Admin creates user**: `POST /api/admin/users` with login, displayName, password, endpointIds
2. **Database transaction**:
   - Insert into `accounts` (login, password hash, role='user')
   - Insert into `vpn_clients` (account_id, xray_uuid)
   - Insert into `subscription_tokens` (client_id, random token)
   - Insert into `client_profiles` (client_id, endpoint_id) for each assigned endpoint
3. **Return account ID**: User can now login at `/login`

### VPS Config Deploy Flow

1. **Admin triggers deploy**: `POST /api/admin/deploy/vpn2`
2. **Generate Xray config**: `deServerConfig()` builds config from panel endpoints + clients
3. **Validate config**: Run `xray run -test` on remote VPS via SSH
4. **Backup current config**: Timestamped backup on remote
5. **Push new config**: SCP or SSH cat to remote
6. **Restart Xray**: `systemctl restart xray` on remote
7. **Smoke test**: Verify Xray is running, check logs

### Endpoint Health Check Flow

1. **Hourly timer**: `scripts/auto-endpoint-check.sh` runs on server-44
2. **Test each endpoint**: Try connecting to each VLESS endpoint
3. **Post results**: `POST /api/health` with API key auth
4. **Update database**: `endpoint_health` table stores last check time + status
5. **Filter subscriptions**: Disabled endpoints excluded from non-admin user subscriptions

## Technology Stack

**Backend**:
- **Runtime**: Node.js 22+ (ESM, NodeNext module resolution)
- **Framework**: Fastify 5.x (HTTP server, routing, validation)
- **Database**: PostgreSQL 18+ (pg driver, connection pooling)
- **Language**: TypeScript 5.x (compiled to dist/ via tsc)
- **Validation**: Zod (schema validation for configs, API inputs)

**Infrastructure**:
- **Reverse proxy**: Nginx (vpn.bezrabotnyi.com → 127.0.0.1:30129)
- **VPN protocols**: Xray (VLESS+Reality, XHTTP, WS, gRPC, HTTPUpgrade)
- **Proxy protocols**: sing-box (HTTP/SOCKS), HAProxy (TCP/SNI routing)
- **SSH**: ssh2 (remote VPS management)
- **QR codes**: qrcode (subscription URL encoding)

**Deployment**:
- **Build**: `npm run build` (tsc → dist/)
- **Service**: systemd (autovpnallowip.service)
- **Deploy script**: Bash + SSH (deploy-all.sh)
- **Config validation**: Docker (xray-core:latest for routing validation)

## Deployment Topology

```
Internet
    │
    ▼
┌─────────────────────────────────────────────────────────┐
│ vpn.bezrabotnyi.com (95.165.165.65)                     │
│ Nginx on server-100 (192.168.2.100)                     │
│   ↓ proxy_pass http://127.0.0.1:30129                   │
│ VPN Panel (Node.js, systemd)                            │
│   ↓ PostgreSQL                                          │
│ vpn_panel DB (localhost:5432)                            │
└─────────────────────────────────────────────────────────┘
    │
    │ SSH (deploy, manage)
    ▼
┌─────────────────────────────────────────────────────────┐
│ vpn2.bezrabotnyi.com (212.192.31.128, DE)               │
│ Xray 26.6.1 (11 inbounds: Reality, XHTTP, WS, gRPC)    │
│   ← Nginx stream SNI routing on :443                    │
│   ← Let's Encrypt certs (/etc/letsencrypt)              │
└─────────────────────────────────────────────────────────┘
    │
    │ SSH
    ▼
┌─────────────────────────────────────────────────────────┐
│ vusa.bezrabotnyi.com (185.240.120.152, USA)             │
│ Xray 26.6.1 (10 inbounds: Reality, XHTTP, WS, gRPC)    │
│   ← Nginx stream SNI routing on :443                    │
│   ← Let's Encrypt certs (/etc/letsencrypt)              │
└─────────────────────────────────────────────────────────┘
    │
    │ LAN (192.168.2.x)
    ▼
┌─────────────────────────────────────────────────────────┐
│ server-44 (192.168.2.5)                                 │
│ sing-box (HTTP proxy :3128, SOCKS :1080)                │
│   ← Multi-outbound auto-balancer (leastPing)            │
└─────────────────────────────────────────────────────────┘
    │
    │ LAN
    ▼
┌─────────────────────────────────────────────────────────┐
│ server-88 (192.168.2.75)                                │
│ Xray (HTTP proxy :3128, SOCKS :1080)                    │
│   ← Multi-outbound auto-balancer                        │
└─────────────────────────────────────────────────────────┘
    │
    │ LAN
    ▼
┌─────────────────────────────────────────────────────────┐
│ HAOS (192.168.2.101)                                    │
│ HAProxy addon (recovery, SNI routing)                   │
│   ← Port 8443 → SNI routing to vpn2/server-100          │
└─────────────────────────────────────────────────────────┘
    │
    │ LAN
    ▼
┌─────────────────────────────────────────────────────────┐
│ OpenWrt router (192.168.2.1)                            │
│ HAProxy (LAN proxy :3128 HTTP, :1080 SOCKS)             │
│   ← DNS, NAT, firewall                                  │
└─────────────────────────────────────────────────────────┘
```

## Key Design Decisions

1. **Single source of truth**: All backend configs (vpn2, server-44, server-88, router) stored in `deploy/` on server-100. Deploy script pushes to remotes.

2. **Per-client endpoint assignment**: Each user gets specific endpoints (M:N via `client_profiles`). Admin controls which endpoints each user can access.

3. **Token-based subscriptions**: Each client has a random token for subscription access. Tokens can be rotated without changing the client UUID.

4. **Secure config separation**: Sensitive data (UUIDs, tokens, Reality keys, VPS credentials) in `/etc/vpn-panel/secure.json`, never in git.

5. **Multi-format subscriptions**: Same client data served in multiple formats (plain, v2ray, happ, sing-box, xray-json) for different client apps.

6. **Geo-routing at subscription level**: `happRoutingLink()` embeds routing policy into Happ subscription. RU/CN/BY direct, everything else via VPN.

7. **Automated health checks**: Hourly endpoint checks from server-44. Broken endpoints auto-disabled for non-admin users.

8. **SSH-based VPS management**: Panel connects to remote VPS via SSH to push configs, sync clients, monitor traffic. No agent on remotes.

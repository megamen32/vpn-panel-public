# Subscription & Routing

## Subscription Flow

### From Token to VLESS Link Generation

1. **Client requests subscription**: `GET /sub/:token/plain` (or other format)
2. **Token validation**: 
   - Look up token in `subscription_tokens` table
   - Check `enabled = true`
   - Update `last_used_at` timestamp
3. **Load client bundle**: 
   - Fetch `vpn_clients` by token's `client_id`
   - Fetch `accounts` by client's `account_id`
   - Fetch assigned endpoints via `client_profiles` + `endpoints`
4. **Generate VLESS links**: 
   - For each assigned endpoint, call `vlessLink(endpoint, uuid, secure)`
   - Build VLESS URL with client UUID and endpoint config
5. **Apply routing policy**: 
   - Call `happRoutingLink()` to generate routing link
   - Attach as `routing` header
6. **Return response**: 
   - Plain text (one link per line) for `/plain`
   - Base64-encoded for `/v2ray`
   - JSON for `/sing-box` and `/xray-json`
   - Routing link + plain for `/happ`

### Client Bundle Structure

```typescript
type ClientBundle = {
  accountId: string;
  clientId: string;
  displayName: string;
  login: string;
  xrayUuid: string;
  token: string;
  endpoints: Endpoint[];  // Assigned endpoints only
};
```

Created by `bundleByToken()` or `bundleByAccount()` in `subscriptions.ts`.

## Endpoint Types

### VLESS+Reality

The primary endpoint type. Uses TCP with Reality TLS.

**VLESS URL format**:
```
vless://uuid@address:port?flow=xtls-rprx-vision&security=reality&encryption=none&type=tcp&sni=ya.ru&sid=shortid&fp=chrome&pbk=publickey&headerType=none#label
```

**Parameters**:
- `flow`: VLESS flow (default: `xtls-rprx-vision`)
- `security`: Always `reality`
- `encryption`: Always `none`
- `type`: Always `tcp`
- `sni`: SNI for Reality (default: `ya.ru`)
- `sid`: Reality short ID
- `fp`: TLS fingerprint (default: `chrome`)
- `pbk`: Reality public key
- `headerType`: Always `none`

**Endpoint config** (from secure.json):
```json
{
  "id": "de-reality",
  "kind": "vless-reality",
  "address": "vpn2.bezrabotnyi.com",
  "port": 443,
  "public_key": "...",
  "short_id": "...",
  "sni": "ya.ru",
  "fingerprint": "chrome",
  "flow": "xtls-rprx-vision"
}
```

### VLESS+WebSocket

Uses WebSocket transport over TLS.

**VLESS URL format**:
```
vless://uuid@address:port?encryption=none&type=ws&security=tls&sni=vpn2.bezrabotnyi.com&path=%2Fws&fp=chrome#label
```

**Parameters**:
- `type`: `ws`
- `security`: `tls`
- `sni`: SNI for TLS
- `path`: WebSocket path (URL-encoded)
- `fp`: TLS fingerprint

**Endpoint config** (from secure.json):
```json
{
  "id": "de-direct-ws",
  "kind": "vless-ws",
  "address": "vpn2.bezrabotnyi.com",
  "port": 443,
  "query": {
    "type": "ws",
    "path": "/direct-ws",
    "sni": "vpn2.bezrabotnyi.com",
    "fp": "chrome"
  }
}
```

### VLESS+HTTPUpgrade

Uses HTTPUpgrade transport (deprecated in Xray 26.5.9).

**VLESS URL format**:
```
vless://uuid@address:port?encryption=none&type=httpupgrade&security=tls&sni=vpn2.bezrabotnyi.com&path=%2Fhup&fp=chrome#label
```

**Parameters**:
- `type`: `httpupgrade`
- `security`: `tls`
- `sni`: SNI for TLS
- `path`: HTTPUpgrade path

**Note**: HTTPUpgrade is deprecated. Prefer WebSocket or XHTTP.

### VLESS+XHTTP

Uses XHTTP transport (HTTP/2 stream-up).

**VLESS URL format**:
```
vless://uuid@address:port?encryption=none&type=xhttp&security=tls&sni=vpn2.bezrabotnyi.com&path=%2Fxhttp&mode=stream-up&fp=chrome#label
```

**Parameters**:
- `type`: `xhttp`
- `security`: `tls`
- `sni`: SNI for TLS
- `path`: XHTTP path
- `mode`: XHTTP mode (`stream-up`, `auto`, etc.)

**Endpoint config** (from secure.json):
```json
{
  "id": "de-xhttp",
  "kind": "vless-ws",
  "address": "vpn2.bezrabotnyi.com",
  "port": 443,
  "query": {
    "type": "xhttp",
    "path": "/xhttp",
    "mode": "stream-up",
    "sni": "vpn2.bezrabotnyi.com",
    "fp": "chrome"
  }
}
```

### VLESS+gRPC

Uses gRPC transport (deprecated in Xray 26.5.9).

**VLESS URL format**:
```
vless://uuid@address:port?encryption=none&type=grpc&security=tls&sni=vpn2.bezrabotnyi.com&serviceName=grpc&fp=chrome#label
```

**Parameters**:
- `type`: `grpc`
- `security`: `tls`
- `sni`: SNI for TLS
- `serviceName`: gRPC service name

**Note**: gRPC is deprecated. Prefer WebSocket or XHTTP.

## Routing Policy

### happRoutingLink() Logic

Located in `src/subscriptions.ts`. Generates a Happ routing link with geo-routing policy.

**Routing configuration**:
```json
{
  "Name": "Relay-managed routing",
  "GlobalProxy": "false",
  "RemoteDNSType": "DoH",
  "RemoteDNSDomain": "https://dns.google/dns-query",
  "RemoteDNSIP": "8.8.8.8",
  "DomesticDNSType": "DoU",
  "DomesticDNSDomain": "77.88.8.8",
  "DomesticDNSIP": "77.88.8.8",
  "Geoipurl": "https://github.com/golukon/russia-only-geoip/releases/latest/download/geoip.dat",
  "Geositeurl": "https://github.com/golukon/russia-only-geosite/releases/latest/download/geosite.dat",
  "LastUpdated": "",
  "DnsHosts": {
    "dns.google": "8.8.8.8",
    "cloudflare-dns.com": "1.1.1.1"
  },
  "DirectSites": ["vpn.bezrabotnyi.com", "geosite:ru-inside"],
  "DirectIp": ["geoip:private", "geoip:ru"],
  "ProxySites": ["openai.com", "chatgpt.com", "oaistatic.com", "oaiusercontent.com", "oaistatsig.com", "openaimerge.com", "workos.com", "workoscdn.com", "telegram.org", "telegram.me", "t.me", "tdesktop.com", "telesco.pe", "telegra.ph", "whatsapp.com", "whatsapp.net", "wa.me"],
  "ProxyIp": ["91.108.56.0/22", "91.108.4.0/22", "91.108.8.0/22", "91.108.16.0/22", "91.108.12.0/22", "91.108.20.0/22", "91.105.192.0/23", "149.154.160.0/20", "185.76.151.0/24", "2001:67c:4e8::/48", "2001:b28:f23c::/48", "2001:b28:f23d::/48", "2001:b28:f23f::/48", "2a0a:f280::/32"],
  "BlockSites": [],
  "BlockIp": [],
  "DomainStrategy": "IPIfNonMatch",
  "FakeDNS": "false"
}
```

**Policy** (2026-08-16, mirrors the local SmartDNS profile):
- The default route is direct (`GlobalProxy: "false"`). The VPN carries only
  three families: OpenAI, Telegram, and WhatsApp (see `HAPP_PROXY_SITES` in
  `src/subscriptions.ts`).
- Russian destinations are strictly direct: `geosite:ru-inside` and
  `geoip:ru` are pinned into the direct rules so no proxy rule can capture
  them.
- Telegram apps connect to hardcoded DC IPs, so `ProxyIp` carries the
  official Telegram CIDR list (`core.telegram.org/resources/cidr.txt`). The
  compact geo DB has no telegram category — keep these as literal CIDRs.
- Smart/Full regional relays now differ only in exit region for the proxied
  families. The server-side smart-relay RU-direct rules remain as a harmless
  second line of defense.

**DNS**:
- Remote (proxy): DoH via dns.google
- Domestic (direct): DoU via 77.88.8.8 (Yandex)

**Compact Geo DB**: `golukon/russia-only-geoip` and
`golukon/russia-only-geosite`. Their daily release artifacts contain only
private/Russian IP ranges and the `ru-inside` domain tag. Validate and deploy
them together with the generated relay config via
`scripts/deploy-compact-xray-geo.sh --dry-run` and then the same command without
`--dry-run`. The coupled deployment prevents a new `geosite:ru-inside` config
from being paired with an old database (or vice versa).

**Important**: `vpn.bezrabotnyi.com` is in DirectSites (not bare `bezrabotnyi.com`) to avoid matching `vpn2.bezrabotnyi.com` and `vusa.bezrabotnyi.com` (the actual VPN endpoints).

### RU Relay Multi-Fingerprint Outbounds

The RU relay (`server-100`) generates multiple Reality outbounds with different TLS fingerprints so the `world-auto` balancer can probe and select the best one per client/network.

**Generated Reality outbound tags** (in `deMultiOutbounds()`):

| Tag | Fingerprint |
|-----|-------------|
| `to-de-reality-chrome` | `chrome` |
| `to-de-reality-firefox` | `firefox` |
| `to-de-reality-safari` | `safari` |
| `to-de-reality-ios` | `ios` |
| `to-de-reality-randomized` | `randomized` |

All five outbounds target the same DE Reality endpoint (same address, port, public key, short ID) — only the `realitySettings.fingerprint` field differs. The observatory probes each independently, and the `leastPing` balancer selects the best.

Non-Reality transports (`to-de-xhttp`, `to-de-httpupgrade`, `to-de-grpc`, `to-de-ws`) use the default fingerprint from `secure.json` and are not duplicated.

**Implementation**: `deOutboundBase()` accepts an optional `fingerprintOverride` parameter. `deMultiOutbounds()` iterates `REALITY_FINGERPRINTS` and passes each fingerprint as the override for Reality transport.

### Endpoint Strategy & Auto-Fallback

#### Default Endpoint Accessibility

Users choose a routing contract and exit region, never a transport:

- **Smart DE / Smart US**: private and Russian traffic is direct; all other traffic uses a healthy route in the named region.
- **Full DE / Full US**: all traffic uses a healthy route in the named region.
- A regional relay must become unhealthy when that region has no working transport. It must not change the promised exit country.

Client routing is selective like SmartDNS (see `happRoutingLink()`): only the
OpenAI, Telegram, and WhatsApp families reach a relay, and Russian traffic is
pinned direct client-side. The `xrayClientSubscription()` diagnostic config
stays full-tunnel with only a private/LAN bypass — `scripts/auto-endpoint-check.sh`
depends on that to test each endpoint with real traffic.

#### Endpoint Priority Order

Defined in `src/secure-config.ts` `endpointOrder`:

```typescript
const endpointOrder = [
  'smart-de-relay',
  'full-de-relay',
  'smart-us-relay',
  'full-us-relay'
];
```

Reality, XHTTP and WS variants remain visible in admin health diagnostics only.
Deprecated gRPC/HTTPUpgrade and duplicate WS routes must not be assigned as
ordinary user choices. High ports may remain available for diagnosis, while the
public relay contract and its health result stay transport-independent.

#### Auto-Balancer Fallback Logic

**LAN proxies (server-44, server-88)** use multi-outbound auto-balancers with **leastPing** strategy:

**server-44 (sing-box)**:
```json
{
  "type": "selector",
  "tag": "proxy",
  "outbounds": [
    "de-reality",
    "de-direct-ws",
    "de-httpupgrade",
    "de-grpc",
    "de-cdn"
  ],
  "default": "de-reality"
}
```

**server-88 (Xray)**:
```json
{
  "balancers": [
    {
      "tag": "proxy",
      "selector": [
        "de-xhttp-h2",
        "de-xhttp",
        "de-direct-ws",
        "de-grpc",
        "de-httpupgrade",
        "de-cdn",
        "de-reality"
      ],
      "strategy": {"type": "leastPing"}
    }
  ]
}
```

**How it works**:

1. **Health monitoring**: Xray observatory probes each endpoint every 30s with `https://www.gstatic.com/generate_204`
2. **Ping measurement**: Each outbound tracks latency (ping) to its destination
3. **Automatic selection**: Balancer selects the outbound with lowest ping
4. **Failover**: If an endpoint becomes unreachable (high ping or timeout), balancer automatically switches to next best
5. **No manual intervention**: Clients automatically use the best available endpoint

**Example scenario**:
- Client connects from network that blocks high ports (28443)
- `de-xhttp-h2` ping increases or times out
- Balancer automatically switches to `de-xhttp` (port 443 via nginx)
- If port 443 XHTTP also fails, falls back to `de-direct-ws` (WebSocket on 443)
- Continues down the list until a working endpoint is found

**Key benefit**: Clients don't need manual configuration changes. The auto-balancer handles network restrictions transparently.

### Happ Routing Link Format

```
happ://routing/onadd/<base64-json>
```

The routing JSON is base64-encoded and appended to the `happ://routing/onadd/` scheme. Happ clients parse this link and import the routing policy.

## Xray Server Configs

### serverConfig()

Located in `src/xray-configs.ts`. Generates Xray server config for RU relays.

**Structure**:
```json
{
  "log": { "loglevel": "info" },
  "inbounds": [ ... ],
  "outbounds": [
    {
      "protocol": "freedom",
      "tag": "direct"
    },
    {
      "protocol": "vless",
      "tag": "vpn2_xray",
      "settings": {
        "vnext": [
          {
            "address": "vpn2.bezrabotnyi.com",
            "port": 443,
            "users": [ ... ]
          }
        ]
      },
      "streamSettings": { ... }
    }
  ],
  "routing": {
    "rules": [
      {
        "type": "field",
        "ip": ["geoip:private", "geoip:ru"],
        "outboundTag": "direct"
      },
      {
        "type": "field",
        "domain": ["geosite:ru-inside"],
        "outboundTag": "direct"
      }
    ],
    "domainStrategy": "IPIfNonMatch"
  }
}
```

**Logic**:
1. Add `freedom` outbound for direct traffic
2. Add `vless` outbound to vpn2 for proxy traffic
3. Add routing rules (RU direct, everything else via vpn2)
4. Add inbounds (SOCKS, HTTP proxy)

### deServerConfig()

Generates Xray server config for vpn2 (DE).

**Structure**:
```json
{
  "log": { "loglevel": "info" },
  "inbounds": [
    {
      "protocol": "vless",
      "port": 23443,
      "tag": "de-reality",
      "settings": {
        "clients": [ ... ],
        "decryption": "none"
      },
      "streamSettings": {
        "network": "tcp",
        "security": "reality",
        "realitySettings": {
          "dest": "ya.ru:443",
          "serverNames": ["ya.ru"],
          "privateKey": "...",
          "shortIds": ["..."]
        }
      }
    },
    {
      "protocol": "vless",
      "port": 20080,
      "tag": "de-xhttp",
      "settings": {
        "clients": [ ... ]
      },
      "streamSettings": {
        "network": "xhttp",
        "security": "none",
        "xhttpSettings": {
          "path": "/xhttp",
          "mode": "stream-up"
        }
      }
    }
    // ... more inbounds
  ],
  "outbounds": [
    {
      "protocol": "freedom",
      "tag": "direct"
    }
  ],
  "routing": {
    "rules": [],
    "domainStrategy": "AsIs"
  }
}
```

**Logic**:
1. Add inbound for each endpoint type (Reality, XHTTP, WS, gRPC, HTTPUpgrade)
2. Each inbound has its own port and tag
3. Add all clients to each inbound
4. Add `freedom` outbound for direct traffic
5. No routing (all traffic goes direct from vpn2)

### clientsForEndpoint()

Generates client list for a specific endpoint.

**Logic**:
1. Fetch all clients from database
2. Filter by assigned endpoints (via `client_profiles`)
3. Return array of `{ uuid, email }` objects

**Used by**: `deServerConfig()` to populate inbound clients.

## Happ Integration

### happ-api.ts

Located in `src/happ-api.ts`. Client for Happ proxy API.

**Base URL**: `https://happ-proxy.com` (from `secure.happ.base_url`)

**Authentication**:
- `provider_code`: Happ provider code (from `secure.happ.provider_code`)
- `auth_key`: Happ API auth key (from `secure.happ.auth_key`)

### API Methods

#### happListHwids(installCode)

Lists hardware IDs for a Happ install.

**Request**:
```
GET /api/v1/provider/hwids/list?provider_code=...&auth_key=...&install_code=...
```

**Response**:
```json
{
  "data": [
    {
      "hwid": "...",
      "device_name": "...",
      "device_model": "...",
      "os_version": "...",
      "app_version": "...",
      "created_at": "...",
      "last_seen_at": "..."
    }
  ]
}
```

#### happDeleteHwid(installCode, hwid)

Deletes a hardware ID.

**Request**:
```
POST /api/v1/provider/hwids/delete
Content-Type: application/x-www-form-urlencoded

provider_code=...&auth_key=...&install_code=...&hwid=...
```

**Response**:
```json
{ "success": true }
```

#### happAddInstall(providerCode, authKey, note)

Creates a new Happ install.

**Request**:
```
POST /api/v1/provider/installs/add
Content-Type: application/x-www-form-urlencoded

provider_code=...&auth_key=...&note=...
```

**Response**:
```json
{
  "data": {
    "install_code": "...",
    "install_id": 123
  }
}
```

#### happUpdateInstall(installCode, settings)

Updates Happ install settings.

**Request**:
```
POST /api/v1/provider/installs/update
Content-Type: application/x-www-form-urlencoded

provider_code=...&auth_key=...&install_code=...&settings=...
```

**Response**:
```json
{ "success": true }
```

#### happSendCommand(installCode, command)

Sends a command to Happ install.

**Request**:
```
POST /api/v1/provider/commands/send
Content-Type: application/x-www-form-urlencoded

provider_code=...&auth_key=...&install_code=...&command=...
```

**Response**:
```json
{ "success": true }
```

#### happInstallDeeplink(installCode)

Generates Happ install deeplink.

**Format**:
```
happ://install/<install_code>
```

### HWID Tracking

The panel tracks Happ HWIDs in the `happ_hwids` table:

```typescript
type HappHwid = {
  id: string;
  account_id: string;
  install_code: string;
  hwid: string;
  device_name: string | null;
  device_model: string | null;
  os_version: string | null;
  app_version: string | null;
  recorded_at: Date;
  last_seen_at: Date;
};
```

**Sync flow**:
1. Admin triggers sync: `POST /api/admin/happ-sync/:accountId`
2. Panel calls `happListHwids(installCode)`
3. Panel upserts HWIDs into `happ_hwids` table
4. Returns list of HWIDs

**Capture flow**:
1. Client requests subscription: `GET /sub/:token/plain`
2. Panel extracts HWID from User-Agent or custom header
3. Panel calls `captureHwidFromSubscription(accountId, hwid, deviceInfo)`
4. HWID is upserted into `happ_hwids` table

**Delete flow**:
1. Admin triggers delete: `DELETE /api/admin/happ-hwids/:hwidId`
2. Panel deletes from `happ_hwids` table
3. Panel calls `happDeleteHwid(installCode, hwid)`
4. Returns success

### Install Tracking

The panel tracks Happ installs in the `happ_installs` table:

```typescript
type HappInstall = {
  account_id: string;
  install_code: string;
  install_id: number | null;
  install_limit: number;
  status: number;
  note: string | null;
  happ_settings: Record<string, unknown>;
  created_at: Date;
  updated_at: Date;
};
```

**Create flow**:
1. Admin triggers create: `POST /api/admin/happ-install/:accountId`
2. Panel calls `happAddInstall(providerCode, authKey, note)`
3. Panel upserts into `happ_installs` table
4. Returns install code

**Update flow**:
1. Admin triggers update: `PUT /api/admin/happ-install/:accountId`
2. Panel calls `happUpdateInstall(installCode, settings)`
3. Panel updates `happ_installs` table
4. Returns success

**Status update flow**:
1. Panel receives status update from Happ API
2. Panel calls `updateHappInstallStatus(accountId, status)`
3. Panel updates `happ_installs.status` field

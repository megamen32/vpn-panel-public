# Configuration Management

## Configuration Sources

VPN Panel uses a layered configuration system with the following precedence (highest to lowest):

1. **Environment variables** — runtime overrides
2. **`/etc/vpn-panel/secure.json`** — sensitive config (endpoints, VPS creds, tokens)
3. **Default values** — hardcoded fallbacks

Environment variables are loaded from the shell environment (systemd unit or `.env` file for development). The `secure.json` file is loaded at startup and validated with Zod.

## Configuration Loading

### App Config (`loadAppConfig()`)

Located in `src/config.ts`. Loads non-sensitive runtime configuration from environment variables.

```typescript
type AppConfig = {
  databaseUrl: string;        // DATABASE_URL (required)
  host: string;               // HOST (default: "127.0.0.1")
  port: number;               // PORT (default: 3129)
  sessionSecret: string;      // VPN_PANEL_SESSION_SECRET or VPN_PANEL_SECRET (auto-generated if missing)
  adminLogin: string;         // VPN_PANEL_ADMIN_LOGIN (default: "admin")
  adminPassword?: string;     // VPN_PANEL_ADMIN_PASSWORD or VPN_PANEL_PASSWORD
  secureConfigPath: string;   // VPN_PANEL_SECURE_CONFIG or VPN_PANEL_CONFIG (default: "/etc/vpn-panel/secure.json")
  publicBaseUrl: string;      // VPN_PANEL_PUBLIC_BASE_URL (default: "https://vpn.bezrabotnyi.com")
  healthApiKey: string;       // VPN_PANEL_HEALTH_API_KEY (for script-based health posting)
};
```

**Required environment variables**:
- `DATABASE_URL` — PostgreSQL connection string. Throws if missing.

**Optional environment variables**:
- `HOST` — Listen address (default: 127.0.0.1)
- `PORT` — Listen port (default: 3129)
- `VPN_PANEL_SESSION_SECRET` — Session cookie signing key. If missing, generates random 32-byte hex on each startup (sessions invalidated on restart).
- `VPN_PANEL_ADMIN_LOGIN` — Admin username (default: admin)
- `VPN_PANEL_ADMIN_PASSWORD` — Admin password (used in `bootstrapAdmin()` to create/update admin account)
- `VPN_PANEL_SECURE_CONFIG` — Path to secure.json (default: /etc/vpn-panel/secure.json)
- `VPN_PANEL_PUBLIC_BASE_URL` — Public URL for subscription links (default: https://vpn.bezrabotnyi.com)
- `VPN_PANEL_HEALTH_API_KEY` — Bearer token for health API (used by auto-endpoint-check.sh)

### Secure Config (`loadSecureConfig()`)

Located in `src/secure-config.ts`. Loads sensitive configuration from `/etc/vpn-panel/secure.json`.

```typescript
type SecureConfig = {
  defaults: {
    fingerprint: string;  // TLS fingerprint (default: "chrome")
    flow: string;         // VLESS flow (default: "xtls-rprx-vision")
    sni: string;          // SNI for Reality/TLS (default: "ya.ru")
    domain_strategy: string; // DNS strategy (default: "IPIfNonMatch")
  };
  nodes: SecureNode[];    // Endpoint definitions
  server_configs: Record<string, Record<string, unknown>>; // Per-server Xray configs
  happ: {
    provider_code: string; // Happ provider code (default: "IDdS75kg")
    auth_key: string;      // Happ API auth key
    base_url: string;      // Happ API base URL (default: "https://happ-proxy.com")
  };
  vps: VpsConnectionConfig;       // Legacy single VPS (auto-migrated to vps_list)
  vps_list: VpsConnectionConfig[]; // Multi-VPS support
};

type SecureNode = {
  id: string;              // Endpoint ID (e.g., "de-xhttp")
  label: string;           // Human-readable label
  enabled: boolean;        // Whether endpoint is active (default: true)
  kind: string;            // "vless-reality", "vless-ws", etc. (default: "vless-reality")
  address: string;         // Server address
  port: number;            // Port number
  public_key?: string;     // Reality public key
  short_id?: string;       // Reality short ID
  profiles?: string[];     // Profile tags
  flow?: string;           // VLESS flow override
  sni?: string;            // SNI override
  fingerprint?: string;    // Fingerprint override
  query?: Record<string, string>; // Transport-specific query params (for WS, HTTPUpgrade, etc.)
};

type VpsConnectionConfig = {
  id: string;              // VPS ID (e.g., "vpn2-bezrabotnyi-com")
  host: string;            // SSH host
  port: number;            // SSH port (default: 22)
  username: string;        // SSH username (default: "root")
  password?: string;       // SSH password (optional)
  private_key?: string;    // SSH private key (optional)
  passphrase?: string;     // SSH key passphrase (optional)
  label: string;           // Human-readable label
};
```

**Validation**: Zod schema validates the JSON structure. Missing required fields throw at startup.

**Auto-migration**: If `vps_list` is empty but legacy `vps` object has a host, the panel auto-migrates it to `vps_list[0]` and saves back to `secure.json`.

## secure.json Schema

Example structure (sensitive values redacted):

```json
{
  "defaults": {
    "fingerprint": "chrome",
    "flow": "xtls-rprx-vision",
    "sni": "ya.ru",
    "domain_strategy": "IPIfNonMatch"
  },
  "nodes": [
    {
      "id": "de-reality",
      "label": "DE Reality",
      "kind": "vless-reality",
      "address": "vpn2.bezrabotnyi.com",
      "port": 443,
      "public_key": "...",
      "short_id": "...",
      "enabled": true
    },
    {
      "id": "de-xhttp",
      "label": "DE XHTTP",
      "kind": "vless-ws",
      "address": "vpn2.bezrabotnyi.com",
      "port": 443,
      "query": {
        "type": "ws",
        "path": "/xhttp",
        "sni": "vpn2.bezrabotnyi.com"
      },
      "enabled": true
    }
  ],
  "server_configs": {
    "vpn2-bezrabotnyi-com": {
      "reality_key": "...",
      "reality_short_id": "..."
    }
  },
  "happ": {
    "provider_code": "IDdS75kg",
    "auth_key": "...",
    "base_url": "https://happ-proxy.com"
  },
  "vps_list": [
    {
      "id": "vpn2-bezrabotnyi-com",
      "host": "vpn2.bezrabotnyi.com",
      "port": 22,
      "username": "root",
      "private_key": "...",
      "label": "DE VPN Server"
    },
    {
      "id": "185-240-120-152",
      "host": "185.240.120.152",
      "port": 22,
      "username": "root",
      "private_key": "...",
      "label": "USA VPN Server"
    }
  ]
}
```

## Environment Variables

### Required

| Variable | Purpose | Example |
|----------|---------|---------|
| `DATABASE_URL` | PostgreSQL connection string | `postgres://user:pass@localhost:5432/vpn_panel` |

### Optional

| Variable | Purpose | Default |
|----------|---------|---------|
| `HOST` | Listen address | `127.0.0.1` |
| `PORT` | Listen port | `3129` |
| `VPN_PANEL_SESSION_SECRET` | Session cookie signing key | Random 32-byte hex |
| `VPN_PANEL_ADMIN_LOGIN` | Admin username | `admin` |
| `VPN_PANEL_ADMIN_PASSWORD` | Admin password (for bootstrap) | (none) |
| `VPN_PANEL_SECURE_CONFIG` | Path to secure.json | `/etc/vpn-panel/secure.json` |
| `VPN_PANEL_PUBLIC_BASE_URL` | Public URL | `https://vpn.bezrabotnyi.com` |
| `VPN_PANEL_HEALTH_API_KEY` | Bearer token for health API | (none) |

## Runtime Config Loading

### Startup Sequence

1. **Load app config**: `loadAppConfig()` reads environment variables
2. **Create DB pool**: `createPool(config)` connects to PostgreSQL
3. **Load secure config**: `loadSecureConfig(path)` reads and validates `/etc/vpn-panel/secure.json`
4. **Run migrations**: `runMigrations(pool)` applies pending schema migrations
5. **Bootstrap admin**: `bootstrapAdmin(pool, config)` creates/updates admin account
6. **Sync endpoints**: `syncCatalogFromSecureConfig(pool, secure)` syncs `nodes` from secure.json to `endpoints` table
7. **Start server**: Fastify listens on `config.host:config.port`

### When Config is Loaded

- **App config**: Once at startup. Changes require restart.
- **Secure config**: Once at startup. Changes require restart. (Exception: VPS CRUD operations write back to secure.json immediately.)

### Config Reload

There is no hot-reload. To apply config changes:

```bash
# Edit config
sudo nano /etc/vpn-panel/secure.json

# Restart service
sudo systemctl restart autovpnallowip.service

# Check logs
sudo journalctl -u autovpnallowip.service -n 50 --no-pager
```

## Sensitive Data Handling

### What Never Goes to Git

- `/etc/vpn-panel/secure.json` — UUIDs, tokens, Reality keys, VPS credentials
- `.env` — Environment variables (DATABASE_URL, secrets)
- `*.bak_*` — Local backup files (gitignored)
- `logs/` — Runtime logs (may contain sensitive data)
- `dist/` — Compiled JavaScript (not tracked)

### File Permissions

```bash
# secure.json should be readable only by vpn-panel user
sudo chown roomhacker:roomhacker /etc/vpn-panel/secure.json
sudo chmod 600 /etc/vpn-panel/secure.json

# .env should be readable only by developer
chmod 600 .env
```

### How Secrets are Stored

- **UUIDs**: Generated with `crypto.randomUUID()`, stored in secure.json
- **Tokens**: Generated with `randomToken()`, stored in DB (`subscription_tokens`)
- **Reality keys**: Generated by Xray, stored in secure.json `server_configs`
- **VPS credentials**: SSH keys/passwords stored in secure.json `vps_list`
- **Passwords**: Hashed with bcrypt, stored in DB (`accounts.password_hash`)

### How Secrets are Loaded

- **secure.json**: Read once at startup via `loadSecureConfig()`
- **Environment variables**: Read once at startup via `loadAppConfig()`
- **Database secrets**: Accessed via `repository.ts` functions (never exposed to HTTP responses)

### Security Practices

1. **Timing-safe comparison**: Health API key comparison uses `crypto.timingSafeEqual()` to prevent timing attacks
2. **Session cookie flags**: `httpOnly`, `sameSite: "strict"`, `secure: true`
3. **Password hashing**: bcrypt with automatic salt
4. **No secrets in logs**: Fastify logger does not log request bodies or sensitive headers
5. **No secrets in URLs**: Tokens are in path (`/sub/:token/plain`), not query params (avoiding referrer leaks)

## Endpoint Order

The `endpointOrder` array in `secure-config.ts` is the complete user-facing product catalog:

```typescript
export const endpointOrder = [
  "smart-de-relay", // RU/private direct; World via healthy DE route
  "full-de-relay",  // all traffic via healthy DE route
  "smart-us-relay", // RU/private direct; World via healthy US route
  "full-us-relay",  // all traffic via healthy US route
];
```

Transport IDs such as `de-xhttp`, `de-direct-ws`, `de-grpc`,
`us-xhttp-h2-443`, and `us-xhttp-h2` live in `diagnosticEndpointOrder`. They are not products. The
historical direct routes are appended to normal links and JSON subscriptions as
compatibility fallbacks. VUSA mirrors VPN2 with Reality, XHTTP, HTTPUpgrade,
direct WS, gRPC, two DNS-only hostnames, and a dedicated XHTTP H2 path on public
`:443`, plus direct XHTTP H2 on `:28443`. DNS-only means Cloudflare only serves
the A records: the TLS traffic goes directly to VUSA, not through a Cloudflare
CDN edge. Every VUSA inbound receives the same active client UUID
set; the regional US relay selects among these paths with `leastPing`. The
disabled `de-cdn-xhttp` route is no longer catalogued.

Migration requirement: deploy and sync all four relay nodes, then migrate
`client_profiles` from legacy `ru-smart-relay`, `ru-full-relay`, and
`us-full-relay` assignments before releasing this catalog. A missing canonical
node is reported as `not assigned`; it does not silently fall back to a route in
another region.

## Configuration Sync

### secure.json → Database

On startup, `syncCatalogFromSecureConfig()` syncs endpoint definitions from secure.json to the `endpoints` table:

```typescript
async function syncCatalogFromSecureConfig(pool: DbPool, secure: SecureConfig): Promise<void> {
  for (const node of secure.nodes) {
    await pool.query(
      `insert into endpoints (id, label, kind, address, port, profile_id, enabled, config)
       values ($1, $2, $3, $4, $5, $6, $7, $8)
       on conflict (id) do update set
         label = excluded.label,
         kind = excluded.kind,
         address = excluded.address,
         port = excluded.port,
         profile_id = excluded.profile_id,
         enabled = excluded.enabled,
         config = excluded.config`,
      [node.id, node.label, node.kind, node.address, node.port, endpointProfile(node), node.enabled, JSON.stringify(node)]
    );
  }
}
```

This ensures the database always reflects the current secure.json configuration.

### Database → secure.json

VPS CRUD operations (admin API) write back to secure.json immediately:

```typescript
// Add VPS
secure.vps_list.push(newVps);
await saveSecureConfig(secure, secureConfigPath);

// Remove VPS
secure.vps_list = secure.vps_list.filter(v => v.id !== vpsId);
await saveSecureConfig(secure, secureConfigPath);
```

This keeps secure.json as the single source of truth for VPS configuration.

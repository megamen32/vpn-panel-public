# Core Modules

> The canonical relay generator is `regionalRelayServerConfig()` and the only
> user-facing endpoint IDs are `smart-de-relay`, `full-de-relay`,
> `smart-us-relay`, and `full-us-relay`.

## Module Map

| Module | Purpose |
|--------|---------|
| `server.ts` | Fastify HTTP server, all route handlers, startup logic |
| `config.ts` | Load app config from environment variables |
| `secure-config.ts` | Load and validate `/etc/vpn-panel/secure.json` (endpoints, VPS creds, tokens) |
| `db.ts` | PostgreSQL connection pool setup |
| `repository.ts` | Database queries: users, endpoints, clients, tokens, HWIDs, health |
| `auth.ts` | Session-based authentication, login/logout, role checks |
| `passwords.ts` | Password hashing and verification (bcrypt) |
| `tokens.ts` | Random token generation for subscriptions and sessions |
| `types.ts` | Core TypeScript types: Account, Endpoint, ClientRecord |
| `subscriptions.ts` | VLESS link generation, subscription formats, Happ routing |
| `xray-configs.ts` | Xray server config generation for vpn2 and RU relays |
| `pages.ts` | HTML page rendering (admin, login, user detail, VPS, account) |
| `happ-api.ts` | Happ proxy API client (HWID management, install commands) |
| `vps-ssh.ts` | SSH operations on remote VPS (Xray management, traffic stats) |
| `migrations.ts` | Database schema migrations, admin bootstrap, endpoint sync |
| `html.ts` | HTML utility functions (escaping, template helpers) |

## Dependency Graph

```
server.ts (main entry point)
  ├── config.ts
  ├── db.ts
  ├── secure-config.ts
  ├── migrations.ts
  │   ├── db.ts
  │   ├── secure-config.ts
  │   └── passwords.ts
  ├── auth.ts
  │   ├── db.ts
  │   ├── passwords.ts
  │   └── tokens.ts
  ├── repository.ts
  │   ├── db.ts
  │   ├── types.ts
  │   ├── passwords.ts
  │   └── tokens.ts
  ├── subscriptions.ts
  │   ├── db.ts
  │   ├── types.ts
  │   └── secure-config.ts
  ├── xray-configs.ts
  │   ├── types.ts
  │   └── secure-config.ts
  ├── pages.ts
  │   └── html.ts
  ├── happ-api.ts
  │   └── secure-config.ts
  └── vps-ssh.ts
      └── (ssh2 external)
```

**Circular dependencies**: None. The dependency graph is acyclic.

**Key observation**: `server.ts` is a monolith — it contains all route handlers (1378 lines). This is the largest file and the only one with significant complexity.

## Key Abstractions

### Account

```typescript
type Account = {
  id: string;           // UUID from DB
  login: string;        // Username
  display_name: string; // Display name
  password_hash: string; // bcrypt hash
  role: "admin" | "user";
  enabled: boolean;
};
```

Represents a panel user (admin or regular user). Stored in `accounts` table.

### Endpoint

```typescript
type Endpoint = {
  id: string;           // e.g., "de-xhttp", "ru-smart-relay"
  label: string;        // Human-readable name
  kind: string;         // "vless-reality", "vless-ws", etc.
  address: string;      // Server address (IP or domain)
  port: number;         // Port number
  profile_id: string;   // Profile identifier
  enabled: boolean;     // Whether endpoint is active
  sort_order: number;   // Display order
  config: Record<string, unknown>; // Endpoint-specific config (public_key, short_id, query params)
};
```

Represents a VLESS endpoint (Reality, WS, XHTTP, gRPC, etc.). Loaded from `secure.json` nodes, synced to `endpoints` table.

### ClientRecord

```typescript
type ClientRecord = {
  id: string;           // UUID
  account_id: string;   // Reference to Account
  xray_uuid: string;    // Xray client UUID (different from account ID)
  enabled: boolean;
};
```

Represents a VPN client. Each account has one client record. The `xray_uuid` is used in VLESS links.

### SecureConfig

```typescript
type SecureConfig = {
  defaults: {
    fingerprint: string; // "chrome"
    flow: string;        // "xtls-rprx-vision"
    sni: string;         // "ya.ru"
    domain_strategy: string;
  };
  nodes: SecureNode[];   // Endpoint definitions
  server_configs: Record<string, Record<string, unknown>>;
  happ: {
    provider_code: string;
    auth_key: string;
    base_url: string;
  };
  vps: VpsConnectionConfig;      // Legacy single VPS
  vps_list: VpsConnectionConfig[]; // Multi-VPS support
};
```

Loaded from `/etc/vpn-panel/secure.json`. Contains all sensitive configuration: endpoint definitions, VPS credentials, Happ API keys, Reality keys.

### UserSummary

```typescript
type UserSummary = {
  account_id: string;
  login: string;
  display_name: string;
  enabled: boolean;
  client_id: string;
  xray_uuid: string;
  client_enabled: boolean;
  token: string | null;      // Active subscription token
  profiles: string[];        // Assigned endpoint IDs
  device_count: number;      // Happ HWID count
  happ_status: number | null; // Happ install status
};
```

Denormalized view of user + client + endpoints. Returned by `listUsers()` and `getUser()`.

## Module Boundaries

### What belongs where

**server.ts**: HTTP routes only. No business logic. Calls repository/subscription functions.

**repository.ts**: Database queries only. No HTTP, no config loading. Returns typed data.

**subscriptions.ts**: VLESS link generation, subscription formatting. No database queries (receives data as parameters).

**secure-config.ts**: Config loading and validation only. No database, no HTTP.

**auth.ts**: Session management only. No business logic.

**vps-ssh.ts**: SSH operations only. No database, no HTTP.

### What should not leak across modules

- **Database queries** should not appear in `server.ts` or `subscriptions.ts` — use `repository.ts`
- **HTTP request/response objects** should not appear in `repository.ts` or `subscriptions.ts`
- **Secure config access** should go through `secure-config.ts` — no direct file reads elsewhere
- **Password hashing** should use `passwords.ts` — no inline crypto in other modules
- **HTML rendering** should use `pages.ts` + `html.ts` — no inline HTML in `server.ts`

### Current violations

None significant. The codebase is well-structured. The only concern is `server.ts` size (1378 lines), but it's purely route handlers, which is acceptable for Fastify.

## Module Responsibilities

### server.ts

- Fastify app setup (cookies, form body parsing)
- All HTTP route handlers (admin, user, subscription, API)
- Startup logic (migrations, config loading, pool creation)
- VPS CRUD (add/remove VPS from `vps_list`)
- Deploy API (trigger deploy-all.sh, show logs)

### repository.ts

- User CRUD (list, get, create, update, delete)
- Endpoint queries (list, get health)
- Token management (rotate, validate)
- HWID tracking (sync from Happ, delete, count)
- Happ install tracking (get, upsert, update status)
- Traffic stats (get user traffic, inbound traffic)

### subscriptions.ts

- VLESS link generation (`vlessLink()`)
- Subscription formatting (plain, v2ray, happ, sing-box, xray-json)
- Happ routing link generation (`happRoutingLink()`)
- Happ deeplink generation (`happDeeplink()`)
- Client bundle creation (`bundleByToken()`, `bundleByAccount()`)
- Link slot computation (`linkSlots()`)
- Personalized announce headers (`personalizedAnnounce()`, `announceHeader()`)

### xray-configs.ts

- Xray server config generation (`serverConfig()`, `deServerConfig()`)
- Client config generation for specific endpoints
- Routing rule generation (RU direct, World proxy)
- Inbound/outbound/proxy definitions

### secure-config.ts

- Load `/etc/vpn-panel/secure.json`
- Validate with Zod schema
- Export endpoint order (`endpointOrder`)
- Export helper functions (`endpointProfile()`)

### auth.ts

- Login (`loginAccount()`)
- Session validation (`accountFromRequest()`)
- Role checks (`requireRole()`)
- Logout (`logout()`)
- Session cookie setup (`setSessionCookie()`)

### vps-ssh.ts

- SSH connection setup (`sshExec()`)
- Xray management (get config, update config, restart, logs, version, status)
- Client sync (`syncXrayClients()`)
- Traffic stats (`getInboundTraffic()`, `getUserTraffic()`, `resetTrafficStats()`)
- Xray updates (`checkXrayUpdate()`, `updateXray()`)

### pages.ts

- Admin page (`adminPage()`)
- Login page (`loginPage()`)
- User detail page (`userDetailPage()`)
- VPS page (`vpsPage()`)
- Account page (`accountPage()`)

### happ-api.ts

- List HWIDs (`happListHwids()`)
- Delete HWID (`happDeleteHwid()`)
- Add install (`happAddInstall()`)
- Update install (`happUpdateInstall()`)
- Send command (`happSendCommand()`)
- Install deeplink (`happInstallDeeplink()`)

### migrations.ts

- Run migrations (`runMigrations()`)
- Bootstrap admin account (`bootstrapAdmin()`)
- Sync endpoints from secure.json (`syncCatalogFromSecureConfig()`)

## Testing Strategy

Tests are in `tests/*.test.ts`. Each test file covers one module:

- `subscriptions.test.ts` — VLESS link generation, subscription formats
- `passwords.test.ts` — Password hashing/verification
- `secure-config.test.ts` — Config loading/validation
- `happ-api.test.ts` — Happ API client
- `pages.test.ts` — HTML rendering
- `vps-ssh.test.ts` — SSH operations (mocked)
- `xray-configs.test.ts` — Xray config generation

Tests use Node test runner (`tsx --test`). No jest/vitest. Mocks are manual (no mocking framework).

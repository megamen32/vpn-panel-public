# Database Schema

## Entity Relationship Diagram

```
┌─────────────────┐
│   accounts      │
│─────────────────│
│ id (PK)         │◄────┐
│ login           │     │
│ display_name    │     │
│ password_hash   │     │
│ role            │     │
│ enabled         │     │
│ created_at      │     │
│ updated_at      │     │
└─────────────────┘     │
        │               │
        │ 1:1           │
        ▼               │
┌─────────────────┐     │
│  vpn_clients    │     │
│─────────────────│     │
│ id (PK)         │◄──┐ │
│ account_id (FK) │   │ │
│ xray_uuid       │   │ │
│ enabled         │   │ │
│ created_at      │   │ │
│ updated_at      │   │ │
└─────────────────┘   │ │
        │             │ │
        │ 1:M         │ │
        ▼             │ │
┌─────────────────┐   │ │
│subscription_    │   │ │
│    tokens       │   │ │
│─────────────────│   │ │
│ id (PK)         │   │ │
│ client_id (FK)  │   │ │
│ token           │   │ │
│ enabled         │   │ │
│ created_at      │   │ │
│ last_used_at    │   │ │
└─────────────────┘   │ │
                      │ │
┌─────────────────┐   │ │
│client_profiles  │   │ │
│─────────────────│   │ │
│ client_id (FK)  │───┘ │
│ endpoint_id(FK) │─────┼──────────┐
│ (PK: both)      │     │          │
└─────────────────┘     │          │
                        │          │
┌─────────────────┐     │          │
│   endpoints     │     │          │
│─────────────────│     │          │
│ id (PK)         │◄────┼──────────┘
│ label           │     │
│ kind            │     │
│ server_id (FK)  │◄────┤
│ address         │     │
│ port            │     │
│ profile_id      │     │
│ enabled         │     │
│ sort_order      │     │
│ config (JSONB)  │     │
│ updated_at      │     │
└─────────────────┘     │
                        │
┌─────────────────┐     │
│    servers      │     │
│─────────────────│     │
│ id (PK)         │◄────┘
│ label           │
│ roles           │
│ enabled         │
│ config (JSONB)  │
│ updated_at      │
└─────────────────┘

┌─────────────────┐
│   sessions      │
│─────────────────│
│ id (PK)         │◄──── accounts.id
│ account_id (FK) │
│ expires_at      │
│ created_at      │
└─────────────────┘

┌─────────────────┐
│endpoint_health  │
│─────────────────│
│ endpoint_id(PK) │◄──── endpoints.id
│ latency_ms      │
│ speed_mbps      │
│ exit_ip         │
│ pass_count      │
│ fail_count      │
│ sites (JSONB)   │
│ checked_at      │
└─────────────────┘

┌─────────────────┐
│  happ_installs  │
│─────────────────│
│ account_id (PK) │◄──── accounts.id
│ install_code    │
│ install_id      │
│ install_limit   │
│ status          │
│ note            │
│ happ_settings   │
│ created_at      │
│ updated_at      │
└─────────────────┘

┌─────────────────┐
│   happ_hwids    │
│─────────────────│
│ id (PK)         │
│ account_id (FK) │◄──── accounts.id
│ install_code    │
│ hwid            │
│ device_name     │
│ device_model    │
│ os_version      │
│ app_version     │
│ recorded_at     │
│ last_seen_at    │
└─────────────────┘

┌─────────────────┐
│  usage_events   │
│─────────────────│
│ id (PK)         │
│ account_id (FK) │◄──── accounts.id
│ client_id (FK)  │◄──── vpn_clients.id
│ event_type      │
│ metadata(JSONB) │
│ created_at      │
└─────────────────┘
```

## Table Definitions

### accounts

User accounts (admin and regular users).

| Column | Type | Constraints | Description |
|--------|------|-------------|-------------|
| `id` | `bigserial` | PRIMARY KEY | Auto-increment ID |
| `login` | `text` | NOT NULL, UNIQUE | Username |
| `display_name` | `text` | NOT NULL | Display name |
| `password_hash` | `text` | NOT NULL | bcrypt hash |
| `role` | `text` | NOT NULL, CHECK (role in ('admin', 'user')) | User role |
| `enabled` | `boolean` | NOT NULL, DEFAULT true | Whether account is active |
| `created_at` | `timestamptz` | NOT NULL, DEFAULT now() | Creation timestamp |
| `updated_at` | `timestamptz` | NOT NULL, DEFAULT now() | Last update timestamp |

**Indexes**: None (primary key only)

### vpn_clients

VPN client records. One per account.

| Column | Type | Constraints | Description |
|--------|------|-------------|-------------|
| `id` | `bigserial` | PRIMARY KEY | Auto-increment ID |
| `account_id` | `bigint` | NOT NULL, UNIQUE, FK → accounts(id) ON DELETE CASCADE | Reference to account |
| `xray_uuid` | `uuid` | NOT NULL, UNIQUE | Xray client UUID (used in VLESS links) |
| `enabled` | `boolean` | NOT NULL, DEFAULT true | Whether client is active |
| `created_at` | `timestamptz` | NOT NULL, DEFAULT now() | Creation timestamp |
| `updated_at` | `timestamptz` | NOT NULL, DEFAULT now() | Last update timestamp |

**Relationship**: 1:1 with `accounts`. When account is deleted, client is cascade-deleted.

### subscription_tokens

Subscription access tokens. Multiple per client (for rotation).

| Column | Type | Constraints | Description |
|--------|------|-------------|-------------|
| `id` | `bigserial` | PRIMARY KEY | Auto-increment ID |
| `client_id` | `bigint` | NOT NULL, FK → vpn_clients(id) ON DELETE CASCADE | Reference to client |
| `token` | `text` | NOT NULL, UNIQUE | Random token (used in subscription URLs) |
| `enabled` | `boolean` | NOT NULL, DEFAULT true | Whether token is active |
| `created_at` | `timestamptz` | NOT NULL, DEFAULT now() | Creation timestamp |
| `last_used_at` | `timestamptz` | | Last access timestamp |

**Indexes**:
- `subscription_tokens_token_idx` on `token` — fast token lookup

**Relationship**: M:1 with `vpn_clients`. When client is deleted, tokens are cascade-deleted.

### endpoints

VPN endpoint definitions. Synced from `secure.json` on startup.

| Column | Type | Constraints | Description |
|--------|------|-------------|-------------|
| `id` | `text` | PRIMARY KEY | Endpoint ID (e.g., "de-xhttp") |
| `label` | `text` | NOT NULL | Human-readable label |
| `kind` | `text` | NOT NULL | Endpoint type ("vless-reality", "vless-ws", etc.) |
| `server_id` | `text` | FK → servers(id) ON DELETE SET NULL | Reference to server |
| `address` | `text` | NOT NULL | Server address (IP or domain) |
| `port` | `integer` | NOT NULL | Port number |
| `profile_id` | `text` | NOT NULL | Profile identifier |
| `enabled` | `boolean` | NOT NULL, DEFAULT true | Whether endpoint is active |
| `sort_order` | `integer` | NOT NULL, DEFAULT 100 | Display order |
| `config` | `jsonb` | NOT NULL, DEFAULT '{}' | Endpoint-specific config (public_key, short_id, query params) |
| `updated_at` | `timestamptz` | NOT NULL, DEFAULT now() | Last update timestamp |

**Relationship**: M:1 with `servers`. When server is deleted, endpoint's `server_id` is set to NULL.

### servers

VPN server definitions. Synced from `secure.json` `server_configs` on startup.

| Column | Type | Constraints | Description |
|--------|------|-------------|-------------|
| `id` | `text` | PRIMARY KEY | Server ID (e.g., "de", "ru") |
| `label` | `text` | NOT NULL | Human-readable label |
| `roles` | `text[]` | NOT NULL, DEFAULT '{}' | Server roles (e.g., ["exit", "direct"]) |
| `enabled` | `boolean` | NOT NULL, DEFAULT true | Whether server is active |
| `config` | `jsonb` | NOT NULL, DEFAULT '{}' | Server-specific config |
| `updated_at` | `timestamptz` | NOT NULL, DEFAULT now() | Last update timestamp |

### client_profiles

Many-to-many relationship between clients and endpoints.

| Column | Type | Constraints | Description |
|--------|------|-------------|-------------|
| `client_id` | `bigint` | NOT NULL, FK → vpn_clients(id) ON DELETE CASCADE | Reference to client |
| `endpoint_id` | `text` | NOT NULL, FK → endpoints(id) ON DELETE CASCADE | Reference to endpoint |
| **PRIMARY KEY** | | `(client_id, endpoint_id)` | Composite primary key |

**Relationship**: M:N between `vpn_clients` and `endpoints`. When client or endpoint is deleted, profile mapping is cascade-deleted.

### sessions

User sessions for authentication.

| Column | Type | Constraints | Description |
|--------|------|-------------|-------------|
| `id` | `text` | PRIMARY KEY | Session ID (random token) |
| `account_id` | `bigint` | NOT NULL, FK → accounts(id) ON DELETE CASCADE | Reference to account |
| `expires_at` | `timestamptz` | NOT NULL | Session expiration timestamp |
| `created_at` | `timestamptz` | NOT NULL, DEFAULT now() | Creation timestamp |

**Indexes**:
- `sessions_expires_at_idx` on `expires_at` — fast expiration cleanup

**Relationship**: M:1 with `accounts`. When account is deleted, sessions are cascade-deleted.

### endpoint_health

Health check results for endpoints. Updated by `auto-endpoint-check.sh`.

| Column | Type | Constraints | Description |
|--------|------|-------------|-------------|
| `endpoint_id` | `text` | PRIMARY KEY, FK → endpoints(id) ON DELETE CASCADE | Reference to endpoint |
| `latency_ms` | `integer` | | Latency in milliseconds |
| `speed_mbps` | `numeric(6,1)` | | Speed in Mbps |
| `exit_ip` | `text` | | Exit IP address |
| `pass_count` | `integer` | NOT NULL, DEFAULT 0 | Number of successful checks |
| `fail_count` | `integer` | NOT NULL, DEFAULT 0 | Number of failed checks |
| `sites` | `jsonb` | NOT NULL, DEFAULT '[]' | List of tested sites |
| `checked_at` | `timestamptz` | NOT NULL, DEFAULT now() | Last check timestamp |

**Relationship**: 1:1 with `endpoints`. When endpoint is deleted, health record is cascade-deleted.

### happ_installs

Happ proxy install tracking. One per account.

| Column | Type | Constraints | Description |
|--------|------|-------------|-------------|
| `account_id` | `bigint` | PRIMARY KEY, FK → accounts(id) ON DELETE CASCADE | Reference to account |
| `install_code` | `text` | NOT NULL, UNIQUE | Happ install code |
| `install_id` | `integer` | | Happ install ID |
| `install_limit` | `integer` | NOT NULL, DEFAULT 10 | Device limit |
| `status` | `integer` | NOT NULL, DEFAULT 10 | Install status |
| `note` | `text` | | Optional note |
| `happ_settings` | `jsonb` | NOT NULL, DEFAULT '{}' | Happ-specific settings |
| `created_at` | `timestamptz` | NOT NULL, DEFAULT now() | Creation timestamp |
| `updated_at` | `timestamptz` | NOT NULL, DEFAULT now() | Last update timestamp |

**Relationship**: 1:1 with `accounts`. When account is deleted, install record is cascade-deleted.

### happ_hwids

Hardware IDs for Happ installs. Tracks devices.

| Column | Type | Constraints | Description |
|--------|------|-------------|-------------|
| `id` | `bigserial` | PRIMARY KEY | Auto-increment ID |
| `account_id` | `bigint` | FK → accounts(id) ON DELETE CASCADE | Reference to account |
| `install_code` | `text` | NOT NULL | Happ install code |
| `hwid` | `text` | NOT NULL | Hardware ID |
| `device_name` | `text` | | Device name |
| `device_model` | `text` | | Device model |
| `os_version` | `text` | | OS version |
| `app_version` | `text` | | App version |
| `recorded_at` | `timestamptz` | NOT NULL, DEFAULT now() | First seen timestamp |
| `last_seen_at` | `timestamptz` | NOT NULL, DEFAULT now() | Last seen timestamp |
| **UNIQUE** | | `(install_code, hwid)` | Prevent duplicate HWIDs per install |

**Indexes**:
- `happ_hwids_account_idx` on `account_id` — fast account lookup

**Relationship**: M:1 with `accounts`. When account is deleted, HWIDs are cascade-deleted.

### usage_events

Audit log for user actions.

| Column | Type | Constraints | Description |
|--------|------|-------------|-------------|
| `id` | `bigserial` | PRIMARY KEY | Auto-increment ID |
| `account_id` | `bigint` | FK → accounts(id) ON DELETE SET NULL | Reference to account |
| `client_id` | `bigint` | FK → vpn_clients(id) ON DELETE SET NULL | Reference to client |
| `event_type` | `text` | NOT NULL | Event type (e.g., "subscription_access") |
| `metadata` | `jsonb` | NOT NULL, DEFAULT '{}' | Event metadata |
| `created_at` | `timestamptz` | NOT NULL, DEFAULT now() | Event timestamp |

**Indexes**:
- `usage_events_account_created_idx` on `(account_id, created_at desc)` — fast account event lookup

**Relationship**: M:1 with `accounts` and `vpn_clients`. When account/client is deleted, event's reference is set to NULL.

### schema_migrations

Tracks applied schema migrations.

| Column | Type | Constraints | Description |
|--------|------|-------------|-------------|
| `id` | `integer` | PRIMARY KEY | Migration ID |
| `applied_at` | `timestamptz` | NOT NULL, DEFAULT now() | Application timestamp |

## Migrations

### Migration Strategy

The panel uses **inline migrations** — schema is created/updated at startup via `runMigrations()`. There are no separate migration files.

```typescript
export async function runMigrations(pool: DbPool): Promise<void> {
  // Create schema_migrations tracking table
  await pool.query(`create table if not exists schema_migrations ...`);
  
  // Create all tables (idempotent with IF NOT EXISTS)
  await pool.query(`create table if not exists accounts ...`);
  await pool.query(`create table if not exists vpn_clients ...`);
  // ... etc
  
  // Add columns to existing tables (idempotent with IF NOT EXISTS)
  await pool.query(`alter table happ_hwids add column if not exists last_seen_at ...`);
  await pool.query(`alter table happ_hwids add column if not exists device_model ...`);
  // ... etc
}
```

### Running Migrations

Migrations run automatically at startup:

```bash
# Restart service (migrations run on startup)
sudo systemctl restart autovpnallowip.service

# Check logs for migration output
sudo journalctl -u autovpnallowip.service -n 50 --no-pager
```

### Migration Safety

- **Idempotent**: All `CREATE TABLE` and `ALTER TABLE` use `IF NOT EXISTS` / `IF NOT EXISTS`
- **Non-destructive**: Migrations only add tables/columns, never drop or rename
- **Transactional**: Each migration runs in a transaction (PostgreSQL default)
- **No rollback**: There is no migration rollback mechanism. To revert, restore from backup.

## Data Access Layer

All database queries are in `src/repository.ts`. The repository layer provides:

### User Management

```typescript
listUsers(pool): Promise<UserSummary[]>
getUser(pool, accountId): Promise<UserSummary | null>
createUser(pool, input): Promise<string>
updateUser(pool, accountId, input): Promise<void>
deleteUser(pool, accountId): Promise<void>
```

### Endpoint Management

```typescript
listEndpoints(pool): Promise<Endpoint[]>
getEndpointHealth(pool): Promise<EndpointHealth[]>
upsertEndpointHealth(pool, endpointId, data): Promise<void>
```

### Token Management

```typescript
rotateToken(pool, clientId): Promise<string>
```

### HWID Management

```typescript
getHwidsForAccount(pool, accountId): Promise<HappHwid[]>
deleteHwid(pool, hwidId): Promise<void>
syncHwidsFromHapp(pool, accountId, hwids): Promise<void>
captureHwidFromSubscription(pool, accountId, hwid, deviceInfo): Promise<void>
countAllDevices(pool): Promise<number>
```

### Happ Install Management

```typescript
getHappInstall(pool, accountId): Promise<HappInstall | null>
getAllHappInstalls(pool): Promise<HappInstall[]>
upsertHappInstall(pool, accountId, installCode): Promise<void>
updateHappSettings(pool, accountId, settings): Promise<void>
updateHappInstallStatus(pool, accountId, status): Promise<void>
```

### Query Patterns

**Transactions**: Multi-step operations use explicit transactions:

```typescript
await pool.connect().then(async (client) => {
  try {
    await client.query("begin");
    // ... multiple queries
    await client.query("commit");
  } catch (error) {
    await client.query("rollback");
    throw error;
  } finally {
    client.release();
  }
});
```

**Parameterized queries**: All queries use `$1`, `$2` placeholders to prevent SQL injection.

**Type safety**: Query results are typed with TypeScript generics:

```typescript
const result = await pool.query<Account>(
  `select id::text, login, display_name, password_hash, role, enabled
   from accounts where login = $1 and role = $2`,
  [login, role],
);
```

**JSON casting**: PostgreSQL `bigint` IDs are cast to `text` to avoid JavaScript number precision loss:

```typescript
select id::text, account_id::text from accounts
```

## Database Maintenance

### Connection Pooling

The panel uses a connection pool with max 10 connections:

```typescript
export function createPool(config: Pick<AppConfig, "databaseUrl">): DbPool {
  return new Pool({
    connectionString: config.databaseUrl,
    max: 10,
  });
}
```

### Cleanup Tasks

There are no automatic cleanup tasks. Expired sessions remain in the database but are ignored by `accountFromRequest()` (checks `expires_at > now()`).

To manually clean up expired sessions:

```sql
DELETE FROM sessions WHERE expires_at < now();
```

### Backup Strategy

PostgreSQL backup is not handled by the panel. Use standard PostgreSQL backup tools:

```bash
# Dump database
pg_dump vpn_panel > backup.sql

# Restore database
psql vpn_panel < backup.sql
```

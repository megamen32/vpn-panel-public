# Authentication & Authorization

## Authentication Flow

### Login

**Endpoint**: `POST /login` (user login) or `POST /admin` (admin login)

**Request body** (form):
```
login=admin
password=secret
```

**Flow**:
1. User submits credentials via login form
2. Server calls `loginAccount(pool, login, password, role)`
3. Server queries `accounts` table for matching login + role
4. Server checks `account.enabled = true`
5. Server verifies password via `verifyPassword(password, account.password_hash)`
6. If valid:
   - Generate random session ID (36 chars)
   - Insert into `sessions` table with 30-day expiration
   - Set `vpn_panel_sid` cookie
   - Redirect to `/account` (user) or `/admin` (admin)
7. If invalid:
   - Redirect back to login page with error

### Session Validation

**Function**: `accountFromRequest(pool, request)`

**Flow**:
1. Read `vpn_panel_sid` cookie from request
2. If missing, return `null`
3. Query `sessions` table:
   ```sql
   SELECT a.* FROM sessions s
   JOIN accounts a ON a.id = s.account_id
   WHERE s.id = $1 AND s.expires_at > now() AND a.enabled = true
   ```
4. If found, return `Account` object
5. If not found (expired, deleted, or disabled), return `null`

### Role Checks

**Function**: `requireRole(pool, request, reply, role)`

**Flow**:
1. Call `accountFromRequest()`
2. If `null` or role doesn't match:
   - If request accepts HTML: redirect to login page
   - Otherwise: return 401 `{ "error": "unauthorized" }`
3. If valid, return `Account` object

**Usage in routes**:
```typescript
app.get("/admin", async (request, reply) => {
  const account = await requireRole(pool, request, reply, "admin");
  if (!account) return;
  // ... admin-only logic
});
```

### Logout

**Endpoint**: `DELETE /logout`

**Flow**:
1. Read `vpn_panel_sid` cookie
2. Delete session from `sessions` table
3. Clear cookie
4. Redirect to `/login`

## Password Handling

### Hashing

**Function**: `hashPassword(password)` in `src/passwords.ts`

**Algorithm**: bcrypt with automatic salt generation

**Cost factor**: Default (10 rounds)

**Implementation**:
```typescript
import bcrypt from "bcrypt";

export async function hashPassword(password: string): Promise<string> {
  return bcrypt.hash(password, 10);
}
```

### Verification

**Function**: `verifyPassword(password, hash)`

**Implementation**:
```typescript
export async function verifyPassword(password: string, hash: string): Promise<boolean> {
  return bcrypt.compare(password, hash);
}
```

**Timing-safe**: bcrypt comparison is timing-safe by design.

### Password Reset

There is no password reset flow. Admin must manually update password via admin panel:

```typescript
PUT /api/admin/users/:accountId
{
  "password": "new-password"
}
```

Server hashes new password and updates `accounts.password_hash`.

## Role System

### Roles

Two roles exist:

1. **admin** — Full access to admin panel, user management, VPS management, deploy
2. **user** — Access to own account page, subscription endpoints

### Admin Capabilities

Admins can:
- View all users (`GET /api/admin/users`)
- Create users (`POST /api/admin/users`)
- Update users (`PUT /api/admin/users/:accountId`)
- Delete users (`DELETE /api/admin/users/:accountId`)
- Rotate tokens (`POST /api/admin/users/:accountId/rotate-token`)
- View endpoints (`GET /api/admin/endpoints`)
- View health (`GET /api/admin/health`)
- Post health (`POST /api/health` with API key)
- Deploy to VPS (`POST /api/admin/deploy/:target`)
- Manage VPS (`GET/POST/DELETE /api/admin/vps`)
- Manage Xray on VPS (config, restart, sync clients, traffic stats, logs, status, updates)
- Manage Happ installs and HWIDs

### User Capabilities

Users can:
- View own account page (`GET /account`)
- Access subscription endpoints (`GET /sub/:token/*`)
- Logout (`DELETE /logout`)

### Role Enforcement

Routes check role via `requireRole()`:

```typescript
// Admin-only route
app.get("/admin", async (request, reply) => {
  const account = await requireRole(pool, request, reply, "admin");
  if (!account) return;
  // ... admin logic
});

// User-only route
app.get("/account", async (request, reply) => {
  const account = await requireRole(pool, request, reply, "user");
  if (!account) return;
  // ... user logic
});
```

**Subscription endpoints** (`/sub/:token/*`) do not check role — they validate token only.

## Session Management

### Cookie Setup

**Function**: `setSessionCookie(reply, sessionId)`

**Cookie properties**:
```typescript
reply.setCookie(COOKIE_NAME, sessionId, {
  path: "/",
  httpOnly: true,      // Not accessible via JavaScript
  sameSite: "strict",  // Prevents CSRF
  secure: true,        // HTTPS only
  maxAge: SESSION_DAYS * 24 * 60 * 60,  // 30 days
});
```

**Cookie name**: `vpn_panel_sid`

**Session duration**: 30 days (hardcoded in `auth.ts`)

### Session Storage

Sessions are stored in PostgreSQL `sessions` table:

```sql
CREATE TABLE sessions (
  id TEXT PRIMARY KEY,              -- Random 36-char token
  account_id BIGINT NOT NULL,       -- Reference to accounts
  expires_at TIMESTAMPTZ NOT NULL,  -- 30 days from creation
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
```

**Cleanup**: Expired sessions remain in database but are ignored by `accountFromRequest()` (checks `expires_at > now()`).

To manually clean up:
```sql
DELETE FROM sessions WHERE expires_at < now();
```

### Session Secret

**Environment variable**: `VPN_PANEL_SESSION_SECRET` or `VPN_PANEL_SECRET`

**Purpose**: Signs session cookies to prevent tampering

**Default**: If not set, generates random 32-byte hex on each startup (sessions invalidated on restart)

**Recommendation**: Set explicit secret in production to survive restarts:
```bash
VPN_PANEL_SESSION_SECRET=$(openssl rand -hex 32)
```

## API Key Auth

### Health API Key

**Environment variable**: `VPN_PANEL_HEALTH_API_KEY`

**Purpose**: Authenticates script-based health checks from `auto-endpoint-check.sh`

**Header format**:
```
Authorization: Bearer <api-key>
```

**Validation function**: `checkHealthApiKey()`

**Implementation**:
```typescript
function checkHealthApiKey(request: { headers: Record<string, string | undefined> }): boolean {
  if (!config.healthApiKey) return false;
  const auth = request.headers["authorization"];
  if (!auth) return false;
  const match = /^Bearer\s+(.+)$/i.exec(auth);
  if (!match) return false;
  const a = Buffer.from(match[1], "utf8");
  const b = Buffer.from(config.healthApiKey, "utf8");
  if (a.length !== b.length) return false;
  return crypto.timingSafeEqual(a, b);
}
```

**Timing-safe**: Uses `crypto.timingSafeEqual()` to prevent timing attacks.

**Used by**: `POST /api/health`

## Security Practices

### Timing-Safe Comparison

Health API key comparison uses `crypto.timingSafeEqual()`:

```typescript
if (a.length !== b.length) return false;
return crypto.timingSafeEqual(a, b);
```

This prevents attackers from guessing the key by measuring response times.

### Cookie Security

Session cookies have secure flags:
- `httpOnly`: Prevents XSS attacks (cookie not accessible via JavaScript)
- `sameSite: "strict"`: Prevents CSRF attacks (cookie not sent on cross-site requests)
- `secure: true`: Cookie only sent over HTTPS

### Password Hashing

Passwords are hashed with bcrypt:
- Automatic salt generation (prevents rainbow table attacks)
- 10 rounds (configurable, default is secure)
- Timing-safe comparison

### No Secrets in Logs

Fastify logger does not log:
- Request bodies (may contain passwords)
- Sensitive headers (Authorization, Cookie)
- Response bodies (may contain tokens)

Logs include:
- Request ID
- Method, URL, status code
- Response time
- Error messages (without sensitive data)

### No Secrets in URLs

Tokens are in path (`/sub/:token/plain`), not query params.

**Why**: Query params leak via:
- Referrer header (when clicking links)
- Browser history
- Server logs
- Proxy logs

Path segments are safer (not logged by proxies, not in referrer).

### Session Expiration

Sessions expire after 30 days. Expired sessions are ignored by `accountFromRequest()`.

**Recommendation**: Periodically clean up expired sessions:
```sql
DELETE FROM sessions WHERE expires_at < now();
```

### Account Disable

Admins can disable accounts:
```typescript
PUT /api/admin/users/:accountId
{
  "enabled": false
}
```

Disabled accounts:
- Cannot login (rejected by `loginAccount()`)
- Existing sessions are invalidated (rejected by `accountFromRequest()`)
- Subscription endpoints still work (token-based, not session-based)

### Account Delete

Admins can delete accounts:
```typescript
DELETE /api/admin/users/:accountId
```

Deleted accounts:
- Removed from `accounts` table
- Cascade deletes: `vpn_clients`, `subscription_tokens`, `sessions`, `client_profiles`, `happ_installs`, `happ_hwids`
- Subscription endpoints stop working (token no longer valid)

## Bootstrap Admin

### bootstrapAdmin()

Located in `src/migrations.ts`. Creates initial admin account if missing.

**Flow**:
1. Check if `VPN_PANEL_ADMIN_PASSWORD` is set
2. If not, skip (admin already exists or no password configured)
3. Query `accounts` for existing admin: `SELECT id FROM accounts WHERE role = 'admin' LIMIT 1`
4. If found, skip
5. If not found:
   - Hash password with bcrypt
   - Insert into `accounts` with `role = 'admin'`

**Usage**: Called at startup:
```typescript
await bootstrapAdmin(pool, config);
```

**Recommendation**: Set `VPN_PANEL_ADMIN_PASSWORD` in `.env` for initial setup, then remove it (or keep it for disaster recovery).

## Admin Panel Access

### URL

- Admin login: `https://vpn.bezrabotnyi.com/admin`
- User login: `https://vpn.bezrabotnyi.com/login`

### Nginx Routing

```nginx
server_name vpn.bezrabotnyi.com;
location / {
    proxy_pass http://127.0.0.1:30129;
}
```

All requests are proxied to the production panel on 127.0.0.1:30129.

### Access Control

- `/admin` requires `role = "admin"`
- `/login` and `/account` require `role = "user"`
- Subscription endpoints (`/sub/:token/*`) require valid token (no role check)

## Common Attack Vectors

### XSS (Cross-Site Scripting)

**Mitigation**:
- Session cookies are `httpOnly` (not accessible via JavaScript)
- HTML pages escape user input via `html.ts` utilities
- No inline JavaScript in admin UI

### CSRF (Cross-Site Request Forgery)

**Mitigation**:
- Session cookies are `sameSite: "strict"` (not sent on cross-site requests)
- No cross-origin requests allowed (CORS not configured)

### Brute Force

**Mitigation**:
- No rate limiting (rely on nginx or firewall)
- Password hashing with bcrypt (slow by design)
- Account disable (admin can disable compromised accounts)

**Recommendation**: Add rate limiting via nginx or fail2ban:
```nginx
limit_req_zone $binary_remote_addr zone=login:10m rate=10r/s;
location /login {
    limit_req zone=login burst=20 nodelay;
    proxy_pass http://127.0.0.1:30129;
}
```

### Session Hijacking

**Mitigation**:
- Session cookies are `secure: true` (HTTPS only)
- Session IDs are random 36-char tokens (high entropy)
- Sessions expire after 30 days

**Recommendation**: Monitor for suspicious session activity (multiple IPs, unusual locations).

### SQL Injection

**Mitigation**:
- All queries use parameterized statements (`$1`, `$2`, etc.)
- No string concatenation in SQL queries
- PostgreSQL driver escapes parameters automatically

### Timing Attacks

**Mitigation**:
- Health API key comparison uses `crypto.timingSafeEqual()`
- Password verification uses bcrypt (timing-safe by design)

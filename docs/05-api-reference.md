# API Reference

> Subscription APIs filter assignments to the four regional relay products.
> Diagnostic transport assignments are visible to operators but are not emitted
> in normal client subscriptions.

## Authentication

### Session-Based Authentication

The panel uses cookie-based sessions for web UI access.

**Login flow**:
1. User submits credentials to `POST /login` or `POST /admin`
2. Server validates credentials against `accounts` table
3. Server creates session in `sessions` table with 30-day expiration
4. Server sets `vpn_panel_sid` cookie with session ID
5. Subsequent requests include cookie automatically

**Cookie properties**:
- Name: `vpn_panel_sid`
- HttpOnly: true (not accessible via JavaScript)
- SameSite: strict (prevents CSRF)
- Secure: true (HTTPS only)
- MaxAge: 30 days

**Session validation**:
- `accountFromRequest()` reads cookie from request
- Looks up session in `sessions` table
- Checks `expires_at > now()` and `account.enabled = true`
- Returns `Account` object or `null`

**Logout**:
- `DELETE /logout` removes session from database
- Clears `vpn_panel_sid` cookie

### API Key Authentication

Script-based health checks use Bearer token authentication.

**Header format**:
```
Authorization: Bearer <api-key>
```

**Validation**:
- `checkHealthApiKey()` extracts token from `Authorization` header
- Compares with `VPN_PANEL_HEALTH_API_KEY` environment variable
- Uses `crypto.timingSafeEqual()` to prevent timing attacks
- Returns `true` if match, `false` otherwise

**Used by**: `scripts/auto-endpoint-check.sh`

## Public Endpoints

### Subscription Endpoints

All subscription endpoints require a valid token in the URL path.

#### GET /sub/:token/plain

Returns plain VLESS links (one per line).

**Response**:
```
vless://uuid@address:port?params#label1
vless://uuid@address:port?params#label2
```

**Headers**:
- `Content-Type: text/plain; charset=utf-8`
- `profile-title: base64("<title>")`
- `profile-update-interval: 1`
- `routing: happ://routing/onadd/<base64-json>`
- `announce: base64("<message>")`

**Logic**:
1. Look up token in `subscription_tokens` table
2. Fetch client bundle (account + client + assigned endpoints)
3. Generate VLESS link for each enabled endpoint
4. Filter by `endpointOrder` priority
5. Return plain text

#### GET /sub/:token/v2ray

Returns base64-encoded plain subscription.

**Response**: Base64-encoded string of plain subscription.

**Headers**: Same as `/sub/:token/plain`.

#### GET /sub/:token/happ

Returns Happ-native subscription (routing link + plain).

**Response**:
```
happ://routing/onadd/<base64-json>
vless://uuid@address:port?params#label1
vless://uuid@address:port?params#label2
```

**Headers**: Same as `/sub/:token/plain`.

#### GET /sub/:token/sing-box

Returns sing-box JSON configuration.

**Response**:
```json
{
  "log": { "level": "info" },
  "dns": { ... },
  "inbounds": [ ... ],
  "outbounds": [ ... ],
  "route": { ... }
}
```

**Headers**:
- `Content-Type: application/json; charset=utf-8`
- `profile-title`, `profile-update-interval`, `routing`, `announce`

**Logic**:
1. Build sing-box outbounds for each assigned endpoint
2. Reality endpoints use `vless` outbound with `reality` TLS
3. WS/HTTPUpgrade endpoints use `vless` outbound with transport
4. Add routing rules (RU direct, World proxy)
5. Return JSON

#### GET /sub/:token/xray-json

Returns Xray client JSON configuration.

**Response**:
```json
{
  "log": { "loglevel": "info" },
  "inbounds": [ ... ],
  "outbounds": [ ... ],
  "routing": { ... }
}
```

**Headers**:
- `Content-Type: application/json; charset=utf-8`
- `profile-title`, `profile-update-interval`, `routing`, `announce`

**Logic**:
1. Build Xray outbounds for each assigned endpoint
2. Reality endpoints use `vless` outbound with `reality` security
3. WS/HTTPUpgrade endpoints use `vless` outbound with `streamSettings`
4. Add routing rules (RU direct, World proxy)
5. Return JSON

### Common Subscription Headers

All subscription endpoints include these headers:

**profile-title**: Base64-encoded subscription title.
```
profile-title: base64("🇷🇺 RU direct / 🌍 World proxy")
```

**profile-update-interval**: Update interval in hours.
```
profile-update-interval: 1
```

**routing**: Happ routing link for geo-routing policy.
```
routing: happ://routing/onadd/<base64-json>
```

**announce**: Base64-encoded personalized announcement message.
```
announce: base64("Добро пожаловать, Иван! Ваша подписка активна.")
```

## Admin API

All admin endpoints require `role: "admin"` authentication.

### GET /admin

Returns admin dashboard HTML page.

**Response**: HTML page with:
- User list (login, display name, status, endpoints, devices)
- Endpoint list (label, kind, address, health)
- System stats (total users, total devices, total endpoints)

**Authentication**: Session cookie required. Redirects to `/admin` login if not authenticated.

### GET /api/admin/users

Returns list of all users.

**Response**:
```json
[
  {
    "account_id": "123",
    "login": "ivan",
    "display_name": "Иван",
    "enabled": true,
    "client_id": "456",
    "xray_uuid": "uuid-here",
    "client_enabled": true,
    "token": "token-here",
    "profiles": ["de-xhttp", "de-reality"],
    "device_count": 3,
    "happ_status": 10
  }
]
```

**Authentication**: Session cookie required. Returns 401 if not admin.

### POST /api/admin/users

Creates a new user.

**Request body** (form or JSON):
```json
{
  "login": "ivan",
  "displayName": "Иван",
  "password": "secret",
  "xrayUuid": "uuid-here",
  "endpointIds": ["de-xhttp", "de-reality"]
}
```

**Validation** (Zod schema):
- `login`: string, min 1 char
- `displayName`: string, min 1 char
- `password`: string, min 1 char
- `xrayUuid`: UUID string (optional)
- `endpointIds`: array of strings or single string (optional)

**Response**:
```json
{ "accountId": "123" }
```

**Logic**:
1. Validate input
2. Hash password with bcrypt
3. Insert into `accounts` (role='user')
4. Insert into `vpn_clients` (with xray_uuid)
5. Insert into `subscription_tokens` (random token)
6. Insert into `client_profiles` (for each endpointId)
7. Return account ID

**Authentication**: Session cookie required. Returns 401 if not admin.

### PUT /api/admin/users/:accountId

Updates an existing user.

**Request body** (form or JSON):
```json
{
  "login": "ivan-new",
  "displayName": "Иван Новый",
  "password": "new-secret",
  "enabled": true,
  "endpointIds": ["de-xhttp", "de-reality", "de-cdn"]
}
```

**Validation** (Zod schema):
- All fields optional
- `enabled`: boolean or "true"/"false" string
- `endpointIds`: array of strings or single string

**Response**:
```json
{ "ok": true }
```

**Logic**:
1. Validate input
2. Update `accounts` (login, displayName, password, enabled)
3. Update `vpn_clients` (enabled)
4. Delete old `client_profiles`
5. Insert new `client_profiles` (for each endpointId)
6. Return success

**Authentication**: Session cookie required. Returns 401 if not admin.

### DELETE /api/admin/users/:accountId

Deletes a user.

**Response**:
```json
{ "ok": true }
```

**Logic**:
1. Delete from `accounts` (cascade deletes vpn_clients, subscription_tokens, client_profiles)
2. Return success

**Authentication**: Session cookie required. Returns 401 if not admin.

### POST /api/admin/users/:accountId/rotate-token

Rotates subscription token for a user.

**Response**:
```json
{ "token": "new-token-here" }
```

**Logic**:
1. Disable old token in `subscription_tokens`
2. Generate new random token
3. Insert new token
4. Return new token

**Authentication**: Session cookie required. Returns 401 if not admin.

### GET /api/admin/endpoints

Returns list of all endpoints.

**Response**:
```json
[
  {
    "id": "de-xhttp",
    "label": "DE XHTTP",
    "kind": "vless-ws",
    "address": "vpn2.bezrabotnyi.com",
    "port": 443,
    "profile_id": "de-xhttp",
    "enabled": true,
    "sort_order": 2,
    "config": { ... }
  }
]
```

**Authentication**: Session cookie required. Returns 401 if not admin.

### GET /api/admin/health

Returns endpoint health status.

**Response**:
```json
[
  {
    "endpoint_id": "de-xhttp",
    "latency_ms": 150,
    "speed_mbps": 50.5,
    "exit_ip": "212.192.31.128",
    "pass_count": 100,
    "fail_count": 2,
    "sites": ["google.com", "youtube.com"],
    "checked_at": "2026-06-24T12:00:00Z"
  }
]
```

**Authentication**: Session cookie required. Returns 401 if not admin.

### POST /api/health

Posts endpoint health check results (used by auto-endpoint-check.sh).

**Request body**:
```json
{
  "endpointId": "de-xhttp",
  "latencyMs": 150,
  "speedMbps": 50.5,
  "exitIp": "212.192.31.128",
  "pass": true,
  "sites": ["google.com", "youtube.com"]
}
```

**Authentication**: Bearer token required (`VPN_PANEL_HEALTH_API_KEY`).

**Response**:
```json
{ "ok": true }
```

**Logic**:
1. Validate API key
2. Upsert into `endpoint_health` table
3. Increment `pass_count` or `fail_count`
4. Return success

### POST /api/admin/deploy/:target

Triggers deployment to a remote VPS.

**Path parameters**:
- `target`: "vpn2", "server-44", "server-88", "router", or "all"

**Query parameters**:
- `dry_run`: "true" for validation only (no push)

**Response**:
```json
{ "ok": true, "log": "..." }
```

**Logic**:
1. Run `scripts/deploy-all.sh <target>`
2. Capture stdout/stderr
3. Return log output

**Authentication**: Session cookie required. Returns 401 if not admin.

### GET /api/admin/deploy/status

Returns last 100 lines of deploy log.

**Response**:
```json
{ "log": "..." }
```

**Authentication**: Session cookie required. Returns 401 if not admin.

### GET /api/admin/vps

Returns list of configured VPS servers.

**Response**:
```json
[
  {
    "id": "vpn2-bezrabotnyi-com",
    "host": "vpn2.bezrabotnyi.com",
    "port": 22,
    "username": "root",
    "label": "DE VPN Server"
  }
]
```

**Authentication**: Session cookie required. Returns 401 if not admin.

### POST /api/admin/vps

Adds a new VPS server.

**Request body**:
```json
{
  "id": "vpn3-new",
  "host": "185.240.120.152",
  "port": 22,
  "username": "root",
  "privateKey": "...",
  "label": "USA VPN Server"
}
```

**Response**:
```json
{ "ok": true }
```

**Logic**:
1. Add to `secure.vps_list`
2. Save to `secure.json`
3. Return success

**Authentication**: Session cookie required. Returns 401 if not admin.

### DELETE /api/admin/vps/:vpsId

Removes a VPS server.

**Response**:
```json
{ "ok": true }
```

**Logic**:
1. Remove from `secure.vps_list`
2. Save to `secure.json`
3. Return success

**Authentication**: Session cookie required. Returns 401 if not admin.

### GET /api/admin/vps/:vpsId/xray-config

Returns Xray config from remote VPS.

**Response**:
```json
{ "config": { ... } }
```

**Logic**:
1. SSH to remote VPS
2. Read `/usr/local/etc/xray/config.json`
3. Parse JSON
4. Return config

**Authentication**: Session cookie required. Returns 401 if not admin.

### PUT /api/admin/vps/:vpsId/xray-config

Updates Xray config on remote VPS.

**Request body**:
```json
{ "config": { ... } }
```

**Response**:
```json
{ "ok": true }
```

**Logic**:
1. Validate JSON
2. SSH to remote VPS
3. Backup current config
4. Write new config
5. Restart Xray service
6. Return success

**Authentication**: Session cookie required. Returns 401 if not admin.

### POST /api/admin/vps/:vpsId/xray-restart

Restarts Xray on remote VPS.

**Response**:
```json
{ "ok": true }
```

**Logic**:
1. SSH to remote VPS
2. Run `systemctl restart xray`
3. Return success

**Authentication**: Session cookie required. Returns 401 if not admin.

### POST /api/admin/vps/:vpsId/xray-sync-clients

Syncs Xray clients on remote VPS.

**Response**:
```json
{ "ok": true, "added": 5, "removed": 2 }
```

**Logic**:
1. Fetch all clients from panel database
2. SSH to remote VPS
3. Read current Xray config
4. Add missing clients, remove extra clients
5. Write updated config
6. Restart Xray
7. Return stats

**Authentication**: Session cookie required. Returns 401 if not admin.

### GET /api/admin/vps/:vpsId/xray-traffic

Returns traffic stats from remote VPS.

**Response**:
```json
{
  "inbounds": [
    { "tag": "de-xhttp", "up": 123456789, "down": 987654321 }
  ],
  "users": [
    { "email": "client-uuid", "up": 123456, "down": 654321 }
  ]
}
```

**Logic**:
1. SSH to remote VPS
2. Query Xray stats API (dokodemo-door on port 10085)
3. Parse response
4. Return stats

**Authentication**: Session cookie required. Returns 401 if not admin.

### POST /api/admin/vps/:vpsId/xray-reset-traffic

Resets traffic stats on remote VPS.

**Response**:
```json
{ "ok": true }
```

**Logic**:
1. SSH to remote VPS
2. Call Xray stats API to reset counters
3. Return success

**Authentication**: Session cookie required. Returns 401 if not admin.

### GET /api/admin/vps/:vpsId/xray-logs

Returns Xray logs from remote VPS.

**Query parameters**:
- `lines`: Number of lines to return (default: 100)

**Response**:
```json
{ "logs": "..." }
```

**Logic**:
1. SSH to remote VPS
2. Run `journalctl -u xray -n <lines> --no-pager`
3. Return output

**Authentication**: Session cookie required. Returns 401 if not admin.

### GET /api/admin/vps/:vpsId/xray-status

Returns Xray service status from remote VPS.

**Response**:
```json
{
  "status": "active",
  "version": "26.6.1",
  "uptime": "3 days ago"
}
```

**Logic**:
1. SSH to remote VPS
2. Run `systemctl status xray`
3. Run `xray version`
4. Parse output
5. Return status

**Authentication**: Session cookie required. Returns 401 if not admin.

### POST /api/admin/vps/:vpsId/xray-check-update

Checks for Xray updates on remote VPS.

**Response**:
```json
{
  "currentVersion": "26.6.1",
  "latestVersion": "26.7.0",
  "updateAvailable": true
}
```

**Logic**:
1. SSH to remote VPS
2. Get current version
3. Query GitHub API for latest release
4. Compare versions
5. Return result

**Authentication**: Session cookie required. Returns 401 if not admin.

### POST /api/admin/vps/:vpsId/xray-update

Updates Xray on remote VPS.

**Response**:
```json
{ "ok": true }
```

**Logic**:
1. SSH to remote VPS
2. Download latest Xray release
3. Stop Xray service
4. Extract and replace binaries
5. Start Xray service
6. Verify version
7. Return success

**Authentication**: Session cookie required. Returns 401 if not admin.

### GET /api/admin/happ-installs

Returns list of all Happ installs.

**Response**:
```json
[
  {
    "account_id": "123",
    "install_code": "code-here",
    "install_id": 456,
    "install_limit": 10,
    "status": 10,
    "note": "Иван",
    "happ_settings": { ... },
    "created_at": "2026-06-24T12:00:00Z",
    "updated_at": "2026-06-24T12:00:00Z"
  }
]
```

**Authentication**: Session cookie required. Returns 401 if not admin.

### DELETE /api/admin/happ-hwids/:hwidId

Deletes a Happ HWID.

**Response**:
```json
{ "ok": true }
```

**Logic**:
1. Delete from `happ_hwids` table
2. Call Happ API to delete HWID
3. Return success

**Authentication**: Session cookie required. Returns 401 if not admin.

## User API

All user endpoints require `role: "user"` authentication.

### GET /login

Returns login page HTML.

**Response**: HTML page with login form.

### POST /login

Authenticates a user.

**Request body** (form):
```
login=admin
password=secret
```

**Response**: Redirect to `/account` on success, `/login` on failure.

**Logic**:
1. Validate credentials
2. Create session
3. Set session cookie
4. Redirect to `/account`

### GET /account

Returns user account page HTML.

**Response**: HTML page with:
- User info (login, display name)
- Subscription links (plain, v2ray, happ, sing-box, xray-json)
- QR codes for each subscription
- Device list (Happ HWIDs)

**Authentication**: Session cookie required. Redirects to `/login` if not authenticated.

### DELETE /logout

Logs out the user.

**Response**: Redirect to `/login`.

**Logic**:
1. Delete session from database
2. Clear session cookie
3. Redirect to `/login`

### GET /sub/:token/plain

(See Public Endpoints section)

### GET /sub/:token/v2ray

(See Public Endpoints section)

### GET /sub/:token/happ

(See Public Endpoints section)

### GET /sub/:token/sing-box

(See Public Endpoints section)

### GET /sub/:token/xray-json

(See Public Endpoints section)

## Health/Monitoring

### GET /api/health

Returns panel health status.

**Response**:
```json
{
  "status": "ok",
  "database": "connected",
  "endpoints": 15,
  "users": 100
}
```

**Authentication**: None (public endpoint).

**Logic**:
1. Check database connection
2. Count endpoints
3. Count users
4. Return status

## Error Handling

### Standard Error Responses

**401 Unauthorized**:
```json
{ "error": "unauthorized" }
```

Returned when:
- Session cookie missing or expired
- API key missing or invalid
- User role does not match required role

**404 Not Found**:
```json
{ "error": "not found" }
```

Returned when:
- User/endpoint/VPS not found
- Token not found

**400 Bad Request**:
```json
{ "error": "invalid input" }
```

Returned when:
- Validation fails (Zod schema)
- Missing required fields
- Invalid field format

**500 Internal Server Error**:
```json
{ "error": "internal error" }
```

Returned when:
- Database query fails
- SSH connection fails
- Unexpected error

### Error Logging

All errors are logged to Fastify logger:

```typescript
app.log.error(error);
```

Logs include:
- Request ID
- Error message
- Stack trace
- Request metadata (URL, method, headers)

Logs are available via:

```bash
sudo journalctl -u autovpnallowip.service -n 100 --no-pager
```

# Admin Panel UI

## Page Structure

All HTML pages are rendered by `src/pages.ts` using template literal functions.

### Pages

| Function | Route | Purpose |
|----------|-------|---------|
| `loginPage(role)` | `/login`, `/admin` | Login form |
| `adminPage(data)` | `/admin` | Admin dashboard |
| `userDetailPage(user, endpoints, health)` | `/admin/users/:id` | User detail/edit |
| `accountPage(account, bundle, slots, baseUrl)` | `/account` | User self-service |
| `vpsPage(vpsList, stats)` | `/admin/vps` | VPS management |
| `testDashboardPage(endpoints, health)` | `/admin/tests` | Unified testing workspace |

### HTML Utilities

`src/html.ts` provides helper functions:

```typescript
escapeHtml(str: string): string  // Escape HTML entities
renderTable(headers, rows): string  // Render HTML table
renderForm(fields, action): string  // Render HTML form
```

## User Management

### Admin Dashboard (`adminPage()`)

**Route**: `GET /admin`

**Data**:
```typescript
{
  users: UserSummary[],
  endpoints: Endpoint[],
  health: EndpointHealth[],
  baseUrl: string,
  totalDevices: number
}
```

**UI elements**:
- **System stats**: Total users, total devices, total endpoints
- **User list table**:
  - Login, display name
  - Status (enabled/disabled)
  - Assigned endpoints (badges)
  - Device count (Happ HWIDs)
  - Actions: Edit, Delete, Rotate Token
- **Endpoint list table**:
  - Label, kind, address:port
  - Status (enabled/disabled)
  - Health (latency, speed, exit IP, last check)
- **Quick actions**:
  - Create User button
  - Deploy to VPS button
  - Refresh Health button

### Create User

**UI**: Modal form on admin dashboard

**Fields**:
- Login (text input)
- Display Name (text input)
- Password (password input)
- Xray UUID (text input with "Generate" button)
- Endpoints (checkboxes for each available endpoint)

**Submit**: `POST /api/admin/users`

**Validation**: Client-side (required fields, UUID format)

### Edit User

**UI**: User detail page (`userDetailPage()`)

**Route**: `GET /admin/users/:accountId`

**Data**:
```typescript
{
  user: UserSummary,
  endpoints: Endpoint[],
  health: EndpointHealth[]
}
```

**Fields**:
- Login (text input)
- Display Name (text input)
- Password (password input, optional)
- Enabled (checkbox)
- Endpoints (checkboxes for each available endpoint)

**Actions**:
- Save: `PUT /api/admin/users/:accountId`
- Delete: `DELETE /api/admin/users/:accountId`
- Rotate Token: `POST /api/admin/users/:accountId/rotate-token`
- Back to Dashboard: link to `/admin`

### Delete User

**UI**: Confirmation dialog on user detail page

**Action**: `DELETE /api/admin/users/:accountId`

**Confirmation**: "Are you sure? This will delete the user and all associated data."

### Rotate Token

**UI**: Button on user detail page

**Action**: `POST /api/admin/users/:accountId/rotate-token`

**Result**: Displays new token with QR code

**Use case**: User lost device or token compromised

## Endpoint Assignment

### How Admin Assigns VLESS Endpoints to Users

**UI**: Checkboxes on create/edit user form

**Flow**:
1. Admin opens create/edit user form
2. Form displays the four supported relay products first
3. Low-level routes are placed under a collapsed **Diagnostic transports** section
4. Each endpoint has a checkbox
5. Admin checks endpoints to assign
6. On submit, server updates `client_profiles` table

**Backend logic**:
```typescript
// Delete old assignments
await client.query("delete from client_profiles where client_id = $1", [clientId]);

// Insert new assignments
for (const endpointId of input.endpointIds) {
  await client.query(
    `insert into client_profiles (client_id, endpoint_id)
     values ($1, $2) on conflict do nothing`,
    [clientId, endpointId],
  );
}
```

**Result**: User subscriptions show the four canonical products first and the
assigned legacy direct transports afterwards as compatibility fallbacks.
VUSA fallbacks include Reality, XHTTP, XHTTP H2, HTTPUpgrade, direct WS, gRPC,
and two DNS-only hostnames on public `:443`, followed by direct
`us-xhttp-h2` on `:28443`.
Health results are path-specific, so a route that fails from the home LAN can
remain useful on a mobile or external network.

### Endpoint Display

**UI**: Endpoint list on admin dashboard

**Columns**:
- Label (e.g., "DE XHTTP")
- Kind (e.g., "vless-ws")
- Address:Port (e.g., "vpn2.bezrabotnyi.com:443")
- Status (enabled/disabled badge)
- Health (latency, speed, exit IP, last check)

**Health indicators**:
- Green: latency < 200ms, speed > 10Mbps
- Yellow: latency < 500ms, speed > 1Mbps
- Red: latency >= 500ms or speed <= 1Mbps or fail_count > pass_count

## Health Dashboard

### Endpoint Health Display

**UI**: Health column on endpoint list

**Data** (from `endpoint_health` table):
- Latency (ms)
- Speed (Mbps)
- Exit IP
- Pass count / Fail count
- Last check timestamp

**Auto-refresh**: Health data is updated hourly by `auto-endpoint-check.sh`

### Auto-Check Results

**Script**: `scripts/auto-endpoint-check.sh`

**Flow**:
1. Run hourly via systemd timer
2. Test each endpoint from server-44
3. Post results to `POST /api/health` with API key
4. Panel updates `endpoint_health` table

**Test method**:
- Connect to endpoint via Xray
- Fetch `https://api.ipify.org` through proxy
- Measure latency and speed
- Record exit IP

**Result**: Broken endpoints are auto-disabled for non-admin users.

## Unified Testing Workspace

**Route**: `GET /admin/tests`

Testing is intentionally presented as one continuous workspace instead of
separate tabs or duplicate cards on `/admin`:

The page has two independent selectors. **Источники теста** chooses enabled
IDs from `vpn-testing/test-plan.json` (SSH/Docker/native workers and Android
ADB on server-100). **Цели проверки** chooses HTTP checks; Reddit and Google
204 are disabled by default but can be re-enabled locally. The browser stores
these selections in localStorage and sends only IDs. The server resolves and
validates the SSH host, port, runner, mode, and engine, so arbitrary hosts
cannot be submitted from the UI.

Manual quick/benchmark runs use the selected source IDs. The hourly
`auto-endpoint-check.sh` policy run deliberately keeps its fixed matrix and is
not changed by the UI selection.

- clear summary of catalog size, currently working endpoints, attention items,
  and the latest health-check;
- current endpoint matrix with purpose, status, latency, site checks, and last
  check time;
- one visible history with filters for network, source, profile, endpoint,
  status, and date range;
- expandable run details backed by `vpn_test_events`, including readable target
  and profile labels plus artifacts;
- the legacy deep probe runner and its file results at the bottom of the same
  page.

`/admin` keeps only a short link card to this workspace so endpoint health and
probe data do not appear in two competing places.

## VPS Management UI

### VPS Page (`vpsPage()`)

**Route**: `GET /admin/vps`

**Data**:
```typescript
{
  vpsList: VpsConnectionConfig[],
  stats: Record<string, VpsSystemStats>
}
```

**UI elements**:
- **VPS list table**:
  - Label, host, port
  - Status (reachable/unreachable)
  - System stats (CPU, memory, disk, uptime)
  - Actions: Manage Xray, View Logs, Restart, Update
- **Add VPS button**: Opens form to add new VPS

### Xray Config Editor

**UI**: Code editor (textarea) on VPS detail page

**Route**: `GET /admin/vps/:vpsId/xray-config`

**Features**:
- Syntax highlighting (via browser)
- Validate button: `POST /api/admin/vps/:vpsId/xray-config` (dry-run)
- Save button: `PUT /api/admin/vps/:vpsId/xray-config`
- Restart button: `POST /api/admin/vps/:vpsId/xray-restart`

### Client Sync

**UI**: Button on VPS detail page

**Action**: `POST /api/admin/vps/:vpsId/xray-sync-clients`

**Result**: Displays stats (added, removed, updated)

**Use case**: Panel database and remote Xray are out of sync

### Traffic Stats

**UI**: Table on VPS detail page

**Route**: `GET /admin/vps/:vpsId/xray-traffic`

**Data**:
- Inbound traffic (tag, uplink, downlink)
- User traffic (email, uplink, downlink)

**Actions**:
- Reset stats: `POST /api/admin/vps/:vpsId/xray-reset-traffic`
- Refresh: reload page

### Xray Logs

**UI**: Log viewer (preformatted text) on VPS detail page

**Route**: `GET /admin/vps/:vpsId/xray-logs?lines=100`

**Features**:
- Line count selector (50, 100, 200, 500)
- Auto-refresh checkbox
- Download button

### Xray Status

**UI**: Status card on VPS detail page

**Route**: `GET /admin/vps/:vpsId/xray-status`

**Data**:
- Running (yes/no)
- PID
- Memory (MB)
- CPU time
- Uptime
- Version
- Update available (yes/no, with version)

**Actions**:
- Restart: `POST /api/admin/vps/:vpsId/xray-restart`
- Check for updates: `POST /api/admin/vps/:vpsId/xray-check-update`
- Update: `POST /api/admin/vps/:vpsId/xray-update` (with confirmation)

## User Self-Service

### Account Page (`accountPage()`)

**Route**: `GET /account`

**Data**:
```typescript
{
  account: Account,
  bundle: ClientBundle,
  slots: LinkSlot[],
  baseUrl: string
}
```

**UI elements**:
- **User info**: Login, display name
- **Subscription links**:
  - Plain (text)
  - v2ray (base64)
  - happ (routing link + plain)
  - sing-box (JSON)
  - xray-json (JSON)
- **QR codes**: One for each subscription format
- **Device list**: Happ HWIDs with device name, model, OS, app version, last seen
- **Actions**:
  - Copy link button
  - Download QR code
  - Delete device (Happ HWID)

### Subscription Links

**UI**: List of subscription links with copy buttons

**Formats**:
- Plain: `{baseUrl}/sub/{token}/plain`
- v2ray: `{baseUrl}/sub/{token}/v2ray`
- happ: `{baseUrl}/sub/{token}/happ`
- sing-box: `{baseUrl}/sub/{token}/sing-box`
- xray-json: `{baseUrl}/sub/{token}/xray-json`

**Copy button**: Copies link to clipboard via JavaScript

**QR code**: Generated via `qrcode` library, displayed as PNG

### Device List

**UI**: Table on account page

**Columns**:
- Device name
- Device model
- OS version
- App version
- Last seen
- Actions: Delete

**Delete action**: `DELETE /api/admin/happ-hwids/:hwidId`

**Use case**: User wants to free up device slot (Happ has device limit)

## Responsive Design

All pages are responsive (mobile-friendly):

- Tables stack on small screens
- Forms adjust width
- Buttons full-width on mobile
- Font sizes readable on small screens

**CSS**: Inline styles in `pages.ts` (no external CSS file)

**Breakpoints**:
- Mobile: < 768px
- Tablet: 768px - 1024px
- Desktop: > 1024px

## Accessibility

- Semantic HTML (headings, lists, tables)
- ARIA labels for interactive elements
- Keyboard navigation (tab order, focus indicators)
- Color contrast WCAG AA compliant
- Screen reader friendly (alt text for images, labels for inputs)

## Browser Support

- Chrome/Edge 90+
- Firefox 88+
- Safari 14+
- Mobile browsers (iOS Safari, Chrome Android)

**No legacy browser support** (IE11, old Edge)

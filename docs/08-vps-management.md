# VPS Management

## SSH Operations

### vps-ssh.ts

Located in `src/vps-ssh.ts`. Provides SSH-based operations on remote VPS servers.

**Connection**:
```typescript
type VpsConnectionConfig = {
  host: string;
  port: number;
  username: string;
  password?: string;
  privateKey?: string;
  passphrase?: string;
};
```

**Core functions**:
- `sshExec(config, command, timeout)` — Execute single command via SSH
- `connect(config)` — Establish SSH connection (ssh2 library)
- `exec(client, command, timeout)` — Execute command on connected client

**Timeout**: Default 15 seconds. Commands that exceed timeout are killed.

**Error handling**: All functions return `{ ok: boolean; error?: string }` or throw on connection failure.

## Xray Config Sync

### How Panel Pushes Configs to vpn2/vpn3

**Flow**:
1. Admin triggers deploy: `POST /api/admin/deploy/vpn2` or `POST /api/admin/vps/:vpsId/xray-config`
2. Panel generates Xray config:
   - `deServerConfig()` for vpn2 (DE endpoints)
   - `serverConfig()` for RU relays
3. Panel validates config locally (JSON syntax)
4. Panel SSHs to remote VPS
5. Panel writes config to `.pending.json`
6. Panel runs `xray run -test -config .pending.json` on remote
7. If validation passes:
   - Backup current config: `cp config.json config.json.bak_<timestamp>`
   - Replace: `mv .pending.json config.json`
   - Restart: `systemctl restart xray`
8. If validation fails:
   - Delete `.pending.json`
   - Return error

**Config write method** (`writeConfigViaExec()`):
```typescript
// Encode config as base64
const b64 = Buffer.from(configJson, "utf8").toString("base64");

// Write via python3 (avoids shell escaping issues)
const writeCmd = `python3 -c "
import base64
data = base64.b64decode('${b64}')
with open('/usr/local/etc/xray/config.pending.json', 'wb') as f:
    f.write(data)
print(len(data))
"`;

// Validate on remote
const validation = await exec(client, "/usr/local/bin/xray run -test -config /usr/local/etc/xray/config.pending.json 2>&1");
if (!validation.includes("Configuration OK")) {
  return { ok: false, error: validation.trim() };
}

// Replace
await exec(client, "cp /usr/local/etc/xray/config.json /usr/local/etc/xray/config.json.bak");
await exec(client, "mv /usr/local/etc/xray/config.pending.json /usr/local/etc/xray/config.json");
```

### updateXrayConfig()

Updates Xray config on remote VPS.

**Signature**:
```typescript
updateXrayConfig(config: VpsConnectionConfig, newConfig: string): Promise<{ ok: boolean; error?: string }>
```

**Flow**:
1. Connect to remote VPS
2. Write new config via `writeConfigViaExec()`
3. Return success/error

**Does not restart Xray**. Call `restartXray()` separately.

### restartXray()

Restarts Xray service on remote VPS.

**Signature**:
```typescript
restartXray(config: VpsConnectionConfig): Promise<{ ok: boolean; error?: string }>
```

**Flow**:
1. Run `systemctl restart xray`
2. Wait 2 seconds
3. Check `systemctl is-active xray`
4. Return success if "active"

## Client Sync

### syncXrayClients()

Syncs Xray clients (UUIDs) on remote VPS to match panel database.

**Signature**:
```typescript
syncXrayClients(
  config: VpsConnectionConfig,
  clientMap: Map<string, InboundClient[]>,
): Promise<{ ok: boolean; error?: string }>
```

**Flow**:
1. Connect to remote VPS
2. Read current Xray config
3. Parse JSON
4. For each inbound tag in `clientMap`:
   - Update `settings.clients` array with new client list
5. Write updated config via `writeConfigViaExec()`
6. Restart Xray
7. Return success/error

**Client map structure**:
```typescript
type InboundClient = {
  id: string;      // Xray UUID
  email: string;   // Client identifier (usually UUID)
  flow?: string;   // VLESS flow (e.g., "xtls-rprx-vision")
};

const clientMap = new Map<string, InboundClient[]>();
clientMap.set("de-reality", [
  { id: "uuid-1", email: "client-1", flow: "xtls-rprx-vision" },
  { id: "uuid-2", email: "client-2", flow: "xtls-rprx-vision" },
]);
```

**Used by**: `POST /api/admin/vps/:vpsId/xray-sync-clients`

**Logic**:
1. Fetch all clients from panel database
2. Group by assigned endpoints
3. Build `clientMap`
4. Call `syncXrayClients()`

## Traffic Stats

### getXrayStats()

Fetches raw Xray stats via stats API.

**Signature**:
```typescript
getXrayStats(config: VpsConnectionConfig): Promise<XrayStats[]>
```

**Flow**:
1. SSH to remote VPS
2. Run `/usr/local/bin/xray api statsquery --server=127.0.0.1:10085`
3. Parse JSON response
4. Return array of `{ name, value }` objects

**Stats API**: Xray exposes stats via dokodemo-door inbound on port 10085 (localhost only).

### getUserTraffic()

Extracts per-user traffic from Xray stats.

**Signature**:
```typescript
getUserTraffic(config: VpsConnectionConfig): Promise<XrayUserTraffic[]>
```

**Flow**:
1. Call `getXrayStats()`
2. Filter stats matching `user>>><email>>>traffic>>>(uplink|downlink)`
3. Group by email
4. Return array of `{ email, uplink_bytes, downlink_bytes, online }`

**Used by**: `GET /api/admin/vps/:vpsId/xray-traffic`

### getInboundTraffic()

Extracts per-inbound traffic from Xray stats.

**Signature**:
```typescript
getInboundTraffic(config: VpsConnectionConfig): Promise<XrayInboundTraffic[]>
```

**Flow**:
1. Call `getXrayStats()`
2. Filter stats matching `inbound>>><tag>>>traffic>>>(uplink|downlink)`
3. Group by tag
4. Return array of `{ tag, uplink_bytes, downlink_bytes }`

**Used by**: `GET /api/admin/vps/:vpsId/xray-traffic`

### resetTrafficStats()

Resets Xray traffic counters.

**Signature**:
```typescript
resetTrafficStats(config: VpsConnectionConfig): Promise<{ ok: boolean }>
```

**Flow**:
1. SSH to remote VPS
2. Run `/usr/local/bin/xray api stats --server=127.0.0.1:10085 --reset`
3. Return success

**Used by**: `POST /api/admin/vps/:vpsId/xray-reset-traffic`

## Health Monitoring

### getXrayStatus()

Checks Xray service status on remote VPS.

**Signature**:
```typescript
getXrayStatus(config: VpsConnectionConfig): Promise<{
  running: boolean;
  pid: number | null;
  memory_mb: number;
  cpu_time: string;
  uptime: string;
}>
```

**Flow**:
1. SSH to remote VPS
2. Run `systemctl show xray --property=ActiveState,MainPID`
3. Parse output
4. If running, get process stats via `ps`
5. Return status object

**Used by**: `GET /api/admin/vps/:vpsId/xray-status`

### getXrayLogs()

Fetches Xray logs from remote VPS.

**Signature**:
```typescript
getXrayLogs(config: VpsConnectionConfig, lines = 50): Promise<XrayLogEntry[]>
```

**Flow**:
1. SSH to remote VPS
2. Run `journalctl -u xray --no-pager -n <lines> --output=short-iso`
3. Fallback to `tail -n <lines> /var/log/xray/access.log`
4. Parse log lines
5. Return array of `{ timestamp, message }`

**Used by**: `GET /api/admin/vps/:vpsId/xray-logs?lines=100`

### getXrayVersion()

Gets Xray version on remote VPS.

**Signature**:
```typescript
getXrayVersion(config: VpsConnectionConfig): Promise<string>
```

**Flow**:
1. SSH to remote VPS
2. Run `/usr/local/bin/xray version | head -1`
3. Return version string (e.g., "Xray 26.6.1")

**Used by**: `getXrayStatus()`, `checkXrayUpdate()`

### checkXrayUpdate()

Checks for available Xray updates.

**Signature**:
```typescript
checkXrayUpdate(config: VpsConnectionConfig): Promise<XrayUpdateInfo>
```

**Flow**:
1. Get current version via `getXrayVersion()`
2. Query GitHub API: `https://api.github.com/repos/XTLS/Xray-core/releases?per_page=15`
3. Parse releases
4. Compare versions
5. Return `{ current_version, releases[] }`

**Used by**: `POST /api/admin/vps/:vpsId/xray-check-update`

### updateXray()

Updates Xray to a specific version on remote VPS.

**Signature**:
```typescript
updateXray(config: VpsConnectionConfig, targetVersion: string): Promise<XrayUpdateResult>
```

**Flow**:
1. SSH to remote VPS
2. Get current version
3. Stop Xray: `systemctl stop xray`
4. Backup binary: `cp /usr/local/bin/xray /usr/local/bin/xray.bak`
5. Download release: `curl -fsSL -o /tmp/xray.zip <download_url>`
6. Extract and replace: `unzip -o xray.zip && mv xray /usr/local/bin/xray`
7. Start Xray: `systemctl start xray`
8. Verify version
9. Return `{ ok, old_version, new_version }`

**On failure**: Rollback to backup binary, restart Xray.

**Used by**: `POST /api/admin/vps/:vpsId/xray-update`

## System Stats

### getSystemStats()

Fetches system stats from remote VPS.

**Signature**:
```typescript
getSystemStats(config: VpsConnectionConfig): Promise<VpsSystemStats>
```

**Flow**:
1. SSH to remote VPS
2. Run multiple commands in parallel:
   - `hostname -s`
   - `cat /etc/os-release | grep PRETTY_NAME`
   - `cat /proc/uptime`
   - `lscpu | grep 'Model name'`
   - `cat /proc/loadavg`
   - `free -m`
   - `df -h /`
   - `nproc`
3. Parse output
4. Return stats object

**Stats**:
```typescript
type VpsSystemStats = {
  hostname: string;
  os: string;
  uptime_seconds: number;
  cpu_count: number;
  cpu_model: string;
  cpu_load_1m: number;
  cpu_load_5m: number;
  cpu_load_15m: number;
  mem_total_mb: number;
  mem_used_mb: number;
  mem_available_mb: number;
  disk_total_gb: number;
  disk_used_gb: number;
  disk_available_gb: number;
  disk_use_percent: number;
};
```

**Used by**: `GET /api/admin/vps/:vpsId/system-stats`

## VPS Connection Config

### From secure.json

VPS connection configs are stored in `secure.json` `vps_list`:

```json
{
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

### VPS Selection

Panel API accepts `?vps=<vpsId>` query param to target a specific VPS:

```typescript
function vpsConfig(secure: SecureConfig, vpsId?: string): VpsConnectionConfig | null {
  if (secure.vps_list.length > 0) {
    let entry;
    if (vpsId) {
      entry = secure.vps_list.find((v) => v.id === vpsId);
    } else {
      entry = secure.vps_list[0]; // default to first
    }
    if (!entry) return null;
    // ... build config
  }
  // Fallback to legacy vps object
  if (!secure.vps.host) return null;
  // ... build config
}
```

**Default**: First VPS in `vps_list` (currently vpn2 DE).

### VPS CRUD

Admin API provides VPS management:

**List VPS**: `GET /api/admin/vps`

**Add VPS**: `POST /api/admin/vps`
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

**Delete VPS**: `DELETE /api/admin/vps/:vpsId`

**Logic**:
1. Update `secure.vps_list`
2. Save to `secure.json`
3. Return success

**Note**: Changes require panel restart to take effect (secure.json is loaded once at startup).

## SSH Key Authentication

### Key Setup

Panel uses SSH key authentication for VPS access:

**Key location**: `/home/roomhacker/.ssh/id_rsa` (on server-100)

**Key installation**:
```bash
# Copy public key to remote VPS
ssh-copy-id -i /home/roomhacker/.ssh/id_rsa root@vpn2.bezrabotnyi.com
ssh-copy-id -i /home/roomhacker/.ssh/id_rsa root@185.240.120.152
```

**Key in secure.json**:
```json
{
  "vps_list": [
    {
      "id": "vpn2-bezrabotnyi-com",
      "host": "vpn2.bezrabotnyi.com",
      "private_key": "<redacted-example-private-key>"
    }
  ]
}
```

**Alternative**: Use `password` field instead of `private_key` (less secure).

### SSH Host Aliases

For convenience, SSH config on server-100 defines host aliases:

```
Host vpn2
    HostName vpn2.bezrabotnyi.com
    User root
    IdentityFile /home/roomhacker/.ssh/id_rsa

Host server-44
    HostName 192.168.2.5
    User roomhacker
    IdentityFile /home/roomhacker/.ssh/id_rsa

Host roomhacker-server-88
    HostName 192.168.2.75
    User roomhacker
    IdentityFile /home/roomhacker/.ssh/id_rsa
```

This allows `ssh vpn2` instead of `ssh -i /home/roomhacker/.ssh/id_rsa root@vpn2.bezrabotnyi.com`.

# Scripts & Automation

> Ownership: VPN Panel owns product routing and deploy automation; see
> [../AGENTS.md](../AGENTS.md). Physical HAOS/OpenWrt/recovery topology belongs
> to `/home/roomhacker/ServersAdministartion`. The unified HAOS Smart Edge
> migration must satisfy both contracts.

## Deploy Scripts

### deploy-all.sh

**Purpose**: Deploy canonical configs to explicit remote VPN/backend targets.
It is not the selected LAN SmartDNS/Smart Edge deploy path.

**Location**: `scripts/deploy-all.sh`

**Usage**:
```bash
scripts/deploy-all.sh vpn2           # specific target
scripts/deploy-all.sh vusa           # USA backend
scripts/deploy-all.sh server-44 server-88  # multiple targets
```

Do not run the no-argument/`all`, `smartdns`, `router-dns`, or `router` forms
for LAN migration. Those routes still encode server-100 SmartDNS and router
HAProxy and are retired. `scripts/deploy-smartdns-unified.sh`, router-HAProxy
deploy scripts, and router-HAProxy watchdog install/deploy routes are likewise
retired and must not be run.

Active explicit backend targets remain `vpn2`, `vusa`, `server-44`, and
`server-88`. The selected LAN path is the unified HAOS add-on: bundled sing-box
`1.13.14`, private HTTP listener `127.0.0.1:13128`, SmartDNS `:53`, and TCP edge
`:443`, plus simple OpenWrt forwarding. It does not depend on external
`local_singbox_proxy :3128`.
Public DoH/DoT, recovery HAProxy `:8080`/`:8443`, and Telegram IP TPROXY remain
separate and are not retired by this change.

**Flow per target**:
1. Generate canonical config from panel + extras
2. Validate config locally
3. Backup current config on remote
4. Push via SSH
5. Validate on remote
6. Replace + restart service
7. Smoke test
8. Rollback on failure

**Details**: See [Infrastructure & Deployment](07-infrastructure-deployment.md)

### deploy-reality-443.sh

**Purpose**: Deploy Reality endpoint on port 443 with nginx stream SNI routing

**Location**: `scripts/deploy-reality-443.sh`

**Usage**:
```bash
scripts/deploy-reality-443.sh
```

**Flow**:
1. Generate Xray config with Reality inbound on port 24443
2. Configure nginx stream SNI routing on port 443
3. Validate configs
4. Restart nginx and Xray
5. Test Reality connection

**Ports tried** (auto-fallback): 443, 4443, 8443

**Rollback**: Automatic on failure (restore previous configs)

**Use case**: Initial setup of Reality endpoint on vpn2.

### VUSA Xray + nginx transport mirror

`scripts/deploy-all.sh vusa` regenerates the Xray server config with the same
active client UUIDs on every inbound, deploys the canonical nginx path router
from `deploy/vusa/nginx/edge-https.conf`, validates both configurations, keeps
timestamped remote backups, restarts Xray, and reloads nginx. The separate
`scripts/smart-edge-deploy.mjs deploy vusa` owns public `:443` SNI dispatch and
preserves GPTAdmin routes.

## Testing Scripts

### test-endpoints.sh

**Purpose**: Test all VPN endpoints from local machine

**Location**: `scripts/test-endpoints.sh`

**Usage**:
```bash
scripts/test-endpoints.sh
```

**Flow**:
1. Fetch subscription from panel
2. Parse VLESS links
3. For each endpoint:
   - Generate Xray client config
   - Start Xray locally
   - Test connection via SOCKS proxy
   - Fetch `https://api.ipify.org`
   - Check exit IP
   - Stop Xray
4. Print results

**Output**:
```
Testing endpoints...
✓ de-reality: 212.192.31.128 (DE)
✓ de-xhttp: 212.192.31.128 (DE)
✗ de-cdn: timeout
✓ us-reality: 185.240.120.152 (USA, :443)
✓ us-xhttp-h2-443: 185.240.120.152 (USA, :443)
✓ us-cdn: 185.240.120.152 (USA, :443)
✓ us-cdn2: 185.240.120.152 (USA, :443)
✓ us-xhttp-h2: 185.240.120.152 (USA, :28443)
```

**Requirements**:
- Local Xray installed
- Panel running
- Internet connection

### test-routing.sh

**Purpose**: Test routing logic (RU direct, World proxy)

**Location**: `scripts/test-routing.sh`

**Usage**:
```bash
scripts/test-routing.sh
```

**Flow**:
1. Start Xray with test config
2. Test Russian sites (should go direct):
   - `https://ya.ru`
   - `https://vk.com`
   - `https://mail.ru`
3. Test international sites (should go via VPN):
   - `https://google.com`
   - `https://youtube.com`
   - `https://twitter.com`
4. Check exit IPs
5. Print results

**Output**:
```
Testing routing...
RU direct:
  ya.ru: 95.165.165.65 (direct) ✓
  vk.com: 95.165.165.65 (direct) ✓
World proxy:
  google.com: 212.192.31.128 (DE) ✓
  youtube.com: 212.192.31.128 (DE) ✓
```

**Requirements**:
- Local Xray installed
- VPN endpoint accessible

### vpn-bench.sh

**Purpose**: Compatibility entrypoint for the shared `benchmark` profile.

**Location**: `scripts/vpn-bench.sh`

**Usage**:
```bash
VPN_TOKEN=xxx ENDPOINTS="de-xhttp,us-xhttp-h2" scripts/vpn-bench.sh
```

**Flow**:
1. Load the versioned plan from `vpn-testing/test-plan.json`.
2. Run preflight, gate, site, UDP, target-network QUIC, and throughput stages.
3. Emit `stage_started` and every completed stage immediately to `/api/telemetry/vpn-tests/events`; the admin history polls the same indexed runs while a test is active. Failed posts are retained under `<spool-root>/<run-id>/` and the next runner start replays pending JSON events from every run UUID root under the configured spool root (default `vpn-testing/results/spool`).
4. Write one common-schema JSON result under `vpn-testing/results/`.

**Output**:
```
Benchmarking de-xhttp...
  Download: 50.5 Mbps
  Upload: 25.3 Mbps
  Latency: 150 ms
Results saved to bench-results/bench-de-xhttp-20260624_120000.json
```

**Requirements**:
- Local Xray installed
- `curl` with SOCKS support

### run-bench-everywhere.sh

**Purpose**: Run the same plan in parallel across selected, allowlisted test targets.

**Location**: `scripts/run-bench-everywhere.sh`

**Usage**:
```bash
scripts/run-bench-everywhere.sh
```

**Flow**:
The registry is the `testTargets` array in `vpn-testing/test-plan.json`. It
currently contains server-44 Xray Docker, server-44 sing-box HTTP/SOCKS, Mac
native Xray, and Android 4G. Android is reached through
`roomhacker@192.168.2.100` (server-100), where ADB is available; it is not a
server-44 target. The wrapper loads `.env` and requires a telemetry key so a
benchmark cannot silently run without posting or durably spooling its events.
Use `TARGETS="lan-server44 external-mac"` for an explicit registry selection;
legacy selectors remain accepted: `HOSTS="s44 mac android"`.

Each target declares `runner`, `sshHost`, `sshPort`, `mode`, and `engine`; an
Android target also declares its explicit `adbSerial`.
`run-network-test.sh` resolves those fields from the copied plan, so adding a
worker means adding one allowlisted entry and deploying the same repository
checkout there. SSH keys remain in the worker's SSH configuration; they are not
sent by the browser or stored in the plan.

**Output**:
```
Running benchmarks everywhere...
Mac:     de-xhttp: 50.5 Mbps
server-44: de-xhttp: 48.2 Mbps
```

**Requirements**:
- Mac SSH access configured
- Xray installed on Mac and server-44

## Monitoring Scripts

### auto-endpoint-check.sh

**Purpose**: Hourly endpoint health check

**Location**: `scripts/auto-endpoint-check.sh`

**Usage**:
```bash
# Run manually
scripts/auto-endpoint-check.sh

# Run via systemd timer (hourly)
sudo systemctl start vpn-endpoint-check.timer
```

**Flow**:
1. Run the shared `health` profile on `lan-server44`.
2. Verify HTTP gates, site ratio, and the exact DE/US exit IP promised by each product.
3. Apply only healthy members of the four-product catalog to normal clients.
4. If the run proves `0/4` canonical relays eligible, keep legacy fallbacks but
   do not re-enable the broken canonical products for normal clients; exit `3`
   so systemd/monitoring records a real failure.
5. Update the legacy `endpoint_health` projection for existing UI consumers.

The hourly policy matrix is fixed and is not changed by the admin UI target
selector. The Android worker itself is on server-100; the registry entry
`external-wireless-android` reaches it through `roomhacker@192.168.2.100`.

## Unified result storage

- `vpn_test_events`: append-only per-stage telemetry; useful after runner crashes.
- `vpn_test_runs`: indexed run summaries for UI filters and aggregation.
- `vpn-testing/results/`: default location for immutable local result JSON and the durable telemetry spool. The spool root can be overridden with `TELEMETRY_SPOOL_DIR`; pending event files are partitioned by run UUID and replayed across all run roots on the next runner start.
- Optional Yandex Object Storage/S3 fallback: set `TELEMETRY_S3_URI`,
  `TELEMETRY_S3_ENDPOINT=https://storage.yandexcloud.net`, and standard AWS
  credentials. The runner uses the AWS CLI when installed or direct SigV4 PUT.

The admin `/admin/tests` page shows the unified history directly. When a run is
started with `--output <path>`, its `run_finished` event carries `artifactPath`
and history exposes the corresponding JSON artifact link; stdout-only runs have
no artifact link. Historical JSON can be imported idempotently with
`npm run import:test-history`. A score of `null` means that no effective
observations exist: the UI displays `—`/unknown and subscription filtering does
not coerce that value to zero.

**Output**: Logged to `logs/endpoint-check.log`

**Systemd timer**: `vpn-endpoint-check.timer` (hourly)

**Requirements**:
- Local Xray installed
- `VPN_PANEL_HEALTH_API_KEY` environment variable

### quick-health-check.sh (diagnostic only)

**Purpose**: Quick health check for all endpoints

**Location**: `scripts/quick-health-check.sh`

**Usage**:
```bash
scripts/quick-health-check.sh
```

**Flow**:
1. For each endpoint in `secure.json`:
   - Try TCP connect to address:port
   - Measure latency
2. Print results

**Output**:
```
Quick health check...
✓ de-reality: 212.192.31.128:443 (150ms)
✓ de-xhttp: 212.192.31.128:443 (152ms)
✗ de-cdn: cdn.demiurge.space:443 (timeout)
```

**Use case**: Raw TCP diagnosis only. It does not influence subscriptions; the
shared `quick`, `health`, and `benchmark` profiles are the source of truth.

## Setup Scripts

### setup-mac.sh

**Purpose**: Setup Mac for VPN testing

**Location**: `scripts/setup-mac.sh`

**Usage**:
```bash
scripts/setup-mac.sh
```

**Flow**:
1. Install Xray via Homebrew
2. Install Python 3 via Homebrew
3. Install curl with SOCKS support
4. Configure SSH access from server-100
5. Test Xray installation

**Output**:
```
Setting up Mac for VPN testing...
✓ Xray installed: 26.3.27
✓ Python 3 installed: 3.11.5
✓ curl installed: 8.4.0
✓ SSH access configured
Setup complete.
```

**Requirements**:
- macOS with Homebrew
- Internet connection

### issue-vps-cert.sh

**Purpose**: Issue Let's Encrypt certificate for VPS

**Location**: `scripts/issue-vps-cert.sh`

**Usage**:
```bash
scripts/issue-vps-cert.sh <domain>
```

**Flow**:
1. Install certbot via apt
2. Stop nginx (to free port 80)
3. Run certbot standalone mode
4. Start nginx
5. Copy certs to Xray directory
6. Set permissions

**Output**:
```
Issuing certificate for vpn2.bezrabotnyi.com...
✓ Certificate issued
✓ Certificate installed to /etc/letsencrypt/live/vpn2.bezrabotnyi.com/
✓ Permissions set for Xray
```

**Requirements**:
- Domain pointing to VPS IP
- Port 80 accessible
- sudo access

## Utility Scripts

### cert-hooks/

**Purpose**: Certbot hooks for certificate renewal

**Location**: `scripts/cert-hooks/`

**Files**:
- `regru_api.py` — DNS-01 challenge hook for reg.ru DNS API

**Usage**:
```bash
certbot certonly --manual --preferred-challenges dns \
  --manual-auth-hook /path/to/regru_api.py \
  -d vpn2.bezrabotnyi.com
```

**Flow**:
1. Certbot requests DNS-01 challenge
2. Hook script calls reg.ru API to add TXT record
3. Certbot validates DNS
4. Certificate issued

**Requirements**:
- reg.ru account with API access
- Python 3 with requests library

### LAN US one-off launchers — removed

`xray-lan-us.sh`, `xray-server88-lan-us.sh`, and `singbox-lan-us.sh` embedded
stale endpoint material and created configurations outside the central deploy
path. The active `192.168.2.1:3127` lane is now a scoped OpenWrt hairpin
DNAT/SNAT to the unified HAOS Smart Edge at `192.168.2.101:3127`. Its bundled
sing-box routes the dedicated `lan-us-http` inbound through `us-regional`; the
add-on healthcheck fails when the listener is absent. The older server-88
implementation remains a rollback path generated by `scripts/deploy-all.sh
server-88`. The retired external HAOS `local_singbox_proxy :3128` is not
involved.

## Automation Patterns

### Systemd Timers

**auto-endpoint-check.timer**:
```ini
[Unit]
Description=Hourly VPN endpoint health check

[Timer]
OnCalendar=hourly
Persistent=true

[Install]
WantedBy=timers.target
```

**auto-endpoint-check.service**:
```ini
[Unit]
Description=VPN endpoint health check

[Service]
Type=oneshot
User=roomhacker
WorkingDirectory=/home/roomhacker/apps/vpn-panel
ExecStart=/home/roomhacker/apps/vpn-panel/scripts/auto-endpoint-check.sh
Environment=DATABASE_URL=postgres://...
Environment=VPN_PANEL_HEALTH_API_KEY=...
```

**Enable timer**:
```bash
sudo systemctl enable vpn-endpoint-check.timer
sudo systemctl start vpn-endpoint-check.timer
```

### Cron Jobs (alternative)

```bash
# Hourly endpoint check
0 * * * * /home/roomhacker/apps/vpn-panel/scripts/auto-endpoint-check.sh >> /home/roomhacker/apps/vpn-panel/logs/endpoint-check.log 2>&1

# Daily subscription consistency check
0 0 * * * /home/roomhacker/apps/vpn-panel/scripts/check-subscription-consistency.sh >> /home/roomhacker/apps/vpn-panel/logs/subscription-check.log 2>&1
```

## Script Best Practices

### Error Handling

```bash
#!/usr/bin/env bash
set -euo pipefail

# Exit on error
set -e

# Exit on undefined variable
set -u

# Exit on pipe failure
set -o pipefail

# Trap errors
trap 'echo "Error on line $LINENO"; exit 1' ERR
```

### Logging

```bash
log() {
  echo "[$(date -Iseconds)] $*" | tee -a logs/script.log
}

log "Starting script..."
log "Step 1 complete"
log "Error: something failed"
```

### SSH Commands

```bash
# Use SSH key
ssh -i /home/roomhacker/.ssh/id_rsa root@vpn2.bezrabotnyi.com 'command'

# Disable strict host key checking (for automation)
ssh -o StrictHostKeyChecking=accept-new root@vpn2.bezrabotnyi.com 'command'

# SCP with key
scp -i /home/roomhacker/.ssh/id_rsa file.txt root@vpn2.bezrabotnyi.com:/tmp/
```

### Validation

```bash
# Validate JSON
python3 -c "import json; json.load(open('config.json'))" || { echo "Invalid JSON"; exit 1; }

# Validate Xray config
xray run -test -config config.json 2>&1 | grep -q "Configuration OK" || { echo "Invalid config"; exit 1; }

# Validate sing-box config
sing-box check -c config.json || { echo "Invalid config"; exit 1; }
```

### Rollback

```bash
# Backup before changes
cp config.json config.json.bak_$(date -u +%Y%m%d_%H%M%S)

# On error, rollback
if ! validate_config; then
  echo "Validation failed, rolling back..."
  cp config.json.bak_* config.json
  exit 1
fi
```

## Creating New Scripts

### Template

```bash
#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
PANEL_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"

log() {
  echo "[$(date -Iseconds)] $*" | tee -a "$PANEL_DIR/logs/script.log"
}

log "Starting script..."

# ... main logic

log "Script complete"
```

### Best Practices

1. **Shebang**: `#!/usr/bin/env bash` (portable)
2. **Strict mode**: `set -euo pipefail`
3. **Logging**: Use `log()` function
4. **Error handling**: Trap errors, rollback on failure
5. **Validation**: Validate configs before applying
6. **Backups**: Backup before changes
7. **SSH keys**: Use `-i` flag for SSH key
8. **Idempotent**: Safe to run multiple times
9. **Dry-run**: Add `--dry-run` flag for testing
10. **Help**: Add `--help` flag with usage

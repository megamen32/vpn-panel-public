# Certificates (Let's Encrypt via reg.ru DNS-01)

## Overview

All VPN server certs are issued via Let's Encrypt **DNS-01** challenge through
the reg.ru API. The certs are 90 days max, but with auto-renewal via systemd
timer, they're effectively "long-period" (always valid).

## Why DNS-01

- No port 80 / nginx required (works behind any firewall)
- Renewal works even if Xray/nginx is down
- More reliable than HTTP-01 for non-public servers

## Architecture

```
certbot on VPS  →  HTTP POST to https://vpn.bezrabotnyi.com/api/admin/cert/regru
                  (uses panel HEALTH_API_KEY as Bearer token)
                         ↓
              panel runs scripts/cert-hooks/regru_api.py
                         ↓
              reg.ru API (whitelisted for 95.165.165.65 / server-100)
                         ↓
              _acme-challenge.{vpn2|vusa}.bezrabotnyi.com TXT record added/removed
                         ↓
              LE validates DNS-01, issues cert
```

The VPSes call back through `vpn.bezrabotnyi.com` (publicly reachable via
OpenWrt forwarding) instead of the LAN-only server-100, so the same mechanism
works for VPSes on any network.

## Single script for all VPSes

```bash
# On server-100
scripts/issue-vps-cert.sh --list                # list known VPSes
scripts/issue-vps-cert.sh vpn2                  # issue/renew vpn2 cert
scripts/issue-vps-cert.sh vusa                  # issue/renew vusa cert
scripts/issue-vps-cert.sh vpn2 --dry-run        # test mode (certbot --dry-run)
```

The script:
1. Reads the VPS list (currently `vpn2` and `vusa`) and pushes
   granted auth/cleanup hooks to `/opt/cert-hooks/` on the VPS
2. Ensures `certbot` is installed
3. Runs `certbot certonly --manual --preferred-challenges dns` with the hooks
4. Sets up `certbot.timer` for automatic renewal

## Panel endpoint

`POST /api/admin/cert/regru` (auth: Bearer HEALTH_API_KEY or admin session)
takes `{action: "auth"|"cleanup", subdomain, value, zone}` and proxies to reg.ru.

## Hooks deployed on each VPS

- `/opt/cert-hooks/regru-auth-hook.sh` — adds the TXT record
- `/opt/cert-hooks/regru-cleanup-hook.sh` — removes the TXT record

Both use Python (via heredoc) for safe JSON construction. The env vars
`API_URL`, `API_KEY`, `ACTION`, `SUBDOMAIN`, `VAL`, `ZONE` are exported
to the python subprocess.

## reg.ru DNS quirks

1. **TXT propagation delay**: reg.ru's DNS API accepts TXT records but the
   nameserver takes **~30 seconds** to start serving them. Certbot's
   default 60s wait is enough for issuance.

2. **Cleanup timing**: The cleanup hook is called immediately after auth
   (before validation succeeds), so the stale TXT can leak briefly.
   Always clean up after cancelled/failed runs:
   ```bash
   python3 scripts/cert-hooks/regru_api.py  # set REGRU_ACTION=cleanup, etc.
   ```

3. **Whitelisted IP**: reg.ru's API only accepts requests from 95.165.165.65
   (server-100's public IP). The VPSes can't call reg.ru directly; they
   must go through the panel endpoint.

4. **Wildcard `*`**: reg.ru has a `*.bezrabotnyi.com → 95.165.165.65` A
   record. Specific records (e.g., `vusa → 185.240.120.152`) override the
   wildcard when queried by reg.ru NS, but local DNS resolvers (like the
   OpenWrt dnsmasq hijack on server-100) may return the wildcard first.
   See RUNBOOK.md for the workaround.

## Let's Encrypt rate limit

LE has a `5 failed authorizations per identifier per 1h` limit. If a run
fails repeatedly (e.g. certbot is killed mid-run), wait ~1h before retrying.
The error message includes `retry after YYYY-MM-DD HH:MM:SS UTC`.

Workarounds:
- Use `--dry-run` to test without using the rate limit
- Wait for the window to expire (1h from first failure)
- Switch to a different identifier (e.g., add a subdomain)

## Auto-renewal

After the first successful run, `certbot.timer` is enabled on the VPS:

```bash
systemctl list-timers certbot.timer
# NEXT: e.g. Tue 2026-06-23 07:10:33 MSK (15h-2d before expiry)
```

Certbot will automatically renew 30 days before expiry using the same
DNS-01 chain. No manual intervention needed.

## Cert state (2026-06-22)

| VPS | Cert path | Status | Notes |
|-----|-----------|--------|-------|
| vpn2 | `/etc/letsencrypt/live/vpn2.bezrabotnyi.com/` | LE DNS-01, renewed | Serial `5dfb...24b76a`, expiry 2026-09-20 |
| vusa | `/etc/letsencrypt/live/vusa.bezrabotnyi.com/` | LE HTTP-01, issued | Serial `5fa8137556fd95086e48b057f18d08a0a04`, expiry 2026-09-20 |

## Cert perms on VPSes

Xray runs as `nobody:nogroup` and needs to read the cert. The cert files
are owned by `root:proxy` with mode 0644 (fullchain) and 0640 (privkey), and
`nobody` is added to the `proxy` group via a systemd drop-in.

The certbot package on Debian/Ubuntu creates certs in `/etc/letsencrypt/{live,archive}/`
owned by `root:proxy` (not `root:nogroup`). The fix is the same on both vpn2 and vusa:
```bash
chown -R root:proxy /etc/letsencrypt/live /etc/letsencrypt/archive
chmod 0755 /etc/letsencrypt/live /etc/letsencrypt/archive
chmod 0644 /etc/letsencrypt/live/*/fullchain.pem /etc/letsencrypt/live/*/chain.pem
chmod 0640 /etc/letsencrypt/live/*/privkey.pem
usermod -aG proxy nobody
# Also add drop-in for systemd:
mkdir -p /etc/systemd/system/xray.service.d
cat > /etc/systemd/system/xray.service.d/20-supplementary-proxy.conf <<EOF
[Service]
SupplementaryGroups=proxy
EOF
systemctl daemon-reload && systemctl restart xray
```

`scripts/issue-vps-cert.sh` runs this fix-up automatically for `http-01` method.

## Renewal history

### vpn2 (LE DNS-01)

| Date | Serial | Notes |
|------|--------|-------|
| 2025-08-15 | (initial) | First LE cert via DNS-01 |
| 2026-05-31 | (renewal) | Manual certbot renewal |
| 2026-06-15 | (renewal) | Manual certbot renewal |
| 2026-06-22 | `5dfb...24b76a` | First DNS-01 cert via reg.ru API (new flow) |

### vusa (LE HTTP-01)

| Date | Serial | Notes |
|------|--------|-------|
| 2026-06-22 | `5fa8137556fd95086e48b057f18d08a0a04` | First LE cert via HTTP-01 (DNS-01 blocked by reg.ru NS wildcard) |

## When LE cert fails or is unavailable

For test setups or when rate limits are hit, use a self-signed cert:

```bash
mkdir -p /etc/letsencrypt/live/<host>
openssl req -x509 -nodes -newkey rsa:2048 -days 365 \
  -keyout /etc/letsencrypt/live/<host>/privkey.pem \
  -out /etc/letsencrypt/live/<host>/fullchain.pem \
  -subj "/CN=<host>" \
  -addext "subjectAltName=DNS:<host>"
chown -R root:proxy /etc/letsencrypt/live /etc/letsencrypt/archive
chmod 0644 /etc/letsencrypt/live/<host>/fullchain.pem
chmod 0640 /etc/letsencrypt/live/<host>/privkey.pem
```

Clients connecting to the self-signed cert must use `--insecure` / `verify=False`.

## reg.ru NS wildcard issue (CRITICAL)

**Symptom**: reg.ru NS returns the wildcard `* → 95.165.165.65` A record for
ALL subdomains, even when specific records exist. The specific record exists
in reg.ru's DB but is not served by their NS.

**Verified via**:
- `dig a-test-XXXX.bezrabotnyi.com A @ns1.reg.ru` → returns 95.165.165.65 (wildcard)
- `dig a-test-XXXX.bezrabotnyi.com A @8.8.8.8` → returns 1.2.3.4 (specific, correct)

**Impact**:
- DNS-01 challenge for vusa.bezrabotnyi.com FAILS because LE queries reg.ru NS
  and gets 95.165.165.65 (server-100), then tries to connect there, gets
  server-100's cert (not vusa's), validation fails.
- Affects any subdomain added under the wildcard `*.bezrabotnyi.com`.

**Workaround**:
- Use HTTP-01 challenge instead of DNS-01 for subdomains covered by the wildcard
- Or use a different DNS provider for the zone
- Or remove the wildcard `*` from reg.ru (but breaks all other subdomains)

**HTTP-01 for vusa** (current method, automated by `issue-vps-cert.sh vusa`):
```bash
# On vusa, install nginx + certbot plugin
apt-get install -y nginx certbot python3-certbot-nginx

# Configure vhost for vusa.bezrabotnyi.com on port 80
cat > /etc/nginx/sites-enabled/vusa.bezrabotnyi.com <<'NGINX'
server {
    listen 80;
    server_name vusa.bezrabotnyi.com;
    location / { return 200 'ok'; add_header Content-Type text/plain; }
}
NGINX
rm -f /etc/nginx/sites-enabled/default
systemctl reload nginx

# Issue cert via HTTP-01
certbot certonly --nginx -d vusa.bezrabotnyi.com

# Fix cert perms (Xray runs as nobody:nogroup, but cert is root:proxy)
chown -R root:proxy /etc/letsencrypt/live /etc/letsencrypt/archive
chmod 0755 /etc/letsencrypt/live /etc/letsencrypt/archive
chmod 0644 /etc/letsencrypt/live/*/fullchain.pem
chmod 0640 /etc/letsencrypt/live/*/privkey.pem
usermod -aG proxy nobody
echo -e "[Service]\nSupplementaryGroups=proxy" > /etc/systemd/system/xray.service.d/20-supplementary-proxy.conf
systemctl daemon-reload && systemctl restart xray
```

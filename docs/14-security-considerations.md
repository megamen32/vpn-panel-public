# Security Considerations

## Sensitive Data

### What's Sensitive

The following data must be protected:

1. **UUIDs**: Xray client UUIDs (used in VLESS links)
2. **Tokens**: Subscription tokens (grant access to VPN)
3. **Reality keys**: Public/private keys for Reality TLS
4. **Short IDs**: Reality short IDs
5. **VPS credentials**: SSH passwords, private keys, passphrases
6. **Happ API keys**: Auth keys for Happ proxy API
7. **Session secrets**: Cookie signing keys
8. **Database credentials**: PostgreSQL connection strings
9. **Admin passwords**: Panel admin account passwords
10. **Auth proxy credentials**: HTTP/SOCKS proxy credentials (root/<redacted>)

### Sensitivity Levels

| Data | Sensitivity | Exposure Impact |
|------|-------------|-----------------|
| Reality private key | Critical | Full VPN compromise |
| VPS SSH private key | Critical | Full VPS access |
| Admin password | High | Panel compromise |
| Subscription tokens | High | Unauthorized VPN access |
| Xray UUIDs | Medium | Client impersonation |
| Session secrets | Medium | Session hijacking |
| Auth proxy credentials | Medium | Proxy abuse |
| Database credentials | Medium | Database access |
| Happ API keys | Low | Happ account abuse |
| Reality public keys | Low | No impact (public) |

## Storage Security

### secure.json

**Location**: `/etc/vpn-panel/secure.json`

**Contents**: UUIDs, tokens, Reality keys, VPS credentials, Happ API keys

**Permissions**:
```bash
sudo chown roomhacker:roomhacker /etc/vpn-panel/secure.json
sudo chmod 600 /etc/vpn-panel/secure.json
```

**Why 600**: Only owner (roomhacker) can read/write. No group or other access.

**Backup**: Exclude from git (`.gitignore`), backup separately.

### .env

**Location**: `/home/roomhacker/apps/vpn-panel/.env`

**Contents**: `DATABASE_URL`, `VPN_PANEL_SESSION_SECRET`, `VPN_PANEL_ADMIN_PASSWORD`

**Permissions**:
```bash
chmod 600 .env
```

**Why 600**: Only owner can read/write. Prevents accidental exposure.

**Git**: Excluded via `.gitignore`.

### Database

**Location**: PostgreSQL on server-100

**Contents**: Accounts, passwords (hashed), tokens, endpoints, sessions

**Access**:
- Local only (127.0.0.1:5432)
- Password-protected
- Role-based access control

**Backup**: Regular pg_dump backups, encrypted at rest.

### SSH Keys

**Location**: `/home/roomhacker/.ssh/id_rsa`

**Contents**: SSH private key for VPS access

**Permissions**:
```bash
chmod 600 /home/roomhacker/.ssh/id_rsa
chmod 644 /home/roomhacker/.ssh/id_rsa.pub
```

**Passphrase**: Recommended (stored in secure.json if needed).

**Backup**: Exclude from git, backup separately.

### Backup Files

**Location**: `*.bak_*` files throughout project

**Contents**: Timestamped backups of configs, secure.json, etc.

**Permissions**: Same as original files

**Git**: Excluded via `.gitignore`

**Cleanup**: Periodically delete old backups (retain last 10).

## Network Security

### Auth Proxies

**Location**: vpn2 (212.192.31.128)

**Services**:
- HTTP proxy: `https://root:<redacted>@vpn2.bezrabotnyi.com:3128`
- SOCKS proxy: `vpn2.bezrabotnyi.com:1080` (SOCKS5+TLS+password)

**Credentials**: root / <redacted>

**Security**:
- TLS encryption (Let's Encrypt cert)
- Password authentication
- Rate limiting (recommended)
- IP whitelist (recommended)

**Risk**: Credentials exposed in URLs. Mitigate by:
- Using strong password
- Monitoring for abuse
- Rotating credentials periodically

### SOCKS+TLS

**Port**: 1080 on vpn2

**Binding**: 212.192.31.128:1080 (not 127.0.0.1 to avoid clash with `whitetransportd`)

**Authentication**: SOCKS5 username/password

**TLS**: Let's Encrypt cert for vpn2.bezrabotnyi.com

**Testing**:
```bash
python3 -c "
import socket, ssl, struct
ctx = ssl.create_default_context(); ctx.check_hostname=False; ctx.verify_mode=ssl.CERT_NONE
s = ctx.wrap_socket(socket.create_connection(('vpn2.bezrabotnyi.com', 1080)), server_hostname='vpn2.bezrabotnyi.com')
s.sendall(bytes([0x05,0x02,0x00,0x02]))  # greet
r = s.recv(2); assert r[1]==0x02
s.sendall(bytes([0x01,4])+b'root'+bytes([11])+b'<redacted>')  # auth
r = s.recv(2); assert r==b'\x01\x00'
"
```

### Firewall Rules

**server-100**:
- Allow: 22 (SSH), 80 (HTTP), 443 (HTTPS)
- Allow: 23444-23447 only from HAOS `192.168.2.101`
- Allow: 5432 (PostgreSQL, local only)
- Allow: 30129 (production panel, local only)
- Deny: everything else

**vpn2**:
- Allow: 22 (SSH)
- Allow: 80 (HTTP, certbot)
- Allow: 443 (HTTPS, nginx stream)
- Allow: 3128 (HTTP proxy, authenticated)
- Allow: 1080 (SOCKS proxy, authenticated)
- Allow: 23443, 28443 (Xray endpoints)
- Deny: everything else

**LAN servers** (server-44, server-88):
- Allow: 22 (SSH, LAN only)
- Allow: 3128 (HTTP proxy, LAN only)
- Allow: 1080 (SOCKS proxy, LAN only)
- Deny: everything else (from WAN)

**Recommendation**: Use UFW or iptables to enforce rules.

### Port 443 Preservation

**Policy**: Public clients use port 443. Regional relay ports 23444-23447 are
internal HAOS-to-server-100 links and must not have WAN forwards or `Anywhere`
firewall rules. Upstream high ports such as 28443 may remain as server-to-server
diagnostics/fallbacks, but are not advertised as user products.

**Why**: Port 443 is critical for:
- nginx stream SNI routing
- Reality TLS
- XHTTP/WS/gRPC over TLS
- Auth proxy TLS

**Never**: Modify or disable port 443 without explicit approval.

## Access Control

### SSH Access

**server-100**:
- Key-based authentication only
- Password authentication disabled
- Root login disabled (use sudo)

**VPS** (vpn2, vpn3):
- Key-based authentication
- Root login allowed (for automation)
- Password authentication disabled (recommended)

**LAN servers** (server-44, server-88):
- Key-based authentication
- Password authentication disabled

**Key management**:
- Store private keys in `~/.ssh/`
- Use SSH agent for key management
- Rotate keys annually
- Revoke compromised keys immediately

### Panel Authentication

**Admin login**:
- Username: admin (configurable)
- Password: bcrypt hashed
- Session: 30-day cookie

**User login**:
- Username: per-user
- Password: bcrypt hashed
- Session: 30-day cookie

**Subscription access**:
- Token-based (no password)
- Tokens are random 36-char strings
- Tokens can be rotated

**API key**:
- Bearer token for health API
- Timing-safe comparison
- Stored in environment variable

### VPS Access

**Panel → VPS**:
- SSH key authentication
- Keys stored in secure.json
- No password authentication

**Admin → VPS**:
- SSH key authentication
- Keys in `~/.ssh/`
- SSH config aliases for convenience

**Recommendation**: Use separate SSH keys for panel and admin access.

## Operational Security

### Backup Handling

**What to backup**:
- PostgreSQL database (`pg_dump`)
- secure.json
- SSH keys
- Deploy configs

**Backup location**:
- Encrypted external storage
- Separate from production server
- Accessible only to admin

**Backup encryption**:
```bash
# Encrypt backup
gpg -c backup.tar.gz

# Decrypt backup
gpg backup.tar.gz.gpg
```

**Backup rotation**:
- Daily backups (retain 7 days)
- Weekly backups (retain 4 weeks)
- Monthly backups (retain 12 months)

**Test restores**: Periodically test backup restoration.

### Log Sanitization

**What to sanitize**:
- Passwords (never log)
- Tokens (truncate in logs)
- UUIDs (truncate in logs)
- IP addresses (optional, depends on privacy policy)

**Fastify logger**:
- Does not log request bodies
- Does not log sensitive headers (Authorization, Cookie)
- Logs request ID, method, URL, status code, response time

**Custom logging**:
```typescript
// Bad: logs password
app.log.info("Login attempt:", { login, password });

// Good: logs only login
app.log.info("Login attempt:", { login });
```

**Log rotation**:
```bash
# /etc/logrotate.d/vpn-panel
/home/roomhacker/apps/vpn-panel/logs/*.log {
    daily
    rotate 14
    compress
    delaycompress
    missingok
    notifempty
    create 0640 roomhacker roomhacker
}
```

### Deploy Safety

**Pre-deploy checklist**:
- [ ] Config validated locally
- [ ] Config validated on remote
- [ ] Backup created on remote
- [ ] Rollback plan ready
- [ ] Smoke test prepared

**Deploy flow**:
1. Validate config locally
2. Backup current config on remote
3. Push new config to remote
4. Validate on remote
5. Replace config
6. Restart service
7. Smoke test
8. On failure: rollback

**Rollback procedure**:
```bash
# List backups
ssh root@vpn2.bezrabotnyi.com 'ls -la /usr/local/etc/xray/config.json.bak_*'

# Rollback
ssh root@vpn2.bezrabotnyi.com 'cp /usr/local/etc/xray/config.json.bak_20260624_120000 /usr/local/etc/xray/config.json && systemctl restart xray'
```

### Incident Response

**Compromised subscription token**:
1. Rotate token: `POST /api/admin/users/:accountId/rotate-token`
2. Notify user
3. Monitor for abuse

**Compromised admin account**:
1. Disable account: `PUT /api/admin/users/:accountId` `{ "enabled": false }`
2. Change password
3. Delete all sessions: `DELETE FROM sessions WHERE account_id = :accountId`
4. Re-enable account
5. Investigate access logs

**Compromised VPS**:
1. Revoke SSH keys
2. Rotate all credentials (Reality keys, tokens, UUIDs)
3. Redeploy from clean backup
4. Investigate access logs
5. Notify affected users

**Compromised secure.json**:
1. Rotate all secrets (UUIDs, tokens, Reality keys, VPS credentials)
2. Redeploy secure.json
3. Restart panel
4. Redeploy to all VPS
5. Notify affected users

### Security Audit Checklist

**Monthly**:
- [ ] Review admin access logs
- [ ] Check for unusual subscription access patterns
- [ ] Verify backup integrity
- [ ] Review firewall rules
- [ ] Check for outdated dependencies

**Quarterly**:
- [ ] Rotate SSH keys
- [ ] Rotate admin passwords
- [ ] Rotate auth proxy credentials
- [ ] Review secure.json permissions
- [ ] Test backup restoration
- [ ] Review firewall logs

**Annually**:
- [ ] Full security audit
- [ ] Penetration test (optional)
- [ ] Update security policies
- [ ] Train admin on security best practices
- [ ] Review incident response plan

## Common Vulnerabilities

### XSS (Cross-Site Scripting)

**Mitigation**:
- Session cookies are `httpOnly`
- HTML pages escape user input via `html.ts`
- No inline JavaScript in admin UI

**Testing**:
```bash
# Try injecting script
curl -X POST 'http://127.0.0.1:30129/api/admin/users' \
  -d 'login=<script>alert(1)</script>&displayName=Test&password=secret'
```

**Expected**: Script tag is escaped, not executed.

### CSRF (Cross-Site Request Forgery)

**Mitigation**:
- Session cookies are `sameSite: "strict"`
- No cross-origin requests allowed

**Testing**:
```html
<!-- Try CSRF attack from different origin -->
<form action="https://vpn.bezrabotnyi.com/api/admin/users" method="POST">
  <input name="login" value="hacker">
  <input name="password" value="secret">
  <button type="submit">Submit</button>
</form>
```

**Expected**: Request rejected (cookie not sent).

### SQL Injection

**Mitigation**:
- All queries use parameterized statements
- No string concatenation in SQL
- PostgreSQL driver escapes parameters

**Testing**:
```bash
# Try SQL injection
curl -X POST 'http://127.0.0.1:30129/api/admin/users' \
  -d "login=admin' OR '1'='1&displayName=Test&password=secret"
```

**Expected**: Login fails (no SQL injection).

### Brute Force

**Mitigation**:
- Password hashing with bcrypt (slow by design)
- Account disable (admin can disable compromised accounts)

**Recommendation**: Add rate limiting:
```nginx
limit_req_zone $binary_remote_addr zone=login:10m rate=10r/s;
location /login {
    limit_req zone=login burst=20 nodelay;
    proxy_pass http://127.0.0.1:30129;
}
```

### Timing Attacks

**Mitigation**:
- Health API key comparison uses `crypto.timingSafeEqual()`
- Password verification uses bcrypt (timing-safe by design)

**Testing**: Measure response times for different inputs. Should be constant.

## Security Resources

### Documentation

- [OWASP Top 10](https://owasp.org/www-project-top-ten/)
- [Node.js Security Checklist](https://blog.risingstack.com/node-js-security-checklist/)
- [PostgreSQL Security](https://www.postgresql.org/docs/current/security.html)

### Tools

- [npm audit](https://docs.npmjs.com/cli/audit) — Check for vulnerable dependencies
- [snyk](https://snyk.io/) — Vulnerability scanning
- [letsencrypt](https://letsencrypt.org/) — Free TLS certificates

### Contacts

- Security issues: Report to admin via email
- Vulnerabilities: Disclose responsibly (90-day disclosure period)

# VPN Panel Documentation Index

> Current product contract: normal subscriptions contain exactly Smart DE,
> Full DE, Smart US, and Full US, all on public port 443. The 11 historical
> direct routes are appended as compatibility fallbacks, not separate products.

Welcome to the VPN Panel documentation. This documentation covers the complete VPN infrastructure control panel behind `vpn.bezrabotnyi.com`.

## Documentation Structure

### Core Documentation

1. **[Architecture Overview](01-architecture.md)**
   - System context and component relationships
   - Data flow diagrams
   - Technology stack
   - Deployment topology

2. **[Core Modules](02-core-modules.md)**
   - Module map and responsibilities
   - Dependency graph
   - Key abstractions (Account, Endpoint, ClientRecord, SecureConfig)
   - Module boundaries and best practices

3. **[Configuration Management](03-configuration.md)**
   - Configuration sources and precedence
   - secure.json schema and validation
   - Environment variables
   - Runtime config loading
   - Sensitive data handling

4. **[Database Schema](04-database-schema.md)**
   - Entity relationship diagram
   - Table definitions (accounts, vpn_clients, endpoints, etc.)
   - Migration strategy
   - Data access layer (repository.ts)

5. **[API Reference](05-api-reference.md)**
   - Authentication (session-based and API key)
   - Public endpoints (subscription formats)
   - Admin API (user management, VPS management, deploy)
   - User API (account management)
   - Error handling

### Feature Documentation

6. **[Subscription & Routing](06-subscription-routing.md)**
   - Subscription flow (token to VLESS link)
   - Endpoint types (Reality, WS, XHTTP, gRPC, HTTPUpgrade)
   - Routing policy (happRoutingLink)
   - Xray server configs
   - Happ integration

7. **[Infrastructure & Deployment](07-infrastructure-deployment.md)**
   - Server inventory (server-100, vpn2, vpn3, server-44, server-88, HAOS, router)
   - Network topology
   - Deploy workflow (deploy-all.sh)
   - Rollback procedures
   - Service management

8. **[VPS Management](08-vps-management.md)**
   - SSH operations (vps-ssh.ts)
   - Xray config sync
   - Client sync
   - Traffic stats
   - Health monitoring
   - System stats

9. **[Authentication & Authorization](09-authentication-authorization.md)**
   - Authentication flow (login, session validation, logout)
   - Password handling (bcrypt)
   - Role system (admin, user)
   - Session management
   - API key auth
   - Security practices

10. **[Admin Panel UI](10-admin-panel-ui.md)**
    - Page structure (admin, user detail, account, VPS)
    - User management (create, edit, delete)
    - Endpoint assignment
    - Health dashboard
    - VPS management UI
    - User self-service

### Operations Documentation

11. **[Testing Strategy](11-testing-strategy.md)**
    - Test framework (Node test runner + tsx)
    - Test organization
    - Running tests
    - Test coverage
    - Mocking strategies
    - Integration tests

12. **[CLI Tools](12-cli-tools.md)**
    - Migration tool (migrate.ts)
    - Xray import (import-xray-clients.ts)
    - Routing validation (validate-xray-routing.ts)
    - Subscription consistency check
    - Xray relay config writer
    - Creating new CLIs

13. **[Scripts & Automation](13-scripts-automation.md)**
    - Deploy scripts (deploy-all.sh, deploy-reality-443.sh)
    - Testing scripts (test-endpoints.sh, test-routing.sh, vpn-bench.sh)
    - Monitoring scripts (auto-endpoint-check.sh, quick-health-check.sh)
    - Setup scripts (setup-mac.sh, issue-vps-cert.sh)
    - Utility scripts
    - Automation patterns (systemd timers, cron)

14. **[Security Considerations](14-security-considerations.md)**
    - Sensitive data (UUIDs, tokens, keys, credentials)
    - Storage security (secure.json, .env, database, SSH keys)
    - Network security (auth proxies, SOCKS+TLS, firewall)
    - Access control (SSH, panel, VPS)
    - Operational security (backups, logs, deploy safety)
    - Common vulnerabilities (XSS, CSRF, SQL injection)

15. **[SmartDNS Architecture and Limits](15-smartdns.md)**
    - Production DNS and Smart Edge data path
    - Clear boundary between DNS steering and VPN tunneling
    - DPI limitations for Telegram, Discord, YouTube, and Instagram
    - Correct staged health semantics

## Quick Start

### For Developers

1. Read [Architecture Overview](01-architecture.md) to understand the system
2. Read [Core Modules](02-core-modules.md) to understand the codebase
3. Read [Configuration Management](03-configuration.md) to set up your environment
4. Read [Testing Strategy](11-testing-strategy.md) to run tests
5. Read [CLI Tools](12-cli-tools.md) to use command-line utilities

### For Administrators

1. Read [Admin Panel UI](10-admin-panel-ui.md) to learn the admin interface
2. Read [API Reference](05-api-reference.md) to understand API endpoints
3. Read [Infrastructure & Deployment](07-infrastructure-deployment.md) to manage infrastructure
4. Read [VPS Management](08-vps-management.md) to manage remote VPS
5. Read [Security Considerations](14-security-considerations.md) to secure the system

### For Operators

1. Read [Scripts & Automation](13-scripts-automation.md) to automate operations
2. Read [Infrastructure & Deployment](07-infrastructure-deployment.md) to deploy configs
3. Read [VPS Management](08-vps-management.md) to monitor VPS
4. Read [Testing Strategy](11-testing-strategy.md) to test endpoints
5. Read [Security Considerations](14-security-considerations.md) to handle incidents
6. Read [SmartDNS Architecture and Limits](15-smartdns.md) before treating a DNS policy match as application availability

## Key Concepts

### VPN Panel

The central control plane for managing VPN infrastructure:
- Manages users, endpoints, subscriptions
- Generates VLESS links in multiple formats
- Deploys configs to remote VPS
- Monitors endpoint health

### Endpoints

VPN access points with different transports:
- **Reality**: TCP with Reality TLS (most secure)
- **XHTTP**: HTTP/2 stream-up (fast)
- **WebSocket**: WS over TLS (reliable)
- **gRPC**: gRPC over TLS (deprecated)
- **HTTPUpgrade**: HTTP upgrade (deprecated)

### Subscriptions

Per-client VPN configurations in multiple formats:
- **plain**: Plain VLESS links (one per line)
- **v2ray**: Base64-encoded plain
- **happ**: Routing link + plain (Happ native)
- **sing-box**: sing-box JSON config
- **xray-json**: Xray client JSON config

### Routing

Geo-based routing policy:
- **Smart relay direct**: RU/private via compact `geoip` and `geosite:ru-inside`
- **Smart relay proxy**: Everything else through the selected region
- **Full relay proxy**: Everything through the selected region; client keeps only LAN/private direct

### VPS

Remote VPN servers:
- **vpn2**: DE (Germany) — primary VPN upstream
- **vpn3**: USA (Virginia) — secondary VPN upstream
- **server-44**: LAN proxy (sing-box)
- **server-88**: LAN proxy (Xray)

## Common Tasks

### Create a User

1. Login to admin panel: `https://vpn.bezrabotnyi.com/admin`
2. Click "Create User"
3. Fill in login, display name, password
4. Select endpoints to assign
5. Click "Create"
6. Share subscription link with user

### Deploy Configs

```bash
# Deploy to all targets
scripts/deploy-all.sh

# Deploy to specific target
scripts/deploy-all.sh vpn2

# Dry-run (validate only)
scripts/deploy-all.sh --dry-run all
```

### Check Endpoint Health

```bash
# Quick health check
scripts/quick-health-check.sh

# Full health check (hourly via systemd)
scripts/auto-endpoint-check.sh

# View health in admin panel
curl -b cookies.txt 'http://127.0.0.1:30129/api/admin/health'
```

### Rotate Subscription Token

```bash
# Via admin panel
POST /api/admin/users/:accountId/rotate-token

# Via curl
curl -X POST -b cookies.txt 'http://127.0.0.1:30129/api/admin/users/123/rotate-token'
```

### Sync Xray Clients

```bash
# Via admin panel
POST /api/admin/vps/:vpsId/xray-sync-clients

# Via curl
curl -X POST -b cookies.txt 'http://127.0.0.1:30129/api/admin/vps/vpn2/xray-sync-clients'
```

## Troubleshooting

### Panel Not Starting

**Symptom**: `npm run dev` fails with database error

**Solution**:
```bash
# Check DATABASE_URL
echo $DATABASE_URL

# Check PostgreSQL
psql $DATABASE_URL -c "SELECT 1"

# Run migrations
npm run migrate
```

### Subscription Not Working

**Symptom**: User reports subscription not working

**Solution**:
1. Check token validity:
   ```bash
   curl 'http://127.0.0.1:30129/sub/<token>/plain'
   ```
2. Check endpoint health:
   ```bash
   scripts/quick-health-check.sh
   ```
3. Check user's assigned endpoints in admin panel
4. Rotate token if compromised

### Deploy Failing

**Symptom**: `deploy-all.sh` fails with validation error

**Solution**:
1. Check config locally:
   ```bash
   python3 -c "import json; json.load(open('deploy/vpn2/xray/config.json'))"
   ```
2. Check config on remote:
   ```bash
   ssh root@vpn2.bezrabotnyi.com 'xray run -test -config /usr/local/etc/xray/config.json'
   ```
3. Check logs:
   ```bash
   tail -100 logs/deploy/deploy.log
   ```
4. Rollback if needed:
   ```bash
   ssh root@vpn2.bezrabotnyi.com 'cp /usr/local/etc/xray/config.json.bak_* /usr/local/etc/xray/config.json && systemctl restart xray'
   ```

### VPS Unreachable

**Symptom**: SSH connection to VPS fails

**Solution**:
1. Check SSH key:
   ```bash
   ssh -i /home/roomhacker/.ssh/id_rsa root@vpn2.bezrabotnyi.com
   ```
2. Check VPS status:
   ```bash
   ping vpn2.bezrabotnyi.com
   ```
3. Check firewall rules
4. Check VPS console (if accessible)

## Contributing

### Code Style

- TypeScript ESM with NodeNext module resolution
- Imports use `.js` extensions (even for `.ts` files)
- No lint/format step (just `tsc`)
- Tests use Node test runner (no jest/vitest)

### Adding Features

1. Read [Core Modules](02-core-modules.md) to understand architecture
2. Add feature to appropriate module
3. Add tests in `tests/*.test.ts`
4. Update API reference if adding endpoints
5. Update admin UI if adding pages
6. Run tests: `npm test`
7. Build: `npm run build`

### Reporting Issues

1. Check existing documentation
2. Check existing issues (if using issue tracker)
3. Provide:
   - Steps to reproduce
   - Expected behavior
   - Actual behavior
   - Logs (sanitized)
   - Environment (OS, Node version, etc.)

## Resources

### Internal

- [AGENTS.md](../AGENTS.md) — Agent instructions and infrastructure details
- [README.md](../README.md) — Project overview and quick start
- [infra/](../infra/) — Infrastructure documentation (SERVERS.md, CERTIFICATES.md, etc.)

### External

- [Fastify](https://www.fastify.io/) — Web framework
- [PostgreSQL](https://www.postgresql.org/) — Database
- [Xray](https://xtls.github.io/) — VPN protocol
- [Happ](https://happ-proxy.com/) — VPN client app
- [Let's Encrypt](https://letsencrypt.org/) — TLS certificates

## Version History

- **v1.0.0** (2026-06-24) — Initial documentation release
  - Complete architecture documentation
  - API reference
  - Admin panel documentation
  - Operations guides
  - Security considerations

## License

Proprietary. All rights reserved.

## Contact

For questions or issues, contact the project maintainer.

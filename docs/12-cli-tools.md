# CLI Tools

## Available CLIs

All CLI tools are in `src/cli/*.ts` and run via `tsx`:

```bash
npx tsx src/cli/<script>.ts [options]
```

**NPM scripts** (convenience wrappers):
```bash
npm run migrate              # tsx src/cli/migrate.ts
npm run import:xray -- ...   # tsx src/cli/import-xray-clients.ts ...
npm run validate:xray        # tsx src/cli/validate-xray-routing.ts
npm run check:subscription   # tsx src/cli/check-subscription-consistency.ts
npm run write:xray-relay-config  # tsx src/cli/write-xray-relay-config.ts
```

## Migration Tool

### migrate.ts

**Purpose**: Run database schema migrations

**Usage**:
```bash
npm run migrate
```

**Flow**:
1. Load app config from environment
2. Create database pool
3. Call `runMigrations(pool)` from `migrations.ts`
4. Create tables if not exist (idempotent)
5. Add columns if not exist (idempotent)
6. Exit

**Output**:
```
Migrations complete.
```

**When to run**:
- After initial setup
- After pulling code with schema changes
- Before starting panel (panel also runs migrations on startup)

**Safety**: All migrations are idempotent (`IF NOT EXISTS`). Safe to run multiple times.

## Xray Import

### import-xray-clients.ts

**Purpose**: Bulk import Xray clients from existing config

**Usage**:
```bash
npm run import:xray -- /path/to/xray-config.json
```

**Flow**:
1. Read Xray config file
2. Parse JSON
3. Extract clients from inbounds
4. For each client:
   - Check if already exists (by UUID)
   - If not, create account + vpn_client + subscription_token
   - Assign default endpoints
5. Print summary

**Output**:
```
Imported 50 clients.
  Created: 45
  Skipped: 5 (already exist)
```

**Input format**:
```json
{
  "inbounds": [
    {
      "tag": "de-reality",
      "settings": {
        "clients": [
          {
            "id": "uuid-here",
            "email": "client-name"
          }
        ]
      }
    }
  ]
}
```

**Default endpoints**: Imported clients are assigned all enabled endpoints.

**Use case**: Migrate from standalone Xray setup to panel-managed setup.

## Routing Validation

### validate-xray-routing.ts

**Purpose**: Validate Xray routing configuration using Docker

**Usage**:
```bash
npm run validate:xray
```

**Flow**:
1. Generate Xray config from panel data
2. Write to temporary file
3. Run Docker container: `ghcr.io/xtls/xray-core:latest`
4. Execute: `xray run -test -config /tmp/config.json`
5. Check output for "Configuration OK"
6. Clean up temporary file

**Output**:
```
Validating Xray routing config...
✓ Configuration OK
```

**Requirements**:
- Docker installed and running
- Internet connection (to pull Xray image)

**When to run**:
- After modifying routing logic
- After modifying endpoint assignments
- Before deploying to production

**Error handling**:
```
✗ Validation failed:
  Invalid routing rule: outbound tag "nonexistent" not found
```

## Subscription Consistency Check

### check-subscription-consistency.ts

**Purpose**: Audit subscription tokens and endpoint assignments

**Usage**:
```bash
npm run check:subscription
```

**Flow**:
1. Load app config
2. Create database pool
3. Load secure config
4. Query all users
5. For each user:
   - Check if has active token
   - Check if has assigned endpoints
   - Check if assigned endpoints are enabled
   - Check if Xray UUID is valid
6. Print report

**Output**:
```
Subscription Consistency Report
================================
Total users: 100
Users with active tokens: 98
Users with assigned endpoints: 95
Users with disabled endpoints: 2
Users with invalid UUIDs: 0

Issues:
  - user123: No active token
  - user456: No assigned endpoints
  - user789: Assigned endpoint "de-cdn-xhttp" is disabled
```

**When to run**:
- Periodically (weekly/monthly)
- After bulk operations (import, delete)
- When users report subscription issues

**Fix issues**:
- Missing token: `POST /api/admin/users/:accountId/rotate-token`
- No endpoints: Edit user via admin panel
- Disabled endpoints: Re-enable endpoint or reassign user

## Xray Relay Config Writer

### write-xray-relay-config.ts

**Purpose**: Generate Xray config for RU relay servers

**Usage**:
```bash
npm run write:xray-relay-config
```

**Flow**:
1. Load app config
2. Create database pool
3. Load secure config
4. Call `serverConfig()` from `xray-configs.ts`
5. Write to stdout or file

**Output**: Xray JSON config

**Use case**: Generate config for manual deployment to RU relay servers.

**Options**:
```bash
# Write to file
npm run write:xray-relay-config > /tmp/ru-relay-config.json

# Deploy to server
scp /tmp/ru-relay-config.json server-44:/etc/xray/config.json
ssh server-44 'sudo systemctl restart xray'
```

## DE Config Generator

### _gen-de-config.ts

**Purpose**: Generate Xray config for vpn2 (DE) from panel data

**Usage**:
```bash
npx tsx src/cli/_gen-de-config.ts > /tmp/de-config.json
```

**Flow**:
1. Load app config
2. Create database pool
3. Load secure config
4. Call `deServerConfig()` from `xray-configs.ts`
5. Write to stdout

**Output**: Xray JSON config with all DE endpoints and clients

**Used by**: `scripts/deploy-all.sh` to regenerate vpn2 config before deploy.

**Note**: This is an internal script (prefixed with `_`). Use `deploy-all.sh` instead of running directly.

## Common Patterns

### Environment Setup

All CLIs load config from environment:

```typescript
import { loadAppConfig } from "../config.js";
import { createPool } from "../db.js";
import { loadSecureConfig } from "../secure-config.js";

const config = loadAppConfig();
const pool = createPool(config);
const secure = await loadSecureConfig(config.secureConfigPath);
```

**Required environment variables**:
- `DATABASE_URL` — PostgreSQL connection string
- `VPN_PANEL_SECURE_CONFIG` — Path to secure.json (optional, defaults to /etc/vpn-panel/secure.json)

### Error Handling

All CLIs handle errors gracefully:

```typescript
try {
  // ... main logic
} catch (error) {
  console.error("Error:", error.message);
  process.exit(1);
}
```

**Exit codes**:
- `0`: Success
- `1`: Error (message printed to stderr)

### Logging

CLIs use `console.log()` for output and `console.error()` for errors.

**Verbose mode**: Not implemented. Use `DEBUG=*` environment variable for detailed logs (future enhancement).

## Creating New CLIs

### Template

```typescript
#!/usr/bin/env tsx
import { loadAppConfig } from "../config.js";
import { createPool } from "../db.js";

async function main() {
  const config = loadAppConfig();
  const pool = createPool(config);
  
  try {
    // ... main logic
    console.log("Success");
  } catch (error) {
    console.error("Error:", error);
    process.exit(1);
  } finally {
    await pool.end();
  }
}

main();
```

### Best Practices

1. **Load config first**: Always call `loadAppConfig()` at start
2. **Create pool**: Use `createPool(config)` for database access
3. **Close pool**: Call `pool.end()` in `finally` block
4. **Error handling**: Wrap main logic in try-catch
5. **Exit codes**: Use `process.exit(1)` on error
6. **Output**: Use `console.log()` for output, `console.error()` for errors
7. **Arguments**: Parse from `process.argv` or use a library (commander, yargs)
8. **Help**: Add `--help` flag with usage instructions

### Example with Arguments

```typescript
#!/usr/bin/env tsx
import { loadAppConfig } from "../config.js";
import { createPool } from "../db.js";

async function main() {
  const args = process.argv.slice(2);
  if (args.includes("--help")) {
    console.log("Usage: my-cli [options]");
    console.log("  --help     Show help");
    console.log("  --verbose  Enable verbose output");
    process.exit(0);
  }
  
  const verbose = args.includes("--verbose");
  
  const config = loadAppConfig();
  const pool = createPool(config);
  
  try {
    if (verbose) console.log("Starting...");
    // ... main logic
    console.log("Success");
  } catch (error) {
    console.error("Error:", error);
    process.exit(1);
  } finally {
    await pool.end();
  }
}

main();
```

## NPM Script Conventions

### Naming

- `npm run <action>:<target>` — e.g., `import:xray`, `validate:xray`
- `npm run <verb>-<noun>` — e.g., `check-subscription`, `write-xray-relay-config`

### Arguments

Pass arguments after `--`:
```bash
npm run import:xray -- /path/to/config.json
```

### Environment Variables

Set via `.env` or command line:
```bash
DATABASE_URL=postgres://... npm run migrate
```

## Debugging CLIs

### Verbose Output

Add `console.log()` statements:
```typescript
console.log("Config:", config);
console.log("Pool:", pool);
```

### Debugger

Use Node.js debugger:
```bash
node --inspect-brk -r tsx/cjs src/cli/migrate.ts
```

Then open `chrome://inspect` in Chrome.

### Dry Run

Add `--dry-run` flag:
```typescript
const dryRun = args.includes("--dry-run");
if (!dryRun) {
  await pool.query("UPDATE ...");
} else {
  console.log("Would update ...");
}
```

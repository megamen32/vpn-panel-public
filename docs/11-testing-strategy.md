# Testing Strategy

## Test Framework

### Node Test Runner + tsx

The project uses **Node's built-in test runner** with **tsx** for TypeScript execution.

**No jest/vitest**: The project avoids heavy test frameworks in favor of Node's lightweight built-in runner.

**Test command**:
```bash
npm test
```

**Expands to**:
```bash
tsx --test tests/*.test.ts
```

**Why tsx**: tsx executes TypeScript directly without compilation. Tests are typechecked at runtime (not compile time).

**tsconfig.json**: Excludes `tests/` from compilation. Tests are not included in `dist/` build.

## Test Organization

### Test Files

All tests are in `tests/*.test.ts`:

| File | Coverage |
|------|----------|
| `subscriptions.test.ts` | VLESS link generation, subscription formats, routing |
| `passwords.test.ts` | Password hashing and verification |
| `secure-config.test.ts` | Config loading and validation |
| `happ-api.test.ts` | Happ API client |
| `pages.test.ts` | HTML page rendering |
| `vps-ssh.test.ts` | SSH operations (mocked) |
| `xray-configs.test.ts` | Xray config generation |
| `announce-announcements.test.ts` | Personalized announce headers |

### Test Structure

Each test file follows this pattern:

```typescript
import { describe, it } from "node:test";
import assert from "node:assert";
import { functionToTest } from "../src/module.js";

describe("moduleName", () => {
  it("should do something", () => {
    const result = functionToTest(input);
    assert.strictEqual(result, expected);
  });

  it("should handle edge case", () => {
    assert.throws(() => functionToTest(badInput));
  });
});
```

**Assertions**: Node's built-in `node:assert` module

**Test runner**: `node:test` (describe, it, before, after, beforeEach, afterEach)

## Running Tests

### Basic Usage

```bash
# Run all tests
npm test

# Run specific test file
npx tsx --test tests/subscriptions.test.ts

# Run tests matching pattern
npx tsx --test --test-name-pattern="should generate VLESS link" tests/subscriptions.test.ts
```

## Scheduled transport measurements

The scheduling source of truth is each entry in
`vpn-testing/test-plan.json` under `testTargets[].probeSchedule`:

```json
"probeSchedule": {
  "enabled": true,
  "everyMinutes": 180,
  "profile": "health"
}
```

`scripts/run-target-probe-scheduler.py --due` reads those values, starts due
targets independently (up to five at once by default), and records both the
last scheduled attempt and the last successful run in
`vpn-testing/results/target-probe-scheduler/state.json`. The systemd timer
`target-probe-scheduler.timer` wakes the dispatcher every five minutes; that
wake-up interval is not the measurement interval. A target is measured only
when its own `everyMinutes` has elapsed since its last scheduled attempt. A
slow target therefore cannot delay another due target, and a failed target
retries on its configured cadence instead of running continuously.

Useful commands:

```bash
# Inspect all configured schedules
scripts/run-target-probe-scheduler.py --list

# Preview what is currently due
scripts/run-target-probe-scheduler.py --due --dry-run

# Manual measurement; does not postpone the next scheduled run
scripts/run-target-probe-scheduler.py --target external-wireless-android

# Transactional server-100 installation with rollback receipt
scripts/deploy-target-probe-scheduler.sh preview
TARGET_PROBE_LIVE_APPROVED=1 scripts/deploy-target-probe-scheduler.sh apply
```

The S21 (`R5CR702SRFP`) is configured for `180` minutes. The other current
targets retain their former `60` minute health cadence. The deploy replaces
the old global hourly timer to prevent duplicate runs. A failed measurement
updates the attempt timestamp but not the separate success timestamp. Manual
`--target` runs update neither timestamp and therefore never postpone the next
scheduled measurement.

### Test Output

```
✔ should generate VLESS link for Reality endpoint (5ms)
✔ should generate VLESS link for WS endpoint (2ms)
✔ should return null for disabled endpoint (1ms)
# tests 3
# pass 3
# fail 0
# cancelled 0
# skipped 0
# todo 0
# duration_ms 15
```

### Exit Codes

- `0`: All tests passed
- `1`: One or more tests failed
- `2`: Test file not found or syntax error

## Test Coverage

### What's Tested

**subscriptions.ts**:
- VLESS link generation for each endpoint type (Reality, WS, XHTTP, gRPC, HTTPUpgrade)
- Subscription formatting (plain, v2ray, happ, sing-box, xray-json)
- Routing link generation (`happRoutingLink()`)
- Link slot computation (`linkSlots()`)
- Personalized announce headers

**passwords.ts**:
- Password hashing (bcrypt)
- Password verification
- Invalid password rejection

**secure-config.ts**:
- Config loading from JSON
- Zod schema validation
- Missing required fields
- Invalid field types
- Default values

**happ-api.ts**:
- API client methods (list HWIDs, delete HWID, add install, etc.)
- HTTP request formatting
- Error handling

**pages.ts**:
- HTML rendering (admin page, login page, user detail, etc.)
- HTML escaping
- Template rendering

**vps-ssh.ts**:
- SSH command execution (mocked)
- Config parsing
- Error handling

**xray-configs.ts**:
- Xray server config generation
- Client config generation
- Routing rule generation

### What's NOT Tested

- **server.ts**: Route handlers (requires HTTP server setup)
- **repository.ts**: Database queries (requires PostgreSQL connection)
- **migrations.ts**: Schema migrations (requires database)
- **Integration tests**: End-to-end flows (requires full environment)

**Why**: These modules require external dependencies (database, HTTP server) that are difficult to mock. Integration tests are done manually or via deploy scripts.

## Mocking

### Manual Mocks

The project uses **manual mocks** (no mocking framework).

**Example** (vps-ssh.test.ts):
```typescript
import { describe, it, mock } from "node:test";
import assert from "node:assert";

// Mock ssh2 module
mock.module("ssh2", {
  defaultClient: {
    connect: () => {},
    exec: (cmd: string, cb: Function) => {
      cb(null, {
        on: (event: string, handler: Function) => {
          if (event === "data") handler(Buffer.from("mock output"));
          if (event === "close") handler();
        },
      });
    },
    end: () => {},
    on: () => {},
  },
});
```

**Why no mocking framework**: Node's test runner is lightweight. Mocking frameworks (jest, sinon) add complexity and dependencies.

### Database Mocks

Database tests are not automated. Manual testing via:

```bash
# Start local PostgreSQL
createdb vpn_panel_test

# Set DATABASE_URL
export DATABASE_URL=postgres://localhost:5432/vpn_panel_test

# Run migrations
npm run migrate

# Run tests
npm test
```

## Integration Tests

### End-to-End Flows

Integration tests are not automated. Manual testing via:

1. **Subscription flow**:
   ```bash
   # Start panel
   npm run dev
   
   # Create user via admin panel
   curl -X POST -b cookies.txt 'http://127.0.0.1:30129/api/admin/users' \
     -d 'login=test&displayName=Test&password=secret&endpointIds[]=de-xhttp'
   
   # Fetch subscription
   curl 'http://127.0.0.1:30129/sub/<token>/plain'
   ```

2. **Deploy flow**:
   ```bash
   # Deploy to vpn2
   scripts/deploy-all.sh vpn2
   
   # Verify Xray config on vpn2
   ssh root@vpn2.bezrabotnyi.com 'xray run -test -config /usr/local/etc/xray/config.json'
   ```

3. **VPS management**:
   ```bash
   # Sync clients
   curl -X POST -b cookies.txt 'http://127.0.0.1:30129/api/admin/vps/vpn2/xray-sync-clients'
   
   # Check traffic
   curl -b cookies.txt 'http://127.0.0.1:30129/api/admin/vps/vpn2/xray-traffic'
   ```

### Test Environment

**Recommended setup**:
- Local PostgreSQL (or Docker)
- Local Xray (or Docker)
- Test `secure.json` with mock endpoints

**Docker Compose** (optional):
```yaml
version: '3'
services:
  postgres:
    image: postgres:18
    environment:
      POSTGRES_DB: vpn_panel_test
      POSTGRES_USER: test
      POSTGRES_PASSWORD: test
    ports:
      - "5432:5432"
  
  xray:
    image: ghcr.io/xtls/xray-core:latest
    volumes:
      - ./test-xray-config.json:/etc/xray/config.json
    ports:
      - "10085:10085"
```

## Continuous Integration

### GitHub Actions (not configured)

Recommended CI setup:

```yaml
name: Test
on: [push, pull_request]
jobs:
  test:
    runs-on: ubuntu-latest
    services:
      postgres:
        image: postgres:18
        env:
          POSTGRES_DB: vpn_panel_test
          POSTGRES_USER: test
          POSTGRES_PASSWORD: test
        ports:
          - 5432:5432
    steps:
      - uses: actions/checkout@v3
      - uses: actions/setup-node@v3
        with:
          node-version: 22
      - run: npm ci
      - run: npm test
        env:
          DATABASE_URL: postgres://test:test@localhost:5432/vpn_panel_test
```

### Local CI

Run tests before committing:

```bash
# Run tests
npm test

# Build (typecheck)
npm run build

# If both pass, commit
git commit -m "..."
```

## Test Best Practices

### Naming

- Test files: `<module>.test.ts`
- Test descriptions: "should <expected behavior>"
- Describe blocks: module name

### Assertions

- Use `assert.strictEqual()` for primitive values
- Use `assert.deepStrictEqual()` for objects/arrays
- Use `assert.throws()` for error cases
- Use `assert.match()` for regex matching

### Async Tests

```typescript
it("should fetch data asynchronously", async () => {
  const result = await asyncFunction();
  assert.strictEqual(result, expected);
});
```

### Test Isolation

- Each test should be independent
- No shared state between tests
- Use `beforeEach()` to reset state

```typescript
import { beforeEach } from "node:test";

let state: any;

beforeEach(() => {
  state = { count: 0 };
});

it("should increment count", () => {
  state.count++;
  assert.strictEqual(state.count, 1);
});
```

### Test Data

- Use realistic test data
- Avoid hardcoded values (use constants)
- Test edge cases (empty, null, undefined, boundary values)

## Debugging Tests

### Verbose Output

```bash
npx tsx --test --test-reporter=spec tests/subscriptions.test.ts
```

### Break on Failure

```bash
node --test --inspect-brk tests/subscriptions.test.ts
```

### Logging

```typescript
it("should debug", () => {
  console.log("Input:", input);
  console.log("Output:", result);
  assert.strictEqual(result, expected);
});
```

## Future Improvements

### Desired Enhancements

1. **Integration tests**: Automated end-to-end tests with Docker
2. **Coverage reporting**: Track test coverage (c8 or istanbul)
3. **Mock database**: In-memory PostgreSQL for repository tests
4. **API tests**: HTTP client tests for route handlers
5. **Performance tests**: Benchmark critical paths
6. **Visual regression tests**: Screenshot comparison for admin UI

### Tools to Consider

- **c8**: Code coverage for Node.js
- **supertest**: HTTP assertions
- **testcontainers**: Docker-based test environments
- **MSW**: Mock Service Worker for API mocking

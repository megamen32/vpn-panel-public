# VPN Test and Endpoint Detail Cards Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make test history rows open a site-result card and make endpoint rows open a three-day aggregate matrix by network, client, access method, and wire method.

**Architecture:** Keep the existing run-event API for individual test cards and add one authenticated endpoint-summary API backed by PostgreSQL aggregates. Render both detail cards in the existing server-rendered test center, with browser-side fetches only when the user clicks a row. Endpoint aggregates use the same telemetry window and separate runner errors from endpoint failures.

**Tech Stack:** TypeScript ESM, Fastify, PostgreSQL, node:test, existing inline dashboard JavaScript and CSS.

## Global Constraints

- Endpoint details default to the rolling last 3 days and accept a bounded `days` query parameter.
- Runner errors are shown separately and never counted as endpoint failures.
- Site status uses `contentOk` when present, with reachability retained as a separate signal.
- The endpoint matrix must include target, network class, client, access method, wire method, host role, score, site pass counts, Telegram latency, and throughput mean/p95 when present.
- Detail cards are admin-only and must use the existing session guard.
- After source changes run focused tests, `npm test`, `npm run build`, restart `autovpnallowip.service`, and verify the live API.

---

### Task 1: Add failing backend and interaction tests

**Files:**
- Modify: `tests/vpn-test-telemetry.test.ts`
- Modify: `tests/pages-extended.test.ts`
- Modify: `tests/vpn-test-history-page.test.ts`

- [ ] **Step 1: Add a failing endpoint-detail aggregate test**

Mock the database with summary and matrix rows and assert that `getVpnTestEndpointDetail(pool, "de-xhttp-h2")` returns camel-case summary fields, nested Telegram metrics, nested throughput metrics, and matrix dimensions.

- [ ] **Step 2: Run the focused telemetry test and verify it fails**

```bash
npx tsx --test tests/vpn-test-telemetry.test.ts --test-name-pattern='endpoint detail'
```

Expected: failure because the detail aggregate type and function do not exist.

- [ ] **Step 3: Add failing dashboard assertions**

Assert that the rendered test center contains endpoint row click hooks, `endpoint-detail-card`, run-card site matrix markup, and the endpoint-summary API path.

- [ ] **Step 4: Run the focused dashboard tests and verify they fail**

```bash
npx tsx --test tests/pages-extended.test.ts tests/vpn-test-history-page.test.ts
```

Expected: failure because the click hooks and detail card are not rendered yet.

---

### Task 2: Implement endpoint aggregate telemetry and API

**Files:**
- Modify: `src/vpn-test-telemetry.ts`
- Modify: `src/server.ts`

- [ ] **Step 1: Add typed endpoint detail records**

Define summary, stage metric, site aggregate, matrix row, and endpoint detail types with explicit numeric/null fields.

- [ ] **Step 2: Add two aggregate queries**

Aggregate endpoint-finished events for totals and score, and stage-finished events for per-target dimensions, site pass counts, Telegram latency mean/median/p95, UDP metrics, and throughput mean/median/p95. Keep raw runner errors in their own count.

- [ ] **Step 3: Add the admin route**

Register `GET /api/admin/vpn-tests/endpoints/:endpointId/summary?days=3` after the existing run routes, validate the endpoint ID and days range, require admin role, and return the typed aggregate.

- [ ] **Step 4: Run the telemetry focused test and verify it passes**

```bash
npx tsx --test tests/vpn-test-telemetry.test.ts --test-name-pattern='endpoint detail'
```

---

### Task 3: Implement run cards and endpoint detail UI

**Files:**
- Modify: `src/test-dashboard.ts`
- Modify: `tests/pages-extended.test.ts`
- Modify: `tests/vpn-test-history-page.test.ts`

- [ ] **Step 1: Add endpoint click affordances**

Make score-table and current-endpoint rows keyboard/click targets carrying their endpoint ID and calling `openEndpointDetail`.

- [ ] **Step 2: Add the endpoint detail card shell**

Render a hidden `endpoint-detail-card` near the top of the workspace with close control and loading/error states.

- [ ] **Step 3: Add browser rendering for endpoint aggregates**

Fetch the summary API on click and render a summary strip plus a matrix table. Each matrix row shows target dimensions, score, effective observations, runner errors, Telegram `passed/total` with mean/median/p95, throughput mean/p95, and compact site chips with pass rate and latency.

- [ ] **Step 4: Replace raw run-stage rows with a site-result card**

Group stage-finished events by endpoint, omit infrastructure-only stages from the site table, and render each site as passed, warning, or failed with HTTP code, latency, and error text. Keep endpoint eligibility and runner errors visible.

- [ ] **Step 5: Run dashboard tests and verify they pass**

```bash
npx tsx --test tests/pages-extended.test.ts tests/vpn-test-history-page.test.ts
```

---

### Task 4: Verify production behavior

**Files:**
- No additional files unless a test exposes a contract mismatch.

- [ ] **Step 1: Run `npm test` and `npm run build`**

- [ ] **Step 2: Restart `autovpnallowip.service`**

Use `sudo -n systemctl restart autovpnallowip.service` and verify the unit is active.

- [ ] **Step 3: Verify the live admin API contract**

Use an authenticated request or an in-process pool query to confirm endpoint detail rows contain the matrix dimensions and metrics, and confirm the public test page still returns successfully.

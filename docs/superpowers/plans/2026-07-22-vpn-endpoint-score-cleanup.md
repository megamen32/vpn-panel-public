# VPN Endpoint Score Cleanup Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Show a three-day endpoint reliability score in the admin test center and remove only clearly bad endpoints (score below 50%) from user subscriptions while ordering the remaining endpoints from best to worst.

**Architecture:** Reuse the persisted `vpn_test_events` telemetry as the source of truth. Aggregate endpoint-finished events separately from stage events so runner failures do not multiply observations; calculate score from eligible versus real endpoint failures, then use the same score rows for the admin panel and public subscription filtering. Keep the catalog and diagnostics intact: only public subscription output is filtered.

**Tech Stack:** TypeScript ESM, Fastify, PostgreSQL, node:test, server-rendered HTML, existing subscription and telemetry modules.

## Global Constraints

- The score window is exactly the rolling last 3 days at query time.
- `runner_errors` are excluded from the endpoint score and shown separately.
- An endpoint with score `< 50` and at least 20 effective observations is hidden from user subscriptions.
- Endpoints with no score or fewer than 20 effective observations remain available at the bottom until measured.
- Existing admin diagnostics, endpoint catalog rows, and server configurations remain intact.
- After source changes run `npm test` and `npm run build`; production uses `dist/server.js`.

---

### Task 1: Add failing tests for score-aware public endpoint policy

**Files:**
- Modify: `tests/subscriptions.test.ts`
- Modify: `tests/vpn-test-telemetry.test.ts`

**Interfaces:**
- Test the exported subscription policy helper with endpoint fixtures and measured scores.
- Test that the telemetry score query maps aggregate database rows into typed score records without treating runner errors as endpoint failures.

- [ ] **Step 1: Write the failing subscription policy test**

Add a test that passes `de-direct` with score `0`, `de-xhttp-h2` with score `96.6`, and an unmeasured endpoint to the public ordering helper. Assert that `de-direct` is absent, `de-xhttp-h2` is first, and the unmeasured endpoint remains last.

- [ ] **Step 2: Run the focused test and verify the expected failure**

Run:

```bash
npm test -- tests/subscriptions.test.ts
```

Expected: failure because the score-aware public ordering helper does not exist yet.

- [ ] **Step 3: Write the failing telemetry mapping test**

Use the existing lightweight pool mock in `tests/vpn-test-telemetry.test.ts` and assert that a database row with `passed=9`, `effective_observations=10`, `runner_errors=4`, and `telegram_median_ms=420` becomes a score record with `score=90`, `effectiveObservations=10`, `runnerErrors=4`, and `telegramMedianMs=420`.

- [ ] **Step 4: Run the focused telemetry test and verify the expected failure**

Run:

```bash
npm test -- tests/vpn-test-telemetry.test.ts
```

Expected: failure because the score query and exported score type do not exist yet.

---

### Task 2: Implement telemetry aggregation and public filtering

**Files:**
- Modify: `src/vpn-test-telemetry.ts`
- Modify: `src/subscriptions.ts`

**Interfaces:**
- Produce `VpnTestEndpointScore` records from PostgreSQL.
- Produce `orderPublicSubscriptionEndpoints(endpoints, scores)` for all subscription formats.

- [ ] **Step 1: Implement the minimal telemetry aggregate**

Add `getVpnTestEndpointScores(pool, windowDays = 3, minimumObservations = 20)`. Aggregate endpoint-finished events in one CTE and stage-finished events in another. Return score, passed count, effective observations, endpoint failures, runner errors, and Telegram median latency. Do not join raw events before counting endpoint observations.

- [ ] **Step 2: Implement the public policy helper**

Export `PUBLIC_ENDPOINT_MIN_SCORE = 50` and `orderPublicSubscriptionEndpoints`. Keep measured endpoints with fewer than 20 effective observations and unmeasured endpoints, remove only measured endpoints below 50, then sort by score descending, Telegram median ascending, and existing sort order.

- [ ] **Step 3: Apply the policy to bundles**

In `endpointsForClient`, load the three-day scores and return only policy-approved endpoints in score order. Change the plain, V2Ray, Xray, sing-box, and macOS builders to preserve the already score-ordered endpoint list rather than reintroducing the old fixed fallback order.

- [ ] **Step 4: Run the focused tests and verify they pass**

Run:

```bash
npm test -- tests/subscriptions.test.ts tests/vpn-test-telemetry.test.ts
```

Expected: all focused tests pass, including the new filtering behavior and existing subscription format checks.

---

### Task 3: Add the score panel to the admin test center

**Files:**
- Modify: `src/pages.ts`
- Modify: `src/test-dashboard.ts`
- Modify: `src/server.ts`
- Modify: `tests/pages-extended.test.ts`
- Modify: `tests/vpn-test-history-page.test.ts`

**Interfaces:**
- `testsPage` accepts optional `scores` and continues to render when scores are absent.
- `/admin/tests` loads scores from the same three-day telemetry query used by subscriptions.

- [ ] **Step 1: Add the failing page assertion**

Pass a score fixture to `testsPage` and assert that the resulting HTML contains `Score за 3 дня`, the highest endpoint before the lower-scored endpoint, the runner-error count, and the text that score below 50 is hidden from subscriptions.

- [ ] **Step 2: Run the page test and verify it fails**

Run:

```bash
npm test -- tests/pages-extended.test.ts tests/vpn-test-history-page.test.ts
```

Expected: failure because `testsPage` does not accept or render endpoint scores yet.

- [ ] **Step 3: Render the panel**

Add a server-rendered score table above the current endpoint matrix. Sort best first, show score, effective sample size, endpoint failures, excluded runner errors, and median Telegram latency. Mark score `<50` rows as `Не выдаётся пользователям` while keeping them visible for diagnostics.

- [ ] **Step 4: Connect the live route**

Pass `await getVpnTestEndpointScores(pool)` from `/admin/tests` into `testsPage`.

- [ ] **Step 5: Run focused page tests and verify they pass**

Run the two focused page test files again; expected: PASS.

---

### Task 4: Verify the complete runtime path

**Files:**
- No additional files unless a test exposes a contract mismatch.

- [ ] **Step 1: Run the full test suite**

```bash
npm test
```

- [ ] **Step 2: Build the production bundle**

```bash
npm run build
```

- [ ] **Step 3: Verify the rendered score rows against the live database**

Use the exact rolling three-day query and confirm the panel orders the same endpoints as the pre-deploy report, with the six sub-50 endpoints excluded from user subscriptions.

- [ ] **Step 4: Restart and smoke-test the service**

Create a timestamped backup of the current service state if needed, restart `autovpnallowip.service`, then verify `curl -fsS http://127.0.0.1:3129/` and fetch one authenticated subscription/config path. Confirm that no sub-50 endpoint appears in the public subscription and that `/admin/tests` contains the score panel.

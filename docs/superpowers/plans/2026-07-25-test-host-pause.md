# Test Host Pause Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let an admin pause an individual test host so it is excluded from default and scheduled VPN health checks until resumed.

**Architecture:** Keep the authoritative host state in `vpn-testing/test-plan.json`, alongside the existing `testTargets` `enabled` setting. The admin API validates a requested state transition against that catalog and rewrites only the matching `enabled` field; the Test Center renders a pause/resume control and refreshes after a successful update.

**Tech Stack:** TypeScript ESM, Fastify, Node test runner, JSON test plan.

## Global Constraints

- A paused host must never be eligible for a run that relies on the plan defaults.
- The API is admin-only and only accepts configured host IDs.
- Do not change any live host state while changing the test control plane.

---

### Task 1: Persist and expose host pause state

**Files:**
- Modify: `src/server.ts`
- Test: `tests/test-host-pause.test.ts`

**Interfaces:**
- Consumes: `testTargets` entries from `vpn-testing/test-plan.json`.
- Produces: `PATCH /api/admin/endpoint-health/targets/:targetId` with `{ enabled: boolean }`.

- [x] **Step 1: Write the failing test** for an admin pause request that sets only the Android target's `enabled` field to `false` and rejects an unknown target.
- [x] **Step 2: Run the test** with `npx tsx --test tests/test-host-pause.test.ts`; expect a 404/400 before the route exists.
- [x] **Step 3: Implement the minimal route**: validate the body with Zod, read the plan, update only the selected target, atomically write it, and return the changed target.
- [x] **Step 4: Run the focused test** and expect PASS.

### Task 2: Make the Test Center pause/resume hosts

**Files:**
- Modify: `src/test-dashboard.ts`
- Test: `tests/test-host-pause.test.ts`

**Interfaces:**
- Consumes: `TestTarget.enabled` plus the Task 1 route.
- Produces: a host card with an enabled/paused label and a pause/resume button.

- [x] **Step 1: Extend the failing rendering test** to require the Android host pause control and the update endpoint.
- [x] **Step 2: Run the focused test**; expect missing markup.
- [x] **Step 3: Add the minimal button and browser handler** that PATCHes `{ enabled }`, reports errors, and reloads after success.
- [x] **Step 4: Run the focused test** and expect PASS.

### Task 3: Verify the host is excluded at the execution boundary

**Files:**
- Modify: `tests/vpn-test-plan.test.ts` if the current plan runner contract needs an explicit regression.

- [x] **Step 1: Verify the existing runner contract**: it already rejects an explicitly requested target whose `enabled` value is `false`; no duplicate regression was needed for that path.
- [x] **Step 2: Identify the remaining default-selection gap**: `scripts/run-bench-everywhere.sh` previously passed its default target list through without filtering paused hosts.
- [x] **Step 3: Implement the minimum enforcement** in `scripts/run-bench-everywhere.sh`, filtering its default-selected targets to enabled entries from the plan.
- [x] **Step 4: Run focused tests, then `npm test` and `npm run build`**; focused test passed, `npm test` passed 312/312, and `npm run build` passed before deployment.

## Completion

Implemented, deployed, and committed as `b036041` (`feat: add persistent test host pause controls`). The Android test target is paused in the canonical plan (`enabled: false`).

# Configurable VPN Test Targets Implementation Plan

> For agentic workers: use subagent-driven-development or executing-plans to implement this plan task-by-task. Steps use checkbox syntax for tracking.

**Goal:** Let administrators choose allowlisted test targets in /admin/tests, keep SSH/engine details server-side, and run Android through server-100.

**Architecture:** Keep a versioned `testTargets` registry in `vpn-testing/test-plan.json`, containing only safe metadata and SSH aliases. Expose its allowlisted IDs to the admin UI, and pass selected IDs through the existing API to the runner. Manual UI runs may select targets; the hourly auto-endpoint-check.sh path remains fixed so it cannot accidentally change endpoint policy scope.

**Tech Stack:** TypeScript ESM/Fastify, inline HTML UI, Bash wrappers, Python 3 runner, Node test runner, Python unittest.

## Global Constraints

- SSH hosts and runner modes come from a server-side allowlist; the browser never supplies arbitrary SSH destinations.
- Android test execution uses the server-100 ADB host.
- Preserve the existing quick, health, and benchmark result schema and telemetry.
- Preserve the fixed hourly policy-check matrix.
- Run npm run build, focused tests, full npm test, Python contract tests, and git diff --check.

### Task 1: Define the target registry and failing contract tests

**Files:**
- Modify: vpn-testing/test-plan.json
- Modify: vpn-testing/test_unified_contract.py
- Modify: tests/vpn-test-history-page.test.ts

- [x] Add `testTargets` entries for server-44 Xray Docker, server-44 sing-box HTTP, server-44 sing-box SOCKS, Mac native Xray, and Android 4G via server-100.
- [x] Test that Android resolves to server-100 and that every registry target has an execution mode and plan target.
- [x] Test that the admin HTML exposes target checkboxes and sends selected target IDs.
- [x] Run focused tests and verify the new assertions fail before implementation.

### Task 2: Wire target selection through the UI and API

**Files:**
- Modify: src/test-dashboard.ts
- Modify: src/pages.ts
- Modify: src/server.ts

- [x] Load and validate `testTargets` from the shared plan.
- [x] Render target checkboxes with labels and execution descriptions; persist selection in browser localStorage.
- [x] Send a body containing targets and checks from quick and manual benchmark buttons.
- [x] Validate target IDs server-side and reject unknown IDs.
- [x] Keep the automated policy endpoint on its fixed matrix and add a separate manual target selection path if required by the current wrapper contract.

### Task 3: Make dispatch configuration-driven and fix Android location

**Files:**
- Modify: scripts/run-network-test.sh
- Modify: scripts/run-bench-everywhere.sh
- Modify: scripts/run-android-network-test.sh
- Modify: vpn-testing/test-plan.json

- [x] Resolve target execution mode, SSH alias, engine, and plan target from the registry instead of a hard-coded case statement.
- [x] Pass ANDROID_ADB_HOST=roomhacker@192.168.2.100 for the Android target.
- [x] Preserve explicit HOSTS/TARGETS automation overrides.
- [x] Keep the hourly script fixed to its current policy matrix.

### Task 4: Verify and document operation

**Files:**
- Modify: docs/13-scripts-automation.md
- Modify: docs/10-admin-panel-ui.md

- [x] Document registry fields, UI behavior, and adding a new SSH worker.
- [x] Run bash -n on changed wrappers.
- [x] Run focused TypeScript/Python tests, full npm test, npm run build, and Python contract tests.
- [x] Inspect the final diff and preserve unrelated worktree changes.

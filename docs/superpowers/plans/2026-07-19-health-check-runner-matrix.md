# Health-check Runner Matrix Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make health-check transport timeouts appear as endpoint failures instead of runner errors, add a user-controlled history auto-refresh toggle, and run Xray server-44, sing-box server-44, an explicitly engine-labeled Mac check with unverified network path, and Android 4G checks together.

**Architecture:** Keep the unified result and telemetry contract as the single integration point. Extend the Python runner with an explicit `xray`/`singbox` engine choice, map sing-box-compatible targets to the existing server-44 remote runner, and let the batch script start all target jobs concurrently. The dashboard toggle controls only history polling and defaults to enabled for existing users.

**Tech Stack:** Python 3 standard library, Bash, TypeScript ESM, Node test runner, `tsx`, PostgreSQL-backed telemetry APIs.

## Global Constraints

- Preserve `vpn-testing/test-plan.json` target metadata and the existing telemetry schema.
- Transport timeouts must remain visible as failed checks with `code=0`, not be classified as orchestration failures.
- Xray and sing-box test processes must use isolated ports and lifecycle cleanup.
- `npm run build` is the TypeScript verification command; Python contract tests run with `python3 -m unittest`.
- Do not modify `/etc`, systemd, nginx, or other infrastructure source-of-truth files for this application-only change.

---

### Task 1: Make HTTP transport timeouts endpoint failures

**Files:**
- Modify: `vpn-testing/unified_runner.py:542-560`
- Test: `vpn-testing/test_unified_contract.py`

**Interfaces:**
- `classify_http_response(check, 0)` remains the fatal transport classification.
- `_http_check(check, socks_port)` returns a normal check object when curl raises `subprocess.TimeoutExpired` or returns a non-zero status.

- [ ] **Step 1: Write the failing test**

Add a test that patches `_run` to raise `subprocess.TimeoutExpired` and asserts `_http_check` returns `code == 0`, `reachable is False`, `severity == "fatal"`, and a timeout error. Import `_http_check` and `subprocess` in the test module.

- [ ] **Step 2: Run the focused test and verify it fails**

Run:

```bash
python3 -m unittest vpn-testing/test_unified_contract.py -k timeout
```

Expected: FAIL because `_http_check` currently lets `TimeoutExpired` escape to `_run_endpoint`, which records an `error` field instead of a failed check.

- [ ] **Step 3: Implement the minimal fix**

Wrap the curl call in `_http_check` with `try/except subprocess.TimeoutExpired`, produce `code = 0`, preserve elapsed latency, and include a stable timeout message. Keep non-zero curl return codes as check-level errors and retain the existing response classification.

- [ ] **Step 4: Run the focused test and the Python contract suite**

Run:

```bash
python3 -m unittest vpn-testing/test_unified_contract.py -k timeout
python3 -m unittest vpn-testing/test_unified_contract.py
```

Expected: PASS with no runner-level exception for the simulated transport timeout.

### Task 2: Add explicit sing-box engine support to the unified runner

**Files:**
- Modify: `vpn-testing/unified_runner.py:506-527, 663-702, 717-815`
- Test: `vpn-testing/test_unified_contract.py`

**Interfaces:**
- Add `singbox_endpoint_config(base, endpoint, socks_port) -> JsonObject` for Reality, WebSocket, and HTTPUpgrade VLESS outbounds.
- Add `--engine {xray,singbox}` to the runner; default remains `xray`.
- Result `engine` is `xray-{mode}` or `sing-box-{mode}`.

- [ ] **Step 1: Write failing contract tests**

Add tests asserting a supported VLESS Reality outbound becomes a sing-box VLESS outbound with `tls.reality`, `utls`, and a SOCKS inbound, and an unsupported XHTTP outbound is rejected by `singbox_endpoint_config` with `PlanError`.

- [ ] **Step 2: Run the focused tests and verify they fail**

Run:

```bash
python3 -m unittest vpn-testing/test_unified_contract.py -k singbox
```

Expected: FAIL because the engine option and converter do not exist.

- [ ] **Step 3: Implement minimal engine support**

Convert only the transports already supported by the repository’s sing-box subscription contract: Reality, WS, and HTTPUpgrade. Select the sing-box Docker image and mount `/etc/sing-box/config.json`; keep Xray behavior unchanged. Filter unavailable endpoint tags for the sing-box engine before reserving ports, so unsupported XHTTP/gRPC entries do not become misleading runner errors.

- [ ] **Step 4: Run focused and full Python tests**

Run:

```bash
python3 -m unittest vpn-testing/test_unified_contract.py -k singbox
python3 -m unittest vpn-testing/test_unified_contract.py vpn-testing/test_automation_scripts.py
```

Expected: PASS, with the existing Xray contract unchanged.

### Task 3: Route all target types through the batch runner

**Files:**
- Modify: `scripts/run-network-test.sh:20-65`
- Modify: `scripts/run-bench-everywhere.sh:5-45`
- Modify: `scripts/auto-endpoint-check.sh:15-24`
- Test: `vpn-testing/test_automation_scripts.py`
- Test: `vpn-testing/test_unified_contract.py`

**Interfaces:**
- `run-network-test.sh` accepts `lan-server44-singbox-http`, `lan-server44-singbox-socks`, and `external-mac` in addition to existing targets.
- `run-bench-everywhere.sh` accepts `PROFILE` and defaults to `s44 s44-singbox-http s44-singbox-socks mac android`.
- `auto-endpoint-check.sh` runs the health profile for the full matrix concurrently, then applies the canonical Xray server-44 result to endpoint policy; all jobs still publish their own telemetry.

- [ ] **Step 1: Write failing orchestration tests**

Assert the shell source exposes the sing-box targets and neutral `external-mac`, passes `--engine singbox` for sing-box targets, and that the batch default includes both server-44 sing-box variants, the unclassified Mac lane, and Android 4G. Assert Android telemetry includes `client=xray`, `wireMethod=4g`, and its engine. Assert the auto-check invokes `run-bench-everywhere.sh` with `PROFILE=health` and applies the server-44 result.

- [ ] **Step 2: Run the focused tests and verify they fail**

Run:

```bash
python3 -m unittest vpn-testing/test_automation_scripts.py vpn-testing/test_unified_contract.py -k 'target\|everywhere\|auto'
```

Expected: FAIL because the scripts currently support only Xray server-44, a misclassified Mac lane, and Android, and the hourly script invokes only one target.

- [ ] **Step 3: Implement target routing and concurrent matrix execution**

Add a target-to-remote mapping in `run-network-test.sh` that chooses the remote host, mode, and engine without changing existing SSH cleanup or telemetry environment propagation. Parameterize the batch script’s profile and target aliases. In `auto-endpoint-check.sh`, create a timestamp marker, run the matrix, locate the new `unified-lan-server44-health-*.json` result for policy application, post its health payload before profile application, and leave the other matrix runs represented by their telemetry events.

- [ ] **Step 4: Run shell syntax and focused contract tests**

Run:

```bash
bash -n scripts/run-network-test.sh scripts/run-bench-everywhere.sh scripts/auto-endpoint-check.sh
python3 -m unittest vpn-testing/test_automation_scripts.py vpn-testing/test_unified_contract.py
```

Expected: PASS.

### Task 4: Add the history auto-refresh toggle

**Files:**
- Modify: `src/test-dashboard.ts:150-151, 284-309`
- Test: `tests/vpn-test-history-page.test.ts`

**Interfaces:**
- Add checkbox `history-auto-refresh`, checked by default and persisted under a page-local `localStorage` key.
- `scheduleHistoryRefresh()` stops scheduling when the toggle is off.
- The live status text distinguishes enabled/disabled polling while preserving the existing 3-second running-run refresh.

- [ ] **Step 1: Write the failing page test**

Assert the rendered page contains the checkbox, `localStorage`, and the disabled branch in `scheduleHistoryRefresh`.

- [ ] **Step 2: Run the focused test and verify it fails**

Run:

```bash
npx tsx --test tests/vpn-test-history-page.test.ts
```

Expected: FAIL because the page currently hardcodes “Автообновление каждые 15 с” and has no toggle.

- [ ] **Step 3: Implement the UI toggle**

Render a compact checkbox beside the history status, read its persisted value on page load, listen for changes, clear an existing timer when disabled, and set the next refresh only when enabled. Keep the initial history load unconditional so the page remains useful with auto-update disabled.

- [ ] **Step 4: Run focused TypeScript tests and build**

Run:

```bash
npx tsx --test tests/vpn-test-history-page.test.ts
npm test
npm run build
```

Expected: PASS and a clean TypeScript build.

### Task 5: Final integration verification

- [ ] Run `python3 -m unittest discover -s vpn-testing -p 'test_*.py'`.
- [ ] Run `npm test` and `npm run build`.
- [ ] Run `git diff --check` and inspect the final diff for unrelated changes.
- [ ] Confirm the generated UI has the toggle and the batch script’s default matrix contains Xray 44, sing-box HTTP/SOCKS, an unclassified Mac lane, and Android 4G with explicit Xray metadata.

# Dynamic LAN Proxy and Test Matrix Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make server-44 and server-88 expose the same regional proxy contract and make every VPN test record the client stack, access method, wire method, and endpoint from one dynamically rendered endpoint catalog.

**Architecture:** Keep Xray on server-88 and sing-box on server-44, but generate both LAN configs from the enabled endpoint catalog and shared regional lane definitions. Render the Python test plan from the same endpoint catalog, while keeping target/network metadata explicit and persisting the four test dimensions as queryable telemetry fields rather than burying them in opaque JSON.

**Tech Stack:** TypeScript ESM, Fastify/PostgreSQL, Zod, Node test runner, Python 3 unified runner, Xray JSON, sing-box JSON, shell deployment scripts.

## Global Constraints

- `3127` is the US HTTP lane and `3128` is the DE HTTP lane on both LAN proxy hosts.
- SOCKS and smart HTTP remain available but are optional compatibility interfaces.
- The source of endpoint transport data is the panel endpoint catalog synchronized from `secure.json`; no second hand-maintained endpoint list may be introduced.
- Test records must expose `client`, `accessMethod`, `wireMethod`, and `endpoint` for every endpoint event and run.
- Existing `network_class` remains backward-compatible and is derived from `wireMethod`.
- Disabled or incompatible endpoints may remain in diagnostics, but cannot enter an active LAN selector or generated test endpoint list.
- Production config changes require JSON/config validation, timestamped remote backup, restart, and functional smoke tests.

---

### Task 1: Define the shared LAN contract and dynamic endpoint catalog

**Files:**
- Create: `src/lan-proxy-contract.ts`
- Test: `tests/lan-proxy-contract.test.ts`
- Modify: `src/secure-config.ts` only if a shared endpoint mapping needs a typed export

**Interfaces:**
- Produces `LAN_PROXY_LANES`, `LanLane`, `LanEndpointCatalog`, `activeEndpointsForLane()`, and `testMatrixMetadata()`.
- Consumes the existing `SecureConfig` and `SecureNode` endpoint records.

- [ ] Write a failing test proving the contract defines identical US/DE HTTP and SOCKS ports for both hosts, filters disabled nodes, and derives `wireMethod` values without conflating `accessMethod`.
- [ ] Run `npm test -- --test-name-pattern='LAN proxy contract'` and confirm the new test fails because the shared contract does not exist.
- [ ] Implement the typed lane definitions and endpoint filtering with explicit failure when a required lane has no compatible enabled endpoint.
- [ ] Run the focused test and confirm it passes.

### Task 2: Generate server-44 sing-box LAN config from endpoints

**Files:**
- Create: `src/lan-singbox-config.ts`
- Create: `src/cli/_gen-server44-config.ts`
- Test: `tests/lan-singbox-config.test.ts`
- Modify: `src/subscriptions.ts` to export the reusable `singBoxOutboundFromEndpoint()` endpoint conversion helper
- Modify: `scripts/deploy-all.sh`

**Interfaces:**
- `buildServer44SingBoxConfig(secure: SecureConfig): Record<string, unknown>` emits HTTP `3127/3128/3129`, SOCKS `1081/1080`, active regional selectors, and diagnostic-only outbounds.
- The generator loads `secure.json`, renders JSON to stdout, and never embeds UUIDs or transport paths in shell code.

- [ ] Write failing tests for dynamic endpoint-derived outbounds, identical lane ports, US/DE active selectors, and disabled endpoint exclusion.
- [ ] Run the focused tests and verify the expected missing-generator failure.
- [ ] Implement the generator using the existing sing-box endpoint conversion rules and regional relay credentials from `server_configs["regional-relays"]`.
- [ ] Update `deploy-all.sh` so server-44 is regenerated before validation/deployment instead of using a committed static config.
- [ ] Run focused tests, JSON validation, and sing-box validation.

### Task 3: Make server-88 active LAN pools endpoint-driven

**Files:**
- Modify: `src/lan-us-config.ts`
- Modify: `src/cli/_gen-server88-config.ts`
- Test: `tests/lan-us-config.test.ts`
- Test: `tests/server88-routing.test.ts`

**Interfaces:**
- `withStableDeLane(config, enabledEndpointIds?)` and `withRegionalUsLane(config, regional, enabledEndpointIds?)` keep diagnostic outbounds but select only enabled compatible endpoint-derived transports.
- Fallback selection is deterministic and errors clearly if a lane has no enabled route.

- [ ] Add failing tests showing a disabled endpoint is absent from the active selector while a remaining fallback stays available.
- [ ] Run the focused tests and confirm RED.
- [ ] Implement filtering and deterministic fallback selection.
- [ ] Regenerate the server-88 canonical config from the dynamic endpoint catalog and run focused tests plus Xray validation.

### Task 4: Version and render the test matrix dynamically

**Files:**
- Create: `src/cli/render-vpn-test-plan.ts`
- Create: `tests/render-vpn-test-plan.test.ts`
- Modify: `vpn-testing/test-plan.json` as generated output
- Modify: `scripts/run-bench-everywhere.sh` and `scripts/run-network-test.sh` to render/validate before dispatching tests

**Interfaces:**
- `renderTestPlan(secure: SecureConfig, basePlan: JsonObject): JsonObject` replaces hardcoded endpoint expectations with enabled endpoint metadata from the catalog.
- Target metadata contains explicit `client`, `accessMethod`, `wireMethod`, host role, and legacy `networkClass`.
- The runner must reject a target missing any of these fields.

- [ ] Add failing tests for dynamic endpoint expectations, target matrix fields for server-44/server-88/server-100/4G/external wire, and no disabled endpoint in the generated list.
- [ ] Run the focused tests and confirm RED.
- [ ] Implement the renderer and generated-plan check.
- [ ] Update runner entrypoints to generate the plan before copying it to remote targets.
- [ ] Run the renderer tests and Python plan validation.

### Task 5: Persist and display the four-dimensional telemetry identity

**Files:**
- Modify: `src/migrations.ts`
- Modify: `src/vpn-test-telemetry.ts`
- Modify: `src/repository.ts`
- Modify: `src/test-dashboard.ts`
- Modify: `tests/vpn-test-telemetry.test.ts`
- Modify: `tests/vpn-test-history-page.test.ts`

**Interfaces:**
- Every event target requires `client`, `accessMethod`, `wireMethod`, and `networkClass`.
- `vpn_test_runs` and `vpn_test_events` persist `client`, `access_method`, and `wire_method` columns with indexes for matrix queries.
- Existing API filters continue to work; new optional filters expose the three new dimensions.

- [ ] Add failing schema and persistence tests proving missing dimensions are rejected and valid dimensions reach SQL parameters.
- [ ] Run focused telemetry tests and confirm RED.
- [ ] Add idempotent migrations and update ingestion/query types.
- [ ] Render the dimensions in the test history summary and stage detail.
- [ ] Run focused tests, build, and migration dry checks.

### Task 6: End-to-end verification and deployment staging

**Files:**
- Modify: `tests/` only for acceptance regressions discovered during verification
- Generated: `deploy/server-44/sing-box/config.json`, `deploy/server-88/xray/config.json`, `vpn-testing/test-plan.json`

- [ ] Run the full TypeScript test suite and build.
- [ ] Validate sing-box, Xray, and generated plan contracts.
- [ ] Re-read infrastructure source-of-truth documents immediately before any live deploy.
- [ ] Deploy server-44 and server-88 with timestamped backups and verify `3127/3128`, `1080/1081`, and `3129` where available.
- [ ] Run matrix smoke tests and query PostgreSQL by `client/access_method/wire_method/endpoint`.
- [ ] Report any route excluded from an active selector separately from endpoints disabled in subscriptions.

# Worker 5.6-luna result

Status: READY_FOR_PLAN

## Decisive findings

1. P1 contract drift: current unified runner stage payloads use camelCase `latencyMs` (`vpn-testing/unified_runner.py:723`, `_http_check` result), and `src/test-dashboard.ts:558` supports both spellings. The legacy `/admin/tests` telemetry renderer in `src/pages.ts:2766-2768` only reads `http_code`/`code` and `latency_ms`, not `latencyMs`; therefore a valid incremental stage event renders `—` instead of its latency on that page. The existing focused tests do not cover the telemetry history renderer.

2. P1 artifact contract gap: `recordVpnTestEvent` derives `artifact_url` only from `run_finished` payload `artifactUrl`/`artifactPath` (`src/vpn-test-telemetry.ts:212-215`). The unified runner emits `run_finished` with only `summary` and `networkChecks` (`vpn-testing/unified_runner.py:958`), while output is written later by `main` (`vpn-testing/unified_runner.py:993-998`). Thus newly generated unified result JSON is not linked from history, contrary to README:241 and docs/13-scripts-automation.md:253,258-259. Legacy importer is unaffected because it includes `artifactPath` (`src/cli/import-vpn-test-history.ts:77,101`).

## Existing mechanism and canary blocker

The ingestion API validates schema v1 and persists append-only events; focused parser/aggregation tests pass. The business canary is blocked only for the two UI/documented-consumer gaps above; no production ingestion or database migration is needed to repair them. A repair should add focused renderer/runner contract tests before implementation.

## Checked hypotheses

- Event identity and matrix dimensions: covered by `tests/vpn-test-telemetry.test.ts`; no defect found.
- Endpoint score aggregation separating runner errors: covered and currently consistent with runner payloads.
- Main `test-dashboard.ts` stage rendering: supports `latencyMs`; the mismatch is isolated to `pages.ts`.
- Legacy artifact import: explicitly supplies `artifactPath`, so the gap is specific to new unified runner output.

## Proposed independent slices (each <=20 minutes)

1. `src/pages.ts` plus a focused page test: accept `latencyMs` alongside `latency_ms` in `renderVpnTestStages`; acceptance is a rendered stage showing the emitted latency.
2. `vpn-testing/unified_runner.py` plus Python contract test: pass the eventual output artifact path into `run_finished` or otherwise establish the documented artifact link without secrets; acceptance is a unified run event carrying the path and the panel deriving the artifact URL.
3. `docs/13-scripts-automation.md` and README wording/test evidence: align artifact/link behavior after slice 2; acceptance is docs matching the implemented contract.

Dependency: slice 1 is independent. Slice 3 depends on slice 2's selected artifact-link mechanism. No deploy/restart/config mutation included.

## 5.4-mini addendum

Status: READY_FOR_PLAN

### Decisive findings

1. Runtime replay scope bug: `TelemetrySink.replay_pending()` scans `self.spool_dir.parent.glob("*/*.json")` (`vpn-testing/unified_runner.py:303-314`). SSH runners default `TELEMETRY_SPOOL_DIR` to `/tmp/vpn-panel-telemetry-spool` (`scripts/run-network-test.sh:85-92`), so replay expands to `/tmp/*/*.json` and may repost or delete unrelated temp JSON files from other processes.

2. Null-score coercion bug: `getVpnTestEndpointScores()` maps `score: Number(row.score)` (`src/vpn-test-telemetry.ts:520-528`) even though the SQL score can be `null` when `effective_observations` is zero (`src/vpn-test-telemetry.ts:508-510`). The admin API therefore loses the "no score" state and renders it as `0`.

### Evidence checked

- `npx tsx --test tests/vpn-test-telemetry.test.ts tests/pages-extended.test.ts` passed, so the defect is not currently covered by focused tests.
- `logs/endpoint-check.log` shows repeated fetch/post failures, but they are not sufficient to prove a telemetry contract bug by themselves.

### Recommended next slices

1. Add a focused regression for `replay_pending` scope, then narrow the replay root so it only touches the current telemetry spool tree.
2. Add a focused regression for `score === null`, then preserve `null` in the mapping layer instead of coercing it to zero.

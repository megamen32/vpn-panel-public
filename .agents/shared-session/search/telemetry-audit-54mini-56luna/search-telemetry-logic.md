# Search journal: telemetry logic/docs audit

## Scope

Read-only audit of `src/vpn-test-telemetry.ts`, `src/server.ts`, `src/test-dashboard.ts`, `src/pages.ts`, focused telemetry/page tests, runner contract references, README, and `docs/13-scripts-automation.md`. Existing dirty paths were preserved.

## Probes

- `git worktree list --porcelain`, branch/status: current checkout is `/home/roomhacker/apps/vpn-panel` on `agent/mit-seo-readme`; default remote branch is `main`; unrelated dirty files include `src/subscriptions.ts` and `tests/subscriptions.test.ts`.
- `npx tsx --test tests/vpn-test-telemetry.test.ts tests/pages-extended.test.ts`: 34/34 passed.
- Static contract trace: Python runner emits `latencyMs` and `code` in stage payloads; `src/test-dashboard.ts` reads both camelCase and snake_case, while `src/pages.ts` reads `latency_ms` only in its telemetry stage renderer.
- Static artifact trace: `src/vpn-test-telemetry.ts` creates `artifact_url` only when a run-finished payload has `artifactUrl` or `artifactPath`; `vpn-testing/unified_runner.py` emits run-finished with `summary` and `networkChecks` only. The runner writes output after `run_plan`, so current unified runs do not advertise an artifact URL.
- `logs/endpoint-check.log` contains repeated `subscription fetch failed` / `health data post failed` entries, but the shell path already retries and continues; no separate live ingestion failure was proven from the log alone.
- `vpn-testing/unified_runner.py:303-314` replays pending telemetry from `self.spool_dir.parent.glob("*/*.json")`; combined with `scripts/run-network-test.sh:85-92`, which defaults SSH runners to `/tmp/vpn-panel-telemetry-spool`, that sweep reaches unrelated `/tmp/*/*.json` files and can repost/unlink non-telemetry temp artifacts.
- `src/vpn-test-telemetry.ts:520-528` coerces `row.score` with `Number(...)` even though the SQL score expression can be `null` when all observations are runner errors; this collapses a "no score" state into `0` in the admin API / dashboard mapping.

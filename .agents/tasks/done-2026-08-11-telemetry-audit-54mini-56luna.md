# Telemetry audit — completed minimal business path

## User outcome

Find and fix telemetry/log/logic/documentation defects, using 5.4-mini and 5.6-luna, then prove the real business path.

## Delivered

- Fixed camelCase `latencyMs` rendering, nullable endpoint scores, durable managed spool replay, managed artifact URL validation, post-SCP local artifact handoff, and secret-safe handoff-key loading.
- Updated telemetry lifecycle documentation and focused regressions.
- Preserved unrelated dirty work; no unrelated paths are included in this completion snapshot.

## Minimal acceptance evidence

- Production Nikita run `9b07a0c8-19c8-4eea-a13f-593726f9ab80` completed through the real runner and normal authenticated protocol consumer path.
- Result summary: 18 endpoints, 16 eligible, 0 runner errors, 2 endpoint failures.
- Telemetry ingestion returned HTTP 202; 111 persisted events span `run_started` to `run_finished`.
- History advertised `/api/admin/vpn-tests/runs/9b07a0c8-19c8-4eea-a13f-593726f9ab80/artifact`; authenticated artifact GET returned HTTP 200.
- Focused checks and build were recorded green before the final canary.

## Explicit minimal-path boundary

The fresh BrowserOS Tester could not independently repeat the readback because its browser lacked an admin session and received HTTP 401. The user selected the minimal path, so the authenticated protocol E2E receipt above is accepted as the completion proof; no further browser login, retry, deploy, restart, or production mutation is required.

## Evidence record

Detailed research, review, test, operational receipts, and the Tester boundary remain in:
`work-2026-08-11-telemetry-audit-54mini-56luna.md`.


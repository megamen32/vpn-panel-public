# Endpoint prune and S21 acceptance

Status: in progress

Outcome: normal subscriptions expose four regional products plus only the smallest phone-proven fallback set.

Shortest canary: physical S21 `R5CR702SRFP` over cellular passes the selected endpoints with correct DE/US exit IPs and required site checks.

Leaves:

- Rank current endpoints from live health evidence (5-10 active min).
- Reduce subscription fallbacks with contract tests (5-15 active min).
- Run physical S21 acceptance and retain telemetry artifact (10-20 active min).

Current evidence:

- `agent-device devices --json` sees physical `SM G998B` as booted.
- Happ UI contains the existing BezVPN subscription but currently lists many fallback transports.
- Current target list marks `external-wireless-android` disabled, so phone benchmarking uses the repository Android cellular harness directly; `agent-device` remains the UI verification interface.

Excluded: unrelated infrastructure hardening and adding new transports.

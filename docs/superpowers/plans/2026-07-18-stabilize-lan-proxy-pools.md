# Stabilize LAN proxy pools

## Goal

Keep both LAN HTTP proxy ports on server-88 available under partial transport
failure. Port `3127` must remain US-only and use several DB-proven VUSA
transports. Port `3128` must use several DB-proven DE transports. Failed or
deprecated transports stay available only as diagnostics, not as automatic
balancer candidates.

## Evidence

- `endpoint_health` at 2026-07-18 16:02 MSK reports 9/9 sites for
  `us-xhttp-h2`, `us-cdn`, `us-cdn2`, and `us-reality`; `us-grpc` reports 0/9.
- The last seven days of `endpoint_finished` eligibility reports 94.0%, 94.5%,
  96.4%, and 94.6% for those four US transports; the other US transports are
  0% eligible in the same history.
- `endpoint_health` reports 9/9 sites for `de-cdn`, `de-cdn2`,
  `de-direct-ws`, `de-httpupgrade`, and `de-xhttp-h2`; `de-grpc` reports 6/9,
  while `de-direct` and `de-xhttp` currently time out.
- After the first live rollout, `de-httpupgrade` dominated the automatic
  selection and produced two fresh `vpn2:443` dial timeouts; it is therefore
  retained only as a diagnostic outbound and removed from the LAN pool.
- The hourly runner status is `error` because it records failed endpoint
  checks in the run summary. It is not evidence that every endpoint is down.

## Tasks

1. Add failing regression coverage for the tested LAN transport pools and the
   faster observatory interval.
   - Files: `tests/lan-us-config.test.ts`, a new server-88 routing config test
   - Command: `npm test -- --test-name-pattern='LAN|server-88'`

2. Implement explicit stable LAN pool policy.
   - Files: `src/lan-us-config.ts`, `src/cli/_gen-server88-config.ts`
   - Keep all generated outbounds for diagnostics, but make only DB-proven
     transports without fresh live dial errors eligible for `leastPing`; use
     `de-cdn2` and `to-us-xhttp-h2` as cold-start fallbacks.
   - Probe the eligible paths every 10 seconds so failures are removed and
     recovered promptly; this intentionally spends extra probe traffic for
     availability.

3. Update the checked-in server-88 Xray artifact and add a config-contract
   test for both inbounds.
   - Files: `deploy/server-88/xray/config.json`, new test if needed
   - Assert `3127 -> us-auto`, `3128 -> proxy`, no failed transports in either
     selector, and fallback tags exist.

4. Verify and stage the change.
   - Commands: `npm test`, `npm run build`, `python3 -m json.tool deploy/server-88/xray/config.json`, `git diff --check`, and the Xray validation command where available.
   - Before any live deploy, reread the infrastructure source-of-truth files
     required by `AGENTS.md`, then deploy only the server-88 Xray artifact with
     its existing backup/rollback path.
   - Smoke-test both `http://127.0.0.1:3127` and `http://127.0.0.1:3128`, then
     test the router paths through `192.168.2.1` without touching
     WhiteTransport.

## Self-review

- The change does not modify WhiteTransport, VPN endpoint definitions, or the
  database health collector.
- The US selector remains VUSA-only; the `3127` backup in router HAProxy may
  still be DE by existing policy, but server-88 itself cannot silently change
  the country.
- The selected pools have multiple independent routes, while known failing
  gRPC/HTTPUpgrade/XHTTP variants remain out of automatic selection.

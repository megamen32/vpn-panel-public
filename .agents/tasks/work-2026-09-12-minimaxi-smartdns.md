# MiniMax / SmartDNS recovery

Started at 2026-09-12T04:14:22+03:00 (manual clock)

Status: done

## Minimal path

- Wanted result: the VPN Panel SmartDNS editor loads and saves its durable policy, and the correctly spelled MiniMax Agent hostname resolves and opens from the LAN client path.
- Shortest real canary: authenticated SmartDNS page returns HTML, then the Mac resolves and opens `https://agent.minimax.io/` through its normal LAN DNS path.
- Smallest slice: repair policy-file access for the panel service, preserve the current policy, and distinguish `agent.minimax.io` from the misspelled NXDOMAIN name shown in the screenshot.
- Discard: no broad SmartDNS refactor, no new routing family, no topology change, and no edits to rollback-only router HAProxy or server-100 LAN DNS.

## Estimate

- Trace and focused Red regression: 5-10 active minutes; uncertainty is the existing installer/runtime ownership path.
- Smallest durable fix plus focused Green/build: 10-20 active minutes; depends on Red.
- Controlled deploy and real client canary: 5-15 active minutes; depends on LAN/Mac reachability.
- Total effort and elapsed forecast (one serial lane): 20-45 active minutes, plus any external client availability wait.

## Evidence

- Red (live, 2026-09-12): `/etc/vpn-panel/smart-dns-policy.json` is `0600 root:root`; `autovpnallowip.service` runs as `roomhacker:roomhacker`; the admin page reports `EACCES`.
- Red (DNS, 2026-09-12): `agent.minimaxi.io` returns no address / `ESERVFAIL`; `agent.minimax.io` resolves to Akamai addresses and returns HTTPS 200 from an independent network probe.
- Runtime fix: backed up the unchanged policy to `/etc/vpn-panel/smart-dns-policy.json.bak_20260912T042100+0300`, changed only the live policy owner to `roomhacker:roomhacker`, and retained mode `0600`.
- Red (source): `npx tsx --test --test-name-pattern='policy saved by the panel can be loaded again' tests/smart-dns-policy.test.ts` failed with `duplicate or empty routing rule id: protected:ua` after one save/load round trip.
- Green (source): the same focused command passed after ignoring already generated `protected:*` rows during normalization; all 7 tests in `tests/smart-dns-policy.test.ts` passed and `npm run build` passed.
- Green (live panel): after restart, two authenticated GET/POST cycles returned `200/302`, the final authenticated GET and internal policy consumer returned `200`, and the rules hash remained unchanged.
- Green (public ingress): authenticated `https://vpn.bezrabotnyi.com/admin/smart-dns` returned HTTP 200 without either prior error.
- Green (LAN consumer): server-44 resolved `agent.minimax.io` through the router DNS to `2.16.53.11,2.16.53.56` and opened the official HTTPS URL with HTTP 200.
- Broader suite: `npm test` passed 423/425; two unrelated pre-existing router-transparent-smart-edge tests fail against their unchanged deploy scripts. The focused policy suite and build are green.
- Remaining proof boundary: the Mac reverse SSH tunnel on `localhost:2222` refused connections and BrowserOS was not connected, so the final browser click on the user's Mac was not independently observed.

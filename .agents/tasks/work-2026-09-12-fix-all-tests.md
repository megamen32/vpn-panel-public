# Restore full VPN Panel test suite

Started at 2026-09-12T04:32:15+03:00 (manual clock)

Status: done

## Minimal path

- Wanted result: `npm test` passes every test on current `main`.
- Shortest real canary: the two failing router-transparent-smart-edge tests pass, followed by the full suite with zero failures.
- Smallest slice: update the stale router test fixture and assertions to the active `203.0.113.1` public-alias topology introduced by commit `1a5e11a`.
- Discard: no production routing changes, no live OpenWrt/HAOS deploy, and no edits to unrelated dirty files.

## Estimate

- Fixture/assertion repair and focused Green: 5-10 active minutes.
- Full suite, build, review, commit, and push: 5-15 active minutes.
- Total serial effort and elapsed forecast: 10-25 active minutes; uncertainty is whether the full suite exposes another stale assertion.

## Red

- `npx tsx --test tests/router-transparent-smart-edge.test.ts`: 0 passed, 2 failed.
- The fake `fw4`/`nft` output omits the required public-alias DNAT rule.
- The wrapper assertion still expects ChatGPT to resolve to `$router_ip` although the active topology uses `$public_edge_ip` (`203.0.113.1`).

## Green

- Updated both fake firewall renderers with the public-alias DNAT rule, asserted the alias UCI state, corrected the rollback argv, and matched the wrapper's `$public_edge_ip` canary.
- `npx tsx --test tests/router-transparent-smart-edge.test.ts`: 2 passed, 0 failed.
- `npm test`: 425 passed, 0 failed.
- `npm run build`: passed.

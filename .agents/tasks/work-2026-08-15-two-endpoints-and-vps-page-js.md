# Work: "only 2 endpoints for everyone" + broken Deploy button on /admin/vps

- Date: 2026-08-15
- Request (RU): 1) почему-то у всех только 2 endpoint стало; 2) кнопка Deploy All Endpoints на /admin/vps?vps=185-240-120-152 не работает — Uncaught SyntaxError: Unexpected string (vps:1194:159), затем ReferenceError: deployServer/vpsQ/loadXrayConfig is not defined.
- Objective: restore full working endpoint set for users; fix JS syntax error in /admin/vps page so buttons work.
- Class: Short (bugfix), Red-first where practical.
- Initial active-minute estimate: 60.
- Exclusions: no infrastructure/deploy actions without asking.

## Evidence log

- 2026-08-15 logs/endpoint-check.log last successful run 2026-07-14: working set = us-xhttp-h2 + us-full-relay only (2 endpoints) → matches "у всех 2 эндпоинта".
- 2026-08-15 journalctl: vpn-endpoint-check.service fails hourly with `health assertion failed: 0/4 canonical relays are eligible` (exit 3) after `{"ok":true,"updated":2}`. Timer active.
- VPS page functions exist in src/pages.ts (vpsQ @1542, deployServer @1561) — syntax error earlier in served <script> kills definitions (Uncaught SyntaxError at served line ~1194 col 159).

## Root causes (2026-08-15)

1. Two endpoints: uncommitted in-progress prune task `.agents/tasks/work-2026-08-12-endpoint-prune-phone.md` changed `src/secure-config.ts` `subscriptionEndpointOrder` from products+mobile+legacy fallbacks to ONLY `[de-direct-ws, us-cdn2]`, contradicting its own stated outcome ("four regional products plus minimal fallbacks"). Built+deployed to dist 2026-08-13 00:16 (service restarted then). Side effects: unified health probes test only 2 endpoints; `apply-endpoint-health.py` exits 3 hourly ("0/4 canonical relays are eligible") because relays are never probed; profiles last applied 2026-07-14.
2. VPS page JS: commit 10ec831 introduced two template-literal escaping bugs in the inline script of `vpsPage` (src/pages.ts):
   - line 1745: `performSingBoxUpdate(\'...` — in a template literal `\'` evaluates to `'`, emitting `('' + ... + '')` → SyntaxError "Unexpected string" (served line ~1194).
   - lines 1771-1772, 1783-1784: `join('\n')` emitted a literal newline inside a JS string → SyntaxError "Invalid or unexpected token".
   Both killed the whole script block → deployServer/vpsQ/loadXrayConfig undefined → Deploy button dead.

## Fixes (2026-08-15)

- src/pages.ts:1745 `\'`→`\\'` (x2); 1771/1772/1783/1784 `'\t'`/`'\n'`→`'\\t'`/`'\\n'`.
- src/secure-config.ts: `subscriptionEndpointOrder = [...endpointOrder, ...stableFallbackEndpointOrder]` (4 products + 2 phone-proven fallbacks = 6).
- tests/vps-page.test.ts: new red-first test "VPS page inline scripts parse without syntax errors" (`new Function` on every inline <script>) — was red, now green.
- tests updated: secure-config.test.ts (products included), mobile-relay-ingress.test.ts:54 (products included), subscriptions.test.ts (plain=6 lines products-first, sing-box selector 6, xray json 6+direct+block, score-order keeps unscored product, macOS sing-box default=smart-de-relay).
- Verification: `npm test` 364/364 pass; `npm run build` OK; dist rebuilt.
- Deployed: user authorized restart; `sudo systemctl restart autovpnallowip.service` 2026-08-15, service active, panel 302 (login redirect).
- Live verification: dist-rendered /admin/vps inline scripts pass `node --check`; live subscription for geier25 returns 6 endpoints (Smart/Full DE, Smart/Full US, DE-Direct-WS, US CDN2 fallbacks).
- DB client_profiles was already full (all endpoints, 11 clients) — no DB repair needed; hourly vpn-endpoint-check should now probe 6 endpoints and succeed (relays were eligible 2026-08-12 17:00 run).

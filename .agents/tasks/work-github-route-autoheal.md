# GitHub LAN route semantic auto-heal

Started at 2026-08-29T20:06:40+03:00 (manual clock)

- Wanted result: GitHub pages on the LAN Smart Edge load reliably, and automatic repair detects the real broken application path instead of declaring DNS-only health.
- Shortest real canary: on the Mac with system proxy off, `https://github.com/meanwebuser/whitetransport-public` loads repository HTML repeatedly through `192.168.2.1` without GitHub `Bad request`, Fastly `unknown domain`, or HTTP 504.
- Smallest YAGNI vertical slice: move GitHub off the currently broken US lane to the existing stable DE pool, add one semantic server-100 canary that redeploys the canonical server-88 config after two failures, and deploy only those owned surfaces.
- Discard: direct-DNS bypass, new dashboard, generic multi-service healing framework, changes to unrelated VPN endpoints, and nginx changes.

Cycle: direct diagnosis, focused regression, canonical route repair, semantic watchdog, deploy, real Mac canary. Estimate: minimum 12, maximum 35 active minutes. Active time: not continuously measured.

## Evidence

- Current router `smart-dns-route` only resolves one CloudFront domain to `192.168.2.1`; it never makes a GitHub HTTP request.
- Exact Mac path reproduced: GitHub repository returned `504` / `Fastly error: unknown domain github.com`; the short `/robots.txt` probe misleadingly returned 200.
- Exact repository through server-88 US lane returned 504/92 bytes, while the existing DE lane, server-44 lane, and direct control returned 200/281787 bytes.

## Delivery

- Focused TDD: 20/20 passed, including the two-failure repair transition with a mocked deploy and required post-repair semantic verification.
- Full verification: `npm run build` passed; `npm test` passed 392/392; `scripts/deploy-all.sh --dry-run server-88` passed remote validation.
- Live server-88 deploy completed at 2026-08-29T20:17:36+03:00 with remote backup, candidate validation, Xray restart, and smoke checks.
- Post-deploy exact LAN-edge series: 3/3 returned HTTP 200, 281788 bytes, and the repository marker.
- Installed `github-route-autoheal.timer`; source/live unit parity passed. Initial service run exited 0 and recorded `failures=0`, `status=healthy`.
- Rollback: `scripts/deploy-github-route-autoheal.sh rollback 20260829_201756`.
- Real Mac Chrome canary after reload: title is `meanwebuser/whitetransport-public: Sanitized public source snapshot of WhiteTransport` with the exact requested URL; no Bad request/Fastly page.

- Autonomous timer proof: the scheduled 20:18:59 run completed successfully at 20:19:00 and refreshed `status=healthy`, `failures=0` without manual invocation.
- Final Mac proof: HTTP 200, 281787 bytes, repository marker present; the real Chrome tab title remained the expected WhiteTransport repository title.
- Implementation commit: `3a14512 fix(router): auto-heal GitHub smart edge route`.

## Profile-path regression follow-up

Started at 2026-08-29T20:36:54+03:00 (manual system clock). Estimate: minimum 8, maximum 25 active minutes; active time is not continuously controlled.

- Wanted result: the watchdog must catch the reported `Fastly error: unknown domain` on `https://github.com/meanwebuser`, not only failures of one repository page.
- Real canary: both the profile and repository URLs render through the exact LAN edge, and real Mac Chrome shows the profile rather than a Fastly error.
- Smallest vertical slice: add the profile URL as a second semantic probe in the existing watchdog, retain the same two-failure repair transaction, deploy only the existing server-100 unit, and prove the live browser path.
- Discard: generic website monitoring, unrelated GitHub/API routes, a new repair service, and router/nginx topology changes.
- Red proof: a fixture with a healthy repository page and broken profile page failed before the implementation.
- Focused green proof: all 3 watchdog tests pass after probing both URLs.
- Full verification: `npm test` passes 393/393, `npm run build` succeeds, shell syntax and source diff checks pass.
- Live activation: the existing server-100 oneshot completed successfully with `failures=0`, and the next autonomous timer run at 20:42:16 also completed successfully and refreshed `status=healthy`.
- Exact LAN proof: profile 5/5 and repository 5/5 returned HTTP 200 with their required markers and none of the known error bodies.
- Real browser proof: a fresh explicit Mac Chrome window loaded `https://github.com/meanwebuser` with title `meanwebuser (meanwebuser) · GitHub`.
- Implementation commit: `9eb2c31 fix(router): monitor GitHub profile path`.

Status: complete; final task-record commit and blocking push pending.

## Deterministic vpn2 routing follow-up

Started at 2026-08-30T13:58:02+03:00 (manual system clock). Estimate: minimum 10, maximum 20 active minutes; active time is not continuously controlled.

- Wanted result: GitHub traffic entering the LAN Smart Edge must use vpn2 deterministically and never fall through to a direct outbound.
- Shortest real canary: the reported OAuth URL renders in a real browser, while the deployed server-88 rule maps the GitHub family to a single outbound whose destination is `vpn2.bezrabotnyi.com`.
- Smallest YAGNI vertical slice: add one explicit high-priority GitHub-family rule to the existing LAN Smart Edge, pin it to the stable `de-xhttp-h2` vpn2 transport, and add the OAuth URL to the existing semantic watchdog.
- Discard: generic interception of every external DNS/DoH client, new proxy infrastructure, unrelated domains, and changes to nginx or public ingress.
- Red proof: focused tests failed because the GitHub rule and OAuth semantic probe were both absent.
- Focused green proof: 9/9 route/watchdog tests passed; full suite passed 393/393 and `npm run build` succeeded.
- Deployment: server-88 candidate validation, backup, activation, Xray restart, and smoke tests passed; the semantic watchdog was reinstalled and is healthy. Rollback receipt: `20260830_140621`.
- Live route proof: server-88 maps the four GitHub suffix families from both LAN Smart Edge inbounds to `de-xhttp-h2`; the deployed peer is `vpn2.bezrabotnyi.com:28443` and Xray is active.
- Exact edge proof: the reported OAuth path returned HTTP 200 through `192.168.2.1` five times; the watchdog state is `healthy` with zero failures.
- Real browser proof: BrowserOS rendered the actual GitHub sign-in page at the reported OAuth URL, with no Fastly error body.
- Implementation commit: `b928ca4 fix(router): pin GitHub traffic to vpn2`.

Status: complete; implementation and delivery record pushed to `origin/main` through `d6a2322`.

## Direct-bypass follow-up

Started at 2026-08-30T14:17:07+03:00 (manual system clock). Estimate: minimum 10, maximum 20 active minutes; active time is not continuously controlled.

- Wanted result: the affected client must not reach GitHub directly even when it retains or obtains a public GitHub/Fastly address.
- Shortest real canary: the same client opens `/login/device` successfully, while router/server-88 evidence shows the connection traverses the VPN edge and vpn2.
- Smallest YAGNI vertical slice: identify the client and its bypass mechanism, then add the narrowest persistent transparent enforcement that captures GitHub TLS without changing unrelated traffic.
- Discard: global TLS interception, blanket DoH blocking, unrelated domain routing, and browser-specific workarounds unless the client itself is the only broken surface.
- Root cause: the client retained a public GitHub Pages/Fastly address and bypassed the DNS Smart Edge; additionally, the earlier ordinary server-88 deploy had removed the mandatory TPROXY inbound while leaving its nft policy active.
- Red proof: canonical server-88 lacked the TPROXY inbound, router had no `github_v4` enforcement, and the first poisoned-IP canary timed out because the deployer installed a new nft file without restarting the already-active policy unit.
- Fix: preserve the TPROXY inbound in canonical config, sniff HTTP/TLS hostnames, pin sniffed GitHub traffic to `de-xhttp-h2`, mark the principal GitHub web CIDRs on OpenWrt, and restart the policy unit after every coupled deploy.
- Focused proof: 22/22 transparent-route tests passed; full suite passed 394/394 and TypeScript build succeeded.
- Live proof: router `github_v4` contains `185.199.111.133`, its PREROUTING counter rose from 9 to 41 packets, server-88 TPROXY and policy are active, and the route peer is `vpn2.bezrabotnyi.com:28443`.
- Real browser proof: headless Chrome on the LAN Mac was forced to resolve `github.com` to the exact poisoned `185.199.111.133` yet rendered GitHub Sign in with HTTP 200 and no Fastly error.
- Implementation commits: `fb152e2`, `71a53d6`, and `dde38b8`.

Status: complete; transparent enforcement and delivery record pushed to `origin/main` through `2a73289`.

## Direct GitHub correction

Started at 2026-08-30T14:51:58+03:00 (manual system clock). Estimate: minimum 8, maximum 20 active minutes; active time is not continuously controlled.

- Wanted result: the affected Mac Chrome opens GitHub reliably over the ordinary direct Internet path.
- Shortest real canary: Chrome itself loads `https://github.com/megamen32/site-mimic`, while Secure DNS no longer bypasses the system resolver and the router has no GitHub transparent-VPN rule.
- Smallest YAGNI vertical slice: remove the GitHub-only vpn2/TPROXY overrides, remove GitHub from the runtime SmartDNS proxy policy, disable the Mac Chrome OpenDNS override, deploy only the affected DNS/transparent-lane surfaces, and reload the exact browser URL.
- Discard: new proxies, new monitoring infrastructure, changes to unrelated Telegram TPROXY behavior, nginx/public-ingress changes, and interception of unrelated traffic.
- Root-cause evidence: the affected Chrome profile has Secure DNS forced to `https://doh.opendns.com/dns-query{?dns}`, bypassing LAN DNS and reproducing the GitHub Pages/Fastly address family shown in the report.

- Red proof: 6 focused assertions failed against the vpn2 SmartDNS rule, LAN-edge override, GitHub TPROXY route, router CIDR interception, and server-88 nft interception.
- Green proof: focused suite passes 26/26; full suite passes 394/394; `npm run build` succeeds.
- Live deployment: unified SmartDNS activated with rollback suffix `20260830_115949`; the canonical router DNS candidate was applied after the unrelated server-88 stale-lease compatibility unit rejected its own redeploy; the coupled Telegram lane was redeployed without GitHub while preserving its active Telegram TPROXY service.
- Live route proof: router DNS answers `github.com` as public `140.82.121.3`; `github_v4` and its PREROUTING rule are absent; server-88 has no GitHub route; Xray and Telegram policy are active.
- Mac correction: Chrome Secure DNS changed from forced OpenDNS to `off`, with backup `Local State.bak_github_direct_20260830_145158`; all 10 existing tabs were restored and the requested repository opened as an 11th tab.
- Real browser proof: after a fresh navigation, actual Mac Chrome shows `GitHub - megamen32/site-mimic...`; system proxy settings are off and a direct request returns HTTP 200 from `140.82.121.3`.

- Implementation commit: `95783ed fix(router): restore direct GitHub access`.

Status: complete; reviewed implementation pushed to `origin/main`.

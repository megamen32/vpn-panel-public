# Public SmartDNS MVP

Started at 2026-08-31T00:47:25+03:00 (manual clock). Estimate: minimum 15, maximum 35 active minutes; active time is not continuously controlled.

- Wanted result: anyone who knows `95.165.165.65` can use the owner's SmartDNS over ordinary UDP/TCP DNS, with observable public-only usage and `bezrabotny.com` resolving to `95.165.165.65`.
- Shortest real canary: an external host resolves `bezrabotny.com` through `@95.165.165.65` over both UDP and TCP, and the dedicated public-DNS packet/byte counter increases while LAN DNS remains local-profile.
- Smallest YAGNI vertical slice: add a separate public-profile plain-DNS listener, one static A override, source-controlled OpenWrt WAN redirects with named counters and a usage command, then deploy only SmartDNS/firewall-owned surfaces.
- Discard: authentication, per-user billing, a new dashboard, a Telegram bot/channel, public recursive-DNS SLA, DNSSEC authority, and changes to VPN/Xray/HTTPS ingress.

Pre-deploy verification:

- `npm test`: 396/396 passed.
- `npm run build`: passed.
- `go test ./...` in `scripts/smartdns-go`: passed.
- SmartDNS deploy dry-run and OpenWrt `fw4 check`: passed.
- `npm run validate:xray` was not applicable to this DNS-only change and could not start without `DATABASE_URL`; no Xray config was changed.

Live delivery evidence (2026-08-31T01:00+03:00):

- `smart-dns.service` is active and enabled; UDP/TCP `192.168.2.100:5354` are listening.
- External VUSA canary resolved `bezrabotny.com A` through `95.165.165.65:53` over UDP and TCP to `95.165.165.65` (TTL 60).
- The same external resolver returned normal recursive A answers for `ya.ru`.
- Named WAN counters increased from UDP `0 packets / 0 bytes`, TCP `0 / 0` to UDP `2 / 157`, TCP `1 / 60`.
- SmartDNS rollback suffix: `20260830_215901`; OpenWrt firewall backup: `/etc/config/firewall.bak_public_smartdns_20260830_215916`.
- No runtime-affecting changes were made after the external canary.

Status: complete. Active time was not continuously controlled; wall-clock completion was about 13 minutes from the recorded start.

Correction started at 2026-08-31T01:01:35+03:00 (manual clock). Estimate: minimum 5, maximum 15 active minutes; active time is not continuously controlled.

- Wanted result: correct the zone to `bezrabotnyi.com`; resolve its apex and every subdomain to `95.165.165.65`, except the transport hosts `vpn2.bezrabotnyi.com` and `vusa.bezrabotnyi.com`.
- Shortest real canary: external UDP/TCP queries prove the apex and an arbitrary subdomain return `95.165.165.65`, while the two exclusions return their current authoritative direct-DNS answers and never `95.165.165.65`.
- Smallest YAGNI vertical slice: suffix static-A matching plus an exact exclusion list in the existing public SmartDNS listener.
- Discard: enumerating nginx vhosts, changing public authoritative DNS, wildcard certificates, or touching VPN transport routing.

Correction verification:

- SmartDNS Go tests: passed.
- Public SmartDNS focused tests: 2/2 passed.
- Full repository tests: 396/396 passed.
- TypeScript build and SmartDNS deploy dry-run: passed.
- Review removed the stale `bezrabotny.com` key during config migration.
- First live smoke exposed that excluded names still followed the public default proxy route; the repaired rule forces exact exclusions through direct DNS and avoids stale hardcoded transport IPs.

Correction live evidence (2026-08-31T01:08+03:00):

- Deployed SmartDNS backup suffix: `20260830_220709`; service is active.
- External apex, `vpn.bezrabotnyi.com`, and an arbitrary wildcard canary returned `95.165.165.65` through public `95.165.165.65:53` over UDP/TCP.
- External `vpn2.bezrabotnyi.com` returned direct DNS `194.67.71.96`; `vusa.bezrabotnyi.com` returned `194.67.71.133`, over both UDP and TCP, never the synthesized `95.165.165.65`.
- One first-attempt external UDP packet timed out for each exception; the bounded retry and both TCP checks passed, matching ordinary WAN packet-loss behavior rather than a deterministic resolver failure.
- Public WAN accounting advanced to UDP `6 packets / 519 bytes` and TCP `5 / 284`.
- No runtime-affecting change was made after this canary.

Correction status: complete. Active time was not continuously controlled; wall-clock completion was about 7 minutes from the correction start.

Pinned transport correction started at 2026-08-31T13:42:18+03:00 (manual clock). Estimate: minimum 5, maximum 12 active minutes; active time is not continuously controlled.

- Wanted result: keep the wildcard zone on `95.165.165.65`, but pin `vpn2.bezrabotnyi.com` to `212.192.31.128` and `vusa.bezrabotnyi.com` to `185.240.120.152` exactly.
- Shortest real canary: external UDP/TCP queries through `95.165.165.65:53` return both pinned IPs and still return `95.165.165.65` for an ordinary zone subdomain.
- Smallest YAGNI vertical slice: give exact static-A entries precedence over the suffix exclusion; change no routing or firewall surface.
- Discard: following authoritative DNS for the two transports, modifying Reg.ru records, or changing VPN endpoints.

Pinned correction verification:

- Exact static-A entries now precede suffix exclusions.
- Go tests prove the actual DNS responses for both pinned transport hosts.
- Focused public-DNS tests, TypeScript build, and deploy migration dry-run passed.

Pinned correction live evidence (2026-08-31T13:46+03:00):

- Deployed SmartDNS backup suffix: `20260831_104532`; service is active.
- External VUSA canary through `95.165.165.65:53` returned `vpn2.bezrabotnyi.com = 212.192.31.128` over UDP and TCP.
- The same canary returned `vusa.bezrabotnyi.com = 185.240.120.152` over UDP and TCP.
- An ordinary wildcard canary still returned `95.165.165.65` over UDP and TCP.
- WAN accounting increased by exactly three UDP and three TCP requests.
- No runtime-affecting change was made after this canary.

Pinned correction status: complete. Active time was not continuously controlled; wall-clock completion was about 4 minutes from the recorded start.

# Alfa Careers CloudFront load repair

Started at 2026-08-27T03:02:45+03:00 (manual clock)

- Wanted result: `https://alfa.h.careers/` opens for a real visitor without the blocked jQuery asset preventing the page from loading.
- Shortest real canary: browser load of the public URL shows a rendered page and the jQuery request succeeds or is no longer required.
- Smallest YAGNI vertical slice: identify the owner of the deployed page or its delivery policy and make one reversible asset-delivery correction.
- Discard: redesign, framework migration, unrelated VPN Panel changes, and broad CDN hardening.

Cycle: public-site diagnosis and minimal repair. Estimate: minimum 8, maximum 25 active minutes. Active time: not continuously measured.
Diagnosis: OpenWrt dnsmasq identifies the intentional LAN-edge answer for the
CloudFront hostname as a DNS-rebind attack, returns no A record, and therefore
prevents the browser from loading the mandatory Webflow jQuery asset. Public
resolvers return valid CloudFront addresses.

Deployment: applied directly with the canonical router script after the
`router-dns` orchestrator stopped on an unrelated server-88 compatibility-unit
rollback. Router backup: `/etc/config/dhcp.bak_smartdns_20260827_000708`.

Verification: router DNS returns `192.168.2.1`; the required jQuery asset loads
through that address with HTTP 200 and 89,476 bytes; headless Chrome renders
the public page title and its primary CTA.

Regression: focused OpenWrt SmartDNS test passes; `npm run build` passes. The
full suite has one unrelated existing failure in
`cloudflare-challenge-routing.test.ts` (389 pass, 1 fail).

Status: complete.

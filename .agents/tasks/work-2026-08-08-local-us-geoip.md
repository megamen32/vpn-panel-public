# Local SmartDNS US GeoIP routing

Status: superseded-by-user-correction

Original request: Добавь, пожалуйста, в локальном проксировании все американские сайты, чтобы шли. Заебался я уже. Там же есть GeoIP какой-то, да, американский.

Objective: Make LAN Smart Edge route previously-unmatched external sites, including American sites, through the ordinary VPN proxy path.

Business canary: A LAN HTTPS request to an otherwise-unmatched external site uses the ordinary DE/general VPN path, while an explicit direct/RU rule remains direct.

Confirmed scope: canonical SmartDNS LAN default route and its deployment generator, focused regression coverage, and deployment only after explicit approval at the consequential boundary.

Explicit exclusions: public External SmartDNS behavior, arbitrary domain-list maintenance, changing the general LAN proxy default, and unrelated dirty-file changes.

Initial active-minute estimate: optimistic 35 / likely 60 / pessimistic 120.

## Research findings

- `local-proxy` currently synthesizes LAN traffic to `192.168.2.75`; the server-88 `in-lan-smart-http` and `in-lan-smart-tls` rules send unmatched traffic to the DE `proxy` balancer.
- The existing US lane is `us-auto`, fed by the dedicated `:3127` HTTP proxy and VUSA outbounds.
- Current server-88 config has no `geoip:us` routing rule or local GeoIP asset. The subscription validator uses a Russia-only GeoIP database, which cannot classify all US destinations.
- The user clarified that `us-auto` is not wanted; American sites should use the ordinary VPN path like other proxied sites.

## Plans

1. Максимально идеальный: add and manage a full GeoIP asset for server-88, route `geoip:us` before the general DE rule for LAN Smart Edge, validate the generated config and real US/non-US canary, then deploy server-88 with rollback receipt.
2. Нормальный: reuse a vetted full GeoIP asset already available in the deployment toolchain, add the `geoip:us` rule and asset sync to the canonical server-88 generator, validate locally, and stop before live deployment for approval.
3. YAGNI 80/20 — полный результат: add a reviewed US domain policy for the known blocked services and generate explicit `us-auto` LAN rules, without claiming all US IP destinations; cheaper but does not satisfy the literal “all American sites” requirement.

## Selected implementation correction

- Change the canonical LAN default from `direct` to `proxy`.
- Change `scripts/deploy-smartdns-unified.sh` to preserve `localDefaultRoute = "proxy"` instead of forcing `direct` during runtime config generation.
- Keep direct/RU suffixes, direct domains, local-only rules, and the Cloudflare challenge direct exception ahead of the default.
- Do not add GeoIP assets, `geoip:us`, or `us-auto` rules.

## User correction

- The LAN default must remain `direct`.
- Only American-site traffic should be added to the existing normal `proxy` route.
- The prior broad-default implementation was reverted before live deployment.

## Gate

Selected plan: 2 (Normal), then corrected by the user to use the ordinary VPN path instead of `us-auto`.

Remote evidence: read-only SSH to `roomhacker@88.bezrabotnyi.com` was blocked by `Permission denied (publickey,password)`, so an existing remote GeoIP file is unconfirmed.

## Technical preview

- `src/smart-dns-policy.ts`: set the canonical LAN default route to `proxy` and retain explicit direct exceptions.
- `scripts/deploy-smartdns-unified.sh`: generate the live SmartDNS config with `localDefaultRoute = "proxy"`.
- `tests/local-smartdns-default-route.test.ts`: assert unmatched LAN sites use the ordinary VPN route and the deploy generator preserves it.
- `tests/smart-dns-policy.test.ts` and `tests/cloudflare-challenge-routing.test.ts`: update stale expectations for the intentional default-route change and explicit challenge exception.

Acceptance proof: focused RED/GREEN tests, full `npm test`, `npm run build`, and diff validation passed; live SmartDNS deploy and LAN HTTPS canary remain pending explicit authorization.

Stop when: the selected code path is green and the live deploy canary is ready for authorization.

Abandon when: the user restores the requirement for country-selective routing instead of ordinary VPN routing; that would require a separate GeoIP design.

Forbidden without explicit user request: live SmartDNS/service restart, router/DNS mutation, rollback, or server-88 deployment.

## Evidence

- RED: focused test failed with `localDefaultRoute: direct` and deploy script forced `.localDefaultRoute = "direct"`.
- GREEN: `npm test` passed 348/348; `npm run build` passed; `git diff --check` passed.

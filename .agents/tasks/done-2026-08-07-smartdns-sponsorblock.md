# SmartDNS SponsorBlock external VPN

Status: complete

Original request: add [https://sponsor.ajay.app/](https://sponsor.ajay.app/) to smartdns vpn external; user clarified: all domains for SponsorBlock.

Objective: Route the complete SponsorBlock domain family through the external SmartDNS VPN profile.

Business canary: `sponsor.ajay.app` and the SponsorBlock API hostname resolve/use the public proxy route.

Confirmed scope: canonical SmartDNS policy and focused regression coverage in this repository.

Explicit exclusions: no live deployment, service restart, DNS/ingress mutation, or unrelated dirty-file changes.

Initial active-minute estimate: optimistic 10 / likely 15 / pessimistic 25.

## Plan

1. Найти канонический источник доменных правил и подтвердить семейство доменов SponsorBlock.
2. Добавить минимальное правило внешнего VPN-профиля и красный тест.
3. Исправить правило, прогнать тесты и проверить итоговый маршрут.

## Evidence

### 2026-08-07

- Worktree contains unrelated dirty changes; `deploy/smartdns/protected-policy.json` already has an uncommitted `hailuo.ai` addition and must be preserved.
- Official SponsorBlock documentation identifies `sponsor.ajay.app` as the public API, and `api.sponsor.ajay.app` is an active API hostname; the suffix `sponsor.ajay.app` covers both plus status/web subdomains.
- RED: `npx tsx --test tests/sponsorblock-smartdns.test.ts` failed because `sponsor.ajay.app` resolved to `direct`.
- GREEN: `npx tsx --test tests/sponsorblock-smartdns.test.ts tests/smart-dns-policy.test.ts tests/smartdns-deployment-policy.test.ts` passed 16/16.
- GREEN: `npm run build` passed.
- Live deployment intentionally excluded pending explicit authorization for service mutation.

# SmartDNS Notion external VPN

Status: complete

Original request: Добавь Notion и его PDMN тоже в проксирование в External.

Objective: Route Notion and its PDMN subdomain, plus the required Notion web/static/content domain families, through the external SmartDNS VPN profile.

Business canary: `notion.so` and `pdmn.notion.so` use the public proxy route.

Confirmed scope: canonical SmartDNS policy and focused regression coverage in this repository.

Explicit exclusions: no live deployment, service restart, DNS/ingress mutation, or unrelated dirty-file changes.

Initial active-minute estimate: optimistic 10 / likely 15 / pessimistic 25.

## Plan

1. Проверить текущую policy и официальные сетевые домены Notion.
2. Добавить красную регрессию для Notion/PDMN и исправить canonical External policy.
3. Прогнать focused tests и build, затем зафиксировать только свои файлы.

## Evidence

### 2026-08-08

- Existing worktree has unrelated dirty changes; preserve them.
- Notion official network documentation identifies `notion.so` as the network endpoint.
- RED: `npx tsx --test tests/notion-smartdns.test.ts` failed because `notion.so` resolved to `direct`.
- GREEN: `npx tsx --test tests/notion-smartdns.test.ts tests/sponsorblock-smartdns.test.ts tests/smart-dns-policy.test.ts tests/smartdns-deployment-policy.test.ts` passed 17/17.
- GREEN: `npm run build` and `git diff --check` passed.
- Added `notion.com`, `notion.so`, `notion.site`, `notion-static.com`, `notionusercontent.com`, and `notion-status.com`; `pdmn.notion.so` is covered by the `notion.so` suffix.
- Live deployment intentionally excluded pending explicit authorization for service mutation.

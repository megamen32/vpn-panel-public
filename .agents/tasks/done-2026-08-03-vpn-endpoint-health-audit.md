# Аудит здоровья VPN endpoints и серверов vpn2/vusa

Status: complete
Class: Full (live production topology, recommendations can affect client availability)

## Original request

> Как там здоровье эндпоинтов и серверов vpn2/vusa? Какие самые устойчивые endpoints , какие стоит отключить потому что они безпроезны а какие добавить?

## Objective

Дать подтвержденную текущими read-only проверками картину здоровья vpn2 и vusa, ранжировать пользовательские endpoints по устойчивости, отделить временный сбой от системно бесполезного транспорта и предложить конкретный keep/disable/add набор без изменения production.

## Business canary

Минимальный реальный canary: с контролируемой точки выполнить подключение через каждый рекламируемый DE/US endpoint и получить внешний HTTPS-ответ/exit IP ожидаемого региона; отдельно подтвердить доступность и ресурсное здоровье самих vpn2/vusa.

## Confirmed scope

- Read-only live health vpn2 и vusa.
- Текущий каталог и порядок endpoints.
- Свежие автоматические и ручные вертикальные проверки транспортов.
- Рекомендации keep / disable / add с указанием уверенности и недостающих доказательств.

## Explicit exclusions

- Никаких рестартов, reload, deploy, firewall/DNS/nginx/Xray изменений.
- Никакого удаления endpoint из подписок или production-конфигурации.
- Никаких побочных security, secrets, ACL, database, Grafana или fleet-wide аудитов.
- Никаких заявлений об устойчивости только по `active`/порту без реального трафика.

## Initial estimate (immutable)

- Optimistic: 20 active minutes
- Likely: 35 active minutes
- Pessimistic: 55 active minutes

## Initial plan

1. Запустить компактный read-only fleet probe и локализовать только проблемные узлы.
2. Сверить source of truth каталога, endpoint order и существующий автотестер.
3. Собрать свежую матрицу E2E-проездов DE/US с ожидаемыми exit IP и задержками.
4. Разделить endpoints на keep / observe / disable и определить недостающие транспорты.
5. Перед завершением получить независимый verdict Overseer по исходному запросу и доказательствам.

## Estimate revisions (append-only)

None.

## Evidence log (append-only)

- 2026-08-03: задача создана до live-проверок; worktree уже содержит посторонние изменения, они признаны hands-off.
- 2026-08-03: bundled fleet probe: vpn2/vusa reachable, Xray+nginx active, expected listeners `:443`, `:28443`, `127.0.0.1:20080-20085` present; Xray `26.6.1` on both. vpn2: 75% disk, 452 MiB available; vusa: 78% disk, 425 MiB available.
- 2026-08-03: vpn2 has unrelated failed `coturn.service`; VPN listeners and E2E paths remain working. No service mutation performed.
- 2026-08-03: post-test pressure: both 1 vCPU hosts were CPU-busy. `smart-edge.service` accounted for about 79.8% CPU on vpn2 and 17.2% on vusa; no active swap-in/out pressure during the short sample. Treat host capacity as degraded headroom, not an outage.
- 2026-08-03: three sequential fresh quick E2E matrices from server-44, no telemetry/apply step: `19/25` eligible in every run, expected exits `212.192.31.128` (DE) and `185.240.120.152` (US), zero runner errors.
- 2026-08-03: fresh pass 3/3: all eight DE/US product+mobile relays; DE `de-xhttp-h2`, `de-cdn`, `de-xhttp`, `de-direct-ws`, `de-grpc`, `de-cdn2`, `de-httpupgrade`; US `us-reality`, `us-cdn`, `us-cdn2`, `us-xhttp-h2`.
- 2026-08-03: initial ephemeral fresh fail 0/3: `de-direct`, `us-grpc`, `us-xhttp-h2-443`, `us-xhttp`, `us-direct-ws`, `us-httpupgrade`. One unsaved ephemeral `us-xhttp-h2-443` observation reported the expected exit IP but still failed Telegram; because that raw JSON was cleaned, this observation is non-durable and excluded from the final evidence/ranking. In all three later persisted raw matrices `us-xhttp-h2-443` has `exitIp: null` and a failed Telegram gate.
- 2026-08-03: 14-day production telemetry (runner errors excluded from effective observations) strongest: `de-cdn` 99.8%, `de-xhttp-h2` 99.7%, `de-cdn2`/`de-direct-ws` 99.5%, `de-httpupgrade` 98.9%, `us-cdn` 98.4%, `us-cdn2` 97.9%. Weak: `us-grpc` 38.3%, `us-xhttp` 33.3%, `us-xhttp-h2-443` 32.3%, `us-direct-ws` 23.2%, `us-httpupgrade` 22.9%, `de-direct` 0%.
- 2026-08-03: effective 14-day observations supporting those percentages: `de-cdn` 442/443, `de-xhttp-h2` 303/304, `de-cdn2` 441/443, `de-direct-ws` 435/437, `de-httpupgrade` 438/443, `us-cdn` 443/450, `us-cdn2` 461/471, `de-grpc` 283/314, `us-reality` 428/489, `us-xhttp-h2` 271/339, `us-grpc` 80/209, `us-xhttp` 55/165, `us-xhttp-h2-443` 51/158, `us-direct-ws` 35/151, `us-httpupgrade` 35/153, `de-direct` 0/150. This ranking is server-44/LAN evidence, not multi-origin proof.
- 2026-08-03: health telemetry is stale since 2026-07-31 20:08Z. The hourly timer on server-100 is enabled/active but the service exits 1 every hour because user `roomhacker` cannot read `/etc/vpn-panel/secure.json`; latest observed error is `EACCES` at 07:00 MSK.
- 2026-08-03: a live health-user `xray-json` subscription still emitted all 25 endpoints, including all six fresh failures. Three-day thresholds currently fail open for low observations or retain borderline stale scores.
- 2026-08-03: Explorer independently confirmed catalog/order, latest retained matrix, historical pass/fail split, and the absence of a current automated result.
- 2026-08-03: after Overseer requested durable proof, three fresh no-telemetry raw matrices were persisted under `trash/logs/vpn-endpoint-health-20260803/`; recursive key scan found no token/password/UUID/private-key/API-key/authorization fields.
  - run 1: `server44-quick-run-1.json`, runId `ed3b2bc4-bb59-4435-b15e-40d2de3d4a2c`, SHA-256 `27d002b5800d29277b107a6db47a3c085a664098b63328607e80d14e83e7ba5b`, 19/25 eligible, 6 failed, 0 errors.
  - run 2: `server44-quick-run-2.json`, runId `14571a57-01cf-4179-a49b-357cfd59317c`, SHA-256 `d63cf5e5c6bdb7c8db93fcfc9590b812cbbb23b190a30c93d6278635f86bf74b`, 19/25 eligible, 6 failed, 0 errors.
  - run 3: `server44-quick-run-3.json`, runId `671a7a40-dd58-41a2-8ac9-f42e3105e866`, SHA-256 `0e913f026cc239f56cd27d1c576f3ed7ffbd244b44d23f8029b6cbf70753f4d6`, 19/25 eligible, 6 failed, 0 errors.
  - all runs recorded expected successful exits `212.192.31.128` and `185.240.120.152`; the identical failed set was `de-direct`, `us-grpc`, `us-xhttp-h2-443`, `us-xhttp`, `us-direct-ws`, `us-httpupgrade`.

## Integrated recommendation draft

- Keep/promote: canonical four products and mobile variants; DE `de-cdn`, `de-xhttp-h2`, `de-cdn2`, `de-direct-ws`, `de-xhttp`, `de-httpupgrade`; US `us-cdn`, `us-cdn2`, `us-reality`, with `us-xhttp-h2` as a later high-port fallback.
- Demote but retain temporarily: `de-grpc` (fresh pass, weaker 14-day reliability and legacy transport).
- Remove from public subscriptions until repaired: `de-direct`, `us-grpc`, `us-xhttp-h2-443`, `us-xhttp`, `us-direct-ws`, `us-httpupgrade`.
- Add only after automation repair: first restore a working US XHTTP/H2 path on public `:443`; then add an independent second US upstream/provider rather than another alias on the same vusa host. A second independent DE upstream is the next resilience gain.
- The independent-upstream item is an architecture hypothesis, not a result of this diagnostic. Region, budget, provider/ASN independence criteria, and acceptance soak require a separate human-selected change cycle.

## Completion gate

- 2026-08-03: Overseer final verdict `APPROVE`; no unanswered questions. Approved scope is a diagnostic report plus keep/observe/temporarily-disable recommendations. Any production disable, automation repair, or upstream addition remains a separate confirmed change cycle.

# Work: Happ routing must behave like SmartDNS (selective proxy), not full-tunnel

## Initial plan (2026-08-16, Russian)

Запрос пользователя (дословно):

> сейчас те сайты что мы выдаем должны работать так же как по сути и smartdns а сейчас не так. в идеале это впн только немного openai telegram whatsapp а все русские строго direct исправь и пуш

Цель: инвертировать клиентский роутинг в Happ-подписке (`happRoutingLink()` в
`src/subscriptions.ts`). Сейчас `GlobalProxy: "true"` — весь трафик в VPN, smart/full
решают релеи. Нужно: по умолчанию direct (как локальный профиль SmartDNS), через VPN —
только семьи openai + telegram + whatsapp; всё русское — строго direct.

Канар: unit-тест на декодированный Happ-профиль (GlobalProxy=false, ProxySites =
3 семьи, DirectSites/DirectIp содержат RU-теги, publication.pravo.gov.ru больше
не proxy). Плюс `npm run build` и живой заголовок `/sub/<token>/happ` после деплоя.

Класс: Short (поведенческий багфикс, red-first регрессионный тест).

Скоуп:
- `src/subscriptions.ts::happRoutingLink()` — единственная прод-поверхность изменения.
- Обновить тест `tests/subscriptions.test.ts` (красный → зелёный).
- Обновить доку: `docs/06-subscription-routing.md`, раздел Happ routing в `AGENTS.md`.
- Telegram IP CIDR: официальный список https://core.telegram.org/resources/cidr.txt
  (Telegram-клиенты ходят по захардкоженным IP, доменные правила их не покрывают).

Исключения (осознанно НЕ меняем):
- `xrayClientSubscription()` / `singBoxSubscription()` остаются full-tunnel — на них
  завязан auto-endpoint-check (тестирует каждый эндпоинт сквозным трафиком) и LAN-диагностика.
- Серверные правила smart-релеев не трогаем: RU-direct на релее становится
  избыточным, но безвредным.
- Семьи SmartDNS вне трёх названных (youtube, discord, instagram, facebook, x,
  spotify, notion, claude, а также защищённые `ua`/`hailuo.ai`) в Happ-профиль НЕ
  включаем — пользователь явно назвал whitelist: openai, telegram, whatsapp.
- macOS-профиль (`macosSingBoxSubscription`) уже работает по модели smartdns — не трогаем.

Оценка (иммутабельная, на старте): min 15 / max 40 активных минут.

Деплой (npm run build + restart autovpnallowip.service) — отдельная граница
авторизации: спрошу отдельным прямым вопросом после пуша.

## Progress

- 2026-08-16: Investigated current model. `happRoutingLink()` is full-tunnel
  (`GlobalProxy: "true"`, DirectSites only panel host, DirectIp only geoip:private,
  ProxySites only `publication.pravo.gov.ru` workaround). Documented design decision
  in `docs/06-subscription-routing.md`: "Smart/Full policy is enforced by the selected
  server-side relay". User directive inverts this: client-side selective proxy like
  the macOS SmartDNS profile (`macosSingBoxSubscription`, final: direct).
- 2026-08-16: Compact geo DB (golukon russia-only) contains only private/RU ranges
  and the `ru-inside` geosite tag — so RU-strict rules use `geoip:ru` +
  `geosite:ru-inside`; proxy families use explicit domain suffixes; Telegram DC IPs
  use official CIDR list (no `geoip:telegram` in the compact DB).
- 2026-08-16: Fetched official Telegram CIDRs from core.telegram.org (14 ranges,
  IPv4+IPv6). Protected SmartDNS suffixes (`ua`, `hailuo.ai`) stay out of the Happ
  whitelist per the user's explicit three-family list.
- 2026-08-16: Red-first regression test rewritten in tests/subscriptions.test.ts
  ("Happ routing proxies only openai/telegram/whatsapp and keeps Russia strictly
  direct"). Confirmed Red against current code (`GlobalProxy 'true' !== 'false'`).
- 2026-08-16: Implemented in src/subscriptions.ts: HAPP_PROXY_SITES (3 families,
  17 suffixes) + HAPP_PROXY_IP (14 official Telegram CIDRs), GlobalProxy="false",
  DirectSites=["vpn.bezrabotnyi.com","geosite:ru-inside"],
  DirectIp=["geoip:private","geoip:ru"]. Dropped the publication.pravo.gov.ru
  proxy exception (RU is strictly direct per user directive). Test green 16/16,
  full suite green 392/392, npm run build (tsc) clean.
- 2026-08-16: Docs updated: docs/06-subscription-routing.md (routing JSON +
  policy notes + default-endpoint section) and AGENTS.md "Happ routing link
  policy" section (was stale Loyalsoldier-era description).
- 2026-08-16: Foreign changes reviewed: both are .agents/tasks evidence files
  (mac-split-routing follow-up note; bez-windows task record for already
  committed e35a8d5). Reviewed-safe, included in commit.


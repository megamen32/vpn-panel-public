# Happ Auto и история качества

## Профиль пользователя

`/sub/:token/happ-json` выдаёт JSON-подписку Happ: один профиль **Авто · стабильный**, затем ручные точки в порядке надёжности. Не публикуйте реальный token.

Параметр `target=external-mac` сравнивает только измерения Mac; `target=external-wireless-android` — Android; `target=lan-server44` — LAN. Без target подпись явно указывает «Все сети». Отсутствие свежих данных не означает неисправность.

Период истории для подписки — три дня. Сначала сравнивается доля успешных endpoint-проверок, затем медианная HTTPS-задержка Telegram. Подпись показывает размер выборки и скорость, если за этот период действительно был benchmark. Две успешные проверки не доказывают многодневную безотказность.

Auto использует существующий macOS Xray Smart-профиль и правила VPN Panel. При наличии минимум двух маршрутов с >=95% успешных измерений они составляют автоматический пул; иначе используются доступные опубликованные кандидаты. Xray observatory проверяет каждый кандидат, включая Finland, каждые 10 секунд; leastPing выбирает живой маршрут в соответствующей политике региона. Стартовый fallback следует порядку истории. Это выбор новых соединений, не бесшовный перенос уже открытого TCP-соединения.

JSON-профили передаются Happ напрямую, поэтому маршрутизация включена в каждый профиль. Ручные профили сохраняют Smart-политику и закрепляют выбранный выход. Обычные plain/v2ray подписки остаются доступными.

Официальное описание JSON-подписок: https://www.happ.su/main/ru/dev-docs/examples-of-links-and-parameters

## Где находятся код и данные

- Канонические исходники: private GitHub `megamen32/vpn-panel-private`, `src/subscriptions.ts`, `src/server.ts`.
- Работающая панель: `/home/roomhacker/apps/vpn-panel/dist/`, `autovpnallowip.service`.
- Запускаемые systemd-скрипты: `/usr/local/lib/vpn-panel/`.
- Общая история: PostgreSQL `vpn_test_runs` и `vpn_test_events`.
- Сохранённые результаты: `/home/roomhacker/apps/vpn-panel/vpn-testing/results/`.
- Повторяемый отчёт: `scripts/report-endpoint-quality.mjs`.
- Повторная доставка измеренного JSON: `vpn-testing/record-artifact.py`; сохраняет event IDs прежних результатов, добавляет throughput/UDP/preflight отдельными ID и не удваивает endpoint-наблюдения.
- Импорт реального USB Android curl-прогона: `vpn-testing/import-android-canary.py`.
- `.tmp` используется для сборочной изоляции и удаляемых конфигураций с ключами; production и история от него не зависят.

## Воспроизведение

После загрузки штатного окружения `.env` без вывода секретов:

```sh
node scripts/report-endpoint-quality.mjs --days=120 --endpoints=de-cdn,de-cdn2,us-cdn,us-cdn2,fi-helsinki-relay > vpn-testing/results/quality-history.json
```

Штатный `vpn-endpoint-check.timer` проверяет доступность одиннадцати маршрутов, включая четыре DNS/CDN и Finland. Benchmark выполняется последовательно, чтобы загрузки не конкурировали за один клиентский канал. Скорость не измеряется каждым health-запуском.

Cloudflare DNS-only домены `cdn[2].demiurge.space` и `us-cdn[2].demiurge.space` на 2026-09-16 разрешаются в адреса VPN2/VUSA. Имена CDN не означают прохождение трафика через Cloudflare POP.

## Проверка 2026-09-16

Последовательный benchmark на Mac M1: файл `unified-external-mac-benchmark-20260916_160147.json`, все пять маршрутов eligible. Загрузка 5 MB — ограниченный замер, не предел пропускной способности.

| Маршрут | HTTPS Telegram, мс | Загрузка, Мбит/с |
|---|---:|---:|
| Finland Helsinki | 400 | 37.01 |
| DE-CDN2 / DNS2 | 433 | 27.55 |
| DE-CDN / DNS | 530 | 22.81 |
| US CDN / DNS | 1790 | 2.18 |
| US CDN2 / DNS2 | 2099 | 1.78 |

Happ показывает медиану всех соответствующих измерений за три дня, поэтому число на экране может отличаться от последнего прогона.

В native Happ 5.3.0 на Mac профиль Auto импортирован, выбран и подключён; три HTTPS canary через utun вернули DE-выход. Finland видна первой среди ручных маршрутов, все четыре DNS/CDN сохранены, статистика и скорость видны в списке.

При рестарте выявлен EACCES: в 15:44 приватный secure.json был заменён root:root 0600. Восстановлен roomhacker:roomhacker 0600, каталог root:roomhacker 0750. Последующие изменения приватного JSON обязаны сохранять owner/mode. Чужие runtime-изменения server.js сохранены при установке только нового обработчика.

USB Android canary требует три успешных HTTPS-запроса и полную загрузку 3 MB для успешного endpoint-результата. Частичная загрузка HTTP 200 после timeout не считается успешной скоростью. На rmnet4 US CDN2 получил лишь 2,216,640 из 3,000,000 байт за 20 секунд; это сохранено как неуспешный benchmark, хотя три коротких HTTPS-запроса прошли. Finland на rmnet4: три запроса 302/331/508 мс и полная загрузка 15.19 Мбит/с.

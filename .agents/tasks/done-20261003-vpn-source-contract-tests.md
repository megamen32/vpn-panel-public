# Четыре падения VPN-тестов после проверки HA-заметок

Статус: локально исправлено и проверено; scoped commit/push и обновление
общего test2git-отчёта выполняет root. Production и сетевые настройки не менялись.

Исходное доказательство: `.test2git/vpn-panel.json`, commit `7f44ac2`,
2026-10-03 09:02:36 +03:00: 441 passed, 4 failed, build exit0.
Четыре теста отдельно воспроизвели те же падения за0.38s.

Проверены canonical `ServersAdministartion/AGENTS.md`, access-topology,
inventory README и карточки100/HAOS, nginx instructions и владельцы product
script/package. Факты ниже относятся к source contracts, не live-health.

1. Private sing-box listener: тест ожидал13128; canonical HAOS card явно
   фиксирует перенос на23128 с2026-09-16, поскольку13128 занят authenticated
   WAN DE. Совпадают пакет `haos-smart-edge-addons`, compatibility config0.1.16,
   run.sh и deploy supervisor_options_set. Тесты теперь требуют23128, сохраняют
   loopback bind и проверяют отсутствие коллизии с WAN.
2. Runtime inbounds: fixture передавала11args при обязательных18args. Добавлены
   явные отключённые FI/RU flags и отдельный mode0600 файл тестовых proxy users.
   Проверяются точные LAN/WAN listener objects, auth только WAN, оба outbound
   направления и уникальность портов; private loopback сохраняется.
3. Router canary: ожидался public_edge_ip, тогда как текущий LAN DNS синтезирует
   router_ip. Тест требует согласованность DNS answer и curl --resolve router_ip;
   US proxy и rollback assertions сохранены.
4. Endpoint-health unit: устарел path `scripts/auto-endpoint-check.sh`; текущий
   unit запускает published `/usr/local/lib/vpn-panel/auto-endpoint-check.sh`.
   Во время работы другой оператор уже обновил этот тест и timer contract до
   measurement-only/4min timeout/5min interval. Его изменения сохранены целиком;
   от этого worker правок в endpoint-health test или runtime unit не было.

Проверка: четыре бывших reds —4 passed,0 failed,0.57s.
Полные три ограниченных test modules:11 passed,0 failed,7.37s; вывод:
`.tmp/ha-notes-vpn-red-20261003/related-files.txt`.
Новые runtime/source/network defects этими четырьмя падениями не доказаны.
Не выдавать этот test repair за production canary или проверку отказа хостов.

Изменения worker: `tests/haos-transparent-smart-edge-addon-worker-a.test.ts`,
`tests/router-transparent-smart-edge.test.ts`, этот tracker.
`tests/vpn-endpoint-health-deploy.test.ts` изменён параллельным оператором,
проверен и сохранён; root должен учитывать его ownership при delivery.

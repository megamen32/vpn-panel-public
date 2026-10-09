# Публичный CI VPN Panel: восстановлен

Статус: завершено; отдельный последующий GitHub Actions run полностью успешен.
Исполнитель: Codex `01a11fa1-b794-7c73-99d9-74924cff5b81`; доставка проверенного source slice по поручению владельца.

## Результат

- Исправление опубликовано forward commit [`105d259`](https://github.com/megamen32/vpn-panel-public/commit/105d25971e4f60fd4d78635703d6aa8e22eaf80c) в `main` через существующий GitHub SSH port22.
- Независимый последующий CI: https://github.com/megamen32/vpn-panel-public/actions/runs/37919584025, HEAD `105d25971e4f60fd4d78635703d6aa8e22eaf80c`, conclusion `success`. Все три jobs — Prepare build, Build aarch64 image, Publish manifest — успешны. Build/push, per-arch cosign и manifest/sign выполнены без отключения gates.
- Подписанный образ публикуется в `ghcr.io/megamen32/vpn-panel-public-haos-smart-edge:0.1.23`; per-arch package — `aarch64-vpn-panel-public-haos-smart-edge`. Проверка публичной видимости/анонимного pull и deployment не входят в этот ремонт.
- Текущий tracker commit меняет только этот документ; source acceptance относится к указанному SHA и run.

## Причина и узкое исправление

Исходный run https://github.com/megamen32/vpn-panel-public/actions/runs/37900547540 успешно собирал aarch64-образ, но GHCR отклонял push с `denied: permission_denied: read_package`. Старые пакеты `aarch64-vpn-panel-haos-smart-edge` и `vpn-panel-haos-smart-edge` связаны с `vpn-panel-private`; публичное зеркало не имело к ним доступа.

Изменены ровно два source файла: IMAGE_NAME в `.github/workflows/build-haos-addon.yaml` и согласованная image ссылка в `deploy/haos/transparent-smart-edge-addon/config.yaml`. Публичное зеркало публикует в собственное GHCR пространство. Версия0.1.23, архитектуры, jobs, triggers, permissions, подпись и runtime options сохранены.

## Проверки и сохранность

- Actionlint PASS; настоящий pinned shell шаг `home-assistant/builder/actions/prepare-multi-arch-matrix@2026.06.0` выполнен до/после, получен согласованный per-arch адрес. Результаты переиспользованы без повторной сборки на флоте.
- Fresh base `105d25971e4f60fd4d78635703d6aa8e22eaf80c`, точный GitHub source readback PASS. Первоначальный OAuth отказ на workflow подтверждён, но blocker снят существующим SSH доступом без изменения credentials.
- Проверенный publisher `.tmp/ci-public-20261009/publish_blobs.py` использовал canonical Admin `.git` с изолированными objects/index; новый clone/worktree не создавался, canonical refs/index/WIP сохранены.
- Существующие release tags сохранены. Секреты, package ACL, product runtime, VPN policy и службы не менялись; deploy/restart0.
- Доказательства на server-100: `/home/roomhacker/ServersAdministartion/.tmp/ci-vpn-panel-public-37900547540/ssh-delivery/publication/receipt.json`, `green-run-37919584025.json`, `green-run.log`, `green-artifacts.json`, `source-checks.json`.

Следующий шаг по конкретному CI сбою: не требуется. Новые incident investigations при другом сбое направлять владельцу OpenCode + MiniMax `minimax-coding-plan`, без скрытого fallback.

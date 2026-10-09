# Публичный CI VPN Panel: блокировка публикации исправления

Статус: исправление подготовлено и проверено, CI ещё не восстановлен.
Исполнитель: Codex, задача по конкретному run 37900547540, разрешение владельца от 2026-10-09.

## Подтверждённая причина

- Падение: https://github.com/megamen32/vpn-panel-public/actions/runs/37900547540, attempt 1, HEAD `4a704679ac8e34a782d08ad5a8944d8398bf13f9`.
- Образ aarch64 успешно собран, публикация отклонена: `denied: permission_denied: read_package`.
- Workflow публичного зеркала использует `vpn-panel-haos-smart-edge`. Оба GHCR пакета (`aarch64-vpn-panel-haos-smart-edge` и `vpn-panel-haos-smart-edge`) по GitHub Packages API привязаны к `megamen32/vpn-panel-private` и имеют visibility private.
- `packages: write` уже установлен у build и manifest jobs; выключать публикацию/подпись/проверки не требуется.

## Подготовленное узкое исправление

1. `.github/workflows/build-haos-addon.yaml`: IMAGE_NAME = `vpn-panel-public-haos-smart-edge`; комментарий объясняет разделение GHCR пространств.
2. `deploy/haos/transparent-smart-edge-addon/config.yaml`: image = `ghcr.io/megamen32/vpn-panel-public-haos-smart-edge`.

Версия 0.1.23, архитектуры, jobs, triggers, permissions, подпись и runtime options сохранены. Новые имена GHCR пока не заняты (API 404).

## Проверки и review

- Actionlint PASS.
- Настоящий shell шаг `home-assistant/builder/actions/prepare-multi-arch-matrix@2026.06.0` выполнен на исходном и исправленном YAML: получен новый per-arch адрес, совпадающий с manifest/config namespace.
- Проверено равенство jobs, triggers, permissions, версии и runtime options до/после.
- Проверка ограничена короткими source checks; Docker/Go/npm сборки на флоте не запускались.
- Git Trees API packet и доказательства сохранены под ignored `.tmp/ci-vpn-panel-public-37900547540/` в доверенном `/home/roomhacker/ServersAdministartion` на server-100. Независимый Git checkout/worktree не создавался.
- Канонический product path `/home/roomhacker/apps/vpn-panel` имеет private origin. Каталог `/home/roomhacker/apps/vpn-panel-public` имеет origin `meanwebuser/vpn-panel` и не является checkout целевого репозитория. Чужие WIP сохранены.

## Внешний блокер и минимальный следующий шаг

Доступный GitHub OAuth токен имеет `repo, write:packages` (и другие существующие scopes), но не имеет `workflow`. POST Git Trees с изменением workflow возвращает HTTP 404 при подтверждённых admin/push правах на репозиторий; новые blobs созданы, ветка не изменена.

Минимальный следующий шаг: владелец публикует подготовленные два файла одним forward commit в main через уже разрешённый доступ с правом workflow (или через GitHub UI), после повторной проверки текущего HEAD и актуального CI. Затем дождаться отдельного последующего успешного run, включая build/push/sign/manifest. Нет разрешения изменять секреты; никаких изменений секретов/ACL/runtime/deploy и существующих release tags не сделано. Автоматический ремонт не считать успешным до независимого зелёного CI.

SHA256 подготовленных файлов:

- `.github/workflows/build-haos-addon.yaml`: `eb055edf0f59b8b9e838e787af1ea749e1854d2c0b6486a0fa2cbb7873b13a12`
- `deploy/haos/transparent-smart-edge-addon/config.yaml`: `e42584200909900d0529ca9a7965a9d3fce0f340998e504bf3e7630ce198fcc3`

# HAOS transport auto-selection and S21 canary

Status: complete

Started at 2026-09-02T13:41:29+03:00 (manual clock)

Current slice: automatic DE/US transport groups are live on HAOS 0.1.6; the
generic per-target scheduler is deployed with independent bounded target runs,
per-attempt cadence, separate success receipts, and a 180-minute S21 schedule.
Final HAOS, browser, failover, scheduler, and physical-phone canaries passed.

## Цель

Вернуть после миграции на HAOS устойчивую работу Smart Edge: HAOS автоматически
выбирает доступный транспорт и переключается при деградации, а физический S21
не реже одного раза в три часа независимо измеряет доступность пользовательских
транспортов. Владелец конфигурации, алгоритм, расписание, артефакты и rollback
явно описаны в репозитории.

## Minimal path

- Wanted result: YouTube, Claude и остальные Smart Edge-сервисы не зависят от
  одного нестабильного `de-cdn`; доступный транспорт выбирается автоматически.
- Shortest real canary: на живом HAOS принудительная недоступность одного
  кандидата не прерывает HTTPS/видео через другой, Claude открывается, а S21
  `R5CR702SRFP` создаёт свежее измерение; каждая цель имеет собственное
  `probeSchedule`, для телефона выставлено ровно 180 минут.
- Smallest YAGNI vertical slice: импортировать в HAOS существующий проверенный
  набор связанных sing-box outbounds и `urltest`, добавить регрессионные тесты;
  переиспользовать существующий testing harness через общий due-dispatcher,
  хранить понятные state/receipt; задокументировать owner/flow/rollback.
- Discard: новый dashboard, LLM-ремедиация, новый Android app, изменение
  продуктового каталога и добавление новых VPN-протоколов.

## Листья

1. HAOS multi-transport config + RED/GREEN contracts (15-45 active min).
2. Отдельный S21 scheduler `00/3:00:00` using the existing harness; телефон не
   включается в hourly controller (15-45 active min).
3. Live HAOS rollout, failure/fallback canary, YouTube/Claude and S21 acceptance
   (20-50 active min).

## Выбранный подход

HAOS выполняет быстрый локальный `urltest`/fallback; телефон остаётся внешним
трёхчасовым измерителем, а не управляющей точкой отказа.

## Текущее доказательство дефекта

- Живой HAOS импортирует только `de-cdn`.
- За два часа до старта ремонта: 407 transport errors, включая 257 EOF и 26
  timeouts; контейнер при этом остаётся `healthy`.
- YouTube и Claude присутствуют в живой политике, поэтому дефект находится в
  transport/fallback path, а не в списке доменов.

## Итоговое доказательство

- Canonical add-on `89a6290` and VPN Panel `745ef98` are pushed on `main`; both
  worktrees are clean. GitHub Actions run `33623885625` for add-on 0.1.6 passed.
- HAOS runs healthy image `ghcr.io/megamen32/haos-smart-edge:0.1.6`. Runtime
  policy contains five-member `de-regional` and `us-regional` `urltest` groups;
  normal traffic selects DE automatically, Telegram TPROXY selects US.
- Disposable failure canary replaced the first DE candidate with a dead
  outbound and still returned HTTP 200 through `de-httpupgrade`; the canary was
  removed after capture.
- Browser canary after rollout: YouTube video remained `readyState=4`, had no
  media error, and advanced from 11.4 to 34.7 seconds. Claude opened its
  authenticated new-chat UI with an enabled prompt textbox; no message sent.
- Scheduled S21 run launched at `2026-09-02T15:11:46+03:00`, immediately and in
  parallel with the other targets. Receipt
  `unified-external-wireless-android-health-20260902_151147.json` contains 19
  transports: 16 eligible, 3 rejected, 0 runner errors. The scheduler state
  records both attempt and success epoch `1788351106` for the phone.
- Every `testTargets[]` entry has an explicit `probeSchedule`; S21 is 180
  minutes and the four existing targets are 60 minutes. Manual `--target` does
  not alter either scheduled timestamp. Failed targets keep a separate success
  receipt but retry only after their configured attempt interval, preventing a
  continuous retry loop.
- `target-probe-scheduler.timer` is enabled/active and the retired
  `vpn-endpoint-check.timer` is disabled/inactive. Deployment rollback receipt:
  `/var/lib/vpn-panel/deploy-receipts/target-probe-scheduler/20260902T124150Z-2910300`.
- Final repository gate: 417 tests passed, 0 failed; TypeScript build and Xray
  validation passed. Focused scheduler tests cover independent completion,
  manual cadence preservation, and failure cadence.

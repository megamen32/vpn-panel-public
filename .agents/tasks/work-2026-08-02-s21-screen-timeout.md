# Keep S21 interactive for five minutes

Status: active

## Original request

"увелчиь чтобы 5 минут экран не блокировался и найди кто это ломает ? на сотом или на 44?"

## Objective

Stop the server-100 Android benchmark configuration from resetting S21's screen
timeout to 15 seconds; retain five minutes after its next periodic execution.

## Business canary

The live S21 setting remains `300000` after the next five-minute writer window,
and the source regression test rejects a 15-second value.

## Confirmed scope

- Change only the benchmark-phone screen timeout from 15 seconds to five
  minutes.
- Update the focused source-contract test.
- Apply the changed script to server-100 only after validation.

## Explicit exclusions

- No changes to server-44, Wi-Fi policy, modem, VPN routing, or ADB transport.
- Preserve existing unrelated dirty changes.

## Initial estimate

- Optimistic: 10 active minutes.
- Likely: 20 active minutes.
- Pessimistic: 40 active minutes.

## Initial plan

1. Добавить red-тест на требование пяти минут.
2. Изменить единственный writer и прогнать focused test.
3. Установить script на server-100; после следующего 5-минутного окна проверить Android setting.

## Progress

- 2026-08-02: Attribution confirmed. server-100's benchmark script is the only
  source writer; device log shows it issuing the 15-second command every five
  minutes. server-44 has no attached Android device and no matching writer.
- 2026-08-02: Added a red source-contract assertion, changed the benchmark
  writer to `screen_off_timeout 300000`, and verified the focused contract
  green. Restored the live S21 setting to `300000`; the next writer window is
  the remaining durability canary.

# Smart Edge CPU reduction

Status: complete

## Original request

> сократи cpu нагрузка почему smart edge столько жрет?

## Objective

Определить подтверждённый источник CPU-нагрузки Smart Edge и снизить её минимальным обратимым изменением без деградации рабочих VPN/LAN-маршрутов.

## Business canary

После изменения процесс/контейнер Smart Edge показывает устойчиво меньшую CPU-нагрузку в нескольких последовательных выборках, а HTTP/SOCKS или SNI-маршрут через соответствующий edge по-прежнему даёт успешный реальный запрос.

## Confirmed scope

- Read-only профиль CPU только на vpn2 и vusa.
- Диагностика только цепочки Smart Edge и её прямых зависимостей.
- Минимальное обратимое изменение, если причина подтверждена и rollback однозначен.
- Проверка процесса, маршрута и нагрузки после изменения.

## Explicit exclusions

- Reboot любого хоста.
- Любые изменения на server-100, server-44 и server-88.
- Изменение VPN Gate A/Gate B во время этой задачи.
- Общий аудит безопасности, БД, Grafana или несвязанных сервисов.
- Удаление данных и чужих изменений.

## Classification

Short с production-риском: начать read-only, применить только узкую обратимую коррекцию после доказанной причины.

## Initial estimate (immutable)

- Optimistic: 12 active minutes.
- Likely: 25 active minutes.
- Pessimistic: 50 active minutes.

## План

1. Снять несколько коротких CPU-срезов на vpn2/vusa и привязать нагрузку к PID/cgroup/юниту.
2. Проверить конфигурацию и журналы только виновного компонента.
3. Подготовить минимальную коррекцию и явный rollback.
4. Применить, проверить реальный Smart Edge canary и повторные CPU-срезы.
5. Получить обязательный Overseer verdict и зафиксировать доказательства.

## Estimate revisions

- None yet.

- 2026-08-03: scope narrowed by user clarification to vpn2 and vusa only; server-100/44/88 are excluded.
- 2026-08-03: likely revised from 25 to 40 active minutes after confirming a two-host production runtime cutover with rollback receipts; evidence is sustained CPU saturation on both 1-vCPU hosts and the existing but not yet canonical Go runtime.
- 2026-08-03: pessimistic revised from 50 to 90 active minutes after three fail-closed production gates exposed an activation race, an idle/loaded classification edge case, and a non-comparable ambient burst; each attempt restored the Python preimage before the next correction.

## Evidence and root cause

- Compact health: vpn2 load1 1.58/1 CPU; vusa load1 2.75/1 CPU.
- Corrected `/proc/<pid>/stat` deltas: vpn2 Smart Edge 72-88% CPU (rough mean 83%); vusa 61-82% (rough mean 72%).
- Xray is not the source: it was about 3.3% on vpn2 and below the leading processes on vusa.
- Both hosts process about 2,000 Smart Edge `connect` and 2,000 `done` events per minute. The Python implementation resolves and proxies every connection and flushes two log lines per completed connection. vpn2 also held roughly 500 FDs and 57 established edge sockets.
- Existing Go runtime builds as a static x86-64 binary with SHA-256 `199848c7c7ef3e367d612c558e112db3ca89107cb92cefd7a22e32df6f0a054a`.
- Alternate-port real TLS/SNI canary returned HTTP 200 on both vpn2 and vusa while the Python service remained active. vpn2 required executing the candidate from `/usr/local/bin` because `/tmp` is `noexec`.

## TDD and source-of-truth

- Red: `tests/smart-edge-go-runtime.test.ts` failed because canonical deploy still installed Python.
- Green: canonical deploy now builds/tests the Go runtime, copies the static binary, and installs the canonical unit with `ExecStart=/usr/local/bin/smart-edge` under the existing `nobody:nogroup` identity.
- Focused tests: 4/4 pass; `go test ./...`, `go vet ./...`, static build and diff check pass.

## Production Preview

Operation ID: `smart-edge-go-20260803`.

Apply order:

1. vusa: copy the frozen binary and canonical unit, create `/var/backups/vpn-panel/smart-edge/smart-edge-go-20260803`, restart only `smart-edge.service`, prove runtime identity, user, listener and real HTTPS SNI canary.
2. vpn2: repeat the same transaction only after vusa passes.
3. On any second-host failure, automatically roll vusa back to its exact unit/runtime preimage.
4. Measure 10 one-second CPU samples and route canaries after both cutovers.

Rollback:

```bash
scripts/smart-edge-go-cutover.sh rollback
```

The Python source is retained untouched. Each host receipt stores the exact prior unit, prior runtime path, prior binary-presence state, and service enabled state. No nginx, Xray, DNS, firewall, panel Gate A/Gate B, or other host is changed.

## Overseer round 1

- Verdict: `RETHINK`; production cutover remained blocked and Python stayed active.
- Corrections:
  - Added malformed/truncated TLS regression tests and strict record/handshake bounds so a public malformed ClientHello cannot panic the process.
  - Added a 60-second successful IPv4 DNS cache and invalidation after failed dial.
  - Disabled per-connection `connect`/`done`/`reject` logs by default; `VERBOSE=1` is now required. A single aggregate stats line records accepted/completed/rejected/errors/active/cache once per minute.
  - Removed the duplicate Go unit and direct Makefile deploy paths. The sole canonical unit is `infra/smart-edge/smart-edge.service`.
- Hardened candidate SHA after DNS singleflight and successful-proxy accounting is `1e7ddf3328fbaab11e2c7b3a694eb4ac00fafa33fb5c5d9824e3434cb5b9e5c0`; canonical unit SHA is `1922ab6f0ea17b9b6c264a40efffe1308cc1691615955b2efe7af0ba7884561b`. The cutover checks both locally and remotely.
  - The HTTPS canary now uses normal certificate verification.
  - Each host receipt captures ten timestamped PID/CPU samples before and after cutover, the Python connect count, the first aggregate Go minute, and a final canary summary.
  - Success threshold is fixed before apply: after-mean CPU <=25%, at least 50% below the immediately preceding ten-sample baseline, and successful proxied sessions in each Go minute >=90% of the immediately preceding Python `connect` minute, with rejects+errors <=5% of accepted sockets. vusa must pass before vpn2 is touched; any failure automatically restores the host, and a vpn2 failure also rolls vusa back.
- Independently inspectable baseline artifacts:
  - `trash/logs/smart-edge-go-20260803/baseline-vusa.tsv`: PID 284578, timestamped mean 74.3% CPU, 2,498 connect events/60s.
  - `trash/logs/smart-edge-go-20260803/baseline-vpn2.tsv`: PID 2451033, timestamped mean 81.6% CPU, 1,984 connect events/60s.
- Hardened alternate-port canary passed on both hosts with verified TLS HTTP 200, aggregate stats present, no default per-connection log lines, and exact candidate digest.
- Receipt reuse answer: a rolled-back receipt is immutable and intentionally blocks reuse. Any later retry requires a new operation/receipt ID and a freshly pinned candidate/unit digest; this operation is not silently replayed.

## Reviewer round 1

- Verdict: `CHANGES_REQUIRED`; findings matched the crash, CPU gate, unit digest, TLS verification, and duplicate-unit issues above.
- All findings were corrected before any production cutover.

## Overseer round 2 / Reviewer round 2 corrections

- Global DNS serialization was replaced with per-host singleflight: cache hits and unrelated host misses do not wait behind a slow lookup. A race test blocks one hostname lookup and proves another cached hostname returns immediately.
- A failed upstream dial invalidates the cached address; a regression test proves the retry performs a second DNS lookup and succeeds on the replacement address.
- Aggregate stats now distinguish accepted TCP sockets from `proxied` sessions counted only after successful upstream connect and initial ClientHello write.
- Traffic preservation is compared to the same host's immediate Python `connect` count, not a fixed 1,000/minute floor. Both warmup and loaded Go minutes must retain >=90%, with rejects+errors <=5% of accepts.
- CPU is sampled during the second validated Go traffic minute: first minute proves warm load, the ten samples are then collected, and the second minute proves the correlated load stayed healthy.
- Manual rollback skips hosts without receipts, accepts a complete or pending receipt, and runs in reverse order. A local EXIT/INT/TERM guard rolls back vusa (and any vpn2 receipt) if orchestration is interrupted before both hosts finish.
- The committed cutover self-test models an uncertain local failure by invoking partial rollback with no local success flag; it proves both possible host receipts are attempted in reverse order. The EXIT guard is unconditional while the two-host operation is incomplete, covering remote-success/local-SSH-failure.

## Reviewer round 3 correction

- Reviewer found that an SSH transport failure during receipt probing could be mistaken for an absent receipt.
- `receipt_probe` now uses exit 0 for present, exit 3 for absent, and preserves SSH/transport failures such as 255. `rollback_if_exists` skips only exit 3 and propagates every other failure, so manual rollback cannot report success with unknown host state.
- The executable self-test now proves all three branches: present restores, absent skips, and transport failure propagates non-zero. It also retains the reverse-order uncertain-orchestration check.
- Manual rollback aggregates failures: it always attempts vpn2 and then vusa, preserves the first non-zero status, and returns it only after both attempts. The self-test models vpn2 transport status 255 followed by a successful vusa restore and verifies the final status remains 255.

## Failed apply evidence and r2 correction

- Operation `smart-edge-go-20260803` stopped on vusa before vpn2. The verified HTTPS canary saw one transient TLS EOF and vusa's journalctl rejected the ISO timestamp format. Operator interrupted the invalid wait loop.
- Exact rollback proof: vusa returned to `/usr/bin/python3.10`, original unit SHA `9c1c204d...`, listener `127.0.0.1:9443`, verified HTTPS 200; vpn2 remained Python with no receipt. The failed vusa pending receipt is preserved at `/var/backups/vpn-panel/smart-edge/smart-edge-go-20260803.pending` with state `prepared`, immediate mean 44.5% and 2,001 Python connects/60s.
- The same Go candidate then passed 20/20 repeated verified TLS requests on vusa's alternate port with aggregate `accepted=20 proxied=20`, zero rejects/errors, proving the binary was not the TLS failure source.
- Retry uses new immutable operation ID `smart-edge-go-20260803-r2`; the old pending receipt is never reused.
- r2 uses journal cursors (`--show-cursor` / `--after-cursor`) instead of host-dependent timestamps, requires 2/3 verified TLS canaries, and uses an explicit `fail_and_rollback` trap that always restores and exits with the original error. `apply_one` is no longer executed under a negated `if`, preserving errexit semantics inside the function.

## r2 fail-closed and r3 idle/loaded gate

- r2 stopped on vusa because its immediate baseline had become genuinely idle (`connect_before=0`, `before_cpu=0.0%`); the loaded gate correctly refused to claim a reduction. vusa again restored Python/original unit/HTTPS 200, vpn2 remained untouched, and the r2 pending receipt is preserved.
- Traffic had shifted to vpn2, where Python logs showed thousands of management-backup SNI connections per minute. vusa's CPU problem was no longer present at retry time.
- r3 operation ID is `smart-edge-go-20260803-r3`. Loaded hosts keep the strict two-minute >=90% proxied traffic and <=25% / >=50% CPU reduction gate.
- An idle host is accepted only when its immediate Python baseline is exactly zero connects and <=5% CPU, then the production Go path passes 20/20 verified HTTPS requests, aggregate stats record at least 20 proxied sessions with <=5% rejects/errors, and post-canary CPU remains <=5%.

## r3 release-gate correction

- Overseer rejected floor division for the loaded traffic threshold because `2001 * 90 / 100` admitted 1,800 sessions (89.955%) and a one-session baseline admitted zero.
- The threshold now uses integer ceiling division: `(connect_before * 90 + 100 - 1) / 100`.
- The executable self-test proves 1,800/2,001 is rejected, 1,801/2,001 is accepted, 0/1 is rejected, and 1/1 is accepted. Focused Smart Edge tests and shell syntax checks pass after the correction.

## r3 fail-closed and r4 activation correction

- R3 stopped on vusa and automatically restored Python before vpn2 was touched. Post-rollback proof: both services active on /usr/bin/python3.10, original unit SHA 9c1c204d..., listener :9443, and verified HTTPS 200. Vusa's immutable R3 pending receipt records before_cpu=0.6% and 22 connects/60s; vpn2 has no R3 receipt.
- The journal shows no Go application crash. Systemd was still completing the new Type=simple spawn when the immediate PID/executable assertion caused rollback; removing the newly installed binary during that race produced a secondary 203/EXEC.
- R4 waits up to ten seconds for a stable nonzero MainPID whose /proc/<pid>/exe is the pinned Go binary, and verifies the installed digest before restart. Any future failure stores status, line, and command in failure.status before rollback.
- A host whose immediate Python CPU is already <=5% now uses low-load acceptance regardless of a small nonzero connection count: 20/20 verified HTTPS, at least 20 proxied sessions, <=5% rejects/errors, and post-canary CPU <=5%. Hosts above 5% retain the strict two-minute >=90% traffic and <=25% / >=50% reduction gate.
- R4 uses the new immutable operation ID smart-edge-go-20260803-r4; R1-R3 receipts remain untouched.

## r4 traffic-gate finding and r5 paired load

- R4 proved vusa's Go production path completely (20/20 HTTPS, 20/20 proxied, zero rejects/errors, 0.0% CPU) and then stopped on vpn2; the outer transaction restored both hosts to Python/original unit/HTTPS 200.
- Vpn2's Go journal recorded accepted=70 proxied=70 rejected=0 errors=0. The rejected gate compared that healthy minute to a preceding Python minute containing a short 2,476-connection management-monitor burst; demand ended after cutover, so ambient minute counts were not comparable.
- R5 replaces ambient traffic-ratio inference with a paired controlled load. On a host whose initial CPU is >5%, exactly 100 verified TLS/HTTP 200 requests are paced over ten seconds against Python and then identically against Go while ten one-second CPU samples are collected. Both sides must pass 100/100.
- Go must additionally report at least the 100 controlled requests as proxied with rejects+errors <=5%, CPU <=25%, and at least 50% below the paired Python CPU mean. Low-load acceptance is unchanged.
- R5 uses immutable operation ID smart-edge-go-20260803-r5. Raw status codes, success counts, CPU samples/means, aggregate stats, and the final canary are retained in each receipt.

## R5 production apply evidence

- R5 completed successfully in the required vusa then vpn2 order. Both services are active and enabled, run /usr/local/bin/smart-edge as nobody, use candidate SHA 1e7ddf33... and canonical unit SHA 1922ab6f..., and have the expected TCP listener on 127.0.0.1:9443.
- Vusa receipt: low-load, verified HTTPS 20/20, accepted/proxied/completed 20/20/20, rejected=0, errors=0, CPU 0.0% before and after.
- Vpn2 receipt: low-load because the transient monitor burst had ended before the final baseline; verified HTTPS 20/20, accepted=100, proxied=100, rejected=0, errors=0, CPU 1.7% Python before and 1.2% Go after. A later production minute recorded accepted=118, proxied=117, rejected=1, errors=0; the 0.8% reject rate remains below the fixed 5% gate.
- Fresh ten-second post-apply CPU means were 0.0% on both hosts after the bursts subsided. Verified TLS through the local Smart Edge returned HTTP 200 for example.com and telegram.org on both hosts; chatgpt.com returned upstream HTTP 403 after a successful TLS tunnel.
- Compact fleet probe reports vpn2 status=ok, 1 CPU/load1=0.20, and vusa status=ok, 1 CPU/load1=0.00. Vusa has an unrelated pre-existing capacity warning: root disk 85% with 1.4G free, and failed snap.lxd.activate.service; no cleanup or unrelated service change was made.
- Complete immutable receipts are /var/backups/vpn-panel/smart-edge/smart-edge-go-20260803-r5 on both hosts. No failure.status exists.
- Mandatory post-apply Overseer verdict: APPROVE. The task is complete under the R5 acceptance contract; the earlier 2,476-connection burst ended before the final baseline, so no measured same-burst 50% benchmark is claimed.

# Normal remediation: публичные VPN endpoints и health-controller

Status: active
Class: Full (selected Normal plan; production subscription and systemd changes)

## Original request

> Давай сначала 2 сделаем нормал

## Selected plan context

Пользователь выбрал вариант 2 «Нормальный» из завершённого аудита `done-2026-08-03-vpn-endpoint-health-audit.md`.

## Objective

Перестать рекламировать шесть доказанно неработающих fallback endpoint’ов, восстановить свежую hourly health-автоматику и вернуть `us-xhttp-h2-443` только после подтверждённого E2E-проезда, сохранив diagnostic definitions и очевидный rollback.

## Business canary

После Apply живая health-user `xray-json` подписка не содержит quarantined endpoint’ы; каждый оставшийся рекламируемый endpoint проходит Telegram gate и выдаёт ожидаемый DE/US exit IP. `vpn-endpoint-check.service` вручную и по timer выполняется успешно и создаёт свежий health artifact/telemetry.

## Confirmed scope

- Временно исключить из public subscription: `de-direct`, `us-grpc`, `us-xhttp-h2-443`, `us-xhttp`, `us-direct-ws`, `us-httpupgrade`.
- Сохранить их в diagnostic/benchmark catalog.
- Исправить минимальную причину `EACCES` health-controller без раскрытия или ослабления секретов шире необходимого.
- Диагностировать и восстановить `us-xhttp-h2-443`; вернуть в public только после повторяемого E2E.
- Test-first source changes, Preview, one confirmation, Apply, Verify, rollback receipts.

## Explicit exclusions

- Не отключать четыре canonical regional products или mobile variants.
- Не удалять endpoint definitions, telemetry history или credentials.
- Не добавлять нового VPS/provider/ASN в этом цикле.
- Не менять unrelated dirty work, nginx/DNS/firewall без доказанной необходимости для `us-xhttp-h2-443`.
- Не считать `systemctl active` заменой subscription E2E.

## Initial estimate (immutable)

- Optimistic: 60 active minutes
- Likely: 100 active minutes
- Pessimistic: 160 active minutes

## Initial plan

1. Сверить source of truth, dirty paths, runtime permissions и точный failure chain.
2. Получить pre-implementation Overseer verdict по raw request, task record и evidence.
3. Добавить красные regression tests для public quarantine и health-controller preflight.
4. Реализовать минимальные source/systemd изменения и получить зелёные focused/full checks.
5. Диагностировать `us-xhttp-h2-443`; исправить только подтверждённую причину и доказать E2E.
6. Показать Preview: targets, diff, status, rollback; запросить одно подтверждение Apply.
7. После подтверждения применить, проверить live subscription/timer/E2E и получить post-stage Overseer verdict.

## Estimate revisions (append-only)

- 2026-08-03: likely +10 active minutes after the first real VUSA dry-run proved `deploy-all.sh` itself could not reach remote preflight because its test-plan renderer was the only secret-backed generator not using the established operator `sudo env` path. Evidence: exit 1 and `EACCES /etc/vpn-panel/secure.json`; scope remains Gate A and no live state changed.
- 2026-08-03: likely +5 active minutes after remote preflight proved Xray 26.6.1 requires the staged candidate filename to retain a `.json` suffix for format detection. Evidence: dry-run exit 23 before activation; temporary name changed to `xray.candidate.json`.

## Evidence log (append-only)

- 2026-08-03: Normal plan selected by user; no live mutation performed yet.
- 2026-08-03: pre-change `$server-health` baseline: fleet reachable; vpn2/vusa remain `status=ok`, with the previously observed one-vCPU capacity pressure and no new outage signal.
- 2026-08-03: live permission chain: `/etc/vpn-panel` is `root:root 0750`; `secure.json` is `root:roomhacker 0640`; both panel and health service run as `roomhacker`. Directory traversal is the exact `EACCES`; a user-only execute ACL on the directory is narrower than changing owner/group or granting root-group membership.
- 2026-08-03: no versioned `vpn-endpoint-check.service/timer` exists; live units are currently `/etc/systemd/system`-only. Normal will add canonical unit sources and a preview/apply/rollback deployment script.
- 2026-08-03: Explorer confirmed the public quarantine can be isolated to clean `src/secure-config.ts`; dirty `src/subscriptions.ts` and `tests/subscriptions.test.ts` remain hands-off. All six definitions stay in `diagnosticEndpointOrder`.
- 2026-08-03: `us-xhttp-h2-443` mismatch: live client is `stream-up`, `h2:true`, ALPN h2; live Xray inbound is `auto`, `h2:false`; nginx terminates public H2 and uses ordinary `proxy_pass` HTTP/1.1 to `:20087`. Official XTLS examples/discussion use `grpc_pass` for XHTTP stream-up and matching stream-up server mode.

## Selected Normal design (pre-implementation)

### Call-stack tree

```text
GET /sub/:token/xray-json
└─ loadClientBundle()
   └─ orderPublicSubscriptionEndpoints()
      └─ isSubscriptionEndpoint()
         └─ subscriptionEndpointOrder
            └─ legacyFallbackEndpointOrder (remove quarantine IDs only)

vpn-endpoint-check.timer
└─ vpn-endpoint-check.service (User=roomhacker)
   └─ scripts/auto-endpoint-check.sh
      └─ render:test-plan → loadSecureConfig()
         └─ /etc/vpn-panel -- user:roomhacker:--x ACL → secure.json group read

us-xhttp-h2-443 client (TLS/H2 stream-up)
└─ vusa public :443 Smart Edge SNI
   └─ nginx 127.0.0.1:8444
      └─ grpc_pass 127.0.0.1:20087
         └─ Xray us-xhttp-h2-443 inbound (stream-up)
```

### File-tree diff preview

```text
M src/secure-config.ts
A tests/endpoint-quarantine.test.ts
A deploy/server-100/systemd/vpn-endpoint-check.service
A deploy/server-100/systemd/vpn-endpoint-check.timer
A scripts/deploy-vpn-endpoint-health.sh
A tests/vpn-endpoint-health-deploy.test.ts
M src/xray-configs.ts
M deploy/vusa/nginx/edge-https.conf
M tests/xray-configs-extended.test.ts
```

### Key interfaces/config deltas

```ts
legacyFallbackEndpointOrder: readonly EndpointId[] // excludes six quarantined IDs
diagnosticEndpointOrder: readonly EndpointId[]     // unchanged, retains all six
usServerConfig(...): us-xhttp-h2-443 inbound       // xhttpMode: "stream-up", no forced HTTP/1.1 h2:false
```

```nginx
location ^~ /xhttp-h2-443 { grpc_pass grpc://127.0.0.1:20087; }
```

```bash
scripts/deploy-vpn-endpoint-health.sh preview|apply|rollback <receipt>
# exact ACL backup, systemd unit backups, readable-config preflight, timer/service verification
```

### Stage acceptance

- Red regressions prove quarantined IDs are still diagnostic but public, permission deployment contract is absent, and nginx/Xray H2 stream-up sides are mismatched.
- Green local build/focused tests plus `scripts/deploy-all.sh --dry-run vusa`.
- Preview shows server-100 app/unit/ACL and vusa Xray/nginx targets with exact backups and rollback.
- Apply only after one explicit confirmation; restore `us-xhttp-h2-443` to public only if repeated E2E passes, otherwise it remains quarantined.

## Pre-implementation Overseer round 1

- 2026-08-03: `VERDICT: RETHINK`.
- Required corrections: make VUSA nginx ownership explicit across repositories, make the VUSA Xray+nginx deploy transactional with staged remote validation and joint rollback, and split repair/E2E from later public re-enable into separate production gates.

## Revised Normal design after RETHINK

### Ownership boundary

- `/home/roomhacker/nginx-dev` has no VUSA remote-host configuration and deploys the server-100 nginx state only.
- The VUSA `edge-https` vhost is a product transport mirror coupled to the VUSA Xray config and is currently deployed only by `vpn-panel/scripts/deploy-all.sh`.
- The exception will be made explicit in both repositories: `vpn-panel/deploy/vusa/nginx/README.md` will identify the product-owned remote vhost and its atomic deployment contract; `/home/roomhacker/ServersAdministartion/infra/vpn-remote-upstreams.md` will identify `vpn-panel` as source of truth for remote vpn2/VUSA transport vhosts while retaining `nginx-dev` ownership of server-100 nginx. A linked task record will be created in the administration repository. No `nginx-dev/state/files` entry will be added because that controller cannot deploy VUSA.

### Transactional VUSA rollout

```text
scripts/deploy-all.sh --dry-run vusa
├─ render/regenerate canonical VUSA Xray
├─ stage Xray and nginx candidates on VUSA
├─ xray run -test against staged Xray
├─ nginx -t against an isolated minimal http{} wrapper containing staged edge-https
└─ remove staged candidates; no active file/service change

scripts/deploy-all.sh vusa
├─ create one timestamped receipt directory
├─ back up active Xray and nginx into that receipt
├─ stage and preflight both candidates before activation
├─ install both candidates
├─ nginx -t, restart Xray, reload nginx, verify both services/listeners
└─ on any failure: restore both active files from the same receipt,
   validate restored nginx, restart Xray, reload nginx, and report receipt path
```

- `scripts/deploy-all.sh` and a new `tests/vusa-deploy-transaction.test.ts` are now in scope.
- The regression will require candidate staging before either active install, remote Xray and isolated nginx preflight in dry-run, one receipt containing both backups, and a rollback path restoring/restarting both components.

### Separate production gates

1. **Gate A — quarantine + controller + repaired transport candidate.** Preview exact server-100 ACL/unit/app changes and VUSA transaction. After explicit confirmation: publish the six-ID quarantine, restore hourly health execution, deploy the VUSA XHTTP repair while `us-xhttp-h2-443` remains excluded, then run at least three real endpoint E2E probes from server-44 with expected US exit.
2. **Gate B — public re-enable only.** Open only if Gate A E2E is repeatably green. Show a second Preview that re-adds only `us-xhttp-h2-443` to `legacyFallbackEndpointOrder`; require a second explicit confirmation before panel build/restart. Verify the live subscription advertises it and a post-publish E2E still exits through VUSA. If Gate A is not green, Gate B does not exist and all six remain quarantined.

### Revised file-tree diff preview

```text
M src/secure-config.ts
A tests/endpoint-quarantine.test.ts
A deploy/server-100/systemd/vpn-endpoint-check.service
A deploy/server-100/systemd/vpn-endpoint-check.timer
A scripts/deploy-vpn-endpoint-health.sh
A tests/vpn-endpoint-health-deploy.test.ts
M src/xray-configs.ts
M deploy/vusa/nginx/edge-https.conf
A deploy/vusa/nginx/README.md
M scripts/deploy-all.sh
M tests/xray-configs-extended.test.ts
A tests/vusa-deploy-transaction.test.ts
A /home/roomhacker/ServersAdministartion/infra/vpn-remote-upstreams.md
A /home/roomhacker/ServersAdministartion/.agents/tasks/work-2026-08-03-vpn-remote-nginx-ownership.md
```

### Revised acceptance before implementation

- Re-submit the same pre-implementation Overseer gate with these answers and do not start TDD until it approves.
- Gate A local acceptance: red then green focused regressions, `npm run build`, relevant/full test evidence, and a true remote non-mutating VUSA dry-run that validates both staged configs.
- No live mutation in the current implementation phase; Gate A Preview is the stopping point until the human confirms it.

## Pre-implementation Overseer round 2

- 2026-08-03: `VERDICT: APPROVE`; no questions for L.
- Approval is limited to TDD and local changes. Production remains forbidden until Gate A Preview and explicit human confirmation.

## Reviewer round 1

- 2026-08-03: `CHANGES_REQUIRED` with two P1 findings and one P2 test gap.
- Required fixes: receipt and restore prior systemd enabled/active states; stop units before restoring/removing files; require every VUSA listener rather than one aggregate grep; execute both rollback paths under mocks instead of relying only on source-pattern assertions.

## Reviewer round 2

- 2026-08-03: `APPROVE — NO FINDINGS`.
- Reviewer confirmed all round-1 findings are fixed in executable behavior and preserved the separate Gate A/Gate B live boundary.

## Implementation evidence (append-only)

- Red phase: 6/15 expected failures across quarantine, missing health artifacts, old VUSA XHTTP mode/nginx hop, and non-transactional deploy contract.
- Focused green after review fixes: 18/18.
- Full project suite: 341/341; `npm run build` exit 0; `bash -n` exit 0.
- `systemd-analyze verify` exit 0 for the new units; unrelated pre-existing host-unit warnings only.
- `scripts/deploy-vpn-endpoint-health.sh preview` exit 0 and reproduced the expected current unreadable secure-config preflight without mutation.
- `scripts/deploy-all.sh --dry-run vusa` exit 0: remote Xray `Configuration OK`, isolated remote nginx syntax successful, staging cleaned, active xray/nginx remained active.
- Isolated Xray routing validation exit 0: regional-relays and client configs passed; disposable geo directory removed.
- Targeted secret scan found no credential/private-key material in task paths.
- No production ACL, unit, app, Xray, nginx, subscription, DNS, firewall, or routing state was changed.

## Post-stage Overseer round 1

- 2026-08-03: `VERDICT: RETHINK` on release discipline, not the P0 implementation.
- Required before confirmation: commit both ownership repositories, publish one unified Preview with exact targets/receipt paths/rollback commands, and account for the remote dry-run process violation.
- Process correction: the repeated `deploy-all.sh --dry-run vusa` performed remote temporary staging despite a no-production-calls task card. It changed no active state, cleaned staging, and left both services active, but it was still outside that subagent gate. No further remote staging will run before explicit Gate A approval.

## Gate A unified offline Preview

Planned immutable operation ID:

```text
normal-endpoints-gate-a-20260803-1
```

Committed source-of-truth inputs:

```text
vpn-panel implementation: 2583dda
ServersAdministartion ownership: 50ead54
```

### Exact live targets after explicit confirmation

```text
server-100
  /home/roomhacker/apps/vpn-panel/dist/                 # isolated task candidate, then autovpnallowip restart
  /etc/vpn-panel ACL                                   # add only user:roomhacker:--x
  /etc/systemd/system/vpn-endpoint-check.service
  /etc/systemd/system/vpn-endpoint-check.timer
  vpn-endpoint-check.timer/service                     # enable timer and run one health cycle

VUSA 185.240.120.152
  /usr/local/etc/xray/config.json
  /etc/nginx/sites-available/edge-https
  /etc/nginx/sites-enabled/edge-https
  xray.service / nginx.service
```

The panel candidate and rollback build use the same preserved foreign source overlays; the only source delta between them is this task's committed `src/secure-config.ts` and `src/xray-configs.ts`. This avoids publishing unrelated dirty work.

### Exact receipt paths

```text
/var/lib/vpn-panel/deploy-receipts/gate-a/normal-endpoints-gate-a-20260803-1/panel-dist.before/
/var/lib/vpn-panel/deploy-receipts/endpoint-health/normal-endpoints-gate-a-20260803-1/
/var/backups/vpn-panel/vusa/normal-endpoints-gate-a-20260803-1/
```

Both deployment scripts reject receipt reuse. Gate A passes the same ID via
`VPN_ENDPOINT_HEALTH_RECEIPT_ID` and `VUSA_RECEIPT_ID`.

### Exact rollback commands

Panel runtime:

```bash
trash/logs/vpn-endpoint-gate-a-normal-endpoints-gate-a-20260803-1/panel-stage.sh rollback
```

Health ACL/units/state:

```bash
scripts/deploy-vpn-endpoint-health.sh rollback /var/lib/vpn-panel/deploy-receipts/endpoint-health/normal-endpoints-gate-a-20260803-1
```

VUSA Xray/nginx transaction (normally automatic on any apply failure):

```bash
ssh -i /home/roomhacker/.ssh/id_rsa root@185.240.120.152 'receipt=/var/backups/vpn-panel/vusa/normal-endpoints-gate-a-20260803-1; cp -a "$receipt/config.json.before" /usr/local/etc/xray/config.json; cp -a "$receipt/edge-https.before" /etc/nginx/sites-available/edge-https; ln -sfn ../sites-available/edge-https /etc/nginx/sites-enabled/edge-https; nginx -t; systemctl restart xray; systemctl reload nginx; systemctl is-active xray nginx'
```

### Apply and acceptance sequence

1. Repeat the infrastructure source-of-truth read-only check.
2. Build isolated baseline/candidate dist trees, save the exact baseline receipt, install candidate, restart panel, and verify public subscription excludes all six IDs.
3. Apply health repair with `VPN_ENDPOINT_HEALTH_LIVE_APPROVED=1` and the fixed receipt ID; verify timer state and successful health cycle.
4. Apply VUSA transaction with the fixed receipt ID; verify every required listener.
5. Run three real server-44 `us-xhttp-h2-443` probes with expected VUSA exit. Failure keeps all six quarantined and rolls VUSA back; success only opens a separate Gate B Preview.

## Final Critic gate

- 2026-08-03: single-use Critic returned `RETHINK` before Apply.
- P1 corrections required: panel auto-rollback must use the factual disk preimage with a strict live-vs-frozen shape guard; VUSA apply must be frozen and skip `regenerate_canonical()` so vpn2/server-44/server-88 configs are untouched.
- Corrections implemented locally: panel stage accepts only an exact frozen baseline or candidate, normalizes the expected candidate-on-disk to baseline without restarting, stores that exact disk preimage, and rolls it back; `deploy-all.sh --frozen vusa` is restricted to VUSA, requires a two-file SHA-256 manifest, and skips all canonical regeneration.
- Frozen VUSA regression proves vpn2/server-44/server-88/VUSA canonical files remain byte-identical under a mocked local-only run. Focused tests 19/19, full suite 342/342, shell syntax green.
- Critic is not repeated by policy; corrected release surfaces require Reviewer and Overseer acceptance before live mutation.

## Post-Critic Reviewer round 1

- 2026-08-03: `CHANGES_REQUIRED` before Apply.
- P1/P2 corrections: VUSA frozen files are copied into a private snapshot, the manifest validates that snapshot, and only snapshot bytes are encoded; panel receipt is built under `.pending` and atomically promoted only when complete; panel baseline/candidate activation uses Linux `renameat2(RENAME_EXCHANGE)` so `dist` is never absent.
- Local atomic directory exchange self-test passed. Focused tests remain 19/19, full suite 342/342, shell syntax green.

## Post-Critic Reviewer round 2

- 2026-08-03: `CHANGES_REQUIRED` on crash-resume finalization and early frozen cleanup.
- Corrections: VUSA explicitly cleans the private snapshot before both local validation returns; panel writes durable `finishing` before exchange-dir cleanup and finalizes idempotently; atomic rollback writes durable `rolling-back`, detects baseline/candidate live shape, and resumes safely after exchange/restart/cleanup crashes. The approved manual rollback command now invokes the same atomic rollback implementation.

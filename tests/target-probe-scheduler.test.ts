import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { spawnSync } from "node:child_process";
import test from "node:test";

const root = resolve(import.meta.dirname, "..");
const scheduler = `${root}/scripts/run-target-probe-scheduler.py`;

test("every test target owns an explicit configurable measurement schedule", async () => {
  const plan = JSON.parse(await readFile(`${root}/vpn-testing/test-plan.json`, "utf8"));
  for (const target of plan.testTargets) {
    assert.equal(typeof target.probeSchedule?.enabled, "boolean", target.id);
    assert.ok(Number.isInteger(target.probeSchedule?.everyMinutes), target.id);
    assert.ok(target.probeSchedule.everyMinutes > 0, target.id);
    assert.equal(typeof target.probeSchedule?.profile, "string", target.id);
  }
  const phone = plan.testTargets.find((target: { id: string }) => target.id === "external-wireless-android");
  assert.deepEqual(phone.probeSchedule, { enabled: false, everyMinutes: 180, profile: "health" });
});

test("due runs respect each interval while manual runs do not reset cadence", async () => {
  await mkdir(`${root}/.tmp`, { recursive: true });
  const dir = await mkdtemp(join(`${root}/.tmp`, "target-probe-test-"));
  const plan = join(dir, "plan.json");
  const state = join(dir, "state.json");
  const log = join(dir, "runner.log");
  const runner = join(dir, "runner.sh");
  await writeFile(plan, JSON.stringify({ testTargets: [
    { id: "hourly", probeSchedule: { enabled: true, everyMinutes: 60, profile: "health" } },
    { id: "phone", probeSchedule: { enabled: true, everyMinutes: 180, profile: "quick" } },
  ] }));
  await writeFile(runner, `#!/bin/sh\nprintf '%s %s\\n' "$TARGETS" "$PROFILE" >>"${log}"\n`);
  spawnSync("chmod", ["+x", runner]);
  const env = { ...process.env, TARGET_PROBE_PLAN: plan, TARGET_PROBE_STATE: state, TARGET_PROBE_RUNNER: runner };

  assert.equal(spawnSync(scheduler, ["--due", "--now", "100000"], { env }).status, 0);
  assert.equal(spawnSync(scheduler, ["--due", "--now", "103601"], { env }).status, 0);
  assert.equal(spawnSync(scheduler, ["--target", "phone", "--now", "104000"], { env }).status, 0);
  assert.equal(spawnSync(scheduler, ["--due", "--now", "110801"], { env }).status, 0);

  const lines = (await readFile(log, "utf8")).trim().split("\n").sort();
  assert.deepEqual(lines, ["hourly health", "hourly health", "hourly health", "phone quick", "phone quick", "phone quick"]);
  const saved = JSON.parse(await readFile(state, "utf8"));
  assert.equal(saved.targets.phone.lastScheduledSuccessEpoch, 110801);
  assert.equal(saved.targets.phone.lastScheduledAttemptEpoch, 110801);
  await rm(dir, { recursive: true, force: true });
});

test("a failed target retries on its own cadence instead of continuously", async () => {
  await mkdir(`${root}/.tmp`, { recursive: true });
  const dir = await mkdtemp(join(`${root}/.tmp`, "target-probe-failure-cadence-test-"));
  const plan = join(dir, "plan.json");
  const state = join(dir, "state.json");
  const log = join(dir, "runner.log");
  const runner = join(dir, "runner.sh");
  await writeFile(plan, JSON.stringify({ testTargets: [
    { id: "unhealthy", probeSchedule: { enabled: true, everyMinutes: 60, profile: "health" } },
  ] }));
  await writeFile(runner, `#!/bin/sh\nprintf '%s\\n' "$TARGETS" >>"${log}"\nexit 1\n`);
  spawnSync("chmod", ["+x", runner]);
  const env = { ...process.env, TARGET_PROBE_PLAN: plan, TARGET_PROBE_STATE: state, TARGET_PROBE_RUNNER: runner };

  assert.equal(spawnSync(scheduler, ["--due", "--now", "100000"], { env }).status, 1);
  assert.equal(spawnSync(scheduler, ["--due", "--now", "100300"], { env }).status, 0);
  assert.equal(spawnSync(scheduler, ["--due", "--now", "103600"], { env }).status, 1);

  assert.deepEqual((await readFile(log, "utf8")).trim().split("\n"), ["unhealthy", "unhealthy"]);
  const saved = JSON.parse(await readFile(state, "utf8"));
  assert.equal(saved.targets.unhealthy.lastScheduledAttemptEpoch, 103600);
  assert.equal(saved.targets.unhealthy.lastScheduledSuccessEpoch, undefined);
  await rm(dir, { recursive: true, force: true });
});

test("one slow target does not delay another due target", async () => {
  await mkdir(`${root}/.tmp`, { recursive: true });
  const dir = await mkdtemp(join(`${root}/.tmp`, "target-probe-concurrency-test-"));
  const plan = join(dir, "plan.json");
  const state = join(dir, "state.json");
  const log = join(dir, "runner.log");
  const runner = join(dir, "runner.sh");
  await writeFile(plan, JSON.stringify({ testTargets: [
    { id: "slow", probeSchedule: { enabled: true, everyMinutes: 60, profile: "health" } },
    { id: "fast", probeSchedule: { enabled: true, everyMinutes: 60, profile: "health" } },
  ] }));
  await writeFile(runner, `#!/bin/sh\n[ "$TARGETS" = slow ] && sleep 1\nprintf '%s\\n' "$TARGETS" >>"${log}"\n`);
  spawnSync("chmod", ["+x", runner]);
  const env = { ...process.env, TARGET_PROBE_PLAN: plan, TARGET_PROBE_STATE: state, TARGET_PROBE_RUNNER: runner };

  const started = performance.now();
  assert.equal(spawnSync(scheduler, ["--due", "--now", "100000"], { env }).status, 0);
  const elapsedMs = performance.now() - started;

  assert.ok(elapsedMs < 1800, `targets ran sequentially: ${elapsedMs}ms`);
  assert.deepEqual((await readFile(log, "utf8")).trim().split("\n"), ["fast", "slow"]);
  const saved = JSON.parse(await readFile(state, "utf8"));
  assert.equal(saved.targets.fast.lastScheduledSuccessEpoch, 100000);
  assert.equal(saved.targets.slow.lastScheduledSuccessEpoch, 100000);
  await rm(dir, { recursive: true, force: true });
});

test("systemd timer only wakes dispatcher; plan owns actual target cadence", async () => {
  const timer = await readFile(`${root}/deploy/server-100/systemd/target-probe-scheduler.timer`, "utf8");
  const service = await readFile(`${root}/deploy/server-100/systemd/target-probe-scheduler.service`, "utf8");
  assert.match(timer, /^OnCalendar=\*:0\/5$/m);
  assert.match(timer, /^Persistent=true$/m);
  assert.match(service, /run-target-probe-scheduler\.py --due/);
});

test("remote measurements stream credentials outside the SSH process command line", async () => {
  const runner = await readFile(`${root}/scripts/run-network-test.sh`, "utf8");
  assert.match(runner, /runner-env\.json/);
  assert.match(runner, /env_payload.*jq -cn/s);
  assert.match(runner, /os\.unlink\(path\); os\.execvpe/);
  assert.match(runner, /runner\.pid/);
  assert.match(runner, /kill .*cat .*remote_pid/s);
  assert.match(runner, /REMOTE_RUN_TIMEOUT_SECONDS/);
  assert.match(runner, /timeout --signal=TERM --kill-after=15/);
  assert.match(runner, /REMOTE_CLEANUP_TIMEOUT_SECONDS/);
  assert.match(runner, /pkill -TERM -P/);
  assert.match(runner, /local_telemetry_url=.*127\.0\.0\.1:30129\/api\/telemetry\/vpn-tests\/events/);
  assert.doesNotMatch(runner, /"VPN_TOKEN=\$quoted_token/);
  assert.doesNotMatch(runner, /TELEMETRY_API_KEY=\$quoted_telemetry_key/);
});

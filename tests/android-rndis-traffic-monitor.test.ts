import assert from "node:assert/strict";
import { chmod, mkdir, mkdtemp, writeFile, symlink, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import test from "node:test";

const execFileAsync = promisify(execFile);
const monitor = join(process.cwd(), "scripts/android-rndis-traffic-monitor.sh");

async function fakeSysfs(root: string, name: string, driver: string, ifindex: string, rx: string, tx: string) {
  const dir = join(root, name);
  await mkdir(join(dir, "statistics"), { recursive: true });
  await mkdir(join(dir, "device"), { recursive: true });
  const driverDir = join(root, "drivers", driver); await mkdir(driverDir, { recursive: true });
  await symlink(driverDir, join(dir, "device/driver"));
  for (const [file, value] of Object.entries({ ifindex, address: "02:00:00:00:00:01", operstate: "up", carrier: "1" })) await writeFile(join(dir, file), value);
  await writeFile(join(dir, "statistics/rx_bytes"), rx);
  await writeFile(join(dir, "statistics/tx_bytes"), tx);
}

test("RNDIS monitor records appearance and byte deltas without mutations", async () => {
  const dir = await mkdtemp(join(tmpdir(), "android-rndis-monitor-"));
  const sysfs = join(dir, "net"); await mkdir(sysfs);
  await fakeSysfs(sysfs, "enxc6f3fc957ba7", "rndis_host", "7", "100", "200");
  const sleep = join(dir, "sleep"); await writeFile(sleep, "#!/usr/bin/env bash\nexit 0\n"); await chmod(sleep, 0o755);
  const result = await execFileAsync(monitor, [], { env: { ...process.env, SYS_CLASS_NET_ROOT: sysfs, STATE_FILE: join(dir, "state"), ITERATIONS: "1", SLEEP_BIN: sleep, INTERVAL_SECONDS: "10" } });
  const event = JSON.parse(result.stdout.trim());
  assert.equal(event.event, "sample");
  assert.equal(event.interface, "enxc6f3fc957ba7");
  assert.equal(event.driver, "rndis_host");
  assert.equal(event.epoch, 1);
  assert.equal(event.rx_bytes, 100);
  assert.equal(event.tx_bytes, 200);
  assert.equal(event.rx_delta, 0);
  assert.equal(event.tx_delta, 0);
});

test("RNDIS monitor resets epoch on counter decrease and ignores non-RNDIS enx", async () => {
  const dir = await mkdtemp(join(tmpdir(), "android-rndis-monitor-reset-"));
  const sysfs = join(dir, "net"); await mkdir(sysfs);
  await fakeSysfs(sysfs, "enxgood", "rndis_host", "8", "500", "700");
  await fakeSysfs(sysfs, "enxbad", "cdc_ether", "9", "1", "1");
  const state = join(dir, "state");
  await writeFile(state, "enxgood 8 1 900 1000\n");
  const result = await execFileAsync(monitor, [], { env: { ...process.env, SYS_CLASS_NET_ROOT: sysfs, ITERATIONS: "1", STATE_FILE: state, SLEEP_BIN: "/bin/true" } });
  const event = JSON.parse(result.stdout.trim());
  assert.equal(event.interface, "enxgood");
  assert.equal(event.driver, "rndis_host");
  assert.equal(event.epoch, 2);
  assert.equal(event.reason, "reset");
  assert.equal(event.rx_delta, 0);
  assert.equal(event.tx_delta, 0);
  assert.match(await readFile(state, "utf8"), /enxgood/);
});

test("RNDIS monitor reports incremental byte deltas from the same epoch", async () => {
  const dir = await mkdtemp(join(tmpdir(), "android-rndis-monitor-delta-"));
  const sysfs = join(dir, "net"); await mkdir(sysfs);
  await fakeSysfs(sysfs, "enxgood", "rndis_host", "10", "150", "260");
  const state = join(dir, "state"); await writeFile(state, "enxgood 10 3 100 200\n");
  const result = await execFileAsync(monitor, [], { env: { ...process.env, SYS_CLASS_NET_ROOT: sysfs, STATE_FILE: state, ITERATIONS: "1", SLEEP_BIN: "/bin/true" } });
  const event = JSON.parse(result.stdout.trim());
  assert.equal(event.epoch, 3);
  assert.equal(event.reason, "sample");
  assert.equal(event.rx_delta, 50);
  assert.equal(event.tx_delta, 60);
});

test("RNDIS monitor closes an epoch when the interface disappears", async () => {
  const dir = await mkdtemp(join(tmpdir(), "android-rndis-monitor-disappear-"));
  const sysfs = join(dir, "net"); await mkdir(sysfs);
  const state = join(dir, "state"); await writeFile(state, "enxgone 11 4 900 1200 1\n");
  const result = await execFileAsync(monitor, [], {
    env: { ...process.env, SYS_CLASS_NET_ROOT: sysfs, STATE_FILE: state, ITERATIONS: "1", SLEEP_BIN: "/bin/true" },
  });
  const event = JSON.parse(result.stdout.trim());
  assert.equal(event.event, "disappearance");
  assert.equal(event.interface, "enxgone");
  assert.equal(event.epoch, 4);
  assert.equal(event.tx_bytes, 1200);
  assert.match(await readFile(state, "utf8"), /enxgone 11 4 900 1200 0/);
});

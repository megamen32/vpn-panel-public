import assert from "node:assert/strict";
import { chmod, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import test from "node:test";

const execFileAsync = promisify(execFile);
const watchdog = join(process.cwd(), "scripts/android-adb-usb-watchdog.sh");

async function fakeCommand(dir: string, name: string, body: string): Promise<string> {
  const path = join(dir, name);
  await writeFile(path, `#!/usr/bin/env bash\n${body}\n`);
  await chmod(path, 0o755);
  return path;
}

test("USB watchdog reconnects host ADB without changing RNDIS functions", async () => {
  const dir = await mkdtemp(join(tmpdir(), "android-adb-watchdog-"));
  const calls = join(dir, "calls");
  const adb = await fakeCommand(
    dir,
    "adb",
    `echo "$*" >> "${calls}"\nif [[ "$*" == "devices -l" ]]; then exit 0; fi\nexit 0`,
  );
  const lsusb = await fakeCommand(dir, "lsusb", 'echo "Bus 001 Device 011: ID 04e8:6864 Samsung Electronics"');

  const result = await execFileAsync(watchdog, [], {
    env: {
      ...process.env,
      ADB_BIN: adb,
      LSUSB_BIN: lsusb,
      ANDROID_DEVICE_SERIAL: "R5CR702SRFP",
      ANDROID_ADB_WATCHDOG_STATE_DIR: dir,
    },
  }).catch((error: any) => error);

  assert.equal(result.code ?? 0, 0);
  const recorded = await import("node:fs/promises").then(({ readFile }) => readFile(calls, "utf8"));
  assert.match(recorded, /start-server/);
  assert.match(recorded, /reconnect usb/);
  assert.doesNotMatch(recorded, /setFunctions|rndis/);
});

test("USB watchdog reports an unauthorized Android debugging session", async () => {
  const dir = await mkdtemp(join(tmpdir(), "android-adb-unauthorized-"));
  const adb = await fakeCommand(dir, "adb", 'if [[ "$*" == "devices -l" ]]; then echo "R5CR702SRFP unauthorized usb:1-2"; fi');
  const lsusb = await fakeCommand(dir, "lsusb", 'echo "Bus 001 Device 011: ID 04e8:6864 Samsung Electronics"');

  const result = await execFileAsync(watchdog, [], {
    env: {
      ...process.env,
      ADB_BIN: adb,
      LSUSB_BIN: lsusb,
      ANDROID_DEVICE_SERIAL: "R5CR702SRFP",
      ANDROID_ADB_WATCHDOG_STATE_DIR: dir,
    },
  }).catch((error: any) => error);

  assert.equal(result.code ?? 0, 0);
  assert.match(result.stderr, /unauthorized.*RSA|RSA.*unauthorized/i);
});

test("USB watchdog records an absent USB transport once until its state changes", async () => {
  const dir = await mkdtemp(join(tmpdir(), "android-adb-absent-"));
  const adb = await fakeCommand(dir, "adb", 'if [[ "$*" == "devices -l" ]]; then exit 0; fi');
  const lsusb = await fakeCommand(dir, "lsusb", "exit 0");
  const env = {
    ...process.env,
    ADB_BIN: adb,
    LSUSB_BIN: lsusb,
    ANDROID_DEVICE_SERIAL: "R5CR702SRFP",
    ANDROID_ADB_WATCHDOG_STATE_DIR: dir,
  };

  const first = await execFileAsync(watchdog, [], { env });
  const second = await execFileAsync(watchdog, [], { env });

  assert.equal(first.code ?? 0, 0);
  assert.match(first.stderr, /USB_ABSENT/);
  assert.equal(second.code ?? 0, 0);
  assert.equal(second.stderr, "");
});

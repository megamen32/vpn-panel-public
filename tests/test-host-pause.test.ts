import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { testDashboardPage } from "../src/test-dashboard.js";
import { setVpnTestTargetEnabled } from "../src/vpn-test-targets.js";

test("Test Center renders a persistent pause control for each test host", () => {
  const html = testDashboardPage({
    endpoints: [],
    health: [],
    scores: [],
    testTargets: [{
      id: "external-wireless-android",
      label: "Android 4G · server-100",
      runner: "android-adb",
      mode: "android",
      engine: "xray",
      enabled: true,
    }],
  });

  assert.match(html, /id="test-target-pause-external-wireless-android"/);
  assert.match(html, /onclick="setTestTargetEnabled\('external-wireless-android', false\)"/);
  assert.match(html, /\/api\/admin\/endpoint-health\/targets\//);
  assert.match(html, /selectedTestEndpoints/);
  assert.match(html, /endpoints: selectedTestEndpoints\(\)/);
});

test("pausing a host persists only its enabled state in the test plan", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "vpn-test-target-pause-"));
  const planPath = path.join(directory, "test-plan.json");
  await writeFile(planPath, JSON.stringify({
    testTargets: [
      { id: "external-mac", enabled: true, label: "Mac" },
      { id: "external-wireless-android", enabled: true, label: "Android" },
    ],
    unrelated: { keep: true },
  }, null, 2));

  try {
    const target = await setVpnTestTargetEnabled("external-wireless-android", false, planPath);
    assert.deepEqual(target, { id: "external-wireless-android", enabled: false });
    const saved = JSON.parse(await readFile(planPath, "utf8"));
    assert.equal(saved.testTargets[0].enabled, true);
    assert.equal(saved.testTargets[1].enabled, false);
    assert.deepEqual(saved.unrelated, { keep: true });
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

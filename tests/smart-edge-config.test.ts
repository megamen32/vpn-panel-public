import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";

import { DEFAULT_SMART_EDGE_TARGETS, serviceTargetCapabilities } from "../src/smart-edge-config.js";

test("service routing exposes explicit VPS capabilities instead of inferring them from an id", () => {
  const capabilities = serviceTargetCapabilities({
    targets: DEFAULT_SMART_EDGE_TARGETS,
    state: { activeEdgeId: "vusa" },
    targetsPath: "unused",
    statePath: "unused",
  });

  assert.deepEqual(capabilities.find((target) => target.id === "vusa"), {
    id: "vusa",
    publicDnsEdge: true,
    lanEgress: true,
    lanBalancerTag: "us-auto",
    dedicatedPublicDnsProfile: "vusa",
  });
  assert.deepEqual(capabilities.find((target) => target.id === "vpn2"), {
    id: "vpn2",
    publicDnsEdge: true,
    lanEgress: true,
    lanBalancerTag: "proxy",
  });
});

test("selecting the current primary edge is an idempotent no-op", async () => {
  const directory = await mkdtemp(path.join(tmpdir(), "vpn-panel-smart-edge-"));
  const statePath = path.join(directory, "state.json");
  const previousStatePath = process.env.VPN_PANEL_SMART_EDGE_STATE;
  const previousScriptPath = process.env.VPN_PANEL_SMART_EDGE_SCRIPT;

  await writeFile(statePath, JSON.stringify({ activeEdgeId: "vusa" }), "utf8");
  process.env.VPN_PANEL_SMART_EDGE_STATE = statePath;
  process.env.VPN_PANEL_SMART_EDGE_SCRIPT = path.join(directory, "must-not-run.mjs");

  try {
    const { runSmartEdgeAction } = await import("../src/smart-edge-config.js");
    const result = await runSmartEdgeAction("select-primary", "vusa");

    assert.equal(result.ok, true);
    assert.match(result.output, /already primary/i);
    assert.deepEqual(JSON.parse(await readFile(statePath, "utf8")), { activeEdgeId: "vusa" });
  } finally {
    if (previousStatePath === undefined) delete process.env.VPN_PANEL_SMART_EDGE_STATE;
    else process.env.VPN_PANEL_SMART_EDGE_STATE = previousStatePath;
    if (previousScriptPath === undefined) delete process.env.VPN_PANEL_SMART_EDGE_SCRIPT;
    else process.env.VPN_PANEL_SMART_EDGE_SCRIPT = previousScriptPath;
    await rm(directory, { recursive: true, force: true });
  }
});

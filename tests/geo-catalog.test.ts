import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { inspectGeoCatalog } from "../src/geo-catalog.js";
import { checkSmartDnsRoute, DEFAULT_SMART_DNS_POLICY } from "../src/smart-dns-policy.js";

test("geo catalog reports asset sizes and tags used by unified rules", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "vpn-panel-geo-catalog-"));
  try {
    await writeFile(path.join(directory, "geoip.dat"), Buffer.alloc(2048));
    await writeFile(path.join(directory, "README"), "fixture");
    const catalog = await inspectGeoCatalog(DEFAULT_SMART_DNS_POLICY.rules, directory);
    const geoip = catalog.assets.find((asset) => asset.kind === "geoip");
    const geosite = catalog.assets.find((asset) => asset.kind === "geosite");
    assert.equal(geoip?.exists, true);
    assert.equal(geoip?.bytes, 2048);
    assert.ok(geoip?.tags.includes("ru"));
    assert.equal(geosite?.exists, false);
    assert.deepEqual(catalog.availableFiles, ["README", "geoip.dat"]);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
test("route checker explains DNS, LAN and VPN decisions", () => {
  const result = checkSmartDnsRoute("https://api.telegram.org/path", DEFAULT_SMART_DNS_POLICY);
  assert.equal(result.dimensions.internalDns, "proxy");
  assert.equal(result.dimensions.externalDns, "proxy");
  assert.equal(result.dimensions.lan, "proxy");
  assert.equal(result.dimensions.vpn, "vusa");
  assert.equal(result.vpnMatched, "api.telegram.org");
});

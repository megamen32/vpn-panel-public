import assert from "node:assert/strict";
import { chmod, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { checkSmartDnsRoute, DEFAULT_SMART_DNS_POLICY, loadSmartDnsPolicy, normalizeSmartDnsPolicy, quickSmartDnsRouteRule, saveSmartDnsPolicy } from "../src/smart-dns-policy.js";

test("policy reader migrates legacy JSON but exposes only canonical rules", async () => {
  const temporary = await mkdtemp(path.join(os.tmpdir(), "vpn-panel-smart-dns-policy-"));
  const file = path.join(temporary, "policy.json");
  try {
    await writeFile(file, JSON.stringify({ defaultRoute: "proxy", localDefaultRoute: "direct", directSuffixes: ["z.ai"], proxySuffixes: ["chatgpt.com"] }));
    const policy = await loadSmartDnsPolicy(file);
    assert.equal("directSuffixes" in policy, false);
    assert.equal(checkSmartDnsRoute("api.z.ai", policy).publicRoute, "direct");
    assert.equal(checkSmartDnsRoute("chatgpt.com", policy).publicRoute, "proxy");
  } finally { await rm(temporary, { recursive: true, force: true }); }
});

test("policy save writes rules-only JSON even after a legacy read", async () => {
  const temporary = await mkdtemp(path.join(os.tmpdir(), "vpn-panel-smart-dns-policy-save-"));
  const file = path.join(temporary, "policy.json");
  try {
    await writeFile(file, `${JSON.stringify(DEFAULT_SMART_DNS_POLICY)}\n`); await chmod(file, 0o600); await chmod(temporary, 0o500);
    const saved = await saveSmartDnsPolicy(DEFAULT_SMART_DNS_POLICY, file);
    const raw = JSON.parse(await readFile(file, "utf8")) as Record<string, unknown>;
    assert.deepEqual(raw.rules, saved.rules);
    assert.equal("proxySuffixes" in raw, false);
  } finally { await chmod(temporary, 0o700); await rm(temporary, { recursive: true, force: true }); }
});

test("policy saved by the panel can be loaded again", async () => {
  const temporary = await mkdtemp(path.join(os.tmpdir(), "vpn-panel-smart-dns-policy-roundtrip-"));
  const file = path.join(temporary, "policy.json");
  try {
    await saveSmartDnsPolicy(DEFAULT_SMART_DNS_POLICY, file);
    const loaded = await loadSmartDnsPolicy(file);
    assert.deepEqual(loaded.rules, normalizeSmartDnsPolicy(DEFAULT_SMART_DNS_POLICY).rules);
  } finally { await rm(temporary, { recursive: true, force: true }); }
});

test("defaults retain LAN-only, VUSA, and direct decisions through rules", () => {
  const instagram = checkSmartDnsRoute("reels.instagram.com", DEFAULT_SMART_DNS_POLICY);
  assert.deepEqual([instagram.route, instagram.localRoute, instagram.publicRoute], ["local-proxy", "proxy", "direct"]);
  assert.equal(checkSmartDnsRoute("api.telegram.org", DEFAULT_SMART_DNS_POLICY).route, "vusa-proxy");
  assert.equal(checkSmartDnsRoute("api.z.ai", DEFAULT_SMART_DNS_POLICY).route, "direct");
  assert.deepEqual(
    [
      checkSmartDnsRoute("github.com", DEFAULT_SMART_DNS_POLICY).localRoute,
      checkSmartDnsRoute("github.com", DEFAULT_SMART_DNS_POLICY).publicRoute,
      checkSmartDnsRoute("github.com", DEFAULT_SMART_DNS_POLICY).vpnRoute,
    ],
    ["direct", "direct", "direct"],
  );
  assert.equal(checkSmartDnsRoute("docs.github.io", DEFAULT_SMART_DNS_POLICY).vpnRoute, "direct");
});

test("row conditions independently project internal and external DNS", () => {
  const policy = normalizeSmartDnsPolicy({ rules: [{ id: "local", text: "example.test", match: "suffix", through: ["vpn2"], conditions: ["internalDns", "vpn"] }] });
  const result = checkSmartDnsRoute("www.example.test", policy);
  assert.deepEqual([result.localRoute, result.publicRoute, result.route], ["proxy", "direct", "local-proxy"]);
});

test("quick SmartDNS bypass routes the exact host through LAN and VPN but not public DNS", () => {
  const rule = quickSmartDnsRouteRule("keenable.ai", "smart-dns");
  const result = checkSmartDnsRoute("https://keenable.ai/", normalizeSmartDnsPolicy({ rules: [rule] }));

  assert.deepEqual(rule.conditions, ["internalDns", "vpn"]);
  assert.deepEqual([result.localRoute, result.publicRoute, result.vpnRoute, result.route], ["proxy", "direct", "vpn2", "local-proxy"]);
});

test("quick VPN DPI bypass routes the exact host through LAN, public SmartDNS, and VPN", () => {
  const rule = quickSmartDnsRouteRule("keenable.ai", "vpn");
  const result = checkSmartDnsRoute("https://keenable.ai/", normalizeSmartDnsPolicy({ rules: [rule] }));

  assert.deepEqual(rule.conditions, ["externalDns", "internalDns", "vpn"]);
  assert.deepEqual([result.localRoute, result.publicRoute, result.vpnRoute], ["proxy", "proxy", "vpn2"]);
});

test("quick Direct action remains an explicit all-scope direct exception", () => {
  const rule = quickSmartDnsRouteRule("blocked.example", "direct");
  const result = checkSmartDnsRoute("blocked.example", normalizeSmartDnsPolicy({ rules: [rule] }));

  assert.deepEqual(rule.conditions, ["externalDns", "internalDns", "vpn"]);
  assert.deepEqual([result.localRoute, result.publicRoute, result.vpnRoute], ["direct", "direct", "direct"]);
});


test("VPN-only exact override is independent from DNS routing", () => {
  const policy = normalizeSmartDnsPolicy({ rules: [
    { id: "dns", text: "example.test", match: "suffix", through: ["vpn2"], conditions: ["externalDns", "internalDns"] },
    { id: "quick:vpn:www.example.test", text: "www.example.test", match: "exact", through: ["direct"], conditions: ["vpn"] },
  ] });
  const result = checkSmartDnsRoute("https://www.example.test/path", policy);
  assert.equal(result.localRoute, "proxy");
  assert.equal(result.publicRoute, "proxy");
  assert.equal(result.vpnRoute, "direct");
  assert.equal(result.vpnMatched, "www.example.test");
});


test("internal and external DNS choose their most specific rules independently", () => {
  const policy = normalizeSmartDnsPolicy({ rules: [
    { id: "external", text: "example.test", match: "suffix", through: ["vpn2"], conditions: ["externalDns"] },
    { id: "internal", text: "www.example.test", match: "exact", through: ["direct"], conditions: ["internalDns"] },
  ] });
  const result = checkSmartDnsRoute("www.example.test", policy);
  assert.equal(result.localRoute, "direct");
  assert.equal(result.publicRoute, "proxy");
  assert.equal(result.route, "proxy");
});

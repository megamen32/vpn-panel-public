import assert from "node:assert/strict";
import test from "node:test";

import { compileDnsRoutingRules, compileVpnRoutingRules, migrateSmartDnsPolicyToRoutingRules, normalizeRoutingRules } from "../src/routing-rules.js";
import type { SmartDnsPolicy } from "../src/smart-dns-policy.js";
import { normalizeSmartDnsPolicy } from "../src/smart-dns-policy.js";
import { checkSmartDnsRoute } from "../src/smart-dns-policy.js";

const policy: SmartDnsPolicy = {
  defaultRoute: "direct",
  localDefaultRoute: "direct",
  blockSuffixes: [], blockDomains: [],
  directSuffixes: ["ru"], directDomains: ["vpn.bezrabotnyi.com"],
  proxySuffixes: ["openai.com"], proxyDomains: ["api.openai.com"],
  localProxySuffixes: ["youtube.com"], localProxyDomains: [],
  vusaProxySuffixes: ["telegram.org"], vusaProxyDomains: ["api.telegram.org"],
};

test("routing rules normalize domain, target, and scope semantics", () => {
  const rules = normalizeRoutingRules([
    { id: "zai", text: "Z.AI", match: "suffix", through: ["direct"], conditions: ["internalDns", "externalDns", "vpn"] },
    { id: "telegram", text: "geoip:telegram", match: "set", through: ["vusa", "vpn2"], conditions: ["vpn"] },
  ]);

  assert.deepEqual(rules[0], { id: "zai", text: "z.ai", match: "suffix", through: ["direct"], conditions: ["externalDns", "internalDns", "vpn"] });
  assert.deepEqual(rules[1], { id: "telegram", text: "geoip:telegram", match: "set", through: ["vusa", "vpn2"], conditions: ["vpn"] });
  assert.throws(() => normalizeRoutingRules([{ id: "bad", text: "example.com", match: "suffix", through: ["direct", "vpn2"], conditions: ["vpn"] }]));
  assert.throws(() => normalizeRoutingRules([{ id: "bad-geo", text: "geoip:ru", match: "set", through: ["direct"], conditions: ["externalDns"] }]));
});

test("legacy SmartDNS policy migrates without changing target scopes", () => {
  const rules = migrateSmartDnsPolicyToRoutingRules(policy);
  const byText = new Map(rules.map((rule) => [rule.text, rule]));

  assert.deepEqual(byText.get("vpn.bezrabotnyi.com"), { id: "domain-exact-vpn-bezrabotnyi-com-direct", text: "vpn.bezrabotnyi.com", match: "exact", through: ["direct"], conditions: ["externalDns", "internalDns", "vpn"] });
  assert.deepEqual(byText.get("youtube.com")?.conditions, ["internalDns", "vpn"]);
  assert.deepEqual(byText.get("telegram.org")?.through, ["vusa"]);
  assert.deepEqual(byText.get("telegram.org")?.conditions, ["externalDns", "internalDns", "vpn"]);
});

test("DNS and VPN compilers project only rules supported by each consumer", () => {
  const rules = normalizeRoutingRules([
    { id: "direct", text: "z.ai", match: "suffix", through: ["direct"], conditions: ["internalDns", "externalDns", "vpn"] },
    { id: "dual", text: "openai.com", match: "suffix", through: ["vpn2", "vusa"], conditions: ["externalDns", "vpn"] },
    { id: "ru", text: "geoip:ru", match: "set", through: ["direct"], conditions: ["vpn"] },
  ]);

  assert.deepEqual(compileDnsRoutingRules(rules, "internalDns"), [
    { id: "direct", text: "z.ai", match: "suffix", through: ["direct"] },
  ]);
  assert.deepEqual(compileDnsRoutingRules(rules, "externalDns"), [
    { id: "direct", text: "z.ai", match: "suffix", through: ["direct"] },
    { id: "dual", text: "openai.com", match: "suffix", through: ["vpn2", "vusa"] },
  ]);
  assert.deepEqual(compileVpnRoutingRules(rules), [
    { id: "direct", domain: ["domain:z.ai"], ip: [], through: ["direct"] },
    { id: "dual", domain: ["domain:openai.com"], ip: [], through: ["vpn2", "vusa"] },
    { id: "ru", domain: [], ip: ["geoip:ru"], through: ["direct"] },
  ]);
});

test("new rules survive SmartDNS policy normalization", () => {
  const saved = normalizeSmartDnsPolicy({
    ...policy,
    rules: [{ id: "zai", text: "z.ai", match: "suffix", through: ["direct"], conditions: ["vpn", "externalDns"] }],
  });
  assert.deepEqual(saved.rules.find((rule) => rule.id === "zai"), { id: "zai", text: "z.ai", match: "suffix", through: ["direct"], conditions: ["externalDns", "vpn"] });
});

test("route check uses rule scopes and target before legacy policy groups", () => {
  const routed = normalizeSmartDnsPolicy({
    ...policy,
    rules: [{ id: "vusa", text: "openai.com", match: "suffix", through: ["vusa"], conditions: ["externalDns", "vpn"] }],
  });
  const result = checkSmartDnsRoute("api.openai.com", routed);
  assert.equal(result.localRoute, "direct");
  assert.equal(result.publicRoute, "proxy");
  assert.equal(result.publicEdgeProfile, "vusa");
});

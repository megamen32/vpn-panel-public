import assert from "node:assert/strict";
import test from "node:test";

import { checkSmartDnsRoute, DEFAULT_SMART_DNS_POLICY } from "../src/smart-dns-policy.js";
import { renderOpenWrtAddressRules } from "../src/openwrt-smart-dns.js";
import { loadRestrictedServicesCatalog, mergeRestrictedServiceRoutes, parseRunetFreedomRules } from "../src/restricted-services.js";

test("restricted catalog stays a unified rule producer", async () => {
  const catalog = await loadRestrictedServicesCatalog();
  const policy = mergeRestrictedServiceRoutes(DEFAULT_SMART_DNS_POLICY, catalog);
  assert.ok(policy.rules.some((rule) => rule.id.startsWith("restricted:")));
  assert.equal("proxySuffixes" in policy, false);
  assert.equal(checkSmartDnsRoute("antigravity.google", policy).route, "vusa-proxy");
  assert.equal(checkSmartDnsRoute("discord.com", policy).publicRoute, "proxy");
});

test("restricted policy rows compile into OpenWrt LAN address rules", async () => {
  const policy = mergeRestrictedServiceRoutes(DEFAULT_SMART_DNS_POLICY, await loadRestrictedServicesCatalog());
  const rendered = renderOpenWrtAddressRules(policy);
  assert.match(rendered, /discord\.com/);
  assert.match(rendered, /telegram\.org/);
});

test("administrator rows win over catalog rows", async () => {
  const policy = { ...DEFAULT_SMART_DNS_POLICY, rules: [{ id: "admin-telegram", text: "telegram.org", match: "suffix" as const, through: ["direct"] as const, conditions: ["externalDns", "internalDns", "vpn"] as const }, ...DEFAULT_SMART_DNS_POLICY.rules] };
  const merged = mergeRestrictedServiceRoutes(policy, await loadRestrictedServicesCatalog());
  assert.equal(checkSmartDnsRoute("telegram.org", merged).route, "direct");
});

test("RunetFreedom parser preserves domain/full forms", () => {
  assert.deepEqual(parseRunetFreedomRules("domain:example.com\nfull:api.example.com\n# comment"), ["api.example.com", "example.com"]);
});

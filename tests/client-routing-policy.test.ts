import test from "node:test";
import assert from "node:assert/strict";
import { clientRoutingPolicyFromSmartDns, xrayDomains } from "../src/client-routing-policy.js";
import type { SmartDnsPolicy } from "../src/smart-dns-policy.js";

const policy: SmartDnsPolicy = {
  defaultRoute: "proxy", localDefaultRoute: "direct",
  blockSuffixes: [], blockDomains: [],
  directSuffixes: ["ru"], directDomains: ["vpn.bezrabotnyi.com"],
  proxySuffixes: ["openai.com"], proxyDomains: ["api.openai.com"],
  localProxySuffixes: ["whatsapp.com"], localProxyDomains: [],
  vusaProxySuffixes: ["telegram.org"], vusaProxyDomains: ["api.telegram.org"],
  rules: [
    { id: "direct-ru", text: "ru", match: "suffix", through: ["direct"], conditions: ["vpn"] },
    { id: "direct-panel", text: "vpn.bezrabotnyi.com", match: "exact", through: ["direct"], conditions: ["vpn"] },
    { id: "de", text: "openai.com", match: "suffix", through: ["vpn2"], conditions: ["vpn"] },
    { id: "de-api", text: "api.openai.com", match: "exact", through: ["vpn2"], conditions: ["vpn"] },
    { id: "local", text: "whatsapp.com", match: "suffix", through: ["vpn2"], conditions: ["vpn"] },
    { id: "us", text: "telegram.org", match: "suffix", through: ["vusa"], conditions: ["vpn"] },
  ],
};

test("desktop client policy is direct by default and keeps exact domains exact", () => {
  const actual = clientRoutingPolicyFromSmartDns(policy);
  assert.equal(actual.defaultAction, "direct");
  assert.deepEqual(actual.block, []);
  assert.deepEqual(actual.direct, ["=vpn.bezrabotnyi.com", "ru"]);
  assert.deepEqual(actual.proxy, ["=api.openai.com", "openai.com", "telegram.org", "whatsapp.com"]);
  assert.deepEqual(xrayDomains(actual.proxy), ["full:api.openai.com", "domain:openai.com", "domain:telegram.org", "domain:whatsapp.com"]);
});

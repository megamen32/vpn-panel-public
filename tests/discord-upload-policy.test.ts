import assert from "node:assert/strict";
import test from "node:test";

import { loadRestrictedServicesCatalog, mergeRestrictedServiceRoutes } from "../src/restricted-services.js";
import { renderOpenWrtAddressRules } from "../src/openwrt-smart-dns.js";
import { checkSmartDnsRoute, DEFAULT_SMART_DNS_POLICY } from "../src/smart-dns-policy.js";

const uploadHost = "discord-attachments-uploads-prd.storage.googleapis.com";

test("Discord attachment upload storage uses the remote VPN route", async () => {
  const catalog = await loadRestrictedServicesCatalog();
  const policy = mergeRestrictedServiceRoutes(DEFAULT_SMART_DNS_POLICY, catalog);
  const result = checkSmartDnsRoute(`https://${uploadHost}/upload`, policy);
  assert.equal(result.route, "proxy");
  assert.equal(result.matched, uploadHost);
  assert.equal(result.localRoute, "proxy");
  assert.equal(result.publicRoute, "proxy");
  const generated = renderOpenWrtAddressRules(policy);
  assert.equal(generated.split("\n").filter((line) => line.trim() === uploadHost).length, 1);
});

test("Discord upload policy does not proxy all Google Cloud Storage", async () => {
  const catalog = await loadRestrictedServicesCatalog();
  const policy = mergeRestrictedServiceRoutes(DEFAULT_SMART_DNS_POLICY, catalog);
  const result = checkSmartDnsRoute("https://unrelated-bucket.storage.googleapis.com/object", policy);
  assert.notEqual(result.matched, uploadHost);
});

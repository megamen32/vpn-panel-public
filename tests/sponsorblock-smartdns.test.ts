import assert from "node:assert/strict";
import test from "node:test";

import { checkSmartDnsRoute, DEFAULT_SMART_DNS_POLICY } from "../src/smart-dns-policy.js";

test("SponsorBlock web and API hosts use the external VPN route", () => {
  for (const host of [
    "sponsor.ajay.app",
    "api.sponsor.ajay.app",
    "status.sponsor.ajay.app",
    "web.sponsor.ajay.app",
  ]) {
    const result = checkSmartDnsRoute(host, DEFAULT_SMART_DNS_POLICY);
    assert.equal(result.localRoute, "proxy", host);
    assert.equal(result.publicRoute, "proxy", host);
    assert.equal(result.matched, "sponsor.ajay.app", host);
  }
});

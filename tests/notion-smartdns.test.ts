import assert from "node:assert/strict";
import test from "node:test";

import { checkSmartDnsRoute, DEFAULT_SMART_DNS_POLICY } from "../src/smart-dns-policy.js";

test("Notion and PDMN use the external VPN route", () => {
  for (const host of [
    "notion.so",
    "www.notion.so",
    "pdmn.notion.so",
    "notion.com",
    "notion.site",
    "notion-static.com",
    "notionusercontent.com",
    "notion-status.com",
  ]) {
    const result = checkSmartDnsRoute(host, DEFAULT_SMART_DNS_POLICY);
    assert.equal(result.localRoute, "proxy", host);
    assert.equal(result.publicRoute, "proxy", host);
  }
});

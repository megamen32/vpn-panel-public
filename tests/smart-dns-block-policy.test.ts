import test from "node:test";
import assert from "node:assert/strict";
import { checkSmartDnsRoute, normalizeSmartDnsPolicy } from "../src/smart-dns-policy.js";

test("legacy block groups are rejected because unified rules have no hidden block action", () => {
  assert.throws(() => normalizeSmartDnsPolicy({ blockSuffixes: ["example.com"] }), /explicit migration decision/);
});

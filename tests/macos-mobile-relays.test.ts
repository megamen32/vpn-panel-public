import assert from "node:assert/strict";
import test from "node:test";
import { macosXraySubscription, type ClientBundle } from "../src/subscriptions.js";
import type { Endpoint } from "../src/types.js";
import type { SecureConfig } from "../src/secure-config.js";
import type { SmartDnsPolicy } from "../src/smart-dns-policy.js";

const secure: SecureConfig = {
  defaults: { fingerprint: "chrome", flow: "xtls-rprx-vision", sni: "ya.ru", domain_strategy: "IPIfNonMatch" },
  nodes: [],
  server_configs: {},
};

function relay(id: string, fingerprint = "safari"): Endpoint {
  return {
    id,
    label: id,
    kind: "vless-reality",
    address: "95.165.165.65",
    port: 443,
    profile_id: id,
    enabled: true,
    sort_order: 0,
    config: { public_key: "relay-key", short_id: "relay-id", sni: `${id}.runet.bezrabotnyi.com`, fingerprint },
  };
}

const bundle: ClientBundle = {
  accountId: "account",
  clientId: "client",
  displayName: "Mac test",
  login: "mac-test",
  xrayUuid: "uuid",
  token: "token",
  endpoints: [
    relay("us-reality", "chrome"),
    relay("fi-helsinki-relay", "chrome"),
    relay("smart-de-relay-mobile"),
    relay("full-us-relay-mobile"),
  ],
};

const policy: SmartDnsPolicy = {
  rules: [
    { id: "de", text: "openai.com", match: "suffix", through: ["vpn2"], conditions: ["vpn"] },
    { id: "us", text: "telegram.org", match: "suffix", through: ["vusa"], conditions: ["vpn"] },
  ],
};

test("macOS Smart Auto offers Finland in both regional leastPing balancers", () => {
  const generated = macosXraySubscription(bundle, secure, policy, "smart");
  const outbounds = generated.outbounds as Array<Record<string, unknown>>;
  const tags = outbounds.filter((outbound) => outbound.protocol === "vless").map((outbound) => String(outbound.tag));
  assert.deepEqual(tags, ["us-reality", "fi-helsinki-relay", "smart-de-relay-mobile", "full-us-relay-mobile"]);

  const balancers = generated.routing as { balancers: Array<Record<string, unknown>> };
  assert.deepEqual(balancers.balancers.find((balancer) => balancer.tag === "bez-de")?.selector, ["fi-helsinki-relay", "smart-de-relay-mobile"]);
  assert.deepEqual(balancers.balancers.find((balancer) => balancer.tag === "bez-us")?.selector, ["us-reality", "fi-helsinki-relay", "full-us-relay-mobile"]);
  assert.equal(balancers.balancers.some((balancer) => (balancer.selector as string[]).includes("smart-us-relay")), false);

  const mobile = outbounds.find((outbound) => outbound.tag === "smart-de-relay-mobile");
  const reality = (mobile?.streamSettings as Record<string, unknown>).realitySettings as Record<string, unknown>;
  assert.equal(reality.fingerprint, "safari");
});

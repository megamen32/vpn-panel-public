import test from "node:test";
import assert from "node:assert/strict";
import type { SecureConfig } from "../src/secure-config.js";
import { regionalRelayServerConfig, ruCombinedServerConfig, ruServerConfig } from "../src/xray-configs.js";
import type { DbPool } from "../src/db.js";

const mockPool = { query: async () => ({ rows: [] }) } as unknown as DbPool;

const secure: SecureConfig = {
  defaults: {
    fingerprint: "chrome",
    flow: "xtls-rprx-vision",
    sni: "ya.ru",
    domain_strategy: "IPIfNonMatch",
  },
  nodes: [],
  server_configs: {
    ru: {
      listen_port: 443,
      private_key: "ru-private",
      server_names: ["ya.ru"],
      short_ids: ["ru-sid"],
      de_address: "vpn2.bezrabotnyi.com",
      de_port: 23443,
      de_public_key: "de-pbk",
      de_short_id: "de-sid",
      relay_uuid: "11111111-1111-1111-1111-111111111111",
    },
  },
};

test("smart relay uses the compact RU-only inverse-routing tags", async () => {
  const config = await regionalRelayServerConfig(mockPool, secure);
  const routing = config.routing as { rules: Array<Record<string, unknown>> };
  const rules = routing.rules.filter((rule) => (rule.inboundTag as string[]).includes("smart-de-relay"));

  assert.deepEqual(rules.map((rule) => rule.ip ?? rule.domain ?? rule.network), [
    ["geoip:private"],
    ["geosite:ru-inside"],
    ["geoip:ru"],
    "tcp,udp",
  ]);
  assert.equal(rules[3].balancerTag, "de-auto");
});

test("legacy DE relay excludes the stalling XHTTP routes", async () => {
  const config = await ruServerConfig(mockPool, secure);
  const outbounds = config.outbounds as Array<{ tag: string }>;
  const balancers = config.routing as { balancers: Array<{ selector: string[] }> };
  const selector = balancers.balancers[0].selector;
  const observatory = config.observatory as { subjectSelector: string[] };

  assert.ok(outbounds.some((outbound) => outbound.tag.startsWith("to-de-reality")));
  assert.ok(selector.some((tag) => tag.startsWith("to-de-reality")));
  assert.ok(observatory.subjectSelector.some((tag) => tag.startsWith("to-de-reality")));
  assert.ok(!selector.some((tag) => tag.includes("xhttp")));
});

test("deprecated combined relay excludes high-port XHTTP H2", async () => {
  const config = await ruCombinedServerConfig(mockPool, secure);
  const balancers = config.routing as { balancers: Array<{ selector: string[] }> };
  const selector = balancers.balancers[0].selector;

  assert.ok(!selector.some((tag) => tag.includes("xhttp-h2")));
});

test("US relay selector contains only transports proven stable by the health matrix", async () => {
  const config = await regionalRelayServerConfig(mockPool, secure);
  const outbounds = config.outbounds as Array<{ tag: string; streamSettings: any; settings?: any }>;

  assert.deepEqual(
    outbounds.filter((outbound) => outbound.tag.startsWith("to-us-")).map((outbound) => outbound.tag),
    ["to-us-cdn2"],
    "VUSA relay must not select diagnostic transports that are absent from the stable health set",
  );
});

test("DE relay selector excludes high-port XHTTP H2", async () => {
  const config = await ruServerConfig(mockPool, secure);
  const balancers = config.routing as { balancers: Array<{ selector: string[] }> };
  assert.ok(!balancers.balancers[0].selector.includes("to-de-xhttp-h2"));
  const observatory = config.observatory as { subjectSelector: string[] };
  assert.ok(!observatory.subjectSelector.includes("to-de-xhttp-h2"));
});

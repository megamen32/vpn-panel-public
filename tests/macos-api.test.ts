import test from "node:test";
import assert from "node:assert/strict";
import fastify from "fastify";
import { registerMacosRoutes } from "../src/macos-api.js";
import { MACOS_CONFIG_TOKEN } from "../src/macos-token.js";
import type { SecureConfig } from "../src/secure-config.js";
import { normalizeSmartDnsPolicy } from "../src/smart-dns-policy.js";

const secure: SecureConfig = {
  defaults: { fingerprint: "chrome", flow: "xtls-rprx-vision", sni: "ya.ru", domain_strategy: "IPIfNonMatch" },
  nodes: [],
  server_configs: {},
};

const policy = normalizeSmartDnsPolicy({
  defaultRoute: "proxy",
  localDefaultRoute: "direct",
  directSuffixes: [".ua", "ru"],
  directDomains: ["localhost"],
  proxySuffixes: ["openai.com"],
  proxyDomains: ["www.example.ua"],
  localProxySuffixes: ["telegram.org"],
  localProxyDomains: [],
  vusaProxySuffixes: [],
  vusaProxyDomains: [],
});

test("macOS API authenticates vpn2-07 and returns distinct no-store smart/all configs", async () => {
  const pool = {
    async query(sql: string) {
      if (sql.includes("from accounts where")) {
        return { rows: [{ id: "7", login: "vpn2-07", display_name: "Masha", password_hash: "not-used", role: "user", enabled: true }] };
      }
      if (sql.includes("from accounts a")) {
        return { rows: [{ account_id: "7", client_id: "9", display_name: "Masha", login: "vpn2-07", xray_uuid: "a5c1b3e1-6fc9-4573-ada5-5022d4fc4b6b", token: "subscription-secret" }] };
      }
      return {
        rows: [{ id: "de-httpupgrade", label: "DE backup", kind: "vless-httpupgrade", address: "212.192.31.128", port: 443, profile_id: "de-httpupgrade", enabled: true, sort_order: 1, config: { query: { type: "httpupgrade", security: "tls", path: "/hup", host: "vpn2.bezrabotnyi.com", sni: "vpn2.bezrabotnyi.com" } } }],
      };
    },
  } as never;
  const app = fastify();
  registerMacosRoutes(app, { baseUrl: "https://vpn.bezrabotnyi.com", pool, secure, loadPolicy: async () => policy });

  const unauthorized = await app.inject({ method: "GET", url: "/api/user/macos-xray-config?mode=smart" });
  assert.equal(unauthorized.statusCode, 401);
  assert.equal(unauthorized.headers["cache-control"], "no-store");
  const wrongToken = await app.inject({ method: "GET", url: "/api/user/macos-xray-config?mode=smart", headers: { authorization: "Bearer wrong-token" } });
  assert.equal(wrongToken.statusCode, 401);

  const auth = `Bearer ${MACOS_CONFIG_TOKEN}`;
  const smart = await app.inject({ method: "GET", url: "/api/user/macos-xray-config?mode=smart", headers: { authorization: auth } });
  const all = await app.inject({ method: "GET", url: "/api/user/macos-xray-config?mode=all", headers: { authorization: auth } });
  assert.equal(smart.statusCode, 200);
  assert.equal(all.statusCode, 200);
  assert.equal(smart.headers["cache-control"], "no-store");
  assert.notEqual(smart.body, all.body);
  assert.doesNotMatch(smart.body, /subscription-secret/);
  assert.doesNotMatch(smart.body, new RegExp(MACOS_CONFIG_TOKEN));
  assert.equal(JSON.parse(smart.body).inbounds.some((inbound: { protocol: string }) => inbound.protocol === "tun"), false);
  assert.equal(JSON.parse(all.body).inbounds.some((inbound: { protocol: string }) => inbound.protocol === "tun"), false);
  assert.equal(JSON.parse(smart.body).routing.rules.at(-1).outboundTag, "direct");
  assert.equal(JSON.parse(all.body).routing.rules.at(-1).balancerTag, "bez-all");
  const smartRules = JSON.parse(smart.body).routing.rules as Array<{ domain?: string[]; balancerTag?: string }>;
  for (const domain of ["domain:ua", "full:www.example.ua"]) {
    assert.ok(smartRules.some((rule) => rule.balancerTag === "bez-de" && rule.domain?.includes(domain)), `${domain} must use the Smart VPN balancer`);
  }
  const addresses = JSON.parse(smart.body).outbounds
    .filter((outbound: { protocol: string }) => outbound.protocol === "vless")
    .map((outbound: { settings: { vnext: Array<{ address: string }> } }) => outbound.settings.vnext[0].address);
  assert.ok(addresses.length > 0);
  assert.ok(addresses.every((address: string) => /^\d+\.\d+\.\d+\.\d+$/.test(address)));
  await app.close();
});

test("macOS policy endpoint serves the live Smart policy to the local dashboard", async () => {
  const pool = { async query() { return { rows: [] }; } } as never;
  const app = fastify();
  registerMacosRoutes(app, { baseUrl: "https://vpn.bezrabotnyi.com", pool, secure, loadPolicy: async () => policy });

  const unauthorized = await app.inject({ method: "GET", url: "/api/user/macos-policy" });
  assert.equal(unauthorized.statusCode, 401);

  const auth = `Bearer ${MACOS_CONFIG_TOKEN}`;
  const response = await app.inject({ method: "GET", url: "/api/user/macos-policy", headers: { authorization: auth } });
  assert.equal(response.statusCode, 200);
  assert.equal(response.headers["cache-control"], "no-store");
  const body = JSON.parse(response.body);
  assert.deepEqual(body.proxySuffixes, policy.proxySuffixes);
  assert.deepEqual(body.localProxySuffixes, policy.localProxySuffixes);
  assert.deepEqual(body.vusaProxySuffixes, policy.vusaProxySuffixes);
  assert.deepEqual(body.directSuffixes, policy.directSuffixes);
  assert.doesNotMatch(response.body, new RegExp(MACOS_CONFIG_TOKEN));
  const shared = await app.inject({ method: "GET", url: "/api/user/client-policy", headers: { authorization: auth } });
  assert.equal(shared.statusCode, 200);
  assert.equal(shared.body, response.body);
});

import assert from "node:assert/strict";
import test from "node:test";
import { server44SingBoxConfig } from "../src/lan-singbox-config.js";
import type { SecureConfig } from "../src/secure-config.js";
import type { Endpoint } from "../src/types.js";

const secure: SecureConfig = {
  defaults: { fingerprint: "chrome", flow: "xtls-rprx-vision", sni: "ya.ru", domain_strategy: "IPIfNonMatch" },
  nodes: [
    { id: "de-reality", address: "de.example.test", port: 443, kind: "vless-reality", enabled: true, public_key: "de-key", short_id: "de-id" },
    { id: "de-ws", address: "de.example.test", port: 443, kind: "vless-ws", enabled: true, query: { type: "ws", path: "/de", host: "de.example.test" } },
    { id: "us-reality", address: "us.example.test", port: 443, kind: "vless-reality", enabled: true, public_key: "us-key", short_id: "us-id" },
    { id: "us-hup", address: "us.example.test", port: 443, kind: "vless-httpupgrade", enabled: true, query: { type: "httpupgrade", path: "/us", host: "us.example.test" } },
    { id: "us-xhttp", address: "us.example.test", port: 443, kind: "vless-xhttp", enabled: true, query: { type: "xhttp", path: "/us-xhttp" } },
    { id: "de-grpc", address: "de.example.test", port: 443, kind: "vless-grpc", enabled: true, query: { type: "grpc", serviceName: "de" } },
    { id: "us-disabled", address: "us.example.test", port: 443, kind: "vless-reality", enabled: false },
  ],
  server_configs: { "regional-relays": { relay_uuid: "relay-uuid" } },
  happ: { provider_code: "IDdS75kg", auth_key: "", base_url: "https://happ-proxy.com" },
  vps: { host: "", port: 22, username: "root", password: "", private_key: "", passphrase: "", label: "VPS" },
  vps_list: [],
};

const endpoints: Endpoint[] = secure.nodes.map((node, sort_order) => ({
  id: node.id,
  label: node.id,
  kind: node.kind,
  address: node.address,
  port: node.port,
  profile_id: node.id,
  enabled: node.enabled,
  sort_order,
  config: {
    public_key: node.public_key,
    short_id: node.short_id,
    flow: node.flow,
    sni: node.sni,
    fingerprint: node.fingerprint,
    query: node.query,
  },
}));

test("server44 config exposes non-conflicting regional lanes from enabled database endpoints", () => {
  const config = server44SingBoxConfig(endpoints, secure);
  const inbounds = config.inbounds as Array<Record<string, unknown>>;
  assert.deepEqual(
    inbounds.map(({ tag, type, listen_port }) => ({ tag, type, listen_port })),
    [
      { tag: "in-http-us", type: "http", listen_port: 3127 },
      { tag: "in-socks-us", type: "socks", listen_port: 1080 },
      { tag: "in-http-de", type: "http", listen_port: 3128 },
      { tag: "in-socks-de", type: "socks", listen_port: 1081 },
      { tag: "in-http-smart", type: "http", listen_port: 3129 },
    ],
  );

  const outbounds = config.outbounds as Array<Record<string, unknown>>;
  assert.equal(outbounds.some(({ tag }) => tag === "us-xhttp" || tag === "de-grpc"), false);
  assert.deepEqual(outbounds.find(({ tag }) => tag === "de-regional"), {
    type: "urltest", tag: "de-regional", outbounds: ["de-reality", "de-ws"],
    url: "https://www.gstatic.com/generate_204", interval: "10s",
  });
  assert.deepEqual(outbounds.find(({ tag }) => tag === "us-regional"), {
    type: "urltest", tag: "us-regional", outbounds: ["us-reality", "us-hup"],
    url: "https://www.gstatic.com/generate_204", interval: "10s",
  });

  const rules = (config.route as { rules: Array<Record<string, unknown>> }).rules;
  assert.deepEqual(rules[0], { inbound: ["in-socks-us", "in-socks-de"], action: "sniff" });
  assert.ok(rules.some((rule) => rule.inbound?.includes("in-http-us") && rule.outbound === "us-regional"));
  assert.ok(rules.some((rule) => rule.inbound?.includes("in-socks-de") && rule.outbound === "de-regional"));
  assert.ok(rules.some((rule) => rule.ip_is_private === true && rule.outbound === "direct"));
  assert.ok(rules.some((rule) => rule.domain_suffix?.includes("telegram.org") && rule.outbound === "de-regional"));
  assert.ok(rules.some((rule) => rule.inbound?.includes("in-http-smart") && rule.outbound === "de-regional"));
});

test("server44 config rejects a region without a compatible enabled endpoint", () => {
  assert.throws(
    () => server44SingBoxConfig(endpoints.filter((endpoint) => !endpoint.id.startsWith("us-")), secure),
    /server-44 us regional selector has no compatible enabled endpoint/,
  );
});

import assert from "node:assert/strict";
import test from "node:test";
import {
  LAN_PROXY_LANES,
  assertSharedLanPorts,
  activeEndpointsForLane,
  testMatrixMetadata,
} from "../src/lan-proxy-contract.js";
import type { SecureConfig } from "../src/secure-config.js";

const secure: SecureConfig = {
  defaults: {
    fingerprint: "firefox",
    flow: "xtls-rprx-vision",
    sni: "ya.ru",
    domain_strategy: "IPIfNonMatch",
  },
  nodes: [
    { id: "de-direct", address: "de.example.test", port: 443, kind: "vless-reality", enabled: true },
    { id: "de-disabled", address: "de.example.test", port: 443, kind: "vless-xhttp", enabled: false },
    { id: "us-xhttp", address: "us.example.test", port: 443, kind: "vless-xhttp", enabled: true },
    { id: "us-disabled", address: "us.example.test", port: 443, kind: "vless-xhttp", enabled: false },
    { id: "unrelated", address: "other.example.test", port: 443, kind: "vless-reality", enabled: true },
  ],
  server_configs: {},
  happ: { provider_code: "IDdS75kg", auth_key: "", base_url: "https://happ-proxy.com" },
  vps: { host: "", port: 22, username: "root", password: "", private_key: "", passphrase: "", label: "VPS" },
  vps_list: [],
};

test("LAN proxy contract shares regional ports, filters disabled nodes, and separates access from wire metadata", () => {
  const laneById = new Map(LAN_PROXY_LANES.map((lane) => [lane.id, lane]));

  assert.equal(laneById.get("us-http")?.port, 3127);
  assert.equal(laneById.get("de-http")?.port, 3128);
  assert.equal(laneById.get("us-socks")?.port, 1080);
  assert.equal(laneById.get("de-socks")?.port, 1081);

  assert.deepEqual(activeEndpointsForLane(secure, laneById.get("de-http")!), [secure.nodes[0]]);
  assert.deepEqual(activeEndpointsForLane(secure, laneById.get("us-http")!), [secure.nodes[2]]);

  assert.deepEqual(testMatrixMetadata("server-44", laneById.get("us-http")!), {
    hostRole: "server-44",
    client: "sing-box",
    accessMethod: "http-proxy",
    wireMethod: "wire-internal",
    networkClass: "lan",
  });
  assert.deepEqual(testMatrixMetadata("server-88", laneById.get("de-socks")!), {
    hostRole: "server-88",
    client: "xray",
    accessMethod: "socks-proxy",
    wireMethod: "wire-internal",
    networkClass: "lan",
  });
});

test("LAN proxy contract fails explicitly when a regional pool is disabled", () => {
  const deLane = LAN_PROXY_LANES.find((lane) => lane.id === "de-http")!;
  const disabled = structuredClone(secure);
  disabled.nodes = disabled.nodes.map((node) => node.id === "de-direct" ? { ...node, enabled: false } : node);
  assert.throws(() => activeEndpointsForLane(disabled, deLane), /no enabled compatible endpoints/);
});

test("LAN proxy contract validates generated host port coverage", () => {
  assertSharedLanPorts([
    { port: 3127 },
    { port: 3128 },
    { port: 1080 },
    { port: 1081 },
  ]);
  assert.throws(() => assertSharedLanPorts([{ port: 3127 }, { port: 3128 }, { port: 1080 }]), /de-socks port 1081/);
});

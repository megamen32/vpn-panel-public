import test from "node:test";
import assert from "node:assert/strict";
import type { SecureConfig } from "../src/secure-config.js";
import {
  deServerConfig,
  regionalRelayServerConfig,
  ruFullServerConfig,
  serverConfig,
  usServerConfig,
} from "../src/xray-configs.js";
import type { DbPool } from "../src/db.js";

const mockPool = { query: async () => ({ rows: [] }) } as unknown as DbPool;

const secureWithNodes: SecureConfig = {
  defaults: {
    fingerprint: "chrome",
    flow: "xtls-rprx-vision",
    sni: "ya.ru",
    domain_strategy: "IPIfNonMatch",
  },
  nodes: [
    { id: "de-xhttp", address: "vpn2.bezrabotnyi.com", port: 443, enabled: true, query: { path: "/xhttp" } },
    { id: "de-cdn", address: "cdn.demiurge.space", port: 443, enabled: true, query: { path: "/cdn-ws" } },
    { id: "de-cdn2", address: "cdn2.demiurge.space", port: 443, enabled: true, query: { path: "/cdn2-ws" } },
    { id: "de-grpc", address: "vpn2.bezrabotnyi.com", port: 443, enabled: true, query: { serviceName: "/grpc" } },
    { id: "de-httpupgrade", address: "vpn2.bezrabotnyi.com", port: 443, enabled: true, query: { path: "/hup" } },
    { id: "de-direct-ws", address: "vpn2.bezrabotnyi.com", port: 443, enabled: true, query: { path: "/direct-ws" } },
    { id: "de-xhttp-h2", address: "vpn2.bezrabotnyi.com", port: 28443, enabled: true, query: { path: "/xhttp-h2" } },
    { id: "us-reality", address: "vusa.bezrabotnyi.com", port: 443, enabled: true, public_key: "us-public", short_id: "us-sid", sni: "www.google.com" },
    { id: "us-httpupgrade", address: "vusa.bezrabotnyi.com", port: 443, enabled: true, query: { path: "/hup" } },
    { id: "us-direct-ws", address: "vusa.bezrabotnyi.com", port: 443, enabled: true, query: { path: "/direct-ws" } },
    { id: "us-grpc", address: "vusa.bezrabotnyi.com", port: 443, enabled: true, query: { serviceName: "/grpc" } },
    { id: "us-cdn", address: "us-cdn.demiurge.space", port: 443, enabled: true, query: { path: "/cdn-ws" } },
    { id: "us-cdn2", address: "us-cdn2.demiurge.space", port: 443, enabled: true, query: { path: "/cdn2-ws" } },
    { id: "us-xhttp", address: "vusa.bezrabotnyi.com", port: 443, enabled: true, query: { path: "/xhttp" } },
    { id: "us-xhttp-h2-443", address: "vusa.bezrabotnyi.com", port: 443, enabled: true, query: { path: "/xhttp-h2-443", mode: "stream-up", h2: "true", alpn: "h2" } },
    { id: "us-xhttp-h2", address: "vusa.bezrabotnyi.com", port: 28443, enabled: true, query: { path: "/xhttp-h2" } },
  ],
  server_configs: {
    de: {
      listen_port: 23443,
      private_key: "de-private",
      server_names: ["ya.ru"],
      short_ids: ["de-sid"],
      dest: "127.0.0.1:8443",
      xver: 0,
    },
    us: {
      listen_port: 23443,
      private_key: "us-private",
      server_names: ["www.google.com"],
      short_ids: ["us-sid"],
      dest: "www.google.com:443",
      xver: 0,
    },
    ru: {
      relay_uuid: "11111111-1111-1111-1111-111111111111",
      fi_relay_uuid: "22222222-2222-2222-2222-222222222222",
      fi_address: "31.76.43.193",
      fi_public_key: "fi-public-key",
      fi_short_id: "fi-short-id",
      fi_sni: "www.google.com",
    },
  },
};

test("deServerConfig generates Reality inbound", async () => {
  const config = await deServerConfig(mockPool, secureWithNodes);
  const inbounds = config.inbounds as Array<Record<string, unknown>>;

  const reality = inbounds.find((i) => i.tag === "de-reality");
  assert.ok(reality, "de-reality inbound must exist");
  assert.equal(reality.port, 23443);
  assert.equal(reality.protocol, "vless");

  const streamSettings = reality.streamSettings as Record<string, unknown>;
  assert.equal(streamSettings.network, "tcp");
  assert.equal(streamSettings.security, "reality");
});

test("deServerConfig generates path inbounds for enabled nodes", async () => {
  const config = await deServerConfig(mockPool, secureWithNodes);
  const inbounds = config.inbounds as Array<Record<string, unknown>>;

  const tags = inbounds.map((i) => i.tag);
  assert.ok(tags.includes("de-xhttp"), "de-xhttp inbound must exist");
  assert.ok(tags.includes("de-cdn"), "de-cdn inbound must exist");
  assert.ok(tags.includes("de-cdn2"), "de-cdn2 inbound must exist");
  assert.ok(tags.includes("de-grpc"), "de-grpc inbound must exist");
  assert.ok(tags.includes("de-httpupgrade"), "de-httpupgrade inbound must exist");
  assert.ok(tags.includes("de-direct-ws"), "de-direct-ws inbound must exist");
  assert.ok(tags.includes("de-xhttp-h2"), "de-xhttp-h2 inbound must exist");
  assert.ok(tags.includes("api"), "api inbound must exist");
});

test("deServerConfig includes API and stats config", async () => {
  const config = await deServerConfig(mockPool, secureWithNodes);

  assert.ok(config.api, "api config must exist");
  assert.ok(config.stats, "stats config must exist");
  assert.ok(config.policy, "policy config must exist");
  assert.ok(config.routing, "routing config must exist");

  const routing = config.routing as Record<string, unknown>;
  const rules = routing.rules as Array<Record<string, unknown>>;
  assert.ok(rules.some((r) => r.inboundTag?.includes("api")), "routing must have api rule");
});

test("usServerConfig mirrors the proven VPN2 public-443 transports plus the high-port fallback", async () => {
  const config = await usServerConfig(mockPool, {
    ...secureWithNodes,
    nodes: secureWithNodes.nodes.filter((node) => ["us-reality", "us-xhttp", "us-xhttp-h2-443", "us-httpupgrade", "us-direct-ws", "us-grpc", "us-cdn", "us-cdn2", "us-xhttp-h2"].includes(node.id)),
  });
  const inbounds = config.inbounds as Array<Record<string, unknown>>;
  assert.deepEqual(inbounds.map((inbound) => inbound.tag), ["us-reality", "us-xhttp", "us-xhttp-h2-443", "us-cdn", "us-grpc", "us-httpupgrade", "us-cdn2", "us-direct-ws", "us-xhttp-h2", "api"]);

  const reality = inbounds.find((inbound) => inbound.tag === "us-reality");
  assert.equal(reality?.listen, "127.0.0.1", "nginx SNI routing must be the only public :443 listener");
  assert.equal(reality?.port, 23443);
  assert.equal((reality?.streamSettings as Record<string, any>).realitySettings.xver, 0);

  const xhttp = inbounds.find((inbound) => inbound.tag === "us-xhttp");
  assert.equal(xhttp?.listen, "127.0.0.1");
  assert.equal(xhttp?.port, 20080);
  const xhttpStream = xhttp?.streamSettings as Record<string, any>;
  assert.equal(xhttpStream.xhttpSettings.mode, "auto");
  assert.equal(xhttpStream.xhttpSettings.h2, false);

  const xhttpH2On443 = inbounds.find((inbound) => inbound.tag === "us-xhttp-h2-443");
  assert.equal(xhttpH2On443?.listen, "127.0.0.1");
  assert.equal(xhttpH2On443?.port, 20087);
  const xhttpH2On443Stream = xhttpH2On443?.streamSettings as Record<string, any>;
  assert.equal(xhttpH2On443Stream.security, "none", "nginx must terminate public TLS/H2");
  assert.equal(xhttpH2On443Stream.xhttpSettings.mode, "stream-up", "nginx preserves XHTTP stream-up over grpc_pass");
  assert.equal("h2" in xhttpH2On443Stream.xhttpSettings, false, "the grpc_pass loopback hop must not force an Xray HTTP version");

  const ws = inbounds.find((inbound) => inbound.tag === "us-direct-ws");
  assert.equal(ws?.listen, "127.0.0.1");
  assert.equal(ws?.port, 20085);

  const h2 = inbounds.find((inbound) => inbound.tag === "us-xhttp-h2");
  assert.equal(h2?.port, 28443);
  const streamSettings = h2?.streamSettings as Record<string, unknown>;
  assert.deepEqual(
    streamSettings.sockopt,
    { trustedXForwardedFor: ["\u0000"] },
    "the direct public listener must never trust client-supplied X-Forwarded-For",
  );
});

test("usServerConfig never exposes public auth-proxy inbounds", async () => {
  const config = await usServerConfig(mockPool, {
    ...secureWithNodes,
    nodes: secureWithNodes.nodes.filter((node) => node.id === "us-xhttp-h2"),
    server_configs: {
      ...secureWithNodes.server_configs,
      us: { ...secureWithNodes.server_configs.us, auth_proxy_enabled: true },
    },
  });
  const inbounds = config.inbounds as Array<Record<string, unknown>>;

  assert.ok(!inbounds.some((inbound) => inbound.tag === "auth-http"));
  assert.ok(!inbounds.some((inbound) => inbound.tag === "auth-socks"));
});

test("ruFullServerConfig generates full relay config", async () => {
  const config = await ruFullServerConfig(mockPool, secureWithNodes);

  assert.ok(config.inbounds, "inbounds must exist");
  assert.ok(config.outbounds, "outbounds must exist");
  assert.ok(config.routing, "routing must exist");
  assert.ok(config.observatory, "observatory must exist");

  const inbounds = config.inbounds as Array<Record<string, unknown>>;
  assert.equal(inbounds.length, 1, "ru-full must have 1 inbound");
  assert.equal(inbounds[0].tag, "ru-full-relay");

  const routing = config.routing as Record<string, unknown>;
  const balancers = routing.balancers as Array<Record<string, unknown>>;
  assert.ok(balancers.some((b) => b.tag === "de-auto"), "deprecated RU full relay must remain pinned to DE");
  assert.ok(!balancers.some((b) => b.tag === "world-auto"), "legacy relay must not spill over between countries");
});

test("regionalRelayServerConfig exposes country-pinned DE/US profiles and the Helsinki exit", async () => {
  const config = await regionalRelayServerConfig(mockPool, secureWithNodes);
  const inbounds = config.inbounds as Array<{ tag: string; port: number }>;
  assert.deepEqual(
    inbounds.map(({ tag, port }) => ({ tag, port })),
    [
      { tag: "full-de-relay", port: 23444 },
      { tag: "smart-de-relay", port: 23445 },
      { tag: "full-us-relay", port: 23446 },
      { tag: "smart-us-relay", port: 23447 },
      { tag: "fi-helsinki-relay", port: 23448 },
    ],
  );

  const routing = config.routing as {
    balancers: Array<{ tag: string; selector: string[] }>;
    rules: Array<{ inboundTag: string[]; outboundTag?: string; balancerTag?: string }>;
  };
  const deBalancer = routing.balancers.find((balancer) => balancer.tag === "de-auto");
  const usBalancer = routing.balancers.find((balancer) => balancer.tag === "us-auto");
  assert.ok(deBalancer, "DE relay profiles must have a DE-only balancer");
  assert.ok(usBalancer, "US relay profiles must have a US-only balancer");
  assert.ok(deBalancer.selector.every((tag) => tag.startsWith("to-de-")));
  assert.ok(usBalancer.selector.every((tag) => tag.startsWith("to-us-")));
  assert.deepEqual(
    usBalancer.selector,
    ["to-us-cdn2"],
    "US relay must select only transports proven stable by the health matrix",
  );
  assert.ok(deBalancer.selector.some((tag) => tag.startsWith("to-de-reality-")));
  assert.ok(!deBalancer.selector.some((tag) => tag.includes("grpc") || tag.includes("xhttp")));
  assert.ok(!routing.balancers.some((balancer) => balancer.tag === "world-auto"));
  assert.equal(deBalancer.fallbackTag, "to-de-httpupgrade");
  assert.equal(usBalancer.fallbackTag, "to-us-cdn2", "cold LAN selection must use the proven stable transport");

  const finalRule = (tag: string) => routing.rules.find(
    (rule) => rule.inboundTag?.includes(tag) && rule.balancerTag,
  );
  assert.equal(finalRule("full-de-relay")?.balancerTag, "de-auto");
  assert.equal(finalRule("smart-de-relay")?.balancerTag, "de-auto");
  assert.equal(finalRule("full-us-relay")?.balancerTag, "us-auto");
  assert.equal(finalRule("smart-us-relay")?.balancerTag, "us-auto");
  assert.equal(
    routing.rules.find((rule) => rule.inboundTag?.includes("fi-helsinki-relay") && rule.network === "tcp,udp")?.outboundTag,
    "to-fi-reality",
    "a single Helsinki exit must not depend on leastPing selection",
  );

  for (const smartTag of ["smart-de-relay", "smart-us-relay"]) {
    assert.ok(routing.rules.some(
      (rule) => rule.inboundTag?.includes(smartTag) && rule.outboundTag === "direct-ru",
    ));
  }
  for (const fullTag of ["full-de-relay", "full-us-relay", "fi-helsinki-relay"]) {
    assert.ok(!routing.rules.some(
      (rule) => rule.inboundTag?.includes(fullTag) && rule.outboundTag === "direct-ru",
    ));
  }
});

test("regional relay keeps DE Reality and the stable US CDN2 route on public 443", async () => {
  const config = await regionalRelayServerConfig(mockPool, secureWithNodes);
  const outbounds = config.outbounds as Array<Record<string, any>>;
  const deReality = outbounds.find((outbound) => String(outbound.tag).startsWith("to-de-reality-"));
  assert.equal(deReality?.settings.vnext[0].port, 443);
  assert.equal(outbounds.find((outbound) => outbound.tag === "to-us-cdn2")?.settings.vnext[0].port, 443);
  const fiReality = outbounds.find((outbound) => outbound.tag === "to-fi-reality");
  assert.equal(fiReality?.settings.vnext[0].address, "31.76.43.193");
  assert.equal(fiReality?.streamSettings.realitySettings.publicKey, "fi-public-key");
});

test("regional relay pins the canonical VPN2 dial IP without changing TLS routing names", async () => {
  const config = await regionalRelayServerConfig(mockPool, secureWithNodes);
  const outbounds = config.outbounds as Array<Record<string, any>>;
  const deOutbounds = outbounds.filter((outbound) => String(outbound.tag).startsWith("to-de-"));

  assert.ok(deOutbounds.length > 0);
  assert.ok(deOutbounds.every((outbound) => outbound.settings.vnext[0].address === "212.192.31.128"));

  const ws = deOutbounds.find((outbound) => outbound.tag === "to-de-ws");
  assert.equal(ws?.streamSettings.tlsSettings.serverName, "vpn2.bezrabotnyi.com");
  assert.equal(ws?.streamSettings.wsSettings.host, "vpn2.bezrabotnyi.com");

  const httpUpgrade = deOutbounds.find((outbound) => outbound.tag === "to-de-httpupgrade");
  assert.equal(httpUpgrade?.streamSettings.tlsSettings.serverName, "vpn2.bezrabotnyi.com");
  assert.equal(httpUpgrade?.streamSettings.httpupgradeSettings.host, "vpn2.bezrabotnyi.com");
});

test("serverConfig dispatcher routes to correct functions", async () => {
  const deConfig = await serverConfig(mockPool, secureWithNodes, "de");
  assert.ok(deConfig.inbounds, "de config must have inbounds");

  const ruConfig = await serverConfig(mockPool, secureWithNodes, "ru");
  assert.ok(ruConfig.inbounds, "ru config must have inbounds");

  const ruCombinedConfig = await serverConfig(mockPool, secureWithNodes, "ru-combined");
  assert.ok(ruCombinedConfig.inbounds, "ru-combined config must have inbounds");

  const ruFullConfig = await serverConfig(mockPool, secureWithNodes, "ru-full");
  assert.ok(ruFullConfig.inbounds, "ru-full config must have inbounds");

  const regionalConfig = await serverConfig(mockPool, secureWithNodes, "regional-relays");
  assert.equal((regionalConfig.inbounds as unknown[]).length, 5, "regional-relays config must include the Helsinki inbound");

  const usConfig = await serverConfig(mockPool, secureWithNodes, "us");
  assert.ok(usConfig.inbounds, "us config must have inbounds");
});

test("serverConfig throws on unknown serverId", async () => {
  await assert.rejects(
    async () => serverConfig(mockPool, secureWithNodes, "unknown"),
    /unknown server config: unknown/
  );
});

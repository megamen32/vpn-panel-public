import assert from "node:assert/strict";
import test from "node:test";
import { withRegionalUsLane, withServiceCatalogLanRules, withStableDeLane, withVusaSmartEdgeLanes } from "../src/lan-us-config.js";
import type { ServiceRoutingProjection } from "../src/service-catalog-activation.js";

function serviceProjection(domains: ServiceRoutingProjection["domains"]): ServiceRoutingProjection {
  return { schemaVersion: 1, sourceCatalogRevision: "revision-1", activePublicDnsEdgeId: null, domains };
}

function lanBase() {
  return {
    outbounds: [{ tag: "direct", protocol: "freedom" }],
    routing: {
      balancers: [
        { tag: "proxy", selector: ["de-cdn"] },
        { tag: "us-auto", selector: ["to-us-cdn"] },
        { tag: "catalog-vpn2", selector: ["de-cdn"] },
        { tag: "catalog-alpha", selector: ["de-cdn"] },
        { tag: "catalog-beta", selector: ["de-cdn"] },
      ],
      rules: [
        { type: "field", inboundTag: ["in-lan-smart-http", "in-lan-smart-tls"], balancerTag: "proxy" },
        { type: "field", inboundTag: ["other"], outboundTag: "direct" },
      ],
    },
    observatory: { subjectSelector: [] },
  };
}

test("withStableDeLane avoids the failing WebSocket/CDN transports", () => {
  const base = {
    outbounds: [{ tag: "de-xhttp", protocol: "vless" }, { tag: "de-xhttp-h2", protocol: "vless" }, { tag: "de-direct-ws", protocol: "vless" }],
    routing: {
      balancers: [{ tag: "proxy", selector: ["de-httpupgrade"], strategy: { type: "leastPing" } }],
      rules: [{ type: "field", inboundTag: ["in-http-us"], outboundTag: "direct" }],
    },
    observatory: { subjectSelector: ["de-httpupgrade"], probeUrl: "https://example.test", probeInterval: "30s" },
  };

  const generated = withStableDeLane(base);
  assert.deepEqual(generated.routing.balancers[0], {
    tag: "proxy",
    selector: ["de-xhttp", "de-xhttp-h2"],
    fallbackTag: "de-xhttp-h2",
    strategy: { type: "leastPing" },
  });
  assert.deepEqual(generated.observatory.subjectSelector, ["de-xhttp", "de-xhttp-h2"]);
  assert.equal(generated.observatory.probeInterval, "10s");
});

test("withRegionalUsLane keeps several DB-proven VUSA routes for LAN :3127", () => {
  const base = {
    outbounds: [
      { tag: "direct", protocol: "freedom" },
      { tag: "us-xhttp-h2", protocol: "vless", settings: { legacy: true } },
    ],
    routing: {
      balancers: [{ tag: "proxy", selector: ["de-one"], strategy: { type: "leastPing" } }],
      rules: [
        { type: "field", inboundTag: ["in-http-us"], outboundTag: "us-xhttp-h2" },
        { type: "field", inboundTag: ["other"], outboundTag: "direct" },
      ],
    },
    observatory: { subjectSelector: ["de-one"], probeUrl: "https://example.test", probeInterval: "30s" },
  };
  const tags = [
    "to-us-reality",
    "to-us-xhttp",
    "to-us-xhttp-h2-443",
    "to-us-httpupgrade",
    "to-us-ws",
    "to-us-grpc",
    "to-us-cdn",
    "to-us-cdn2",
    "to-us-xhttp-h2",
  ];
  const regional = {
    outbounds: tags.map((tag) => ({ tag, protocol: "vless", settings: { source: tag } })),
    routing: {
      balancers: [{ tag: "us-auto", selector: tags, fallbackTag: "to-us-reality", strategy: { type: "leastPing" } }],
    },
    observatory: { subjectSelector: tags, probeUrl: "https://www.gstatic.com/generate_204", probeInterval: "30s" },
  };

  const generated = withRegionalUsLane(base, regional);
  assert.deepEqual(
    generated.outbounds.filter((outbound) => outbound.tag.startsWith("to-us-")).map((outbound) => outbound.tag),
    tags,
  );
  assert.ok(!generated.outbounds.some((outbound) => outbound.tag === "us-xhttp-h2"));
  assert.deepEqual(
    generated.routing.balancers.find((balancer) => balancer.tag === "us-auto")?.selector,
    ["to-us-reality", "to-us-cdn", "to-us-cdn2", "to-us-xhttp-h2"],
  );
  assert.equal(generated.routing.balancers.find((balancer) => balancer.tag === "us-auto")?.fallbackTag, "to-us-xhttp-h2");
  assert.deepEqual(
    generated.routing.rules.find((rule) => rule.inboundTag?.includes("in-http-us")),
    { type: "field", inboundTag: ["in-http-us"], network: "tcp,udp", balancerTag: "us-auto" },
  );
  assert.deepEqual(generated.observatory.subjectSelector, ["de-one", "to-us-reality", "to-us-cdn", "to-us-cdn2", "to-us-xhttp-h2"]);
  assert.equal(generated.observatory.probeInterval, "10s");
});

test("LAN pools can be narrowed by the enabled endpoint catalog", () => {
  const base = {
    outbounds: [
      { tag: "de-xhttp", protocol: "vless" },
      { tag: "de-xhttp-h2", protocol: "vless" },
      { tag: "de-direct-ws", protocol: "vless" },
    ],
    routing: {
      balancers: [{ tag: "proxy", selector: ["de-xhttp", "de-xhttp-h2", "de-direct-ws"] }],
      rules: [{ type: "field", inboundTag: ["in-http-us"], outboundTag: "direct" }],
    },
    observatory: { subjectSelector: ["de-xhttp", "de-xhttp-h2", "de-direct-ws"] },
  };
  const regional = {
    outbounds: [
      { tag: "to-us-reality", protocol: "vless" },
      { tag: "to-us-cdn", protocol: "vless" },
      { tag: "to-us-cdn2", protocol: "vless" },
      { tag: "to-us-xhttp-h2", protocol: "vless" },
    ],
    routing: { balancers: [{ tag: "us-auto", selector: ["to-us-reality", "to-us-cdn", "to-us-cdn2", "to-us-xhttp-h2"] }] },
    observatory: { subjectSelector: ["to-us-reality", "to-us-cdn", "to-us-cdn2", "to-us-xhttp-h2"], probeUrl: "https://example.test" },
  };
  const enabled = new Set(["de-xhttp-h2", "us-cdn"]);
  const generated = withRegionalUsLane(withStableDeLane(base, enabled), regional, enabled);
  assert.deepEqual(generated.routing.balancers.find((item) => item.tag === "proxy")?.selector, ["de-xhttp-h2"]);
  assert.deepEqual(generated.routing.balancers.find((item) => item.tag === "us-auto")?.selector, ["to-us-cdn"]);
  assert.equal(generated.routing.balancers.find((item) => item.tag === "us-auto")?.fallbackTag, "to-us-cdn");
});

test("VUSA-only LAN SNI traffic is matched before the DE smart-edge rule", () => {
  const config = {
    outbounds: [],
    routing: {
      balancers: [
        { tag: "proxy", selector: ["de-cdn"] },
        { tag: "us-auto", selector: ["to-us-reality"] },
      ],
      rules: [
        { type: "field", inboundTag: ["in-lan-smart-http", "in-lan-smart-tls"], balancerTag: "proxy" },
      ],
    },
    observatory: { subjectSelector: [] },
  };

  const generated = withVusaSmartEdgeLanes(config);
  assert.deepEqual(generated.routing.rules[0], {
    type: "field",
    inboundTag: ["in-lan-smart-http", "in-lan-smart-tls"],
    domain: ["domain:antigravity.google", "domain:gweb-jetski.appspot.com"],
    balancerTag: "us-auto",
  });
  assert.ok(!generated.routing.rules[0]?.domain?.some((domain) => domain.includes("github")));
  assert.equal(generated.routing.rules[1]?.balancerTag, "proxy");
});

test("service catalog suffix LAN proxy targets its balancer before generic Smart Edge", () => {
  const base = lanBase();
  const projection = serviceProjection([{
    serviceId: "chat",
    match: "suffix",
    domain: "chat.example.com",
    lan: { kind: "proxy", targetId: "vpn2", balancerTag: "catalog-vpn2" },
  }]);

  const generated = withServiceCatalogLanRules(base, projection);
  assert.deepEqual(generated.routing.rules[0], {
    type: "field",
    inboundTag: ["in-lan-smart-http", "in-lan-smart-tls"],
    domain: ["domain:chat.example.com"],
    balancerTag: "catalog-vpn2",
    comment: "vpn-panel:service-catalog-lan",
  });
  assert.equal(generated.routing.rules[1]?.balancerTag, "proxy");
});

test("service catalog exact LAN proxy is rejected defensively", () => {
  const projection = serviceProjection([{
    serviceId: "chat",
    match: "exact",
    domain: "chat.example.com",
    lan: { kind: "proxy", targetId: "vpn2", balancerTag: "catalog-vpn2" },
  }]);
  assert.throws(() => withServiceCatalogLanRules(lanBase(), projection), /unsupported exact LAN proxy rule/);
});

test("service catalog LAN proxy requires an existing balancer", () => {
  const projection = serviceProjection([{
    serviceId: "chat",
    match: "suffix",
    domain: "chat.example.com",
    lan: { kind: "proxy", targetId: "vpn2", balancerTag: "missing" },
  }]);
  assert.throws(() => withServiceCatalogLanRules(lanBase(), projection), /missing.*balancer/);
});

test("service catalog direct and external-only entries emit no LAN rule", () => {
  const base = lanBase();
  const projection = serviceProjection([
    { serviceId: "direct", match: "suffix", domain: "direct.example.com", lan: { kind: "direct" } },
    { serviceId: "external", match: "suffix", domain: "external.example.com", external: { kind: "proxy", targetId: "vpn2" } },
  ]);
  const generated = withServiceCatalogLanRules(base, projection);
  assert.equal(generated.routing.rules.some((rule) => rule.domain?.includes("domain:direct.example.com")), false);
  assert.equal(generated.routing.rules.some((rule) => rule.domain?.includes("domain:external.example.com")), false);
});

test("service catalog LAN rules sort by suffix specificity and service ID", () => {
  const projection = serviceProjection([
    { serviceId: "zeta", match: "suffix", domain: "example.com", lan: { kind: "proxy", targetId: "vpn2", balancerTag: "catalog-vpn2" } },
    { serviceId: "beta", match: "suffix", domain: "long.example.com", lan: { kind: "proxy", targetId: "vpn2", balancerTag: "catalog-beta" } },
    { serviceId: "alpha", match: "suffix", domain: "long.example.com", lan: { kind: "proxy", targetId: "vpn2", balancerTag: "catalog-alpha" } },
  ]);
  const generated = withServiceCatalogLanRules(lanBase(), projection);
  assert.deepEqual(generated.routing.rules.slice(0, 3).map((rule) => rule.domain), [
    ["domain:long.example.com"],
    ["domain:long.example.com"],
    ["domain:example.com"],
  ]);
  assert.equal(generated.routing.rules[0]?.balancerTag, "catalog-alpha");
  assert.equal(generated.routing.rules[1]?.balancerTag, "catalog-beta");
});

test("service catalog LAN adapter is idempotent and preserves hard-coded VUSA rules", () => {
  const base = lanBase();
  base.routing.rules.splice(0, 0, {
    type: "field",
    inboundTag: ["in-lan-smart-http", "in-lan-smart-tls"],
    domain: ["domain:legacy-vusa.example.com"],
    balancerTag: "us-auto",
  });
  const projection = serviceProjection([{
    serviceId: "chat",
    match: "suffix",
    domain: "chat.example.com",
    lan: { kind: "proxy", targetId: "vpn2", balancerTag: "catalog-vpn2" },
  }]);
  const once = withServiceCatalogLanRules(base, projection);
  const twice = withServiceCatalogLanRules(once, projection);
  assert.deepEqual(twice, once);
  assert.equal(twice.routing.rules.some((rule) => rule.domain?.includes("domain:legacy-vusa.example.com")), true);
  assert.notEqual(twice, base);
  assert.equal(base.routing.rules.some((rule) => rule.domain?.includes("domain:chat.example.com")), false);
});

test("service catalog LAN adapter rejects null routes", () => {
  const projection = serviceProjection([{
    serviceId: "broken",
    match: "suffix",
    domain: "broken.example.com",
    lan: null as never,
  }]);
  assert.throws(() => withServiceCatalogLanRules(lanBase(), projection), /null route/);
});

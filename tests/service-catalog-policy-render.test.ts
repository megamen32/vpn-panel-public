import assert from "node:assert/strict";
import test from "node:test";

import type { ServiceRoutingProjection } from "../src/service-catalog-activation.js";
import { renderCatalogSmartDnsPolicy } from "../src/service-catalog-policy-render.js";
import { DEFAULT_SMART_DNS_POLICY } from "../src/smart-dns-policy.js";

function projection(domains: ServiceRoutingProjection["domains"]): ServiceRoutingProjection { return { schemaVersion: 1, sourceCatalogRevision: "test", activePublicDnsEdgeId: "vpn2", domains }; }
function domain(value: string, routes: Pick<ServiceRoutingProjection["domains"][number], "lan" | "external">): ServiceRoutingProjection["domains"][number] { return { serviceId: value, domain: value, match: "suffix", ...routes }; }

test("catalog compiles a projection into managed unified rows without touching admins", () => {
  const base = { ...DEFAULT_SMART_DNS_POLICY, rules: [{ id: "admin", text: "admin.example", match: "suffix" as const, through: ["direct"] as const, conditions: ["vpn"] as const }, ...DEFAULT_SMART_DNS_POLICY.rules] };
  const rendered = renderCatalogSmartDnsPolicy(base, null, projection([
    domain("lan.example", { lan: { kind: "proxy", targetId: "vpn2", balancerTag: "lan" } }),
    domain("us.example", { lan: { kind: "proxy", targetId: "vusa", balancerTag: "lan" }, external: { kind: "proxy", targetId: "vusa", profileId: "vusa" } }),
  ]));
  assert.deepEqual(rendered.rules.find((rule) => rule.id === "admin")?.through, ["direct"]);
  assert.deepEqual(rendered.rules.find((rule) => rule.id.includes("lan.example"))?.conditions, ["internalDns", "vpn"]);
  assert.deepEqual(rendered.rules.find((rule) => rule.id.includes("us.example"))?.through, ["vusa"]);
});

test("catalog replacement removes retired managed rows", () => {
  const previous = projection([domain("old.example", { external: { kind: "direct" } })]);
  const active = renderCatalogSmartDnsPolicy(DEFAULT_SMART_DNS_POLICY, null, previous);
  const retired = renderCatalogSmartDnsPolicy(active, previous, projection([]));
  assert.equal(retired.rules.some((rule) => rule.id.includes("old.example")), false);
});

test("catalog rejects impossible split proxy projection", () => {
  assert.throws(() => renderCatalogSmartDnsPolicy(DEFAULT_SMART_DNS_POLICY, null, projection([
    domain("bad.example", { lan: { kind: "proxy", targetId: "vpn2", balancerTag: "lan" }, external: { kind: "proxy", targetId: "vusa", profileId: "vusa" } }),
  ])), /targets differ/);
});

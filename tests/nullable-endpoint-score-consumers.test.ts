import assert from "node:assert/strict";
import test from "node:test";
import { orderPublicSubscriptionEndpoints } from "../src/subscriptions.js";
import { testDashboardPage } from "../src/test-dashboard.js";
import type { Endpoint } from "../src/types.js";
import type { VpnTestEndpointScore } from "../src/vpn-test-telemetry.js";

const endpoints = [
  { id: "de-direct-ws", enabled: true, sort_order: 0 },
  { id: "us-cdn2", enabled: true, sort_order: 1 },
] as Endpoint[];

const unscored: VpnTestEndpointScore = {
  endpointId: "de-direct-ws",
  score: null,
  passed: 0,
  effectiveObservations: 20,
  endpointFailures: 0,
  runnerErrors: 20,
  telegramMedianMs: null,
  telegramP95Ms: null,
};

test("dashboard renders a nullable endpoint score as unknown", () => {
  const html = testDashboardPage({ endpoints: [endpoints[0]!], health: [], scores: [unscored] });

  assert.match(html, /score-value unknown/);
  assert.match(html, /Нет достоверного score/);
});

test("dashboard ranks a statistically supported endpoint above a perfect two-check sample", () => {
  const tinyPerfect = { ...unscored, endpointId: "de-direct-ws", score: 100, passed: 2, effectiveObservations: 2 };
  const measured = { ...unscored, endpointId: "us-cdn2", score: 99.6, passed: 996, effectiveObservations: 1000 };
  const html = testDashboardPage({ endpoints, health: [], scores: [tinyPerfect, measured] });
  const scorePanel = html.slice(html.indexOf('id="endpoint-scores"'));

  assert.ok(scorePanel.indexOf("us-cdn2") < scorePanel.indexOf("de-direct-ws"));
});

test("subscriptions retain an endpoint with no score instead of coercing null to zero", () => {
  const measured: VpnTestEndpointScore = { ...unscored, endpointId: "us-reality", score: 80 };
  const compactEndpoints = endpoints.map((endpoint) => ({ ...endpoint, id: endpoint.id === "us-cdn2" ? "us-reality" : "de-httpupgrade" }));

  assert.deepEqual(
    orderPublicSubscriptionEndpoints(compactEndpoints, [{ ...unscored, endpointId: "de-httpupgrade" }, measured]).map((endpoint) => endpoint.id),
    ["us-reality", "de-httpupgrade"],
  );
});

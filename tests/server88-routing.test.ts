import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const configPath = new URL("../deploy/server-88/xray/config.json", import.meta.url);
const config = JSON.parse(readFileSync(configPath, "utf8")) as {
  inbounds: Array<{ tag: string; port: number }>;
  routing: {
    balancers: Array<{ tag: string; selector: string[]; fallbackTag?: string }>;
    rules: Array<{ inboundTag?: string[]; balancerTag?: string }>;
  };
  observatory: { subjectSelector: string[]; probeInterval?: string };
};

test("server-88 LAN HTTP ports use redundant tested regional pools", () => {
  const inbounds = new Map(config.inbounds.map((inbound) => [inbound.port, inbound.tag]));
  assert.equal(inbounds.get(3127), "in-http-us");
  assert.equal(inbounds.get(3128), "in-http-all");

  const balancers = new Map(config.routing.balancers.map((balancer) => [balancer.tag, balancer]));
  const usAuto = balancers.get("us-auto");
  assert.ok(usAuto);
  assert.ok(usAuto.selector.length > 0);
  assert.equal(usAuto.fallbackTag, usAuto.selector.at(-1));
  assert.deepEqual(usAuto.strategy, { type: "leastPing" });
  assert.deepEqual(balancers.get("proxy"), {
    tag: "proxy",
    selector: ["de-xhttp", "de-xhttp-h2"],
    fallbackTag: "de-xhttp-h2",
    strategy: { type: "leastPing" },
  });

  assert.equal(config.observatory.probeInterval, "10s");
  assert.deepEqual(config.observatory.subjectSelector, [...balancers.get("proxy")!.selector, ...usAuto.selector]);

  assert.equal(
    config.routing.rules.find((rule) => rule.inboundTag?.includes("in-http-us"))?.balancerTag,
    "us-auto",
  );
  assert.equal(
    config.routing.rules.find((rule) => rule.inboundTag?.includes("in-http-all"))?.balancerTag,
    "proxy",
  );
});

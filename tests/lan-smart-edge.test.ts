import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

import { renderLanSmartEdgeConfig, renderLanSmartEdgeWithTelegramTproxy } from "../src/lan-smart-edge.js";
import { loadTelegramTransparentLaneConfig } from "../src/telegram-transparent-lane.js";

test("renders only the DNS-addressable Smart Edge listeners on the backup host", () => {
  const source = {
    log: { loglevel: "warning" },
    inbounds: [
      { tag: "in-http-all", listen: "0.0.0.0", port: 3128, protocol: "http" },
      { tag: "in-lan-smart-http", listen: "192.168.2.75", port: 80, protocol: "dokodemo-door" },
      { tag: "in-lan-smart-tls", listen: "192.168.2.75", port: 443, protocol: "dokodemo-door" },
    ],
    outbounds: [{ tag: "de-regional", protocol: "vless" }],
    routing: { rules: [] },
  };

  const result = renderLanSmartEdgeConfig(source, "192.168.2.5");

  assert.deepEqual(result.inbounds, [
    { tag: "in-lan-smart-http", listen: "192.168.2.5", port: 80, protocol: "dokodemo-door" },
    { tag: "in-lan-smart-tls", listen: "192.168.2.5", port: 443, protocol: "dokodemo-door" },
  ]);
  assert.equal((source.inbounds[1] as { listen: string }).listen, "192.168.2.75");
  assert.deepEqual(result.outbounds, source.outbounds);
  assert.deepEqual(result.routing, source.routing);
});

test("adds the existing Telegram TPROXY candidate only to the backup edge", async () => {
  const config = await loadTelegramTransparentLaneConfig();
  const result = renderLanSmartEdgeWithTelegramTproxy({
    inbounds: [
      { tag: "in-lan-smart-http", listen: "192.168.2.75", port: 80, protocol: "dokodemo-door" },
      { tag: "in-lan-smart-tls", listen: "192.168.2.75", port: 443, protocol: "dokodemo-door" },
    ],
    outbounds: [
      { tag: "direct", protocol: "freedom" },
      { tag: "de-xhttp-h2", protocol: "vless" },
    ],
    routing: { rules: [], balancers: [{ tag: "proxy" }] },
  }, "192.168.2.5", config);

  const inbound = (result.inbounds as Array<Record<string, unknown>>).find((item) => item.tag === "in-tproxy-telegram");
  assert.equal(inbound?.listen, "0.0.0.0");
  assert.equal(inbound?.port, 12555);
  assert.equal(
    (result.routing as { rules: Array<Record<string, unknown>> }).rules.find(
      (rule) => rule.comment === "vpn-panel:telegram-transparent-lane",
    )?.balancerTag,
    "proxy",
  );
});

test("rejects an incomplete source config and non-IPv4 listener", () => {
  assert.throws(() => renderLanSmartEdgeConfig({ inbounds: [] }, "192.168.2.5"), /must contain both/);
  assert.throws(() => renderLanSmartEdgeConfig({ inbounds: [] }, "backup.local"), /IPv4/);
});

test("server-44 deploy keeps the Telegram TPROXY policy coupled to the edge", async () => {
  const script = await readFile(new URL("../scripts/deploy-server44-lan-smart-edge.sh", import.meta.url), "utf8");

  assert.match(script, /LAN_SMART_EDGE_TPROXY=1/);
  assert.match(script, /telegram-transparent-lane\.nft/);
  assert.match(script, /telegram-transparent-policy\.service/);
  assert.match(script, /xray-lan-edge-telegram-policy\.sh/);
  assert.match(script, /--dry-run/);
  assert.match(script, /trap 'status=\$\?; rollback; exit/);
});

test("server-88 LAN Smart Edge balances only the verified DE transports", async () => {
  const config = JSON.parse(await readFile(new URL("../deploy/server-88/xray/config.json", import.meta.url), "utf8")) as {
    routing: { balancers: Array<{ tag: string; selector: string[]; fallbackTag: string }> };
    observatory: { subjectSelector: string[] };
  };
  const proxy = config.routing.balancers.find((balancer) => balancer.tag === "proxy");

  assert.deepEqual(proxy?.selector, ["de-xhttp", "de-xhttp-h2"]);
  assert.equal(proxy?.fallbackTag, "de-xhttp-h2");
  assert.deepEqual(config.observatory.subjectSelector.slice(0, 2), ["de-xhttp", "de-xhttp-h2"]);
});

test("GitHub has no LAN Smart Edge override and stays on ordinary direct DNS", async () => {
  const config = JSON.parse(await readFile(new URL("../deploy/server-88/xray/config.json", import.meta.url), "utf8")) as {
    routing: { rules: Array<{ domain?: string[]; inboundTag?: string[]; outboundTag?: string; balancerTag?: string }> };
  };
  const githubRule = config.routing.rules.find(
    (rule) => rule.domain?.includes("domain:github.com") && rule.inboundTag?.includes("in-lan-smart-tls"),
  );
  assert.equal(githubRule, undefined);
});

test("server-88 canonical config preserves the mandatory transparent inbound across deploy-all", async () => {
  const config = JSON.parse(await readFile(new URL("../deploy/server-88/xray/config.json", import.meta.url), "utf8")) as {
    inbounds: Array<{ tag?: string; sniffing?: { enabled?: boolean; destOverride?: string[] } }>;
    routing: { rules: Array<{ comment?: string; outboundTag?: string }> };
  };
  const inbound = config.inbounds.find((item) => item.tag === "in-tproxy-telegram");

  assert.equal(inbound?.sniffing?.enabled, true);
  assert.deepEqual(inbound?.sniffing?.destOverride, ["http", "tls"]);
  assert.equal(config.routing.rules.some((rule) => rule.comment === "vpn-panel:github-transparent-route"), false);
});

import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

const rendererPath = new URL("../scripts/render-nginx-endpoints.mjs", import.meta.url).pathname;
const endpointProfile = (node: string) => new URL(`../deploy/public-ingress/nginx-endpoints/${node}.conf`, import.meta.url);
const recoveryMap = new URL("../deploy/public-ingress/nginx-endpoints/haos-recovery-public.map", import.meta.url);

test("endpoint renderer keeps co-located services on loopback and remote services on the LAN", () => {
  const result = spawnSync("node", [rendererPath, "--check"], { encoding: "utf8" });
  assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`);

  const server100 = readFileSync(endpointProfile("server-100"), "utf8");
  const server88 = readFileSync(endpointProfile("server-88"), "utf8");
  const server44 = readFileSync(endpointProfile("server-44"), "utf8");

  assert.match(server100, /Target: server-100; listener profile: haproxy-loopback\./);
  assert.match(server88, /Target: server-88; listener profile: lan-canary\./);
  assert.match(server44, /Target: server-44; listener profile: lan-canary\./);
  assert.match(server88, /upstream svc_whisper \{\n    server 127\.0\.0\.1:7653;/);
  assert.match(server88, /upstream svc_cockpit_88 \{\n    server 127\.0\.0\.1:9090;/);
  assert.match(server44, /upstream svc_cockpit_44 \{\n    server 127\.0\.0\.1:9090;/);
  for (const profile of [server100, server44]) {
    assert.match(profile, /upstream svc_whisper \{\n    server 192\.168\.2\.75:7653;/);
  }
});

test("server-100 keeps its HAProxy source profile while the endpoint registry validates its canonical identity", () => {
  const topology = JSON.parse(readFileSync(new URL("../deploy/public-ingress/topology.json", import.meta.url), "utf8"));
  const server100 = topology.ingressServicePlacement.nodes["server-100"];

  assert.equal(server100.lanAddress, "192.168.2.100");
  assert.equal(server100.lanMacAddress, "d0:50:99:dc:33:45");
  assert.equal(server100.nginxListenerProfile, "haproxy-loopback");
});

test("HAOS recovery-Nginx map keeps anonymous public services direct and excludes managed or unreplicated services", () => {
  const map = readFileSync(recoveryMap, "utf8");
  const topology = JSON.parse(readFileSync(new URL("../deploy/public-ingress/topology.json", import.meta.url), "utf8"));
  const whisper = topology.ingressServicePlacement.services.find((service: any) => service.id === "whisper");
  assert.match(map, /^whisper\.bezrabotnyi\.com http:\/\/192\.168\.2\.75:7653;$/m);
  assert.match(map, /^books\.bezrabotnyi\.com http:\/\/192\.168\.2\.75:32741;$/m);
  assert.match(map, /^download\.bezrabotnyi\.com http:\/\/192\.168\.2\.75:8000;$/m);
  assert.doesNotMatch(map, /gptadmin/);
  assert.doesNotMatch(map, /cockpit/);
  assert.deepEqual(whisper.health.expectedStatus, [200]);
});

test("renderer does not invent a GPTAdmin fallback without a replica", () => {
  const server100 = readFileSync(endpointProfile("server-100"), "utf8");
  const server88 = readFileSync(endpointProfile("server-88"), "utf8");
  const server44 = readFileSync(endpointProfile("server-44"), "utf8");

  assert.match(server100, /upstream svc_gptadmin_mcp \{\n    server 127\.0\.0\.1:22554;/);
  for (const profile of [server88, server44]) {
    assert.doesNotMatch(profile, /upstream svc_gptadmin_mcp/);
    assert.match(profile, /gptadmin-mcp: unavailable/);
  }
});

function renderWithTopology(
  topology: unknown,
  outputDirectory = mkdtempSync(join(tmpdir(), "nginx-endpoints-")),
  action = "--check",
) {
  const directory = mkdtempSync(join(tmpdir(), "nginx-topology-"));
  const topologyPath = join(directory, "topology.json");
  writeFileSync(topologyPath, JSON.stringify(topology));
  return spawnSync("node", [rendererPath, action], {
    encoding: "utf8",
    env: { ...process.env, INGRESS_TOPOLOGY_PATH: topologyPath, INGRESS_ENDPOINT_OUTPUT_DIR: outputDirectory },
  });
}

test("a topology-only nginx node receives an endpoint profile without renderer changes", () => {
  const topology = JSON.parse(readFileSync(new URL("../deploy/public-ingress/topology.json", import.meta.url), "utf8"));
  topology.ingressServicePlacement.nodes["server-77"] = {
    lanAddress: "192.168.2.77",
    lanMacAddress: "22:77:00:00:00:01",
    publicIngress: false,
    endpointConsumer: "nginx",
    nginxListenerProfile: "future-safe-profile",
  };
  topology.ingressServicePlacement.services
    .find((service: any) => service.id === "whisper")
    .allowedIngressNodes.push("server-77");
  const outputDirectory = mkdtempSync(join(tmpdir(), "nginx-endpoints-server77-"));

  const writeResult = renderWithTopology(topology, outputDirectory, "--write");
  assert.equal(writeResult.status, 0, `${writeResult.stdout}\n${writeResult.stderr}`);
  const server77 = readFileSync(join(outputDirectory, "server-77.conf"), "utf8");
  assert.match(server77, /Target: server-77; listener profile: future-safe-profile\./);
  assert.match(server77, /upstream svc_whisper \{\n    server 192\.168\.2\.75:7653;/);

  const checkResult = renderWithTopology(topology, outputDirectory);
  assert.equal(checkResult.status, 0, `${checkResult.stdout}\n${checkResult.stderr}`);
});

test("renderer rejects malformed topology rather than guessing placement", () => {
  const base = JSON.parse(readFileSync(new URL("../deploy/public-ingress/topology.json", import.meta.url), "utf8"));
  const invalidCases = [
    { mutate: (topology: any) => { topology.ingressServicePlacement.services[1].id = "whisper"; }, message: "duplicate service id" },
    { mutate: (topology: any) => { topology.ingressServicePlacement.nodes["server-88"].lanAddress = "192.168.2.999"; }, message: "invalid LAN address" },
    { mutate: (topology: any) => { delete topology.ingressServicePlacement.nodes["server-88"].lanAddress; }, message: "invalid LAN address" },
    { mutate: (topology: any) => { topology.ingressServicePlacement.nodes["server-44"].lanAddress = topology.ingressServicePlacement.nodes["server-88"].lanAddress; }, message: "duplicate LAN address" },
    { mutate: (topology: any) => { topology.ingressServicePlacement.nodes["server_77"] = structuredClone(topology.ingressServicePlacement.nodes["server-88"]); }, message: "invalid node id" },
    { mutate: (topology: any) => { topology.ingressServicePlacement.nodes["server-"] = structuredClone(topology.ingressServicePlacement.nodes["server-88"]); }, message: "invalid node id" },
    { mutate: (topology: any) => { topology.ingressServicePlacement.nodes["a".repeat(64)] = structuredClone(topology.ingressServicePlacement.nodes["server-88"]); }, message: "invalid node id" },
    { mutate: (topology: any) => { delete topology.ingressServicePlacement.nodes["server-88"].endpointConsumer; }, message: "invalid endpointConsumer" },
    { mutate: (topology: any) => { delete topology.ingressServicePlacement.nodes["server-88"].nginxListenerProfile; }, message: "invalid nginxListenerProfile" },
    { mutate: (topology: any) => { topology.ingressServicePlacement.nodes["server-88"].nginxListenerProfile = "../unsafe-profile"; }, message: "invalid nginxListenerProfile" },
    { mutate: (topology: any) => { topology.ingressServicePlacement.nodes["server-88"].nginxListenerProfile = "unsafe-profile-"; }, message: "invalid nginxListenerProfile" },
    { mutate: (topology: any) => { topology.ingressServicePlacement.nodes["server-88"].nginxListenerProfile = "a".repeat(64); }, message: "invalid nginxListenerProfile" },
    { mutate: (topology: any) => { topology.ingressServicePlacement.nodes["server-88"].lanMacAddress = "22:49:4D:02:95:5B"; }, message: "invalid LAN MAC address" },
    { mutate: (topology: any) => { topology.ingressServicePlacement.nodes["server-44"].lanMacAddress = topology.ingressServicePlacement.nodes["server-88"].lanMacAddress; }, message: "duplicate LAN MAC address" },
    { mutate: (topology: any) => { topology.ingressServicePlacement.services[0].placements.push("server-44"); }, message: "exactly one placement" },
    { mutate: (topology: any) => { topology.ingressServicePlacement.services[0].allowedIngressNodes.push("missing-node"); }, message: "unknown node" },
    { mutate: (topology: any) => { topology.ingressServicePlacement.services.find((service: any) => service.id === "whisper").recoveryAuth = "cookie"; }, message: "recoveryAuth" },
  ];

  for (const invalid of invalidCases) {
    const topology = structuredClone(base);
    invalid.mutate(topology);
    const result = renderWithTopology(topology);
    assert.notEqual(result.status, 0, invalid.message);
    assert.match(`${result.stdout}\n${result.stderr}`, new RegExp(invalid.message));
  }
});

test("renderer reports stale generated endpoint profiles", () => {
  const outputDirectory = mkdtempSync(join(tmpdir(), "nginx-endpoints-stale-"));
  writeFileSync(join(outputDirectory, "server-100.conf"), "stale\n");
  const result = spawnSync("node", [rendererPath, "--check"], {
    encoding: "utf8",
    env: { ...process.env, INGRESS_ENDPOINT_OUTPUT_DIR: outputDirectory },
  });
  assert.notEqual(result.status, 0);
  assert.match(`${result.stdout}\n${result.stderr}`, /nginx endpoint profile is stale/);
});

test("renderer does not confuse the HAOS recovery-Nginx map with a standard upstream profile", () => {
  const outputDirectory = mkdtempSync(join(tmpdir(), "nginx-endpoints-haos-"));
  writeFileSync(join(outputDirectory, "haos.conf"), "stale\n");
  const result = spawnSync("node", [rendererPath, "--check"], {
    encoding: "utf8",
    env: { ...process.env, INGRESS_ENDPOINT_OUTPUT_DIR: outputDirectory },
  });
  assert.notEqual(result.status, 0);
  assert.match(`${result.stdout}\n${result.stderr}`, /haos\.conf/);
});

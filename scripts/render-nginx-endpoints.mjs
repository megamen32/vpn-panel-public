#!/usr/bin/env node
/**
 * Render named Nginx upstreams from the canonical ingress service-placement
 * registry. This deliberately never edits an arbitrary proxy_pass directive.
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const repoDir = path.dirname(scriptDir);
const topologyPath = process.env.INGRESS_TOPOLOGY_PATH || path.join(repoDir, "deploy/public-ingress/topology.json");
const outputDirectory = process.env.INGRESS_ENDPOINT_OUTPUT_DIR || path.join(repoDir, "deploy/public-ingress/nginx-endpoints");
const action = process.argv[2] || "--check";

if (!["--check", "--write"].includes(action)) {
  console.error("Usage: render-nginx-endpoints.mjs [--check|--write]");
  process.exit(2);
}

const topology = JSON.parse(fs.readFileSync(topologyPath, "utf8"));
const registry = topology.ingressServicePlacement;

function fail(message) {
  throw new Error(`invalid ingressServicePlacement: ${message}`);
}

function isLanAddress(value) {
  if (typeof value !== "string") return false;
  const octets = value.split(".");
  return octets.length === 4
    && octets.every((octet) => /^\d+$/.test(octet) && Number(octet) >= 0 && Number(octet) <= 255)
    && octets[0] === "192" && octets[1] === "168" && octets[2] === "2";
}

function isSafeIdentifier(value) {
  return typeof value === "string" && /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/.test(value);
}

function isLanMacAddress(value) {
  return typeof value === "string" && /^(?:[0-9a-f]{2}:){5}[0-9a-f]{2}$/.test(value);
}

function validateRegistry() {
  if (!registry || registry.schemaVersion !== 1) fail("schemaVersion must be 1");
  if (!registry.nodes || typeof registry.nodes !== "object") fail("nodes must be an object");
  if (!Array.isArray(registry.services)) fail("services must be an array");

  const serviceIds = new Set();
  const lanAddresses = new Set();
  const lanMacAddresses = new Set();
  for (const [nodeId, node] of Object.entries(registry.nodes)) {
    if (!isSafeIdentifier(nodeId)) fail(`invalid node id: ${nodeId}`);
    if (!node || typeof node !== "object") fail(`invalid node definition for ${nodeId}`);
    if (!isLanAddress(node.lanAddress)) fail(`invalid LAN address for ${nodeId}`);
    if (lanAddresses.has(node.lanAddress)) fail(`duplicate LAN address for ${nodeId}`);
    lanAddresses.add(node.lanAddress);
    if (node.lanMacAddress !== undefined) {
      if (!isLanMacAddress(node.lanMacAddress)) fail(`invalid LAN MAC address for ${nodeId}`);
      if (lanMacAddresses.has(node.lanMacAddress)) fail(`duplicate LAN MAC address for ${nodeId}`);
      lanMacAddresses.add(node.lanMacAddress);
    }
    if (typeof node.publicIngress !== "boolean") fail(`invalid publicIngress for ${nodeId}`);
    if (!["nginx", "recovery-nginx", "device"].includes(node.endpointConsumer)) fail(`invalid endpointConsumer for ${nodeId}`);
    if (["nginx", "recovery-nginx"].includes(node.endpointConsumer) && !isSafeIdentifier(node.nginxListenerProfile)) {
      fail(`invalid nginxListenerProfile for ${nodeId}`);
    }
  }

  for (const service of registry.services) {
    if (!service || typeof service !== "object") fail("service must be an object");
    if (!/^[a-z0-9-]+$/.test(service.id)) fail(`invalid service id: ${service.id}`);
    if (serviceIds.has(service.id)) fail(`duplicate service id: ${service.id}`);
    serviceIds.add(service.id);
    if (!["http", "https"].includes(service.protocol)) fail(`invalid protocol for ${service.id}`);
    if (!Number.isInteger(service.port) || service.port < 1 || service.port > 65535) fail(`invalid port for ${service.id}`);
    if (!Array.isArray(service.hostnames) || service.hostnames.length === 0 || !service.hostnames.every((name) => typeof name === "string" && /^[*.a-z0-9-]+$/.test(name))) {
      fail(`invalid hostnames for ${service.id}`);
    }
    if (!Array.isArray(service.placements) || service.placements.length !== 1) fail(`exactly one placement is required for ${service.id}`);
    if (!Array.isArray(service.allowedIngressNodes) || service.allowedIngressNodes.length === 0) {
      fail(`missing allowedIngressNodes for ${service.id}`);
    }
    for (const nodeId of [...service.placements, ...service.allowedIngressNodes]) {
      if (!registry.nodes[nodeId]) fail(`unknown node ${nodeId} for ${service.id}`);
    }
    const recoveryNodes = service.allowedIngressNodes.filter((nodeId) => registry.nodes[nodeId].endpointConsumer === "recovery-nginx");
    if (recoveryNodes.length > 0 && !["anonymous", "managed"].includes(service.recoveryAuth)) {
      fail(`recoveryAuth must be anonymous or managed for ${service.id}`);
    }
    if (typeof service.fallback !== "string" || !["remote-backend", "requires-replica"].includes(service.fallback)) fail(`invalid fallback for ${service.id}`);
    if (!service.health || typeof service.health.path !== "string" || !service.health.path.startsWith("/") || !Array.isArray(service.health.expectedStatus) || service.health.expectedStatus.length === 0 || !service.health.expectedStatus.every((status) => Number.isInteger(status) && status >= 100 && status <= 599)) {
      fail(`invalid health policy for ${service.id}`);
    }
  }
}

function upstreamName(service) {
  return `svc_${service.id.replaceAll("-", "_")}`;
}

function endpointFor(service, targetNode) {
  const serviceNode = service.placements[0];
  if (serviceNode === targetNode) return `127.0.0.1:${service.port}`;
  return `${registry.nodes[serviceNode].lanAddress}:${service.port}`;
}

function render(targetNode) {
  const target = registry.nodes[targetNode];
  if (!target) fail(`unknown render target ${targetNode}`);
  if (target.endpointConsumer !== "nginx") fail(`target ${targetNode} is not an nginx endpoint consumer`);

  const blocks = [
    "# Generated from deploy/public-ingress/topology.json by scripts/render-nginx-endpoints.mjs.",
    `# Target: ${targetNode}; listener profile: ${target.nginxListenerProfile}.`,
    "# Do not edit: use named svc_* upstreams from vhost templates.",
  ];

  for (const service of registry.services) {
    if (!service.allowedIngressNodes.includes(targetNode)) {
      blocks.push(`# ${service.id}: unavailable on ${targetNode}; fallback=${service.fallback}.`);
      continue;
    }
    blocks.push([
      `upstream ${upstreamName(service)} {`,
      `    server ${endpointFor(service, targetNode)};`,
      "}",
    ].join("\n"));
  }

  return `${blocks.join("\n\n")}\n`;
}

function recoveryNginxServices() {
  return registry.services.filter((service) => service.recoveryAuth === "anonymous" && service.allowedIngressNodes.some((nodeId) => registry.nodes[nodeId].endpointConsumer === "recovery-nginx"));
}

function renderRecoveryNginxMap() {
  const hostnames = new Set();
  const blocks = [
    "# Generated from deploy/public-ingress/topology.json by scripts/render-nginx-endpoints.mjs.",
    "# Consumer: HAOS recovery-Nginx public gateway. Do not edit.",
  ];

  for (const service of recoveryNginxServices()) {
    for (const hostname of service.hostnames) {
      if (hostname.includes("*")) fail(`wildcard recovery hostname is not supported for ${service.id}`);
      if (hostnames.has(hostname)) fail(`duplicate recovery hostname: ${hostname}`);
      hostnames.add(hostname);
      blocks.push(`${hostname} ${service.protocol}://${endpointFor(service, "haos")};`);
    }
  }

  return `${blocks.join("\n")}\n`;
}

function writeOrCheck(targetPath, rendered) {
  const current = fs.existsSync(targetPath) ? fs.readFileSync(targetPath, "utf8") : null;
  if (current === rendered) return;
  if (action === "--write") {
    fs.mkdirSync(outputDirectory, { recursive: true });
    fs.writeFileSync(targetPath, rendered);
    console.log(`rendered ${path.relative(repoDir, targetPath)}`);
    return;
  }
  drift = true;
  console.error(`nginx endpoint profile is stale: ${path.relative(repoDir, targetPath)}`);
}

validateRegistry();
const nginxTargetNodes = Object.keys(registry.nodes)
  .filter((nodeId) => registry.nodes[nodeId].endpointConsumer === "nginx")
  .sort();
const recoveryMapName = "haos-recovery-public.map";
const expectedProfileNames = new Set([...nginxTargetNodes.map((nodeId) => `${nodeId}.conf`), recoveryMapName]);
let drift = false;
if (fs.existsSync(outputDirectory)) {
  for (const name of fs.readdirSync(outputDirectory)) {
    if (expectedProfileNames.has(name)) continue;
    const targetPath = path.join(outputDirectory, name);
    if (action === "--write") {
      fs.unlinkSync(targetPath);
      console.log(`removed stale ${path.relative(repoDir, targetPath)}`);
    } else {
      drift = true;
      console.error(`nginx endpoint profile is stale: ${path.relative(repoDir, targetPath)}`);
    }
  }
}
for (const nodeId of nginxTargetNodes) {
  const targetPath = path.join(outputDirectory, `${nodeId}.conf`);
  writeOrCheck(targetPath, render(nodeId));
}
writeOrCheck(path.join(outputDirectory, recoveryMapName), renderRecoveryNginxMap());

if (drift) process.exit(1);
if (action === "--check") console.log("nginx endpoint profiles are current");

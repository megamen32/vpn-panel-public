#!/usr/bin/env node
/** Render generated Smart/Full blocks from the canonical ingress topology. */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const repoDir = path.dirname(scriptDir);
const topologyPath = path.join(repoDir, 'deploy/public-ingress/topology.json');
const action = process.argv[2] || '--check';

if (!['--check', '--write'].includes(action)) {
  console.error('Usage: render-public-ingress.mjs [--check|--write]');
  process.exit(2);
}

const topology = JSON.parse(fs.readFileSync(topologyPath, 'utf8'));
const routes = topology.routes;
const REQUIRED_PRODUCT_ROUTE_IDS = new Set([
  'smart-de-relay',
  'full-de-relay',
  'smart-us-relay',
  'full-us-relay',
  'fi-helsinki-relay',
]);

if (!Array.isArray(routes) || routes.length !== REQUIRED_PRODUCT_ROUTE_IDS.size
  || routes.some((route) => !REQUIRED_PRODUCT_ROUTE_IDS.has(route.id))) {
  throw new Error('topology.routes must contain the four canonical products and the owner-managed Helsinki relay');
}

for (const route of routes) {
  if (!/^[a-z0-9-]+$/.test(route.id)) throw new Error(`invalid route id: ${route.id}`);
  if (!/^be_[a-z0-9_]+$/.test(route.backend)) throw new Error(`invalid backend: ${route.backend}`);
  if (!/^[a-z0-9.-]+$/.test(route.sni)) throw new Error(`invalid route SNI: ${route.sni}`);
  if (!Number.isInteger(route.relayPort)) throw new Error(`invalid relay port: ${route.relayPort}`);
}

function replaceGeneratedBlock(content, name, body) {
  const start = `# BEGIN GENERATED: ${name}`;
  const end = `# END GENERATED: ${name}`;
  const startIndex = content.indexOf(start);
  const endIndex = content.indexOf(end);
  if (startIndex < 0 || endIndex < startIndex) throw new Error(`missing generated block: ${name}`);
  const bodyStart = startIndex + start.length;
  return `${content.slice(0, bodyStart)}\n${body}\n${content.slice(endIndex)}`;
}

function aclName(route) {
  return route.backend.replace(/^be_/, 'sni_');
}

function renderAcls() {
  return routes.map((route) => {
    const names = [route.sni, ...(route.aliases || [])];
    return `    acl ${aclName(route)} req.ssl_sni -i ${names.join(' ')}`;
  }).join('\n');
}

function renderSelections() {
  return routes.map((route) => `    use_backend ${route.backend} if ${aclName(route)}`).join('\n');
}

function renderBackends(relayHost) {
  return routes.map((route) => [
    `backend ${route.backend}`,
    '    mode tcp',
    `    server ${route.id} ${relayHost}:${route.relayPort} check inter 5s fall 2 rise 1`,
  ].join('\n')).join('\n\n');
}

function recoveryNginxServices() {
  const registry = topology.ingressServicePlacement;
  if (!registry || !registry.nodes || !Array.isArray(registry.services)) {
    throw new Error("missing ingressServicePlacement registry");
  }
  if (registry.nodes.haos?.endpointConsumer !== "recovery-nginx") {
    throw new Error("HAOS must be declared as the recovery-nginx consumer");
  }
  return registry.services.filter((service) => {
    if (!service.allowedIngressNodes?.includes("haos")) return false;
    return service.recoveryAuth === "anonymous";
  });
}

function recoveryAclName(service, prefix) {
  return `${prefix}_recovery_${service.id.replaceAll("-", "_")}`;
}

function renderRecoverySniAcls() {
  return recoveryNginxServices().map((service) => `    acl ${recoveryAclName(service, "sni")} req.ssl_sni -i ${service.hostnames.join(" ")}`).join("\n");
}

function renderRecoverySniSelections() {
  return recoveryNginxServices().map((service) => `    use_backend be_local_tls if ${recoveryAclName(service, "sni")}`).join("\n");
}

function renderRecoveryHttpAcls() {
  return recoveryNginxServices().map((service) => `    acl ${recoveryAclName(service, "host")} hdr(host),field(1,:),lower -i ${service.hostnames.join(" ")}`).join("\n");
}

function renderRecoveryHttpSelections() {
  return recoveryNginxServices().map((service) => `    use_backend be_recovery_nginx_public if ${recoveryAclName(service, "host")}`).join("\n");
}

function renderConfig(target) {
  let content = fs.readFileSync(target.path, 'utf8');
  content = replaceGeneratedBlock(content, 'regional ACLs', renderAcls());
  content = replaceGeneratedBlock(content, 'regional selections', renderSelections());
  content = replaceGeneratedBlock(content, 'regional backends', renderBackends(target.relayHost));
  if (target.kind === "haos") {
    content = replaceGeneratedBlock(content, "recovery nginx plain HTTP ACLs", renderRecoveryHttpAcls());
    content = replaceGeneratedBlock(content, "recovery nginx plain HTTP selections", renderRecoveryHttpSelections());
    content = replaceGeneratedBlock(content, "recovery nginx SNI ACLs", renderRecoverySniAcls());
    content = replaceGeneratedBlock(content, "recovery nginx SNI selections", renderRecoverySniSelections());
    content = replaceGeneratedBlock(content, "recovery nginx TLS HTTP ACLs", renderRecoveryHttpAcls());
    content = replaceGeneratedBlock(content, "recovery nginx TLS HTTP selections", renderRecoveryHttpSelections());
  }
  return content;
}

const targets = [
  {
    path: path.join(repoDir, 'deploy/server-100/haproxy/public-ingress.cfg'),
    relayHost: topology.server100.relayHost,
    kind: "server100",
  },
  {
    path: path.join(repoDir, 'deploy/haos/recovery-haproxy/haproxy.cfg'),
    relayHost: topology.haos.relayHost,
    kind: "haos",
  },
];

let drift = false;
for (const target of targets) {
  const current = fs.readFileSync(target.path, 'utf8');
  const rendered = renderConfig(target);
  if (current === rendered) continue;
  if (action === '--write') {
    fs.writeFileSync(target.path, rendered);
    console.log(`rendered ${path.relative(repoDir, target.path)}`);
  } else {
    drift = true;
    console.error(`generated ingress blocks are stale: ${path.relative(repoDir, target.path)}`);
  }
}

if (drift) process.exit(1);
if (action === '--check') console.log('public ingress generated blocks are current');

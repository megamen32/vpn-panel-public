import type { ProjectedScopeRoute, ProjectedServiceDomain, ServiceRoutingProjection } from "./service-catalog-activation.js";
import { migrateLegacySmartDnsPolicyToRoutingRules, normalizeRoutingRules, type RoutingCondition, type RoutingRule, type VpnTarget } from "./routing-rules.js";
import type { SmartDnsPolicy } from "./smart-dns-policy.js";

type ProjectedProxy = Extract<ProjectedScopeRoute, { kind: "proxy" }>;

interface PreparedDomain extends RoutingRule { domain: string; }
const catalogPrefix = "catalog:";

/** Render catalog activation into the canonical rules array; admin rows are never rewritten. */
export function renderCatalogSmartDnsPolicy(base: SmartDnsPolicy, previous: ServiceRoutingProjection | null, next: ServiceRoutingProjection): SmartDnsPolicy {
  // Validate the previous projection too: it is a trust boundary before its managed rows are removed.
  previous?.domains.forEach(prepareProjectedDomain);
  const nextEntries = next.domains.map(prepareProjectedDomain);
  const identities = new Map<string, PreparedDomain>();
  for (const entry of nextEntries) {
    const key = `${entry.match}\u0000${entry.domain}`;
    const prior = identities.get(key);
    if (prior && (prior.through.join(",") !== entry.through.join(",") || prior.conditions.join(",") !== entry.conditions.join(","))) throw new Error(`conflicting duplicate projected domain: ${entry.match}/${entry.domain}`);
    identities.set(key, entry);
  }
  return {
    ...base,
    rules: normalizeRoutingRules([...(base.rules ?? migrateLegacySmartDnsPolicyToRoutingRules(base)).filter((rule) => !rule.id.startsWith(catalogPrefix)), ...nextEntries]),
  };
}

function prepareProjectedDomain(entry: ProjectedServiceDomain): PreparedDomain {
  const domain = normalizeDomain(entry.domain);
  if (!domain) throw new Error("projected service domain must be non-empty");
  if (entry.match !== "exact" && entry.match !== "suffix") throw new Error(`unsupported projected domain match for ${entry.serviceId}/${entry.domain}`);
  validateRoute(entry.lan, entry, "LAN"); validateRoute(entry.external, entry, "external");
  if (!entry.lan && !entry.external) throw new Error(`projected domain has no LAN or external route: ${entry.serviceId}/${entry.domain}`);
  const lan = entry.lan; const external = entry.external;
  const lanTarget = lan?.kind === "proxy" ? proxyTarget(lan, entry, "LAN") : undefined;
  const externalTarget = external?.kind === "proxy" ? proxyTarget(external, entry, "external") : undefined;
  if (lan?.kind === "proxy" && external?.kind === "proxy" && lanTarget !== externalTarget) throw new Error(`combined LAN and external proxy targets differ: ${entry.serviceId}/${entry.domain}`);
  if (lan?.kind === "proxy" && entry.match === "exact") throw new Error(`exact LAN proxy is not representable: ${entry.serviceId}/${entry.domain}`);
  if (external?.kind === "proxy" && !lan) throw new Error(`external-only proxy must be deferred: ${entry.serviceId}/${entry.domain}`);
  if (external?.kind === "proxy" && lan?.kind !== "proxy") throw new Error(`combined LAN and external proxy is not representable: ${entry.serviceId}/${entry.domain}`);
  const conditions: RoutingCondition[] = [];
  if (lan) conditions.push("internalDns");
  if (external) conditions.push("externalDns");
  const target = lanTarget ?? externalTarget;
  if (target) conditions.push("vpn");
  return { id: `${catalogPrefix}${entry.serviceId}:${entry.match}:${domain}`, domain, text: domain, match: entry.match, through: target ? [target] : ["direct"], conditions };
}

function validateRoute(route: ProjectedScopeRoute | undefined, entry: ProjectedServiceDomain, scope: string): void {
  if (route === undefined) return;
  if (route === null || typeof route !== "object" || (route.kind !== "direct" && route.kind !== "proxy")) throw new Error(`malformed ${scope} route: ${entry.serviceId}/${entry.domain}`);
}

function proxyTarget(route: ProjectedProxy, entry: ProjectedServiceDomain, scope: string): VpnTarget {
  if (route.targetId !== "vpn2" && route.targetId !== "vusa") throw new Error(`${scope} proxy lacks supported targetId: ${entry.serviceId}/${entry.domain}`);
  if (scope === "external" && route.profileId !== "public" && route.profileId !== "vusa") throw new Error(`unsupported proxy profile ${String(route.profileId)}: ${entry.serviceId}/${entry.domain}`);
  return route.targetId;
}

function normalizeDomain(value: string): string { return value.trim().toLowerCase().replace(/^\.+|\.+$/g, ""); }

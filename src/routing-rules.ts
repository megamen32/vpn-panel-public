/** Compatibility input accepted only by the one-way migration reader. */
export interface LegacySmartDnsPolicy {
  defaultRoute?: "direct" | "proxy";
  localDefaultRoute?: "direct" | "proxy";
  blockSuffixes?: string[];
  blockDomains?: string[];
  directSuffixes?: string[];
  directDomains?: string[];
  proxySuffixes?: string[];
  proxyDomains?: string[];
  localProxySuffixes?: string[];
  localProxyDomains?: string[];
  vusaProxySuffixes?: string[];
  vusaProxyDomains?: string[];
}

export const ROUTING_CONDITIONS = ["externalDns", "internalDns", "vpn"] as const;
export const VPN_TARGETS = ["vpn2", "vusa"] as const;

export type RoutingCondition = typeof ROUTING_CONDITIONS[number];
export type VpnTarget = typeof VPN_TARGETS[number];
export type RoutingMatch = "exact" | "suffix" | "set";

/** One ordered row in the unified routing editor. */
export interface RoutingRule {
  id: string;
  text: string;
  match: RoutingMatch;
  /** `direct` is exclusive; two VPN targets mean primary then fallback. */
  through: Array<"direct" | VpnTarget>;
  conditions: RoutingCondition[];
}

function normalizeDomain(value: string): string {
  const domain = value.trim().toLowerCase().replace(/^\.+|\.+$/g, "");
  if (!domain || /[\s/:?#]/.test(domain)) throw new Error(`invalid domain selector: ${value}`);
  return domain;
}

function normalizeConditions(values: readonly RoutingCondition[]): RoutingCondition[] {
  const conditions = [...new Set(values)].sort((left, right) => ROUTING_CONDITIONS.indexOf(left) - ROUTING_CONDITIONS.indexOf(right));
  if (!conditions.length || conditions.some((condition) => !ROUTING_CONDITIONS.includes(condition))) {
    throw new Error("routing rule must have valid conditions");
  }
  return conditions;
}

function normalizeThrough(values: readonly ("direct" | VpnTarget)[]): Array<"direct" | VpnTarget> {
  const through = [...new Set(values)];
  if (!through.length || through.some((target) => target !== "direct" && !VPN_TARGETS.includes(target))) {
    throw new Error("routing rule must have valid targets");
  }
  if (through.includes("direct") && through.length !== 1) throw new Error("direct cannot be combined with a VPN target");
  return through;
}

export function normalizeRoutingRules(input: readonly RoutingRule[]): RoutingRule[] {
  const ids = new Set<string>();
  return input.map((rule) => {
    const id = rule.id.trim();
    if (!id || ids.has(id)) throw new Error(`duplicate or empty routing rule id: ${rule.id}`);
    ids.add(id);
    const conditions = normalizeConditions(rule.conditions);
    const through = normalizeThrough(rule.through);
    const geo = /^(geoip|geosite):([a-z0-9_.-]+)$/i.exec(rule.text.trim());
    if (geo) {
      if (rule.match !== "set") throw new Error("geo selectors require match=set");
      if (conditions.length !== 1 || conditions[0] !== "vpn") throw new Error("geo selectors support only vpn condition");
      return { id, text: `${geo[1].toLowerCase()}:${geo[2].toLowerCase()}`, match: "set", through, conditions };
    }
    if (rule.match !== "exact" && rule.match !== "suffix") throw new Error("domain selectors require exact or suffix match");
    return { id, text: normalizeDomain(rule.text), match: rule.match, through, conditions };
  });
}

function ruleId(match: RoutingMatch, text: string, target: "direct" | VpnTarget): string {
  return `${text.startsWith("geo") ? text.slice(0, text.indexOf(":")) : "domain"}-${match}-${text.replace(/[^a-z0-9]+/gi, "-").replace(/^-|-$/g, "")}-${target}`;
}

function legacyRules(values: readonly string[], match: "exact" | "suffix", through: Array<"direct" | VpnTarget>, conditions: RoutingCondition[]): RoutingRule[] {
  const target = through[0];
  return values.map((text) => ({ id: ruleId(match, text, target), text, match, through, conditions }));
}

/** Convert the existing persisted groups without silently changing their scope. */
export function migrateLegacySmartDnsPolicyToRoutingRules(input: LegacySmartDnsPolicy | object): RoutingRule[] {
  const policy = input as LegacySmartDnsPolicy;
  if ((policy.blockSuffixes?.length ?? 0) || (policy.blockDomains?.length ?? 0)) {
    throw new Error("legacy block rules need an explicit migration decision");
  }
  const all: RoutingCondition[] = ["externalDns", "internalDns", "vpn"];
  const internalAndVpn: RoutingCondition[] = ["internalDns", "vpn"];
  const legacy = [
    ...legacyRules(policy.directDomains ?? [], "exact", ["direct"], all),
    ...legacyRules(policy.directSuffixes ?? [], "suffix", ["direct"], all),
    ...legacyRules(policy.vusaProxyDomains ?? [], "exact", ["vusa"], all),
    ...legacyRules(policy.vusaProxySuffixes ?? [], "suffix", ["vusa"], all),
    ...legacyRules(policy.proxyDomains ?? [], "exact", ["vpn2"], all),
    ...legacyRules(policy.proxySuffixes ?? [], "suffix", ["vpn2"], all),
    ...legacyRules(policy.localProxyDomains ?? [], "exact", ["vpn2"], internalAndVpn),
    ...legacyRules(policy.localProxySuffixes ?? [], "suffix", ["vpn2"], internalAndVpn),
  ];
  const migrated = normalizeRoutingRules(legacy.map((rule, index) => ({
    ...rule,
    id: legacy.findIndex((candidate) => candidate.id === rule.id) === index ? rule.id : `${rule.id}-${index}`,
  })));
  return migrated.length ? migrated : [];
}

/** @deprecated Compatibility alias for read-only migration callers. */
export const migrateSmartDnsPolicyToRoutingRules = migrateLegacySmartDnsPolicyToRoutingRules;

/** A domain-only projection consumed by the internal and public SmartDNS profiles. */
export interface DnsRoutingRule {
  id: string;
  text: string;
  match: "exact" | "suffix";
  through: Array<"direct" | VpnTarget>;
}

export function compileDnsRoutingRules(rules: readonly RoutingRule[], condition: "internalDns" | "externalDns"): DnsRoutingRule[] {
  return rules
    .filter((rule) => rule.conditions.includes(condition) && rule.match !== "set")
    .map(({ id, text, match, through }) => ({ id, text, match: match as "exact" | "suffix", through }));
}

/** Native Xray/sing-box selector groups. Target order is preserved for the caller's balancer. */
export interface VpnRoutingRule {
  id: string;
  domain: string[];
  ip: string[];
  through: Array<"direct" | VpnTarget>;
}

export function compileVpnRoutingRules(rules: readonly RoutingRule[]): VpnRoutingRule[] {
  return rules
    .filter((rule) => rule.conditions.includes("vpn"))
    .map((rule) => {
      if (rule.match === "set") {
        const [kind, tag] = rule.text.split(":", 2);
        return kind === "geoip"
          ? { id: rule.id, domain: [], ip: [`geoip:${tag}`], through: rule.through }
          : { id: rule.id, domain: [`geosite:${tag}`], ip: [], through: rule.through };
      }
      const selector = `${rule.match === "exact" ? "full" : "domain"}:${rule.text}`;
      return { id: rule.id, domain: [selector], ip: [], through: rule.through };
    });
}

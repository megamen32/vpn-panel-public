import type { SmartDnsPolicy } from "./smart-dns-policy.js";
import { compileVpnRoutingRules, migrateLegacySmartDnsPolicyToRoutingRules } from "./routing-rules.js";

/**
 * Platform-neutral desktop routing contract.
 * A plain domain includes subdomains; `=host` means an exact match.
 * GeoSite/GeoIP remain Xray-native and are intentionally not projected to PAC.
 */
export type ClientRoutingAction = "block" | "direct" | "proxy";

export interface ClientRoutingPolicy {
  defaultAction: "direct";
  block: string[];
  direct: string[];
  proxy: string[];
}

function normalizeDomain(value: string): string {
  const exact = value.trim().startsWith("=");
  const host = value.trim().toLowerCase().replace(/^=+|^\.+|\.+$/g, "");
  return host ? `${exact ? "=" : ""}${host}` : "";
}

export function normalizeClientRoutingDomains(values: readonly string[]): string[] {
  return [...new Set(values.map(normalizeDomain).filter(Boolean))].sort();
}

/** Project hub SmartDNS domain groups into the one desktop policy shape. */
export function clientRoutingPolicyFromSmartDns(policy: SmartDnsPolicy): ClientRoutingPolicy {
  const vpnRules = compileVpnRoutingRules(policy.rules ?? migrateLegacySmartDnsPolicyToRoutingRules(policy));
  return {
    defaultAction: "direct",
    block: [],
    direct: normalizeClientRoutingDomains(vpnRules.filter((rule) => rule.through[0] === "direct").flatMap((rule) => rule.domain.map((domain) => domain.replace(/^full:/, "=").replace(/^domain:/, "")))),
    proxy: normalizeClientRoutingDomains(vpnRules.filter((rule) => rule.through[0] !== "direct").flatMap((rule) => rule.domain.map((domain) => domain.replace(/^full:/, "=").replace(/^domain:/, "")))),
  };
}

export function xrayDomains(domains: readonly string[]): string[] {
  return domains.map((domain) => domain.startsWith("=")
    ? `full:${domain.slice(1)}`
    : `domain:${domain}`);
}

import { readFile, writeFile } from "node:fs/promises";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import {
  migrateLegacySmartDnsPolicyToRoutingRules,
  normalizeRoutingRules,
  type LegacySmartDnsPolicy,
  type RoutingRule,
} from "./routing-rules.js";

export type SmartDnsResolvedRoute = "direct" | "proxy";
export type SmartDnsRoute = SmartDnsResolvedRoute | "local-proxy" | "vusa-proxy";

function normalizeHost(value: string): string {
  return value.trim().toLowerCase().replace(/^\.+|\.+$/g, "");
}

interface ProtectedSmartDnsPolicy { proxyOnlySuffixes: unknown; }

function loadProtectedProxySuffixes(): readonly string[] {
  const policyPath = fileURLToPath(new URL("../deploy/smartdns/protected-policy.json", import.meta.url));
  const source = JSON.parse(readFileSync(policyPath, "utf8")) as ProtectedSmartDnsPolicy;
  if (!Array.isArray(source.proxyOnlySuffixes) || source.proxyOnlySuffixes.some((value) => typeof value !== "string")) {
    throw new Error(`protected SmartDNS policy ${policyPath} must define string proxyOnlySuffixes`);
  }
  const suffixes = [...new Set(source.proxyOnlySuffixes.map((value) => normalizeHost(value)).filter(Boolean))];
  if (!suffixes.length) throw new Error(`protected SmartDNS policy ${policyPath} must not be empty`);
  return suffixes;
}

export const PROTECTED_PROXY_SUFFIXES = loadProtectedProxySuffixes();

/** The persisted policy is exclusively a set of rows from the unified editor. */
export interface SmartDnsPolicy {
  rules: RoutingRule[];
  updatedAt?: string;
}

export interface SmartDnsRouteCheck {
  input: string;
  host: string;
  route: SmartDnsRoute;
  localRoute: SmartDnsResolvedRoute;
  publicRoute: SmartDnsResolvedRoute;
  publicEdgeProfile: "public" | "vusa" | null;
  reason: string;
  matched: string | null;
  vpnRoute: "direct" | "vpn2" | "vusa" | "unknown";
  vpnMatched: string | null;
  dimensions: {
    internalDns: SmartDnsResolvedRoute;
    externalDns: SmartDnsResolvedRoute;
    lan: SmartDnsResolvedRoute;
    vpn: "direct" | "vpn2" | "vusa" | "unknown";
  };
}

const directSuffixes = [
  "ru", "su", "xn--p1ai", "vk.com", "local", "lan", "bezrabotnyi.com", "z.ai",
  "github.com", "github.io", "githubcopilot.com", "githubassets.com", "githubusercontent.com",
];
const directDomains = ["vpn2.bezrabotnyi.com", "vusa.bezrabotnyi.com", "server-44", "localhost"];
const vpn2Suffixes = [
  ...PROTECTED_PROXY_SUFFIXES, "openai.com", "chatgpt.com", "oaistatic.com", "oaiusercontent.com", "oaistatsig.com", "openaimerge.com", "workos.com", "workoscdn.com", "openrouter.ai", "default.exp-tas.com", "claude.ai", "claude.com", "anthropic.com", "spotify.com", "scdn.co", "spotifycdn.com", "sponsor.ajay.app", "notion.com", "notion.so", "notion.site", "notion-static.com", "notionusercontent.com", "notion-status.com", "qoder.com",
];
const internalVpn2Suffixes = ["youtube.com", "youtu.be", "youtube-nocookie.com", "youtube.googleapis.com", "youtubei.googleapis.com", "googlevideo.com", "ytimg.com", "ggpht.com", "gvt1.com", "gvt2.com", "discord.com", "discord.gg", "discordapp.com", "discordapp.net", "discord.media", "discordstatus.com", "whatsapp.com", "whatsapp.net", "wa.me", "facebook.com", "facebook.net", "fb.com", "fbsbx.com", "messenger.com", "m.me", "threads.net", "threads.com", "instagram.com", "cdninstagram.com", "fbcdn.net", "ig.me", "x.com", "twitter.com", "t.co", "twimg.com", "grok.com", "x.ai", "signal.org", "signal.art", "viber.com", "viber.me", "viber.net", "linkedin.com", "licdn.com"];
const vpnDirectSuffixes = ["cloudflare.com"];
const vusaSuffixes = ["telegram.org", "telegram.me", "t.me", "tdesktop.com", "telesco.pe", "telegra.ph"];

function initialRules(): RoutingRule[] {
  const rows: RoutingRule[] = [];
  const add = (prefix: string, values: string[], match: "exact" | "suffix", through: RoutingRule["through"], conditions: RoutingRule["conditions"]) => values.forEach((text, index) => rows.push({ id: `${prefix}-${index}`, text, match, through, conditions }));
  add("default:direct-exact", directDomains, "exact", ["direct"], ["externalDns", "internalDns", "vpn"]);
  add("default:direct-suffix", directSuffixes, "suffix", ["direct"], ["externalDns", "internalDns", "vpn"]);
  add("default:vpn-direct-suffix", vpnDirectSuffixes, "suffix", ["direct"], ["vpn"]);
  add("default:vpn2-suffix", vpn2Suffixes, "suffix", ["vpn2"], ["externalDns", "internalDns", "vpn"]);
  add("default:internal-vpn2-exact", ["i.instagram.com"], "exact", ["vpn2"], ["internalDns", "vpn"]);
  add("default:internal-vpn2-suffix", internalVpn2Suffixes, "suffix", ["vpn2"], ["internalDns", "vpn"]);
  add("default:vusa-exact", ["api.telegram.org", "web.telegram.org"], "exact", ["vusa"], ["externalDns", "internalDns", "vpn"]);
  add("default:vusa-suffix", vusaSuffixes, "suffix", ["vusa"], ["externalDns", "internalDns", "vpn"]);
  return normalizeRoutingRules(rows);
}

export const DEFAULT_SMART_DNS_POLICY: SmartDnsPolicy = { rules: initialRules() };

export function smartDnsPolicyPath(): string { return process.env.VPN_PANEL_SMART_DNS_POLICY || "/etc/vpn-panel/smart-dns-policy.json"; }

/** Accept legacy JSON only while reading it, and always return the rules-only shape. */
export function normalizeSmartDnsPolicy(input: Partial<SmartDnsPolicy> | LegacySmartDnsPolicy): SmartDnsPolicy {
  const candidate = input as Partial<SmartDnsPolicy> & LegacySmartDnsPolicy;
  const sourceRules = Array.isArray(candidate.rules) ? normalizeRoutingRules(candidate.rules) : migrateLegacySmartDnsPolicyToRoutingRules(candidate);
  const protectedRules = PROTECTED_PROXY_SUFFIXES.map((text) => ({ id: `protected:${text}`, text, match: "suffix" as const, through: ["vpn2"] as RoutingRule["through"], conditions: ["externalDns", "internalDns", "vpn"] as RoutingRule["conditions"] }));
  const rules = normalizeRoutingRules([
    ...protectedRules,
    ...sourceRules.filter((rule) => !rule.id.startsWith("protected:") && (rule.through[0] === "vpn2" || !PROTECTED_PROXY_SUFFIXES.some((suffix) => rule.text === suffix || rule.text.endsWith(`.${suffix}`)))),
  ]);
  return {
    rules,
    ...(typeof candidate.updatedAt === "string" ? { updatedAt: candidate.updatedAt } : {}),
  };
}

const POLICY_READ_ATTEMPTS = 3;
const POLICY_READ_RETRY_MS = 20;
const waitForPolicyWrite = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, POLICY_READ_RETRY_MS));

export async function loadSmartDnsPolicy(file = smartDnsPolicyPath()): Promise<SmartDnsPolicy> {
  for (let attempt = 1; attempt <= POLICY_READ_ATTEMPTS; attempt += 1) {
    try { return normalizeSmartDnsPolicy(JSON.parse(await readFile(file, "utf8"))); }
    catch (error: unknown) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return DEFAULT_SMART_DNS_POLICY;
      if (error instanceof SyntaxError && attempt < POLICY_READ_ATTEMPTS) { await waitForPolicyWrite(); continue; }
      throw error;
    }
  }
  throw new Error(`unable to load SmartDNS policy from ${file}`);
}

export async function saveSmartDnsPolicy(policy: SmartDnsPolicy, file = smartDnsPolicyPath()): Promise<SmartDnsPolicy> {
  const normalized = { ...normalizeSmartDnsPolicy(policy), updatedAt: new Date().toISOString() };
  await writeFile(file, `${JSON.stringify(normalized, null, 2)}\n`, "utf8");
  return normalized;
}

export function hostFromInput(input: string): string {
  const raw = input.trim();
  if (!raw) throw new Error("empty input");
  try { return normalizeHost((raw.includes("://") ? new URL(raw) : new URL(`https://${raw}`)).hostname); }
  catch { return normalizeHost(raw.split(/[/?#]/, 1)[0] || raw); }
}

export type QuickSmartDnsRouteMode = "smart-dns" | "vpn" | "direct";

/** An exact route-check shortcut with deliberately explicit consumer scopes. */
export function quickSmartDnsRouteRule(host: string, mode: QuickSmartDnsRouteMode): RoutingRule {
  const route: Pick<RoutingRule, "through" | "conditions"> = mode === "smart-dns"
    ? { through: ["vpn2"], conditions: ["internalDns", "vpn"] }
    : mode === "vpn"
      ? { through: ["vpn2"], conditions: ["externalDns", "internalDns", "vpn"] }
      : { through: ["direct"], conditions: ["externalDns", "internalDns", "vpn"] };
  return {
    id: `quick:vpn:${host}`,
    text: host,
    match: "exact",
    ...route,
  };
}

function matches(rule: RoutingRule, host: string): boolean {
  return rule.match !== "set" && (rule.match === "exact" ? rule.text === host : host === rule.text || host.endsWith(`.${rule.text}`));
}

function bestMatchingRule(rules: readonly RoutingRule[], host: string, condition: RoutingRule["conditions"][number]): RoutingRule | undefined {
  return rules.reduce<RoutingRule | undefined>((best, candidate) => {
    if (!candidate.conditions.includes(condition) || !matches(candidate, host)) return best;
    if (!best) return candidate;
    const candidateScore = (candidate.match === "exact" ? 10_000 : 0) + candidate.text.length;
    const bestScore = (best.match === "exact" ? 10_000 : 0) + best.text.length;
    return candidateScore > bestScore ? candidate : best;
  }, undefined);
}

/** DNS defaults are runtime profile defaults: LAN direct, public edge proxy. */
export function checkSmartDnsRoute(input: string, policy: SmartDnsPolicy): SmartDnsRouteCheck {
  const host = hostFromInput(input);
  if (!host) throw new Error("cannot parse host");
  const matchingDnsRules = policy.rules.filter((candidate) => (candidate.conditions.includes("internalDns") || candidate.conditions.includes("externalDns")) && matches(candidate, host));
  const internalDnsRule = bestMatchingRule(matchingDnsRules, host, "internalDns");
  const externalDnsRule = bestMatchingRule(matchingDnsRules, host, "externalDns");
  const vpnRule = bestMatchingRule(policy.rules, host, "vpn");
  const geoCandidates = policy.rules.filter((candidate) => candidate.match === "set" && candidate.conditions.includes("vpn"));
  const localRoute: SmartDnsResolvedRoute = internalDnsRule?.through[0] && internalDnsRule.through[0] !== "direct" ? "proxy" : "direct";
  const publicRoute: SmartDnsResolvedRoute = externalDnsRule ? (externalDnsRule.through[0] !== "direct" ? "proxy" : "direct") : matchingDnsRules.length ? "direct" : "proxy";
  const publicEdgeProfile = publicRoute === "proxy" ? (externalDnsRule?.through[0] === "vusa" ? "vusa" : "public") : null;
  const vpnRoute = vpnRule?.through[0] ?? "unknown";
  const primaryRule = externalDnsRule ?? internalDnsRule ?? vpnRule;
  const route: SmartDnsRoute = publicEdgeProfile === "vusa" ? "vusa-proxy" : localRoute === "proxy" && publicRoute === "direct" ? "local-proxy" : publicRoute;
  return {
    input,
    host,
    route,
    localRoute,
    publicRoute,
    publicEdgeProfile,
    reason: primaryRule ? `routing rule ${primaryRule.match}` : "runtime profile default",
    matched: primaryRule?.text ?? null,
    vpnRoute,
    vpnMatched: vpnRule?.text ?? (geoCandidates.map((candidate) => candidate.text).join(", ") || null),
    dimensions: { internalDns: localRoute, externalDns: publicRoute, lan: localRoute, vpn: vpnRoute },
  };
}

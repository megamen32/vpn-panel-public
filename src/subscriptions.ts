import { Buffer } from "node:buffer";
import { isIP } from "node:net";
import { URLSearchParams } from "node:url";
import type { DbPool } from "./db.js";
import type { Endpoint } from "./types.js";
import type { SecureConfig } from "./secure-config.js";
import type { SmartDnsPolicy } from "./smart-dns-policy.js";
import { clientRoutingPolicyFromSmartDns, xrayDomains } from "./client-routing-policy.js";
import { compileVpnRoutingRules, migrateLegacySmartDnsPolicyToRoutingRules } from "./routing-rules.js";
import type { VpnTestEndpointScore } from "./vpn-test-telemetry.js";
import { getVpnTestEndpointScores } from "./vpn-test-telemetry.js";
import { endpointOrder, isSubscriptionEndpoint, isUserFacingEndpoint, mobileRelayEndpointOrder } from "./secure-config.js";

export type LinkSlot = {
  id: string;
  label: string;
  available: boolean;
  url: string | null;
  reason: string | null;
};

export type ClientBundle = {
  accountId: string;
  clientId: string;
  displayName: string;
  login: string;
  xrayUuid: string;
  token: string;
  endpoints: Endpoint[];
};

export type MacosXrayMode = "smart" | "all";

export type EndpointQuality = {
  endpointId: string;
  observations: number;
  reliability: number | null;
  latencyMs: number | null;
  mbps: number | null;
  source?: string;
};

export const PUBLIC_ENDPOINT_MIN_SCORE = 50;

/**
 * Ranking penalty for transports carried over QUIC.
 *
 * Hysteria2 often measures fastest, so the score alone puts a UDP node first
 * and every client with automatic selection starts there. QUIC fails
 * differently: on a network that answers a latency probe and then throttles
 * UDP, the client shows a connected tunnel and no traffic, which reads as a
 * dead VPN rather than a degraded one. Paying a small, fixed cost keeps the
 * fastest transport available without making it the default a phone lands on.
 */
const QUIC_RANKING_PENALTY = 2;

function rankingScore(endpoint: Endpoint, score: number | null): number | null {
  if (score == null) return null;
  return endpoint.kind === "hysteria2" ? score - QUIC_RANKING_PENALTY : score;
}
const PUBLIC_ENDPOINT_MIN_OBSERVATIONS = 20;

const MACOS_DIRECT_ENDPOINT_ORDER = [
  "de-hysteria2",
  "us-hysteria2",
  "fi-hysteria2",
  "de-xhttp-h2",
  "us-xhttp-h2",
  "us-xhttp-h2-443",
  "de-direct",
  "de-httpupgrade",
  "de-direct-ws",
  "de-xhttp",
  "de-cdn",
  "de-cdn2",
  "us-reality",
  "us-httpupgrade",
  "us-direct-ws",
  "us-xhttp",
  "us-cdn",
  "us-cdn2",
  "fi-helsinki-relay",
] as const;

const MACOS_RELAY_FALLBACK_ORDER = [
  "smart-de-relay",
  "full-de-relay",
  "smart-us-relay",
  "full-us-relay",
  ...mobileRelayEndpointOrder,
] as const;

const MACOS_IP_BY_HOST: Record<string, string> = {
  "fi-vpn.bezrabotnyi.com": "31.76.43.193",
  "vpn2.bezrabotnyi.com": "212.192.31.128",
  "cdn.demiurge.space": "212.192.31.128",
  "cdn2.demiurge.space": "212.192.31.128",
  "runet.bezrabotnyi.com": "95.165.165.65",
  "smart.runet.bezrabotnyi.com": "95.165.165.65",
  "full.runet.bezrabotnyi.com": "95.165.165.65",
  "vusa.bezrabotnyi.com": "185.240.120.152",
  "us-cdn.demiurge.space": "185.240.120.152",
  "us-cdn2.demiurge.space": "185.240.120.152",
};

const MACOS_PRIVATE_CIDRS = [
  "10.0.0.0/8", "100.64.0.0/10", "127.0.0.0/8", "169.254.0.0/16",
  "172.16.0.0/12", "192.0.0.0/24", "192.0.2.0/24", "192.168.0.0/16",
  "198.18.0.0/15", "198.51.100.0/24", "203.0.113.0/24", "::1/128", "fc00::/7", "fe80::/10",
];

const MACOS_ALWAYS_PROXY_DOMAINS = ["cline.bot", "api.cline.bot"] as const;

function stringConfig(endpoint: Endpoint, key: string): string | undefined {
  const value = endpoint.config?.[key];
  return typeof value === "string" && value ? value : undefined;
}

function queryConfig(endpoint: Endpoint): Record<string, string> {
  const query = endpoint.config?.query;
  if (!query || typeof query !== "object" || Array.isArray(query)) {
    return {};
  }
  return Object.fromEntries(
    Object.entries(query).filter((entry): entry is [string, string] => typeof entry[1] === "string"),
  );
}

/** Fragmentation is supported by Happ; legacy noises URI parsing breaks Xray in Happ 5.3. */
const DEFAULT_FRAGMENT = "1-10,5-20,tlshello";

export interface VlessLinkOptions {
  fingerprint?: string;
  nameSuffix?: string;
}

export function vlessLink(endpoint: Endpoint, uuid: string, secure: SecureConfig, opts?: VlessLinkOptions): string | null {
  if (!endpoint.enabled) {
    return null;
  }

  const defaults = secure.defaults;
  const params = new URLSearchParams(queryConfig(endpoint));
  const kind = endpoint.kind || "vless-reality";
  if (kind === "hysteria2") {
    const hy2 = new URLSearchParams({ sni: stringConfig(endpoint, "sni") || params.get("sni") || endpoint.address });
    return `hysteria2://${encodeURIComponent(uuid)}@${endpoint.address}:${endpoint.port}/?${hy2.toString()}#${encodeURIComponent(endpoint.label || endpoint.id)}`;
  }
  const isReality = kind === "vless-reality";

  if (isReality) {
    const publicKey = stringConfig(endpoint, "public_key");
    const shortId = stringConfig(endpoint, "short_id");
    if (!publicKey || !shortId) {
      return null;
    }
    params.set("flow", stringConfig(endpoint, "flow") || defaults.flow);
    params.set("security", "reality");
    params.set("encryption", "none");
    params.set("type", "tcp");
    params.set("sni", stringConfig(endpoint, "sni") || defaults.sni);
    params.set("sid", shortId);
    params.set("fp", opts?.fingerprint || stringConfig(endpoint, "fingerprint") || defaults.fingerprint);
    params.set("pbk", publicKey);
    params.set("headerType", "none");

    const fragment = stringConfig(endpoint, "fragment") || defaults.fragment || DEFAULT_FRAGMENT;
    params.set("fragment", fragment);
    // Happ 5.3 translates the documented legacy noises tuple into rand: "rand",
    // which fails Xray's integer-range parser before the connection starts.
    params.delete("noises");
  } else {
    params.set("encryption", params.get("encryption") || "none");
    if (!params.get("type")) {
      return null;
    }
    // Apply fingerprint override for non-Reality TLS endpoints
    if (opts?.fingerprint) {
      params.set("fp", opts.fingerprint);
    }
  }

  const rawName = endpoint.label || endpoint.id;
  const suffix = opts?.nameSuffix || "";
  const iconName = endpoint.id === "de-direct" || endpoint.id.startsWith("de-")
    ? `🇩🇪 ${rawName}${suffix}`
    : endpoint.id.startsWith("ru-")
      ? `🇷🇺 ${rawName}${suffix}`
    : endpoint.id.startsWith("us-")
      ? `🇺🇸 ${rawName}${suffix}`
      : endpoint.id.startsWith("fi-")
        ? `🇫🇮 ${rawName}${suffix}`
        : `${rawName}${suffix}`;

  return `vless://${uuid}@${endpoint.address}:${endpoint.port}?${params.toString()}#${encodeURIComponent(iconName)}`;
}

export function linkSlots(bundle: ClientBundle, secure: SecureConfig): LinkSlot[] {
  const byId = new Map(bundle.endpoints.map((endpoint) => [endpoint.id, endpoint]));
  const productIds = [
    ...endpointOrder,
    ...bundle.endpoints
      .filter((endpoint) => isPublicCatalogEndpoint(endpoint) && !endpointOrder.includes(endpoint.id as typeof endpointOrder[number]))
      .sort((left, right) => left.sort_order - right.sort_order || left.id.localeCompare(right.id))
      .map((endpoint) => endpoint.id),
  ];
  return productIds.map((id) => {
    const endpoint = byId.get(id);
    if (!endpoint) {
      return { id, label: id, available: false, url: null, reason: "not assigned" };
    }
    const url = vlessLink(endpoint, bundle.xrayUuid, secure);
    if (!url) {
      return {
        id,
        label: endpoint.label,
        available: false,
        url: null,
        reason: endpoint.enabled ? "not configured" : "disabled",
      };
    }
    return { id, label: endpoint.label, available: true, url, reason: null };
  });
}


// Client-side VPN whitelist (policy 2026-08-16): like the local SmartDNS
// profile, the VPN carries only the OpenAI, Telegram, and WhatsApp families;
// every other destination — above all any Russian one — is strictly direct.
const HAPP_PROXY_SITES: string[] = [
  // OpenAI family (workos hosts the auth flow)
  "openai.com",
  "chatgpt.com",
  "oaistatic.com",
  "oaiusercontent.com",
  "oaistatsig.com",
  "openaimerge.com",
  "workos.com",
  "workoscdn.com",
  "openrouter.ai",
  "github.com",
  "githubcopilot.com",
  "githubassets.com",
  "githubusercontent.com",
  "default.exp-tas.com",
  "discord.com",
  "discord.gg",
  "discordapp.com",
  "discordapp.net",
  "facebook.com",
  "facebook.net",
  "fb.com",
  "fbcdn.net",
  "youtube.com",
  "youtu.be",
  "googlevideo.com",
  // Telegram family
  "telegram.org",
  "telegram.me",
  "t.me",
  "tdesktop.com",
  "telesco.pe",
  "telegra.ph",
  // WhatsApp family
  "whatsapp.com",
  "whatsapp.net",
  "wa.me",
];

// Official Telegram DC ranges (core.telegram.org/resources/cidr.txt). Telegram
// apps connect to hardcoded DC IPs, so domain rules alone miss most traffic.
// The compact russia-only geoip has no telegram category, hence literal CIDRs.
const HAPP_PROXY_IP: string[] = [
  "91.108.56.0/22",
  "91.108.4.0/22",
  "91.108.8.0/22",
  "91.108.16.0/22",
  "91.108.12.0/22",
  "91.108.20.0/22",
  "91.105.192.0/23",
  "149.154.160.0/20",
  "185.76.151.0/24",
  "2001:67c:4e8::/48",
  "2001:b28:f23c::/48",
  "2001:b28:f23d::/48",
  "2001:b28:f23f::/48",
  "2a0a:f280::/32",
];

export function happRoutingLink(policy?: SmartDnsPolicy): string {
  const vpnRules = policy ? compileVpnRoutingRules(policy.rules ?? migrateLegacySmartDnsPolicyToRoutingRules(policy)) : [];
  const directSites = vpnRules.filter((rule) => rule.through[0] === "direct").flatMap((rule) => rule.domain);
  const directIp = vpnRules.filter((rule) => rule.through[0] === "direct").flatMap((rule) => rule.ip);
  const proxySites = vpnRules.filter((rule) => rule.through[0] !== "direct").flatMap((rule) => rule.domain);
  const proxyIp = vpnRules.filter((rule) => rule.through[0] !== "direct").flatMap((rule) => rule.ip);
  const routing = {
    Name: "Relay-managed routing",
    GlobalProxy: "false",
    RemoteDNSType: "DoH",
    RemoteDNSDomain: "https://dns.google/dns-query",
    RemoteDNSIP: "8.8.8.8",
    DomesticDNSType: "DoU",
    DomesticDNSDomain: "77.88.8.8",
    DomesticDNSIP: "77.88.8.8",
    Geoipurl: "https://github.com/golukon/russia-only-geoip/releases/latest/download/geoip.dat",
    Geositeurl: "https://github.com/golukon/russia-only-geosite/releases/latest/download/geosite.dat",
    LastUpdated: "",
    DnsHosts: {
      "dns.google": "8.8.8.8",
      "cloudflare-dns.com": "1.1.1.1",
    },
    // Default route is direct, mirroring the local SmartDNS profile. Russian
    // destinations are pinned direct explicitly (geosite:ru-inside, geoip:ru)
    // so no proxy rule can ever capture them. The exact panel host
    // (vpn.bezrabotnyi.com) goes direct so users can fetch the subscription
    // while VPN is up; the bare "bezrabotnyi.com" would also match
    // vpn2.bezrabotnyi.com and vusa.bezrabotnyi.com (the actual VPN endpoints)
    // and break all VPN traffic.
    DirectSites: policy ? directSites : ["vpn.bezrabotnyi.com", "geosite:ru-inside"],
    DirectIp: policy ? directIp : ["geoip:private", "geoip:ru"],
    ProxySites: policy ? proxySites : HAPP_PROXY_SITES,
    ProxyIp: policy ? proxyIp : HAPP_PROXY_IP,
    // The compact RU-only geosite intentionally omits category-ads-all. Ad
    // blocking belongs in a dedicated DNS/filtering layer, not this routing DB.
    BlockSites: [],
    BlockIp: [],
    DomainStrategy: "IPIfNonMatch",
    FakeDNS: "false"
  };
  const encoded = Buffer.from(JSON.stringify(routing), "utf8").toString("base64");
  return `happ://routing/onadd/${encoded}`;
}

/** Display name for a subscription entry, keeping the region flag convention. */
function endpointIconName(endpoint: Endpoint): string {
  const raw = endpoint.label || endpoint.id;
  if (endpoint.id === "de-direct" || endpoint.id.startsWith("de-")) return `\u{1F1E9}\u{1F1EA} ${raw}`;
  if (endpoint.id.startsWith("ru-")) return `\u{1F1F7}\u{1F1FA} ${raw}`;
  if (endpoint.id.startsWith("us-")) return `\u{1F1FA}\u{1F1F8} ${raw}`;
  if (endpoint.id.startsWith("fi-")) return `\u{1F1EB}\u{1F1EE} ${raw}`;
  return raw;
}

/**
 * Convert one Hysteria2 endpoint into a hy2:// subscription link.
 *
 * The credential is the client UUID, not a separate password: the fleet-wide
 * Hysteria2 deploy script pushes every enabled client's xray_uuid as the
 * inbound `auth`, so one UUID covers both the VLESS and the Hysteria2 exits.
 */
export function hysteria2Link(endpoint: Endpoint, uuid: string): string | null {
  if (!endpoint.enabled) return null;
  const sni = stringConfig(endpoint, "sni") || queryConfig(endpoint).sni || endpoint.address;
  const params = new URLSearchParams();
  params.set("sni", sni);
  params.set("insecure", "0");
  const obfs = stringConfig(endpoint, "obfs");
  if (obfs) {
    params.set("obfs", obfs);
    const obfsPassword = stringConfig(endpoint, "obfs_password");
    if (obfsPassword) params.set("obfs-password", obfsPassword);
  }
  const icon = endpointIconName(endpoint);
  // Catalog labels already end in "· Hysteria2"; only label it when they do not.
  const name = /hysteria2/i.test(icon) ? icon : `${icon} (Hysteria2)`;
  return `hy2://${uuid}@${endpoint.address}:${endpoint.port}?${params.toString()}#${encodeURIComponent(name)}`;
}

/** Generate all VLESS links for an endpoint. */
function allEndpointLinks(endpoint: Endpoint, uuid: string, secure: SecureConfig): string[] {
  if (!endpoint.enabled) return [];
  if (endpoint.kind === "hysteria2") {
    const hy2 = hysteria2Link(endpoint, uuid);
    return hy2 ? [hy2] : [];
  }
  const link = vlessLink(endpoint, uuid, secure);
  return link ? [link] : [];
}

/** A public product can be declared by data, so a new regional exit needs no UI code. */
export function isPublicCatalogEndpoint(endpoint: Endpoint): boolean {
  return isUserFacingEndpoint(endpoint.id) || endpoint.config.public_catalog === true;
}

/** Select products and restored fallbacks in their stable subscription order. */
export function orderPublicSubscriptionEndpoints(
  endpoints: Endpoint[],
  scores: readonly VpnTestEndpointScore[],
): Endpoint[] {
  const scoreById = new Map(scores.map((score) => [score.endpointId, score]));
  return endpoints
    .filter((endpoint) => endpoint.enabled && (isSubscriptionEndpoint(endpoint.id) || isPublicCatalogEndpoint(endpoint)))
    .filter((endpoint) => {
      const score = scoreById.get(endpoint.id);
      return !score
        || score.effectiveObservations < PUBLIC_ENDPOINT_MIN_OBSERVATIONS
        || score.score == null
        || score.score >= PUBLIC_ENDPOINT_MIN_SCORE;
    })
    .sort((left, right) => {
      const leftScore = scoreById.get(left.id);
      const rightScore = scoreById.get(right.id);
      const leftRank = rankingScore(left, leftScore?.score ?? null);
      const rightRank = rankingScore(right, rightScore?.score ?? null);
      if (leftRank != null && rightRank != null && leftRank !== rightRank) {
        return rightRank - leftRank;
      }
      if (leftScore && rightScore && leftScore.score == null && rightScore.score != null) return 1;
      if (leftScore && rightScore && leftScore.score != null && rightScore.score == null) return -1;
      if (leftScore && rightScore && leftScore.telegramMedianMs !== rightScore.telegramMedianMs) {
        return (leftScore.telegramMedianMs ?? Number.MAX_SAFE_INTEGER) - (rightScore.telegramMedianMs ?? Number.MAX_SAFE_INTEGER);
      }
      if (leftScore && !rightScore) return -1;
      if (!leftScore && rightScore) return 1;
      return left.sort_order - right.sort_order || left.id.localeCompare(right.id);
    });
}

/** Preserve the score-ordered bundle while excluding non-subscription catalog entries. */
function orderedSubscriptionEndpoints(endpoints: Endpoint[]): Endpoint[] {
  return endpoints.filter((endpoint) => endpoint.enabled && (isSubscriptionEndpoint(endpoint.id) || isPublicCatalogEndpoint(endpoint)));
}

export function plainSubscription(bundle: ClientBundle, secure: SecureConfig): string {
  const links: string[] = [];

  for (const endpoint of orderedSubscriptionEndpoints(bundle.endpoints)) {
    links.push(...allEndpointLinks(endpoint, bundle.xrayUuid, secure));
  }

  return links.join("\n").concat("\n");
}

export function v2raySubscription(bundle: ClientBundle, secure: SecureConfig): string {
  return Buffer.from(plainSubscription(bundle, secure), "utf8").toString("base64");
}

function realityOutbound(endpoint: Endpoint, uuid: string, secure: SecureConfig): Record<string, unknown> | null {
  if (endpoint.kind !== "vless-reality" || !endpoint.enabled) {
    return null;
  }
  const publicKey = stringConfig(endpoint, "public_key");
  const shortId = stringConfig(endpoint, "short_id");
  if (!publicKey || !shortId) {
    return null;
  }
  return {
    type: "vless",
    tag: endpoint.id,
    server: endpoint.address,
    server_port: endpoint.port,
    uuid,
    flow: stringConfig(endpoint, "flow") || secure.defaults.flow,
    tls: {
      enabled: true,
      server_name: stringConfig(endpoint, "sni") || secure.defaults.sni,
      reality: { enabled: true, public_key: publicKey, short_id: shortId },
      utls: { enabled: true, fingerprint: stringConfig(endpoint, "fingerprint") || secure.defaults.fingerprint },
    },
  };
}

function singBoxTransport(endpoint: Endpoint, query: Record<string, string>, secure: SecureConfig): Record<string, unknown> | null {
  const kind = endpoint.kind;
  if (kind === "vless-reality") return null; // handled by realityOutbound

  const transport = query.type;
  if (transport !== "ws" && transport !== "httpupgrade") return null;

  const tls: Record<string, unknown> = {
    enabled: true,
    server_name: query.sni || secure.defaults.sni,
    utls: { enabled: true, fingerprint: query.fp || secure.defaults.fingerprint },
  };

  if (transport === "ws") {
    return {
      type: "vless",
      tag: endpoint.id,
      server: endpoint.address,
      server_port: endpoint.port,
      uuid: "", // placeholder, caller fills
      tls,
      transport: {
        type: "ws",
        path: query.path || "/",
        headers: query.host ? { Host: query.host } : undefined,
      },
    };
  }

  if (transport === "httpupgrade") {
    return {
      type: "vless",
      tag: endpoint.id,
      server: endpoint.address,
      server_port: endpoint.port,
      uuid: "", // placeholder, caller fills
      tls,
      transport: {
        type: "httpupgrade",
        host: query.host || endpoint.address,
        path: query.path || "/",
      },
    };
  }

  return null;
}

/** Convert one enabled catalog endpoint into its sing-box VLESS outbound. */
export function singBoxOutboundFromEndpoint(endpoint: Endpoint, uuid: string, secure: SecureConfig): Record<string, unknown> | null {
  if (!endpoint.enabled) return null;
  if (endpoint.kind === "hysteria2") {
    return { type: "hysteria2", tag: endpoint.id, server: endpoint.address, server_port: endpoint.port,
      password: uuid, tls: { enabled: true, server_name: stringConfig(endpoint, "sni") || queryConfig(endpoint).sni || endpoint.address } };
  }

  // Reality endpoints (existing logic)
  if (endpoint.kind === "vless-reality") {
    return realityOutbound(endpoint, uuid, secure);
  }

  // WS and HTTPUpgrade endpoints
  const query = queryConfig(endpoint);
  const base = singBoxTransport(endpoint, query, secure);
  if (!base) return null;
  base.uuid = uuid;
  return base;
}

export function singBoxSubscription(bundle: ClientBundle, secure: SecureConfig): Record<string, unknown> {
  const outbounds = orderedSubscriptionEndpoints(bundle.endpoints)
    .map((endpoint) => singBoxOutboundFromEndpoint(endpoint, bundle.xrayUuid, secure))
    .filter((outbound): outbound is Record<string, unknown> => outbound !== null);
  const tags = outbounds.map((outbound) => String(outbound.tag));
  if (!tags.length) {
    throw new Error("client has no sing-box compatible endpoints");
  }

  return {
    log: { level: "info" },
    dns: {
      servers: [
        { type: "local", tag: "local" },
        { type: "https", tag: "remote", server: "1.1.1.1", detour: "proxy" },
      ],
      // Local resolution stays for private ranges, which cannot be answered by a
      // public resolver. Everything public resolves through the tunnel, because
      // a direct lookup is exactly what a network that censors DNS blocks.
      // ip_is_private is a DNS-rule field; ip_accept_private is a route-rule
      // field that sing-box rejects here, and a strict parse turns that into a
      // config that refuses to load.
      rules: [{ ip_is_private: true, server: "local" }],
      final: "remote",
    },
    inbounds: [{ type: "mixed", tag: "mixed-in", listen: "127.0.0.1", listen_port: 2080 }],
    outbounds: [
      // A client that honours this selector starts here, so it must not start
      // on QUIC: UDP answers a latency probe on a network that then refuses to
      // carry the traffic, which presents as a working tunnel with no internet.
      { type: "selector", tag: "proxy", outbounds: tags, default: tags.find((tag) => !tag.includes("hysteria")) ?? tags[0] },
      ...outbounds,
      { type: "direct", tag: "direct" },
      { type: "block", tag: "block" },
    ],
    route: {
      // sing-box 1.12 requires an explicit resolver for outbound dial
      // domains; without it the config refuses to load on current cores and
      // needs a deprecated-behaviour escape hatch even on 1.13.
      default_domain_resolver: { server: "remote" },
      // No remote rule set. sing-box downloads declared rule sets during route
      // init with FastFail, so a network that cannot reach the download host
      // fails to initialise routing at all rather than degrading: a tunnel that
      // is up and carrying nothing. A subscription that works has to be
      // self-contained, and none of these rules needed the set anyway.
      rules: [
        { ip_is_private: true, outbound: "direct" },
      ],
      final: "proxy",
      auto_detect_interface: true,
    },
  };
}

function uniqueSorted(values: string[]): string[] {
  return [...new Set(values)].sort();
}

/** Build the password-protected macOS profile: SmartDNS families use VPN, everything else is direct. */
export function macosSingBoxSubscription(
  bundle: ClientBundle,
  secure: SecureConfig,
  policy: SmartDnsPolicy,
): Record<string, unknown> {
  const config = singBoxSubscription(bundle, secure);
  const proxy = (config.outbounds as Array<Record<string, unknown>>).find((outbound) => outbound.tag === "proxy");
  if (!proxy) throw new Error("sing-box subscription has no proxy selector");

  const vpnRules = compileVpnRoutingRules(policy.rules ?? migrateLegacySmartDnsPolicyToRoutingRules(policy));
  const domainsFor = (target: "direct" | "proxy") => vpnRules
    .filter((rule) => (target === "direct") === (rule.through[0] === "direct"))
    .flatMap((rule) => rule.domain);
  const policyProxyDomains = uniqueSorted(domainsFor("proxy").filter((domain) => domain.startsWith("domain:")).map((domain) => domain.slice("domain:".length)));
  const policyProxyExactDomains = uniqueSorted(domainsFor("proxy").filter((domain) => domain.startsWith("full:")).map((domain) => domain.slice("full:".length)));
  const directSuffixes = uniqueSorted(domainsFor("direct").filter((domain) => domain.startsWith("domain:")).map((domain) => domain.slice("domain:".length)));
  const directDomains = uniqueSorted(domainsFor("direct").filter((domain) => domain.startsWith("full:")).map((domain) => domain.slice("full:".length)));
  const proxyTags = Array.isArray(proxy.outbounds) ? proxy.outbounds.map(String) : [];
  proxy.default = proxyTags.includes("de-httpupgrade") ? "de-httpupgrade" : proxyTags[0];

  config.dns = {
    // Bootstrap DNS must stay direct: resolving vpn2 through the not-yet-started
    // proxy creates a startup loop on a fresh client installation.
    servers: [
      { type: "local", tag: "local" },
      { type: "https", tag: "remote", server: "1.1.1.1", path: "/dns-query" },
    ],
    rules: [],
    final: "remote",
  };
  config.inbounds = [{ type: "mixed", tag: "mixed-in", listen: "127.0.0.1", listen_port: 2080 }];
  config.route = {
    rules: [
      { ip_is_private: true, outbound: "direct" },
      { domain_suffix: policyProxyDomains, outbound: "proxy" },
      { domain: policyProxyExactDomains, outbound: "proxy" },
      { domain_suffix: directSuffixes, outbound: "direct" },
      { domain: directDomains, outbound: "direct" },
    ],
    final: "direct",
    default_domain_resolver: "local",
    auto_detect_interface: true,
  };
  return config;
}

function xrayOutbound(endpoint: Endpoint, uuid: string, secure: SecureConfig): Record<string, unknown> | null {
  if (!endpoint.enabled) {
    return null;
  }
  const query = queryConfig(endpoint);
  switch (endpoint.kind) {
    case "hysteria2":
      return {
        tag: endpoint.id,
        protocol: "hysteria",
        settings: { version: 2, address: endpoint.address, port: endpoint.port },
        streamSettings: {
          network: "hysteria", security: "tls",
          tlsSettings: { serverName: stringConfig(endpoint, "sni") || query.sni || endpoint.address },
          hysteriaSettings: { version: 2, auth: uuid },
        },
      };
    case "vless-reality": {
      const publicKey = stringConfig(endpoint, "public_key") || query.pbk;
      const shortId = stringConfig(endpoint, "short_id") || query.sid;
      if (!publicKey || !shortId) {
        return null;
      }
      return {
        tag: endpoint.id,
        protocol: "vless",
        settings: {
          vnext: [
            {
              address: endpoint.address,
              port: endpoint.port,
              users: [{ id: uuid, encryption: "none", flow: stringConfig(endpoint, "flow") || query.flow || secure.defaults.flow }],
            },
          ],
        },
        streamSettings: {
          network: "tcp",
          security: "reality",
          realitySettings: {
            serverName: stringConfig(endpoint, "sni") || query.sni || secure.defaults.sni,
            fingerprint: stringConfig(endpoint, "fingerprint") || query.fp || secure.defaults.fingerprint,
            publicKey,
            shortId,
          },
        },
      };
    }
    case "vless-ws":
    case "vless-xhttp":
    case "vless-httpupgrade":
    case "vless-grpc": {
      const transport = query.type || "tcp";
      return {
        tag: endpoint.id,
        protocol: "vless",
        settings: {
          vnext: [
            {
              address: endpoint.address,
              port: endpoint.port,
              users: [{ id: uuid, encryption: "none" }],
            },
          ],
        },
        streamSettings: xrayStreamSettings(transport, query),
      };
    }
    default:
      return null;
  }
}

function xrayStreamSettings(transport: string, query: Record<string, string>): Record<string, unknown> {
  const tlsSettings: Record<string, unknown> = {};
  if (query.sni) tlsSettings.serverName = query.sni;
  if (query.fp) tlsSettings.fingerprint = query.fp;
  if (query.alpn) tlsSettings.alpn = [query.alpn];

  const base: Record<string, unknown> = {
    network: transport,
    security: query.security || "tls",
  };
  if (query.security !== "none") {
    base.tlsSettings = tlsSettings;
  }

  switch (transport) {
    case "ws":
      // WS requires HTTP/1.1 ALPN; without it, TLS may negotiate HTTP/2
      // which breaks the WebSocket upgrade through nginx
      if (!tlsSettings.alpn) tlsSettings.alpn = ["http/1.1"];
      base.wsSettings = {
        path: query.path || "/",
        ...(query.host ? { host: query.host } : {}),
      };
      break;
    case "xhttp": {
      const xhttp: Record<string, unknown> = {
        path: query.path || "/",
        host: query.host || undefined,
        mode: query.mode || "auto",
      };
      if (query.h2 !== undefined) {
        xhttp.h2 = query.h2 === "true" || query.h2 === "1";
      } else {
        xhttp.h2 = false;
      }
      base.xhttpSettings = xhttp;
      break;
    }
    case "httpupgrade":
      base.httpupgradeSettings = {
        path: query.path || "/",
        host: query.host || undefined,
      };
      break;
    case "grpc":
      base.grpcSettings = {
        serviceName: query.serviceName || "",
      };
      break;
  }
  return base;
}

export function xrayClientSubscription(
  bundle: ClientBundle,
  secure: SecureConfig,
  options: { includeEveryAssignedEndpoint?: boolean } = {},
): Record<string, unknown> {
  // The public bundle is a product list, so it is filtered down to what is
  // sold. The diagnostic bundle exists to measure everything assigned, and
  // re-filtering it here would hide exactly the endpoints whose health cannot
  // be established, leaving their verdicts frozen instead of observed.
  const selected = options.includeEveryAssignedEndpoint
    ? bundle.endpoints.filter((endpoint) => endpoint.enabled)
    : orderedSubscriptionEndpoints(bundle.endpoints);
  const outbounds = selected
    .map((endpoint) => xrayOutbound(endpoint, bundle.xrayUuid, secure))
    .filter((outbound): outbound is Record<string, unknown> => outbound !== null);
  if (!outbounds.length) {
    throw new Error("client has no Xray compatible endpoints");
  }
  const tags = outbounds.map((outbound) => String(outbound.tag));
  // Pinning tcp,udp to outbounds[0] made a seventeen-server bundle a single-server
  // config: whichever endpoint happened to sort first took every byte, and on a
  // censored mobile network that one endpoint being an unusable UDP transport
  // looks exactly like a dead VPN. Balance on measured reachability instead, and
  // fall back to the most broadly supported transport when nothing probes well.
  const fallbackTag = tags.find((tag) => tag.includes("relay")) ?? tags[0];
  const rules: Record<string, unknown>[] = [
    { type: "field", ip: ["geoip:private"], outboundTag: "direct" },
  ];
  rules.push({ type: "field", network: "tcp,udp", balancerTag: "bez-all" });

  return {
    log: { loglevel: "warning" },
    inbounds: [
      { tag: "socks-in", port: 10808, listen: "127.0.0.1", protocol: "socks", settings: { auth: "noauth", udp: true } },
      { tag: "http-in", port: 10809, listen: "127.0.0.1", protocol: "http" },
    ],
    outbounds: [...outbounds, { tag: "direct", protocol: "freedom" }, { tag: "block", protocol: "blackhole" }],
    observatory: {
      subjectSelector: tags,
      probeUrl: "https://www.gstatic.com/generate_204",
      probeInterval: "10m",
      enableConcurrency: true,
    },
    routing: {
      domainStrategy: secure.defaults.domain_strategy,
      rules,
      balancers: [{ tag: "bez-all", selector: tags, fallbackTag, strategy: { type: "leastPing" } }],
    },
  };
}

function macosDomainRules(policy: SmartDnsPolicy, target: "direct" | "vpn2" | "vusa", route: "direct" | "proxy"): Record<string, unknown>[] {
  const rules = compileVpnRoutingRules(policy.rules ?? migrateLegacySmartDnsPolicyToRoutingRules(policy)).filter((rule) => rule.through[0] === target);
  return rules.flatMap((rule) => {
    const fields: Record<string, unknown> = { type: "field", outboundTag: route };
    if (rule.domain.length) fields.domain = rule.domain;
    if (rule.ip.length) fields.ip = rule.ip;
    return (rule.domain.length || rule.ip.length) ? [fields] : [];
  });
}

function macosEndpoints(bundle: ClientBundle, secure: SecureConfig): Record<string, unknown>[] {
  const byId = new Map(bundle.endpoints.map((endpoint) => [endpoint.id, endpoint]));
  const orderedIds = [...MACOS_DIRECT_ENDPOINT_ORDER, ...MACOS_RELAY_FALLBACK_ORDER];
  return orderedIds
    .map((id) => byId.get(id))
    .filter((endpoint): endpoint is Endpoint => endpoint !== undefined)
    .map((endpoint) => {
      const address = isIP(endpoint.address) ? endpoint.address : MACOS_IP_BY_HOST[endpoint.address];
      if (!address) return null;
      return xrayOutbound({ ...endpoint, address }, bundle.xrayUuid, secure);
    })
    .filter((outbound): outbound is Record<string, unknown> => outbound !== null);
}

function macosRegionTags(outbounds: Record<string, unknown>[], region: "de" | "us"): string[] {
  const prefix = region + "-";
  const tags = outbounds
    .map((outbound) => String(outbound.tag))
    // Helsinki is an explicit cross-region leastPing candidate: Smart Auto
    // may choose it for either regional policy when it has the lower latency.
    .filter((tag) => tag.startsWith("fi-") || tag.startsWith(prefix) || tag.startsWith("smart-" + region + "-") || tag.startsWith("full-" + region + "-"));
  return tags.length ? tags : outbounds.map((outbound) => String(outbound.tag));
}

function macosFallbackTag(tags: string[], preferred: string): string {
  return tags.includes(preferred) ? preferred : tags[0];
}

/** Generate the macOS Xray profile for rootless system-proxy operation. */
export function macosXraySubscription(
  bundle: ClientBundle,
  secure: SecureConfig,
  policy: SmartDnsPolicy,
  mode: MacosXrayMode,
): Record<string, unknown> {
  const outbounds = macosEndpoints(bundle, secure);
  if (!outbounds.length) {
    throw new Error("client has no macOS Xray compatible endpoints");
  }

  const allTags = outbounds.map((outbound) => String(outbound.tag));
  const deTags = macosRegionTags(outbounds, "de");
  const usTags = macosRegionTags(outbounds, "us");
  const deFallback = macosFallbackTag(deTags, "de-httpupgrade");
  const usFallback = macosFallbackTag(usTags, "us-reality");
  const allFallback = macosFallbackTag(allTags, "de-httpupgrade");

  const localDirectRules = mode === "smart"
    ? macosDomainRules(policy, "direct", "direct")
    : [{ type: "field", domain: ["domain:local", "domain:lan", "full:localhost"], outboundTag: "direct" }];
  const rules: Record<string, unknown>[] = [
    ...(mode === "smart" && clientRoutingPolicyFromSmartDns(policy).block.length
      ? [{ type: "field", domain: xrayDomains(clientRoutingPolicyFromSmartDns(policy).block), outboundTag: "block" }]
      : []),
    { type: "field", ip: MACOS_PRIVATE_CIDRS, outboundTag: "direct" },
    ...localDirectRules,
  ];
  const hasVusaRules = compileVpnRoutingRules(policy.rules ?? migrateLegacySmartDnsPolicyToRoutingRules(policy)).some((rule) => rule.through[0] === "vusa");
  if (mode === "smart" && hasVusaRules) {
    const vusaRules = macosDomainRules(policy, "vusa", "proxy").map((rule) => ({ ...rule, outboundTag: undefined, balancerTag: "bez-us" }));
    rules.push(...vusaRules);
  }
  if (mode === "smart") {
    const proxyRules = macosDomainRules(policy, "vpn2", "proxy").map((rule) => ({ ...rule, outboundTag: undefined, balancerTag: "bez-de" }));
    rules.push(...proxyRules);
    rules.push({
      type: "field",
      domain: MACOS_ALWAYS_PROXY_DOMAINS.map((domain) => "domain:" + domain),
      balancerTag: "bez-de",
    });
  }

  if (mode === "all") {
    rules.push({ type: "field", network: "tcp,udp", balancerTag: "bez-all" });
  } else {
    rules.push({ type: "field", network: "tcp,udp", outboundTag: "direct" });
  }

  const balancers: Record<string, unknown>[] = [];
  if (mode === "smart") {
    balancers.push({ tag: "bez-de", selector: deTags, fallbackTag: deFallback, strategy: { type: "leastPing" } });
  }
  if (mode === "smart" && hasVusaRules) {
    balancers.push({ tag: "bez-us", selector: usTags, fallbackTag: usFallback, strategy: { type: "leastPing" } });
  }
  if (mode === "all") {
    balancers.push({ tag: "bez-all", selector: allTags, fallbackTag: allFallback, strategy: { type: "leastPing" } });
  }

  const proxySniffing = {
    enabled: true,
    destOverride: ["http", "tls", "quic"],
    routeOnly: true,
  };
  return {
    log: { loglevel: "warning" },
    inbounds: [
      { tag: "socks-in", port: 10808, listen: "127.0.0.1", protocol: "socks", settings: { auth: "noauth", udp: true }, sniffing: proxySniffing },
      { tag: "http-in", port: 10809, listen: "127.0.0.1", protocol: "http", sniffing: proxySniffing },
    ],
    outbounds: [...outbounds, { tag: "direct", protocol: "freedom" }, { tag: "block", protocol: "blackhole" }],
    observatory: {
      subjectSelector: ["de-", "us-", "smart-de-", "full-de-", "smart-us-", "full-us-"],
      probeUrl: "https://www.gstatic.com/generate_204",
      probeInterval: "10s",
      enableConcurrency: true,
    },
    routing: {
      domainStrategy: secure.defaults.domain_strategy,
      rules,
      balancers,
    },
  };
}

/** One real automatic profile, followed by ranked manual choices for Happ. */
export function happJsonSubscription(
  bundle: ClientBundle, secure: SecureConfig, policy: SmartDnsPolicy,
  quality: readonly EndpointQuality[] = [],
): Record<string, unknown>[] {
  const byId = new Map(quality.map((item) => [item.endpointId, item]));
  const endpoints = orderedSubscriptionEndpoints(bundle.endpoints).slice().sort((a, b) => {
    const left = byId.get(a.id), right = byId.get(b.id);
    const reliability = (right?.reliability ?? -1) - (left?.reliability ?? -1);
    if (reliability) return reliability;
    return (left?.latencyMs ?? Infinity) - (right?.latencyMs ?? Infinity) || a.sort_order - b.sort_order;
  });
  // Historical failures keep a route out of the automatic pool, while manual
  // diagnostics remain possible. Unknown routes are not labelled healthy.
  const stable = endpoints.filter((endpoint) => {
    const item = byId.get(endpoint.id);
    return item?.reliability != null && item.reliability >= 95;
  });
  const candidates = stable.length >= 2 ? stable : endpoints;
  const auto = macosXraySubscription({ ...bundle, endpoints: candidates }, secure, policy, "smart");
  const outbounds = auto.outbounds as Record<string, unknown>[];
  const rank = new Map(candidates.map((endpoint, index) => [endpoint.id, index]));
  const routing = auto.routing as Record<string, unknown>;
  for (const balancer of routing.balancers as Record<string, unknown>[]) {
    const tags = (balancer.selector as string[]).sort((a, b) => (rank.get(a) ?? 999) - (rank.get(b) ?? 999));
    balancer.fallbackTag = tags[0];
  }
  (auto.observatory as Record<string, unknown>).subjectSelector = outbounds
    .filter((outbound) => outbound.protocol !== "freedom" && outbound.protocol !== "blackhole")
    .map((outbound) => String(outbound.tag));
  auto.remarks = "⚡ Авто · стабильный";
  auto.meta = { serverDescription: "История стабильности + живая проверка маршрутов каждые 10 с" };
  const manual = endpoints.map((endpoint) => {
    const config = macosXraySubscription({ ...bundle, endpoints: [endpoint] }, secure, policy, "smart");
    const manualRouting = config.routing as Record<string, unknown>;
    for (const rule of manualRouting.rules as Record<string, unknown>[]) {
      if (rule.balancerTag) { delete rule.balancerTag; rule.outboundTag = endpoint.id; }
    }
    delete manualRouting.balancers;
    delete config.observatory;
    const item = byId.get(endpoint.id);
    const details = item?.reliability == null ? ["Нет свежей истории"]
      : [`Успех ${item.reliability.toFixed(1)}% из ${item.observations} проверок за 3 д.`];
    if (item?.latencyMs != null) details.push(`HTTPS ${Math.round(item.latencyMs)} мс`);
    if (item?.mbps != null) details.push(`${item.mbps.toFixed(1)} Мбит/с`);
    config.remarks = endpoint.label;
    config.meta = { serverDescription: [item?.source, ...details].filter(Boolean).join(" · ") };
    return config;
  });
  return [auto, ...manual];
}

export async function bundleByToken(pool: DbPool, token: string): Promise<ClientBundle | null> {
  const result = await pool.query(
    `select
       a.id::text as account_id,
       a.display_name,
       a.login,
       vc.id::text as client_id,
       vc.xray_uuid::text as xray_uuid,
       st.token
     from subscription_tokens st
     join vpn_clients vc on vc.id = st.client_id
     join accounts a on a.id = vc.account_id
     where st.token = $1 and st.enabled = true and vc.enabled = true and a.enabled = true`,
    [token],
  );
  const row = result.rows[0];
  if (!row) {
    return null;
  }
  await pool.query("update subscription_tokens set last_used_at = now() where token = $1", [token]);
  const endpoints = await endpointsForClient(pool, row.client_id);
  return {
    accountId: row.account_id,
    clientId: row.client_id,
    displayName: row.display_name,
    login: row.login,
    xrayUuid: row.xray_uuid,
    token: row.token,
    endpoints,
  };
}

export async function bundleByAccount(pool: DbPool, accountId: string): Promise<ClientBundle | null> {
  const result = await pool.query(
    `select
       a.id::text as account_id,
       a.display_name,
       a.login,
       vc.id::text as client_id,
       vc.xray_uuid::text as xray_uuid,
       (
         select st.token from subscription_tokens st
         where st.client_id = vc.id and st.enabled = true
         order by st.created_at desc limit 1
       ) as token
     from accounts a
     join vpn_clients vc on vc.account_id = a.id
     where a.id = $1 and a.enabled = true and vc.enabled = true`,
    [accountId],
  );
  const row = result.rows[0];
  if (!row?.token) {
    return null;
  }
  return {
    accountId: row.account_id,
    clientId: row.client_id,
    displayName: row.display_name,
    login: row.login,
    xrayUuid: row.xray_uuid,
    token: row.token,
    endpoints: await endpointsForClient(pool, row.client_id),
  };
}

export async function endpointsForClient(pool: DbPool, clientId: string): Promise<Endpoint[]> {
  const result = await pool.query<Endpoint>(
    `select e.id, e.label, e.kind, e.address, e.port, e.profile_id, e.enabled, e.sort_order, e.config
     from client_profiles cp
     join endpoints e on e.id = cp.endpoint_id
     where cp.client_id = $1
     order by e.sort_order, e.id`,
    [clientId],
  );
  return orderPublicSubscriptionEndpoints(result.rows, await getVpnTestEndpointScores(pool));
}

/**
 * Return every enabled endpoint assigned to a client for authenticated health
 * probes. The normal subscription deliberately omits diagnostic transports
 * and unhealthy public fallbacks; using that filtered view as a probe source
 * creates a feedback loop where omitted endpoints can never be measured.
 */
export async function diagnosticEndpointsForClient(pool: DbPool, clientId: string): Promise<Endpoint[]> {
  const result = await pool.query<Endpoint>(
    `select e.id, e.label, e.kind, e.address, e.port, e.profile_id, e.enabled, e.sort_order, e.config
     from client_profiles cp
     join endpoints e on e.id = cp.endpoint_id
     where cp.client_id = $1 and e.enabled = true
     order by e.sort_order, e.id`,
    [clientId],
  );
  return result.rows;
}

export function subscriptionUrl(baseUrl: string, token: string, format = "plain"): string {
  return `${baseUrl}/sub/${encodeURIComponent(token)}/${format}`;
}

export function happDeeplink(subUrl: string): string {
  // The native Happ import button supplies the automatic profile to every user;
  // the plain URL remains unchanged for Streisand and other URI-list clients.
  subUrl = subUrl.replace(/(\/sub\/[^/?#]+)\/(?:plain|v2ray|happ)(?=[?#]|$)/, "$1/happ-json");
  return `happ://subscription-url/add/${Buffer.from(subUrl, "utf8").toString("base64url")}`;
}

export function happInstallDeeplink(providerCode: string, installCode: string): string {
  return `happ://install/${providerCode}/${installCode}`;
}

export function announceHeader(message: string): string {
  return `base64:${Buffer.from(message, "utf8").toString("base64")}`;
}

const nameOverrides: Record<string, string> = {
  "vpn2-05": "Махмуд",
  "ovign": "мама Ольга",
};

const weekdayGenitive: Record<number, string> = {
  0: "воскресенья", 1: "понедельника", 2: "вторника", 3: "среды",
  4: "четверга", 5: "пятницы", 6: "субботы",
};

const weekdayNominative: Record<number, string> = {
  0: "воскресенье", 1: "понедельник", 2: "вторник", 3: "среду",
  4: "четверг", 5: "пятницу", 6: "субботу",
};

const morningGreetings = [
  "Доброе утро, {name}!",
  "С добрым утром, {name}!",
  "Утро начинается с кофе и BezVPN, {name}!",
  "Проснись и пой, {name}!",
  "Солнце уже встало, а BezVPN уже работает, {name}!",
];

const dayGreetings = [
  "Хорошего дня, {name}!",
  "Отличного настроения, {name}!",
  "Пусть этот день будет продуктивным, {name}!",
  "Сегодня отличный день, {name}!",
  "День удался, ведь у тебя есть BezVPN, {name}!",
];

const eveningGreetings = [
  "Хорошего вечера, {name}!",
  "Отдыхай, {name}, BezVPN всё разрулит!",
  "Вечер в радость, {name}!",
  "Спокойного вечера, {name}!",
  "Кино, чай и BezVPN, {name}!",
];

const nightGreetings = [
  "Спокойной ночи, {name}!",
  "Не сиди долго, {name}, отдохни!",
  "Сладких снов, {name}!",
  "Пусть тебе приснится быстрый интернет, {name}!",
];

const mondayGreetings: string[] = [
  "Удачного понедельника, {name}!",
  "Понедельник — день тяжёлый, но BezVPN облегчит, {name}!",
];

const fridayGreetings: string[] = [
  "С пятницей, {name}!",
  "Пятница — время расслабиться, {name}!",
  "Ура, пятница, {name}!",
];

const weekendGreetings: string[] = [
  "Отличных выходных, {name}!",
  "Выходные созданы для отдыха, {name}!",
  "Хорошего уикенда, {name}!",
];

const randomGreetings: string[] = [
  "BezVPN — твой надёжный друг, {name}!",
  "Да пребудет с тобой быстрый интернет, {name}!",
  "{name}, ты сегодня прекрасно выглядишь!",
  "BezVPN заботится о тебе, {name}!",
  "С днём {weekday}, {name}!",
  "Улыбнись, {name}, всё будет хорошо!",
  "Главное — не скорость, а стабильность, {name}!",
  "Ты лучший пользователь BezVPN, {name}!",
  "{name}, не забудь покормить кота!",
  "BezVPN: твой интернет без границ, {name}!",
  "Хорошего настроения, {name}!",
  "Не болей, {name}!",
  "{name}, ты на связи — и это главное!",
  "BezVPN работает, ты отдыхаешь, {name}!",
  "Пусть твой интернет летает, {name}!",
];

function pick<T>(arr: T[]): T {
  return arr[Math.floor(Math.random() * arr.length)];
}

export function personalizedAnnounce(displayName: string, login: string, now: Date = new Date()): string {
  const name = nameOverrides[login] || displayName;
  const hour = now.getHours();
  const day = now.getDay();

  let greeting: string;

  // Day-specific first
  if (day === 1 && Math.random() < 0.4) {
    greeting = pick(mondayGreetings);
  } else if (day === 5 && Math.random() < 0.4) {
    greeting = pick(fridayGreetings);
  } else if (day === 6 || day === 0) {
    if (Math.random() < 0.6) {
      greeting = pick(weekendGreetings);
    } else {
      greeting = pick(randomGreetings);
    }
  } else if (hour < 10) {
    greeting = pick(morningGreetings);
  } else if (hour < 17) {
    greeting = pick(dayGreetings);
  } else if (hour < 22) {
    greeting = pick(eveningGreetings);
  } else {
    greeting = pick(nightGreetings);
  }

  if (!greeting) {
    greeting = pick(randomGreetings);
  }

  return greeting.replace("{name}", name).replace("{weekday}", weekdayNominative[day]);
}

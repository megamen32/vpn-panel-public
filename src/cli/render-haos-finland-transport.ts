import { readFile } from "node:fs/promises";

import { loadSecureConfig } from "../secure-config.js";

const input = JSON.parse(await readFile("/dev/stdin", "utf8")) as Record<string, unknown>;
const outbounds = Array.isArray(input.outbounds) ? input.outbounds as Array<Record<string, unknown>> : null;
if (!outbounds) throw new Error("HAOS transport source has no outbounds array");

const secure = await loadSecureConfig(process.env.VPN_PANEL_SECURE_CONFIG || "/etc/vpn-panel/secure.json");
const serverConfig = { ...(secure.server_configs.ru || {}), ...(secure.server_configs["regional-relays"] || {}) };
const required = (key: string): string => {
  const value = String(serverConfig[key] || "");
  if (!value) throw new Error(`missing required Finland transport field: ${key}`);
  return value;
};

const server = String(serverConfig.fi_connect_address || serverConfig.fi_address || "");
if (!server) throw new Error("missing required Finland transport field: fi_connect_address");

const finlandOutbound = {
  type: "vless",
  tag: "fi-helsinki",
  server,
  server_port: Number(serverConfig.fi_port || 443),
  uuid: required("fi_relay_uuid"),
  flow: String(serverConfig.fi_flow || secure.defaults.flow),
  tls: {
    enabled: true,
    server_name: String(serverConfig.fi_sni || "www.google.com"),
    utls: { enabled: true, fingerprint: String(serverConfig.fi_fingerprint || secure.defaults.fingerprint) },
    reality: {
      enabled: true,
      public_key: required("fi_public_key"),
      short_id: required("fi_short_id"),
    },
  },
};

const regionalMembers = (tag: string): string[] => {
  const group = outbounds.find((outbound) => outbound.tag === tag);
  const members = group?.type === "urltest" && Array.isArray(group.outbounds)
    ? group.outbounds.filter((member): member is string => typeof member === "string" && member.length > 0)
    : [];
  if (members.length === 0) throw new Error(`missing required regional transport group: ${tag}`);
  return members;
};

const telegramMembers = [...new Set([
  ...regionalMembers("de-regional"),
  "fi-helsinki",
  ...regionalMembers("us-regional"),
])];
const worldAutoOutbound = {
  type: "urltest",
  tag: "world-auto",
  outbounds: telegramMembers,
  url: "https://www.gstatic.com/generate_204",
  interval: "30s",
};
const telegramAutoOutbound = {
  type: "urltest",
  tag: "telegram-auto",
  outbounds: telegramMembers,
  url: "https://t.me/s/telegram",
  interval: "30s",
};
const telegramWebRule = {
  inbound: ["transparent-edge-http"],
  domain_suffix: ["telegram.org", "telegram.me", "t.me", "tdesktop.com", "telesco.pe", "telegra.ph"],
  outbound: "telegram-auto",
};

if (!Number.isInteger(finlandOutbound.server_port) || finlandOutbound.server_port < 1 || finlandOutbound.server_port > 65535) {
  throw new Error("invalid Finland transport port");
}

// The HAOS runtime enables the RU proxy alongside Finland. The regional
// importer intentionally keeps only VLESS groups, so restore its direct leaf.
input.outbounds = [
  ...outbounds.filter((outbound) => !["fi-helsinki", "world-auto", "telegram-auto", "direct"].includes(String(outbound.tag))),
  finlandOutbound, worldAutoOutbound, telegramAutoOutbound, { type: "direct", tag: "direct" },
];
const route = input.route && typeof input.route === "object" && !Array.isArray(input.route)
  ? input.route as Record<string, unknown>
  : {};
const routeRules = Array.isArray(route.rules) ? route.rules as Array<Record<string, unknown>> : [];
route.rules = [telegramWebRule, ...routeRules.filter((rule) => {
  const inbound = Array.isArray(rule.inbound) ? rule.inbound : [];
  const suffixes = Array.isArray(rule.domain_suffix) ? rule.domain_suffix : [];
  return !(inbound.includes("transparent-edge-http") && suffixes.includes("t.me"));
})];
route.final = "world-auto";
input.route = route;
process.stdout.write(`${JSON.stringify(input)}\n`);

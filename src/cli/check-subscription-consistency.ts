#!/usr/bin/env tsx
import { readFileSync } from "node:fs";
import { request } from "node:http";
import { spawnSync } from "node:child_process";
import { loadAppConfig } from "../config.js";
import { createPool } from "../db.js";

type VlessParsed = {
  uuid: string;
  host: string;
  port: number;
  query: Record<string, string>;
  name: string;
  raw: string;
};

function readTextMaybeSudo(path: string): string {
  try {
    return readFileSync(path, "utf8");
  } catch (error: any) {
    if (error?.code !== "EACCES") throw error;
    const result = spawnSync("sudo", ["cat", path], { encoding: "utf8", timeout: 30000 });
    if (result.status !== 0) {
      throw new Error(`cannot read ${path} directly or via sudo cat: ${result.stderr}`);
    }
    return result.stdout;
  }
}

function parseArgs() {
  const args = process.argv.slice(2);
  const token = args.find((arg) => arg.startsWith("--token="))?.slice("--token=".length) || args[0];
  const xrayConfig = args.find((arg) => arg.startsWith("--xray-config="))?.slice("--xray-config=".length) || "/etc/vpn-panel/xray-relay/config.json";
  const baseUrl = args.find((arg) => arg.startsWith("--base-url="))?.slice("--base-url=".length) || "http://127.0.0.1:3129";
  if (!token) {
    console.error("usage: npm run check:subscription -- --token=<subscription-token> [--base-url=http://127.0.0.1:3129] [--xray-config=/etc/vpn-panel/xray-relay/config.json]");
    process.exit(2);
  }
  return { token, xrayConfig, baseUrl };
}

function fetchPlain(baseUrl: string, token: string): Promise<{ body: string; routing: string | undefined; statusCode: number }> {
  const url = new URL(`/sub/${token}/plain`, baseUrl);
  return new Promise((resolve, reject) => {
    const req = request(url, (res) => {
      const chunks: Buffer[] = [];
      res.on("data", (chunk) => chunks.push(Buffer.from(chunk)));
      res.on("end", () => resolve({
        body: Buffer.concat(chunks).toString("utf8"),
        routing: Array.isArray(res.headers.routing) ? res.headers.routing[0] : res.headers.routing,
        statusCode: res.statusCode || 0,
      }));
    });
    req.on("error", reject);
    req.end();
  });
}

function parseVless(line: string): VlessParsed | null {
  if (!line.startsWith("vless://")) return null;
  const url = new URL(line);
  const query: Record<string, string> = {};
  url.searchParams.forEach((value, key) => { query[key] = value; });
  return {
    uuid: url.username,
    host: url.hostname,
    port: Number(url.port || "443"),
    query,
    name: decodeURIComponent(url.hash.replace(/^#/, "")),
    raw: line,
  };
}

function mustEqual(errors: string[], label: string, actual: unknown, expected: unknown) {
  if (actual !== expected) errors.push(`${label}: expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`);
}

const { token, xrayConfig, baseUrl } = parseArgs();
const app = loadAppConfig();
const pool = createPool(app);

try {
  const tokenResult = await pool.query(
    `select st.token, st.enabled token_enabled, vc.id client_id, vc.xray_uuid, vc.enabled client_enabled, a.login
     from subscription_tokens st
     join vpn_clients vc on vc.id = st.client_id
     join accounts a on a.id = vc.account_id
     where st.token = $1`,
    [token],
  );
  if (!tokenResult.rowCount) throw new Error("subscription token not found");
  const client = tokenResult.rows[0];

  const endpointResult = await pool.query(
    `select e.id, e.label, e.address, e.port, e.kind, e.enabled, e.config, e.sort_order
     from client_profiles cp
     join endpoints e on e.id = cp.endpoint_id
     where cp.client_id = $1
     order by e.sort_order, e.id`,
    [client.client_id],
  );

  const endpoints = endpointResult.rows;
  const endpointsByLabel = new Map(endpoints.map((endpoint: any) => [endpoint.label, endpoint]));
  const plain = await fetchPlain(baseUrl, token);
  if (plain.statusCode !== 200) throw new Error(`subscription HTTP status ${plain.statusCode}`);
  const links = plain.body.split(/\n+/).map((line) => line.trim()).filter(Boolean).map(parseVless).filter((v): v is VlessParsed => Boolean(v));
  const xray = JSON.parse(readTextMaybeSudo(xrayConfig));
  const inbounds = new Map<string, any>((xray.inbounds || []).map((inbound: any) => [inbound.tag, inbound]));
  const errors: string[] = [];

  console.log(JSON.stringify({
    token: token.slice(0, 6) + "…" + token.slice(-6),
    client: {
      id: String(client.client_id),
      login: client.login,
      uuid: client.xray_uuid,
      token_enabled: client.token_enabled,
      client_enabled: client.client_enabled,
    },
    subscription: {
      statusCode: plain.statusCode,
      routingHeader: plain.routing?.slice(0, 32) + "…",
      linkCount: links.length,
    },
  }, null, 2));

  if (!client.token_enabled) errors.push("token is disabled");
  if (!client.client_enabled) errors.push("client is disabled");

  for (const link of links) {
    const endpoint = [...endpointsByLabel.values()].find((candidate: any) => link.name.includes(candidate.label));
    console.log(JSON.stringify({ name: link.name, host: link.host, port: link.port, sni: link.query.sni, sid: link.query.sid, uuid: link.uuid }, null, 2));
    mustEqual(errors, `${link.name} uuid`, link.uuid, client.xray_uuid);
    if (!endpoint) {
      errors.push(`${link.name}: no matching DB endpoint by label`);
      continue;
    }
    mustEqual(errors, `${endpoint.id} address`, link.host, endpoint.address);
    mustEqual(errors, `${endpoint.id} port`, link.port, endpoint.port);
    if (endpoint.kind === "vless-reality") {
      const config = endpoint.config || {};
      mustEqual(errors, `${endpoint.id} pbk`, link.query.pbk, config.public_key);
      mustEqual(errors, `${endpoint.id} sid`, link.query.sid, config.short_id);
      mustEqual(errors, `${endpoint.id} sni`, link.query.sni, config.sni || "ya.ru");
      mustEqual(errors, `${endpoint.id} flow`, link.query.flow, config.flow || "xtls-rprx-vision");
    }
  }

  // All four public products terminate on the regional-relays Xray instance.
  for (const relayId of ["smart-de-relay", "full-de-relay", "smart-us-relay", "full-us-relay"]) {
    const inbound = inbounds.get(relayId);
    const endpoint = endpoints.find((candidate: any) => candidate.id === relayId);
    if (!inbound) {
      errors.push(`${relayId}: missing in xray config`);
      continue;
    }
    const clients = inbound.settings?.clients || [];
    const xrayClient = clients.find((candidate: any) => candidate.id === client.xray_uuid);
    if (!xrayClient) {
      errors.push(`${relayId}: xray inbound does not include client uuid ${client.xray_uuid}`);
    }
    if (endpoint?.config?.short_id) {
      const shortIds = inbound.streamSettings?.realitySettings?.shortIds || [];
      if (!shortIds.includes(endpoint.config.short_id)) {
        errors.push(`${relayId}: xray shortIds ${JSON.stringify(shortIds)} do not include endpoint short_id ${endpoint.config.short_id}`);
      }
    }
    if (endpoint?.config?.sni) {
      const serverNames = inbound.streamSettings?.realitySettings?.serverNames || [];
      if (!serverNames.includes(endpoint.config.sni)) {
        errors.push(`${relayId}: xray serverNames ${JSON.stringify(serverNames)} do not include endpoint sni ${endpoint.config.sni}`);
      }
    }
  }

  if (errors.length) {
    console.error("CONSISTENCY CHECK FAILED");
    for (const error of errors) console.error("- " + error);
    process.exit(1);
  }
  console.log("CONSISTENCY CHECK OK");
} finally {
  await pool.end();
}

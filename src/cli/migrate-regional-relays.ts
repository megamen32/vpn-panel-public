import { chmod, chown, copyFile, readFile, rename, stat, writeFile } from "node:fs/promises";
import { pathToFileURL } from "node:url";
import { loadAppConfig } from "../config.js";
import { createPool } from "../db.js";
import { syncCatalogFromSecureConfig } from "../migrations.js";
import { loadSecureConfig } from "../secure-config.js";

type JsonObject = Record<string, unknown>;

type MutableNode = JsonObject & {
  id: string;
  address: string;
  port: number;
};

type MutableSecureConfig = JsonObject & {
  nodes: MutableNode[];
  server_configs: Record<string, JsonObject>;
};

const CANONICAL_RELAYS = ["smart-de-relay", "full-de-relay", "smart-us-relay", "full-us-relay"] as const;
const HELSINKI_RELAY = "fi-helsinki-relay";
const MOBILE_RELAYS = ["smart-de-relay-mobile", "full-de-relay-mobile", "smart-us-relay-mobile", "full-us-relay-mobile"] as const;
const LEGACY_RELAYS = new Set(["ru-smart-relay", "ru-full-relay", "us-full-relay"]);
const VUSA_ENDPOINTS = [
  "us-reality",
  "us-xhttp",
  "us-xhttp-h2-443",
  "us-httpupgrade",
  "us-direct-ws",
  "us-grpc",
  "us-cdn",
  "us-cdn2",
  "us-xhttp-h2",
] as const;

function timestamp(): string {
  return new Date().toISOString().replaceAll(/[-:]/g, "").replace(/\..+/, "Z");
}

function nodeById(nodes: MutableNode[], id: string): MutableNode {
  const node = nodes.find((candidate) => candidate.id === id);
  if (!node) throw new Error(`required secure node is missing: ${id}`);
  return node;
}

function requiredNodeString(node: MutableNode, field: string): string {
  const value = node[field];
  if (typeof value !== "string" || !value) throw new Error(`${node.id}.${field} is required`);
  return value;
}

function realityRelay(template: MutableNode, id: string, label: string, sni: string,
                      extraServerNames: string[] = []): MutableNode {
  return {
    ...template,
    id,
    label,
    address: "95.165.165.65",
    port: 443,
    profiles: [id],
    sni,
    // Additional names the relay must also accept, so a memorable short
    // hostname resolves to this same exit.
    server_names: [sni, ...extraServerNames],
    fingerprint: "chrome",
    enabled: true,
  };
}

function mobileRealityRelay(template: MutableNode, id: string, label: string): MutableNode {
  return {
    ...template,
    id,
    label,
    profiles: [id],
    fingerprint: "safari",
  };
}

function usPathNode(
  template: MutableNode,
  input: {
    id: string;
    label: string;
    address?: string;
    port?: number;
    type: "xhttp" | "httpupgrade" | "ws" | "grpc";
    pathKey: "path" | "serviceName";
    path: string;
    fingerprint?: string;
    alpn?: string;
  },
): MutableNode {
  const address = input.address || "vusa.bezrabotnyi.com";
  return {
    ...template,
    id: input.id,
    label: input.label,
    address,
    port: input.port || 443,
    profiles: [input.id],
    enabled: true,
    query: {
      security: "tls",
      type: input.type,
      [input.pathKey]: input.path,
      host: address,
      sni: "vusa.bezrabotnyi.com",
      fp: input.fingerprint || "chrome",
      ...(input.alpn ? { alpn: input.alpn } : {}),
      ...(input.type === "xhttp" ? { mode: "auto" } : {}),
    },
  };
}

function usXhttpH2Node(template: MutableNode): MutableNode {
  return {
    ...template,
    id: "us-xhttp-h2",
    label: "US XHTTP H2",
    kind: "vless-xhttp",
    address: "vusa.bezrabotnyi.com",
    port: 28443,
    profiles: ["us-xhttp-h2"],
    enabled: true,
    query: {
      security: "tls",
      type: "xhttp",
      path: "/xhttp-h2",
      mode: "stream-up",
      h2: "true",
      host: "vusa.bezrabotnyi.com",
      sni: "vusa.bezrabotnyi.com",
      fp: "chrome",
      alpn: "h2",
    },
  };
}

function usXhttpH2On443Node(template: MutableNode): MutableNode {
  return {
    ...template,
    id: "us-xhttp-h2-443",
    label: "US XHTTP H2 443",
    kind: "vless-xhttp",
    address: "vusa.bezrabotnyi.com",
    port: 443,
    profiles: ["us-xhttp-h2-443"],
    enabled: true,
    query: {
      security: "tls",
      type: "xhttp",
      path: "/xhttp-h2-443",
      mode: "stream-up",
      h2: "true",
      host: "vusa.bezrabotnyi.com",
      sni: "vusa.bezrabotnyi.com",
      fp: "chrome",
      alpn: "h2",
    },
  };
}

export function transformSecure(raw: MutableSecureConfig): MutableSecureConfig {
  const smartTemplate = raw.nodes.find((node) => node.id === "ru-smart-relay")
    || raw.nodes.find((node) => node.id === "smart-de-relay");
  if (!smartTemplate) throw new Error("legacy or canonical smart relay node is missing");
  const realityTemplate = nodeById(raw.nodes, "us-reality");
  const xhttpTemplate = nodeById(raw.nodes, "de-xhttp");
  const httpUpgradeTemplate = nodeById(raw.nodes, "de-httpupgrade");
  const wsTemplate = nodeById(raw.nodes, "de-direct-ws");
  const grpcTemplate = nodeById(raw.nodes, "de-grpc");
  const cdnTemplate = nodeById(raw.nodes, "de-cdn");
  const cdn2Template = nodeById(raw.nodes, "de-cdn2");
  const firstRelayIndex = raw.nodes.findIndex((node) => LEGACY_RELAYS.has(node.id)
    || CANONICAL_RELAYS.includes(node.id as typeof CANONICAL_RELAYS[number])
    || MOBILE_RELAYS.includes(node.id as typeof MOBILE_RELAYS[number]));
  const relays = [
    realityRelay(smartTemplate, "smart-de-relay", "Smart DE", "smart-de.runet.bezrabotnyi.com"),
    realityRelay(smartTemplate, "full-de-relay", "Full DE", "full-de.runet.bezrabotnyi.com"),
    realityRelay(smartTemplate, "smart-us-relay", "Smart US", "smart-us.runet.bezrabotnyi.com"),
    realityRelay(smartTemplate, "full-us-relay", "Full US", "full-us.runet.bezrabotnyi.com"),
  ];
  const helsinkiRelay: MutableNode = {
    ...realityRelay(smartTemplate, HELSINKI_RELAY, "Finland Helsinki", "fi.runet.bezrabotnyi.com", ["fin.bezrabotnyi.com"]),
    public_catalog: true,
  };
  const mobileRelays = [
    mobileRealityRelay(relays[0], "smart-de-relay-mobile", "Smart DE (4G)"),
    mobileRealityRelay(relays[1], "full-de-relay-mobile", "Full DE (4G)"),
    mobileRealityRelay(relays[2], "smart-us-relay-mobile", "Smart US (4G)"),
    mobileRealityRelay(relays[3], "full-us-relay-mobile", "Full US (4G)"),
  ];
  const usReality: MutableNode = {
    ...realityTemplate,
    id: "us-reality",
    label: "US Reality 443",
    address: "vusa.bezrabotnyi.com",
    port: 443,
    profiles: ["us-reality"],
    sni: "www.google.com",
    enabled: true,
  };
  const vusaNodes = [
    usReality,
    usPathNode(xhttpTemplate, {
      id: "us-xhttp",
      label: "US XHTTP 443",
      type: "xhttp",
      pathKey: "path",
      path: "/xhttp",
    }),
    usXhttpH2On443Node(xhttpTemplate),
    usPathNode(httpUpgradeTemplate, {
      id: "us-httpupgrade",
      label: "US HTTPUpgrade 443",
      type: "httpupgrade",
      pathKey: "path",
      path: "/hup",
    }),
    usPathNode(wsTemplate, {
      id: "us-direct-ws",
      label: "US Direct WS 443",
      type: "ws",
      pathKey: "path",
      path: "/direct-ws",
      alpn: "http/1.1",
    }),
    usPathNode(grpcTemplate, {
      id: "us-grpc",
      label: "US gRPC 443",
      type: "grpc",
      pathKey: "serviceName",
      path: "/grpc",
    }),
    usPathNode(cdnTemplate, {
      id: "us-cdn",
      label: "US CDN fallback",
      address: "us-cdn.demiurge.space",
      type: "ws",
      pathKey: "path",
      path: "/cdn-ws",
      fingerprint: "ios",
      alpn: "http/1.1",
    }),
    usPathNode(cdn2Template, {
      id: "us-cdn2",
      label: "US CDN2 fallback",
      address: "us-cdn2.demiurge.space",
      type: "ws",
      pathKey: "path",
      path: "/cdn2-ws",
      fingerprint: "ios",
      alpn: "http/1.1",
    }),
    usXhttpH2Node(xhttpTemplate),
  ];
  const retained = raw.nodes.filter((node) => !LEGACY_RELAYS.has(node.id)
    && !CANONICAL_RELAYS.includes(node.id as typeof CANONICAL_RELAYS[number])
    && node.id !== HELSINKI_RELAY
    && !MOBILE_RELAYS.includes(node.id as typeof MOBILE_RELAYS[number])
    && node.id !== "de-cdn-xhttp"
    && !VUSA_ENDPOINTS.includes(node.id as typeof VUSA_ENDPOINTS[number]));
  retained.splice(Math.max(firstRelayIndex, 0), 0, ...relays, helsinkiRelay, ...mobileRelays);
  retained.push(...vusaNodes);

  const legacyServerConfig = raw.server_configs["ru-combined"] || raw.server_configs.ru;
  if (!legacyServerConfig) throw new Error("ru-combined/ru server config is missing");
  const serverNames = new Set<string>([
    ...((legacyServerConfig.server_names as string[] | undefined) || []),
    "smart-de.runet.bezrabotnyi.com",
    "full-de.runet.bezrabotnyi.com",
    "smart-us.runet.bezrabotnyi.com",
    "full-us.runet.bezrabotnyi.com",
    "fi.runet.bezrabotnyi.com",
  ]);
  return {
    ...raw,
    nodes: retained,
    server_configs: {
      ...raw.server_configs,
      "regional-relays": {
        ...legacyServerConfig,
        ...(raw.server_configs["regional-relays"] || {}),
        smart_de_listen_port: 23445,
        full_de_listen_port: 23444,
        smart_us_listen_port: 23447,
        full_us_listen_port: 23446,
        fi_listen_port: 23448,
        de_reality_port: 443,
        de_ws_path: "/direct-ws",
        us_address: "vusa.bezrabotnyi.com",
        us_reality_port: 443,
        us_sni: "www.google.com",
        us_public_key: requiredNodeString(usReality, "public_key"),
        us_short_id: requiredNodeString(usReality, "short_id"),
        us_xhttp_path: "/xhttp",
        us_xhttp_h2_443_path: "/xhttp-h2-443",
        us_hup_path: "/hup",
        us_ws_path: "/direct-ws",
        us_grpc_path: "/grpc",
        us_cdn_address: "us-cdn.demiurge.space",
        us_cdn_path: "/cdn-ws",
        us_cdn2_address: "us-cdn2.demiurge.space",
        us_cdn2_path: "/cdn2-ws",
        us_xhttp_h2_port: 28443,
        us_xhttp_h2_path: "/xhttp-h2",
        server_names: [...serverNames],
      },
    },
  };
}

async function migrateDatabase(): Promise<void> {
  const app = loadAppConfig();
  const secure = await loadSecureConfig(app.secureConfigPath);
  const pool = createPool(app);
  try {
    await syncCatalogFromSecureConfig(pool, secure);
    const client = await pool.connect();
    try {
      await client.query("begin");
      await client.query("delete from client_profiles where endpoint_id = any($1::text[])", [[...LEGACY_RELAYS]]);
      await client.query(
        `insert into client_profiles (client_id, endpoint_id)
         select vc.id, endpoint_id
         from vpn_clients vc
         join accounts a on a.id = vc.account_id
         cross join unnest($1::text[]) endpoint_id
         where a.role = 'user' and a.enabled = true and vc.enabled = true
         on conflict do nothing`,
        [[...CANONICAL_RELAYS, HELSINKI_RELAY, ...MOBILE_RELAYS, ...VUSA_ENDPOINTS]],
      );
      await client.query("delete from endpoints where id = any($1::text[])", [[...LEGACY_RELAYS, "de-cdn-xhttp"]]);
      await client.query("commit");
    } catch (error) {
      await client.query("rollback");
      throw error;
    } finally {
      client.release();
    }
  } finally {
    await pool.end();
  }
}

async function main(): Promise<void> {
  const dryRun = process.argv.includes("--dry-run");
  const app = loadAppConfig();
  const raw = JSON.parse(await readFile(app.secureConfigPath, "utf8")) as MutableSecureConfig;
  if (!Array.isArray(raw.nodes) || !raw.server_configs) throw new Error("invalid secure config structure");
  const transformed = transformSecure(raw);
  if (dryRun) {
    console.log(JSON.stringify({ dryRun: true, relayIds: CANONICAL_RELAYS, mobileRelayIds: MOBILE_RELAYS, nodeCount: transformed.nodes.length }));
    return;
  }

  const backupPath = `${app.secureConfigPath}.bak_${timestamp()}`;
  const pendingPath = `${app.secureConfigPath}.pending`;
  const originalStat = await stat(app.secureConfigPath);
  const originalMode = originalStat.mode & 0o777;
  await copyFile(app.secureConfigPath, backupPath);
  await chown(backupPath, originalStat.uid, originalStat.gid);
  await chmod(backupPath, originalMode);
  await writeFile(pendingPath, `${JSON.stringify(transformed, null, 2)}\n`, { mode: 0o600 });
  await chown(pendingPath, originalStat.uid, originalStat.gid);
  // Keep the service-readable group mode; a root-run migration must not turn
  // root:roomhacker 0640 into 0600 and take the panel offline.
  await chmod(pendingPath, originalMode);
  await loadSecureConfig(pendingPath);
  await rename(pendingPath, app.secureConfigPath);
  await migrateDatabase();
  console.log(JSON.stringify({ backupPath, relayIds: CANONICAL_RELAYS, mobileRelayIds: MOBILE_RELAYS, nodeCount: transformed.nodes.length }));
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) await main();

import dns from "node:dns/promises";
import path from "node:path";
import { readFile, writeFile } from "node:fs/promises";
import { loadAppConfig } from "../config.js";
import { loadSecureConfig, type SecureConfig, type SecureNode } from "../secure-config.js";

type JsonObject = Record<string, unknown>;

function regionForEndpoint(id: string): "DE" | "US" | "FI" | null {
  if (id.startsWith("de-") || id.includes("-de-")) return "DE";
  if (id.startsWith("us-") || id.includes("-us-")) return "US";
  if (id === "fi-helsinki-relay") return "FI";
  return null;
}

function modeForEndpoint(id: string): "smart" | "full" | "diagnostic" {
  if (id.startsWith("smart-")) return "smart";
  if (id.startsWith("full-") || id === "fi-helsinki-relay") return "full";
  return "diagnostic";
}

function vpsHostForRegion(secure: SecureConfig, region: "DE" | "US" | "FI"): string | undefined {
  if (region === "FI") return undefined;
  const entry = secure.vps_list.find((vps) => region === "DE" ? /de|germany/i.test(vps.label) : /us|usa|america/i.test(vps.label));
  return entry?.host;
}

async function resolveHost(host: string | undefined): Promise<string | undefined> {
  if (!host) return undefined;
  try {
    const result = await dns.lookup(host, { family: 4 });
    return result.address;
  } catch {
    return undefined;
  }
}

async function endpointExpectation(secure: SecureConfig, node: SecureNode): Promise<JsonObject> {
  const region = regionForEndpoint(node.id);
  const exitIp = region ? await resolveHost(vpsHostForRegion(secure, region)) : undefined;
  return {
    mode: modeForEndpoint(node.id),
    ...(region ? { region, ...(exitIp ? { exitIp } : {}) } : {}),
  };
}

/**
 * Helsinki is a canonical owner-managed relay, not a secure.json node. Keep it
 * in the runner catalog so an assigned phone profile can be tested and scored.
 */
const ownerManagedTestEndpoints = [{
  id: "fi-helsinki-relay",
  label: "🇫🇮 Helsinki, Finland",
  kind: "vless-reality",
  address: "95.165.165.65",
  port: 443,
  enabled: true,
  region: "FI",
}] as const;

/** Render the benchmark plan from the same enabled endpoint catalog as subscriptions. */
export async function renderVpnTestPlan(template: JsonObject, secure: SecureConfig): Promise<JsonObject> {
  const enabledNodes = secure.nodes.filter((node) => node.enabled);
  const endpointCatalog = [...enabledNodes.map((node) => ({
    id: node.id,
    label: node.label ?? node.id,
    kind: node.kind,
    address: node.address,
    port: node.port,
    enabled: node.enabled,
    region: regionForEndpoint(node.id),
  })), ...ownerManagedTestEndpoints];
  const expectations: JsonObject = {};
  for (const node of enabledNodes) expectations[node.id] = await endpointExpectation(secure, node);
  expectations["fi-helsinki-relay"] = { mode: "full", region: "FI" };
  return {
    ...template,
    schemaVersion: 1,
    generatedFrom: "secure.json:nodes",
    endpointCatalog,
    endpointExpectations: expectations,
  };
}

async function main(): Promise<void> {
  const app = loadAppConfig();
  const secure = await loadSecureConfig(app.secureConfigPath);
  const output = path.resolve(process.argv[2] || "vpn-testing/test-plan.json");
  const templatePath = path.resolve(process.argv[3] || "vpn-testing/test-plan.json");
  const template = JSON.parse(await readFile(templatePath, "utf8")) as JsonObject;
  await writeFile(output, `${JSON.stringify(await renderVpnTestPlan(template, secure), null, 2)}\n`);
  console.log(`rendered ${output} from ${secure.nodes.filter((node) => node.enabled).length} enabled endpoints`);
}

if (import.meta.url === `file://${process.argv[1]}`) await main();

import { readFile } from "node:fs/promises";
import path from "node:path";
import { loadAppConfig } from "../config.js";
import { createPool } from "../db.js";
import { assertSharedLanPorts } from "../lan-proxy-contract.js";
import { withRegionalUsLane, withServiceCatalogLanRules, withStableDeLane, withVusaSmartEdgeLanes, type XrayConfigWithRouting } from "../lan-us-config.js";
import { loadSecureConfig } from "../secure-config.js";
import { loadActiveServiceCatalogProjection } from "../service-catalog-active-projection.js";
import { regionalRelayServerConfig } from "../xray-configs.js";
import {
  loadTelegramTransparentLaneConfig,
  renderTelegramTransparentLaneCandidate,
} from "../telegram-transparent-lane.js";

/** Generate server-88's LAN config with the current secret-backed US pool. */
async function main(): Promise<void> {
  const app = loadAppConfig();
  const secure = await loadSecureConfig(app.secureConfigPath);
  const pool = createPool(app);
  try {
    const basePath = process.env.TELEGRAM_BASE_CONFIG
      ? path.resolve(process.env.TELEGRAM_BASE_CONFIG)
      : path.join(process.cwd(), "deploy/server-88/xray/config.json");
    const base = JSON.parse(await readFile(basePath, "utf8")) as XrayConfigWithRouting;
    const regional = await regionalRelayServerConfig(pool, secure) as XrayConfigWithRouting;
    const enabledEndpointIds = new Set(secure.nodes.filter((node) => node.enabled).map((node) => node.id));
    const withLanes = withVusaSmartEdgeLanes(withRegionalUsLane(withStableDeLane(base, enabledEndpointIds), regional, enabledEndpointIds));
    const activeProjection = await loadActiveServiceCatalogProjection();
    let generated = activeProjection ? withServiceCatalogLanRules(withLanes, activeProjection) : withLanes;
    const telegramTproxyEnabled = process.env.TELEGRAM_TPROXY_ENABLE === "1";
    if (telegramTproxyEnabled) {
      const telegramLane = await loadTelegramTransparentLaneConfig();
      generated = renderTelegramTransparentLaneCandidate(generated, telegramLane) as unknown as XrayConfigWithRouting;
    }
    assertSharedLanPorts(generated.inbounds as Array<Record<string, unknown>>);
    process.stdout.write(`${JSON.stringify(generated, null, 2)}\n`);
  } finally {
    await pool.end();
  }
}

await main();

import { mkdir, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import { loadAppConfig } from "../config.js";
import { createPool } from "../db.js";
import { loadSecureConfig } from "../secure-config.js";
import { serverConfig } from "../xray-configs.js";

const output = process.argv[2] || "/etc/vpn-panel/xray-relay/config.json";
const serverId = process.argv[3] || "ru-combined";

const app = loadAppConfig();
const pool = createPool(app);

try {
  const secure = await loadSecureConfig(app.secureConfigPath);
  const config = await serverConfig(pool, secure, serverId);
  await mkdir(dirname(output), { recursive: true });
  await writeFile(output, `${JSON.stringify(config, null, 2)}\n`, { mode: 0o600 });
  const inbounds = (config.inbounds as Array<Record<string, unknown>>).map((inbound) => ({
    tag: inbound.tag,
    port: inbound.port,
    clients: (((inbound.settings as Record<string, unknown>)?.clients as unknown[]) || []).length,
  }));
  console.log(JSON.stringify({ output, serverId, inbounds }, null, 2));
} finally {
  await pool.end();
}

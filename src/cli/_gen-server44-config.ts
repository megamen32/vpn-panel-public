import { loadAppConfig } from "../config.js";
import { createPool } from "../db.js";
import { server44SingBoxConfig } from "../lan-singbox-config.js";
import { listEndpoints } from "../repository.js";
import { loadSecureConfig } from "../secure-config.js";

/** Print server-44's database-backed sing-box configuration as JSON. */
async function main(): Promise<void> {
  const app = loadAppConfig();
  const secure = await loadSecureConfig(app.secureConfigPath);
  const pool = createPool(app);
  try {
    const endpoints = await listEndpoints(pool);
    process.stdout.write(`${JSON.stringify(server44SingBoxConfig(endpoints, secure), null, 2)}\n`);
  } finally {
    await pool.end();
  }
}

await main();

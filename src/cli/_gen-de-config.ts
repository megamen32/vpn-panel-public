import { Pool } from "pg";
import { loadSecureConfig } from "../secure-config.js";
import { deServerConfig } from "../xray-configs.js";

async function main() {
  const pool = new Pool({ connectionString: process.env.DATABASE_URL });
  const secure = await loadSecureConfig(
    process.env.VPN_PANEL_SECURE_CONFIG || "/etc/vpn-panel/secure.json",
  );
  const cfg = await deServerConfig(pool, secure);
  process.stdout.write(JSON.stringify(cfg, null, 2));
  await pool.end();
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});

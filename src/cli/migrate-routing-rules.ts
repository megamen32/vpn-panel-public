import { chmod, readFile, rename, stat, writeFile } from "node:fs/promises";

import { migrateLegacySmartDnsPolicyToRoutingRules, type LegacySmartDnsPolicy } from "../routing-rules.js";
import { smartDnsPolicyPath } from "../smart-dns-policy.js";

async function main(): Promise<void> {
  const path = process.env.VPN_PANEL_SMART_DNS_POLICY || smartDnsPolicyPath();
  const write = process.argv.includes("--write");
  const raw = JSON.parse(await readFile(path, "utf8")) as LegacySmartDnsPolicy & { rules?: unknown };
  if (Array.isArray(raw.rules)) {
    console.log(JSON.stringify({ path, migrated: false, reason: "rules already present", rules: raw.rules.length }));
    return;
  }
  const rules = migrateLegacySmartDnsPolicyToRoutingRules(raw);
  if (write) {
    const mode = (await stat(path)).mode & 0o777;
    const temporary = `${path}.tmp-${process.pid}`;
    await writeFile(temporary, `${JSON.stringify({ rules, updatedAt: new Date().toISOString() }, null, 2)}\n`, { mode });
    await chmod(temporary, mode);
    await rename(temporary, path);
  }
  console.log(JSON.stringify({
    path,
    migrated: true,
    rules: rules.length,
    domainExact: rules.filter((rule) => rule.match === "exact").length,
    domainSuffix: rules.filter((rule) => rule.match === "suffix").length,
    geo: rules.filter((rule) => rule.match === "set").length,
    written: write,
  }));
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});

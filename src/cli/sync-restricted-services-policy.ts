import { loadRestrictedServicesCatalog, mergeRestrictedServiceRoutes } from "../restricted-services.js";
import { loadSmartDnsPolicy, saveSmartDnsPolicy } from "../smart-dns-policy.js";

async function main(): Promise<void> {
  const catalog = await loadRestrictedServicesCatalog();
  const current = await loadSmartDnsPolicy();
  const merged = mergeRestrictedServiceRoutes(current, catalog);
  const saved = await saveSmartDnsPolicy(merged);
  console.log(`SmartDNS policy synchronized: ${saved.rules.length} unified rules`);
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.stack ?? error.message : String(error));
  process.exitCode = 1;
});

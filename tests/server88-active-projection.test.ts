import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

test("server-88 generator consumes only the durable active projection after LAN lanes", async () => {
  const source = await readFile(new URL("../src/cli/_gen-server88-config.ts", import.meta.url), "utf8");
  assert.match(source, /loadActiveServiceCatalogProjection/);
  assert.match(source, /withServiceCatalogLanRules/);
  assert.match(source, /const activeProjection\s*=\s*await loadActiveServiceCatalogProjection\(\)/);
  assert.match(source, /withVusaSmartEdgeLanes\([^;]+\);[\s\S]*?loadActiveServiceCatalogProjection/);
  assert.match(source, /activeProjection\s*\?\s*withServiceCatalogLanRules\(/);
  assert.doesNotMatch(source, /loadServiceCatalog|loadRestrictedServicesCatalog|restricted-services/);
});

test("SmartDNS and all-target deploys keep the router edge and server-44 policy coupled", async () => {
  const [source, deployAll] = await Promise.all([
    readFile(new URL("../scripts/deploy-smartdns-unified.sh", import.meta.url), "utf8"),
    readFile(new URL("../scripts/deploy-all.sh", import.meta.url), "utf8"),
  ]);
  assert.doesNotMatch(source, /restricted-services|catalog_vusa|antigravity/i);
  assert.match(source, /\.sync\.token \| type == "string" and length > 0/);
  assert.match(source, /LAN_SMART_EDGE_IP:-192\.168\.2\.1/);
  assert.match(source, /edgeProfiles\.local\.ipv4 == \$lan_smart_edge_ip/);
  assert.match(source, /\.rules \| type == "array"/);
  assert.match(source, /del\(\.directDomains, \.directSuffixes, \.proxyDomains, \.proxySuffixes/);
  assert.match(deployAll, /deploy-server44-lan-smart-edge\.sh/);
  assert.match(deployAll, /VPN2_PROXY_CREDENTIALS_FILE/);
  assert.match(deployAll, /VPN2_PROXY_PASSWORD/);
});

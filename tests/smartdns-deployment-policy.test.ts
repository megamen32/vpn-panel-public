import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";

const protectedPolicy = path.resolve("deploy/smartdns/protected-policy.json");
const unifiedDeployment = path.resolve("scripts/deploy-smartdns-unified.sh");
const typeScriptPolicy = path.resolve("src/smart-dns-policy.ts");

test("deployment script consumes only canonical rules after generating its config", async () => {
  const script = await readFile(unifiedDeployment, "utf8");
  const generatedConfig = script.indexOf('> "$work_dir/config.json"');
  const canonicalProjection = script.indexOf(".rules = $policy[0].rules");

  assert.ok(generatedConfig >= 0, "deployment script must generate config.json");
  assert.ok(canonicalProjection >= 0, "deployment script must project canonical rules into config.json");
  assert.doesNotMatch(script, /sync-smartdns-protected-policy\.py/);
});

test("deployment script prints a restore and restart rollback command", async () => {
  const script = await readFile(unifiedDeployment, "utf8");

  assert.match(script, /Rollback command: sudo cp -a \/usr\/local\/bin\/smartdns\.bak_\$timestamp/);
  assert.match(script, /sudo systemctl daemon-reload && sudo systemctl restart smart-dns\.service/);
});

test("deployment script syncs runtime clients from the active VPN Panel listener", async () => {
  const script = await readFile(unifiedDeployment, "utf8");

  assert.match(script, /\.sync\.url = "http:\/\/127\.0\.0\.1:30129\/api\/internal\/smart-dns\/clients"/);
  assert.doesNotMatch(script, /\.sync\.url = "http:\/\/127\.0\.0\.1:3129\/api\/internal\/smart-dns\/clients"/);
});

test("protected suffixes are declared in the shared machine-readable policy", async () => {
  const source = JSON.parse(await readFile(protectedPolicy, "utf8")) as { proxyOnlySuffixes: unknown };

  assert.deepEqual(source.proxyOnlySuffixes, ["ua", "hailuo.ai"]);
});

test("TypeScript normalization loads the shared protected policy", async () => {
  const typeScriptSource = await readFile(typeScriptPolicy, "utf8");

  assert.match(typeScriptSource, /deploy\/smartdns\/protected-policy\.json/);
});

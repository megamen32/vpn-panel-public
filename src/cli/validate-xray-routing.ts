import { chmod, mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawn, spawnSync } from "node:child_process";
import { Socket } from "node:net";
import { loadAppConfig } from "../config.js";
import { createPool } from "../db.js";
import { loadSecureConfig } from "../secure-config.js";
import { serverConfig } from "../xray-configs.js";
import { bundleByToken, xrayClientSubscription, happRoutingLink } from "../subscriptions.js";

const XRAY_IMAGE = process.env.XRAY_IMAGE || "ghcr.io/xtls/xray-core:latest";
const GEO_DIR = process.env.XRAY_GEO_DIR || "/etc/vpn-panel/xray-geo";
const runtime = process.argv.includes("--runtime");
const tokenArg = process.argv.find((arg) => arg.startsWith("--token="))?.slice("--token=".length);
const endpointArg = process.argv.find((arg) => arg.startsWith("--endpoint="))?.slice("--endpoint=".length) || "smart-de-relay";
const localRelay = process.argv.includes("--local-relay");
const EXPECTED_RU_IP = process.env.EXPECTED_RU_IP || "95.165.165.65";

function run(cmd: string, args: string[], opts: { input?: string; timeout?: number } = {}) {
  const result = spawnSync(cmd, args, { encoding: "utf8", input: opts.input, timeout: opts.timeout || 120000 });
  if (result.status !== 0) {
    throw new Error(`${cmd} ${args.join(" ")} failed\nSTDOUT:\n${result.stdout}\nSTDERR:\n${result.stderr}`);
  }
  return result.stdout.trim();
}

async function download(url: string, path: string) {
  if (existsSync(path)) return;
  console.log(`download ${url}`);
  run("curl", ["-fL", "--retry", "3", "--connect-timeout", "20", "-o", path, url], { timeout: 180000 });
}

async function ensureGeo() {
  await mkdir(GEO_DIR, { recursive: true });
  await download("https://github.com/golukon/russia-only-geoip/releases/latest/download/geoip.dat", join(GEO_DIR, "geoip.dat"));
  await download("https://github.com/golukon/russia-only-geosite/releases/latest/download/geosite.dat", join(GEO_DIR, "geosite.dat"));
}

function decodeHappRoutingLink(link: string): Record<string, unknown> {
  const match = link.match(/^happ:\/\/routing\/(?:add|onadd)\/(.+)$/);
  if (!match) throw new Error(`invalid Happ routing link: ${link.slice(0, 80)}`);
  return JSON.parse(Buffer.from(match[1], "base64").toString("utf8"));
}

function collectGeoTags(value: unknown, tags = new Set<string>()): Set<string> {
  if (typeof value === "string") {
    const match = value.match(/^(geoip|geosite):(.+)$/);
    if (match) tags.add(value);
  } else if (Array.isArray(value)) {
    for (const item of value) collectGeoTags(item, tags);
  } else if (value && typeof value === "object") {
    for (const item of Object.values(value as Record<string, unknown>)) collectGeoTags(item, tags);
  }
  return tags;
}

function xrayTest(configPath: string, workdir: string) {
  const docker = spawnSync("docker", [
    "run", "--rm",
    "-v", `${workdir}:/work:ro`,
    "-v", `${GEO_DIR}:/usr/local/share/xray:ro`,
    XRAY_IMAGE,
    "run", "-test", "-config", `/work/${configPath.split("/").pop()}`,
  ], { encoding: "utf8", timeout: 120000 });
  if (docker.status !== 0) {
    throw new Error(`xray test failed for ${configPath}\nSTDOUT:\n${docker.stdout}\nSTDERR:\n${docker.stderr}`);
  }
  console.log(`xray test OK: ${configPath}`);
}

async function firstToken(pool: ReturnType<typeof createPool>): Promise<string> {
  if (tokenArg) return tokenArg;
  const result = await pool.query("select token from subscription_tokens where enabled=true order by created_at desc limit 1");
  const token = result.rows[0]?.token;
  if (!token) throw new Error("no enabled subscription token found");
  return token;
}

function forceEndpointClientConfig(config: Record<string, unknown>, endpoint: string, socksPort: number, httpPort: number) {
  const outbounds = (config.outbounds as Array<Record<string, unknown>>).filter((outbound) =>
    [endpoint, "direct", "block"].includes(String(outbound.tag)),
  );
  if (!outbounds.some((outbound) => outbound.tag === endpoint)) {
    throw new Error(`endpoint ${endpoint} not found in client outbounds`);
  }
  if (localRelay) {
    for (const outbound of outbounds) {
      const vnext = ((outbound.settings as Record<string, unknown> | undefined)?.vnext as Array<Record<string, unknown>> | undefined);
      if (String(outbound.tag).endsWith("-relay") && vnext?.[0]) vnext[0].address = "127.0.0.1";
    }
  }
  return {
    ...config,
    inbounds: [
      { tag: "socks-in", port: socksPort, listen: "127.0.0.1", protocol: "socks" },
      { tag: "http-in", port: httpPort, listen: "127.0.0.1", protocol: "http" },
    ],
    outbounds,
    routing: { domainStrategy: "IPIfNonMatch", rules: [{ type: "field", network: "tcp,udp", outboundTag: endpoint }] },
  };
}

async function waitPort(port: number) {
  for (let i = 0; i < 40; i++) {
    if (await new Promise<boolean>((resolve) => {
      const s = new Socket();
      s.setTimeout(500);
      s.once("connect", () => { s.destroy(); resolve(true); });
      s.once("error", () => resolve(false));
      s.once("timeout", () => { s.destroy(); resolve(false); });
      s.connect(port, "127.0.0.1");
    })) return;
    await new Promise((r) => setTimeout(r, 500));
  }
  throw new Error(`port ${port} did not open`);
}

function curlViaSocks(port: number, url: string) {
  return run("curl", ["-k", "-L", "--http1.1", "-fsSL", "--max-time", "25", "--socks5-hostname", `127.0.0.1:${port}`, url], { timeout: 35000 });
}

function curlDirect(url: string) {
  return run("curl", ["-k", "-L", "--http1.1", "-fsSL", "--max-time", "20", url], { timeout: 30000 });
}

function extractIp(text: string): string | null {
  const matches = [...text.matchAll(/\b(?:\d{1,3}\.){3}\d{1,3}\b/g)].map((m) => m[0]);
  return matches.find((ip) => ip.split(".").every((x) => Number(x) >= 0 && Number(x) <= 255)) || null;
}

async function countryFor(ip: string): Promise<string> {
  try { return curlDirect(`https://ipinfo.io/${ip}/country`).trim(); } catch {}
  try { return curlDirect(`https://ipapi.co/${ip}/country/`).trim(); } catch {}
  return "UNKNOWN";
}

async function runtimeCheck(clientConfig: Record<string, unknown>, workdir: string) {
  const socksPort = 18080 + Math.floor(Math.random() * 500);
  const httpPort = socksPort + 1;
  const runtimeConfig = forceEndpointClientConfig(clientConfig, endpointArg, socksPort, httpPort);
  const runtimePath = join(workdir, `runtime-${endpointArg}.json`);
  await writeFile(runtimePath, JSON.stringify(runtimeConfig, null, 2), { mode: 0o644 });
  await chmod(runtimePath, 0o644);
  const child = spawn("docker", [
    "run", "--rm", "--network", "host",
    "-v", `${workdir}:/work:ro`,
    "-v", `${GEO_DIR}:/usr/local/share/xray:ro`,
    XRAY_IMAGE,
    "run", "-config", `/work/${runtimePath.split("/").pop()}`,
  ], { stdio: ["ignore", "pipe", "pipe"] });
  let log = "";
  child.stdout.on("data", (d) => { log += d.toString(); });
  child.stderr.on("data", (d) => { log += d.toString(); });
  try {
    await waitPort(socksPort);
    const ruUrls = ["https://2ip.ru/", "https://yandex.ru/internet/", "https://internet.yandex.ru/"];
    let ruIp: string | null = null;
    const ruErrors: string[] = [];
    for (const url of ruUrls) {
      try {
        const body = curlViaSocks(socksPort, url);
        ruIp = extractIp(body);
        if (ruIp) break;
      } catch (error) {
        ruErrors.push(`${url}: ${error instanceof Error ? error.message.split("\n")[0] : String(error)}`);
      }
    }
    if (!ruIp) {
      console.log("RU checker did not expose IP; errors:", ruErrors);
    }
    const ruCountry = ruIp ? await countryFor(ruIp) : "UNKNOWN";
    const worldIp = curlViaSocks(socksPort, "https://api.ipify.org").trim();
    const worldCountry = await countryFor(worldIp);
    const result = { endpoint: endpointArg, localRelay, ruChecker: { ip: ruIp, country: ruCountry }, worldChecker: { ip: worldIp, country: worldCountry } };
    console.log(JSON.stringify(result, null, 2));
    if (endpointArg.startsWith("smart-")) {
      if (ruIp !== EXPECTED_RU_IP) {
        throw new Error(`RU checker expected exact IP ${EXPECTED_RU_IP}, got ${ruIp || "no-ip"} (${ruCountry})`);
      }
      if (worldIp === EXPECTED_RU_IP || worldCountry === "RU") {
        throw new Error(`World checker expected non-RU/non-${EXPECTED_RU_IP}, got ${worldIp} (${worldCountry})`);
      }
    }
  } finally {
    child.kill("SIGTERM");
    setTimeout(() => child.kill("SIGKILL"), 3000).unref();
    if (log) console.log(log.split("\n").slice(-20).join("\n"));
  }
}

const app = loadAppConfig();
const pool = createPool(app);
try {
  await ensureGeo();
  const secure = await loadSecureConfig(app.secureConfigPath);
  const workdir = await mkdtemp(join(tmpdir(), "vpn-panel-xray-validate-"));
  await chmod(workdir, 0o755);
  // Remote DE/US configs reference certificates that exist only on their
  // hosts and are validated by deploy-all.sh. This local validator covers the
  // regional routing core and generated client contract.
  const serverIds = ["regional-relays"];
  const configs: Array<{ name: string; path: string; config: Record<string, unknown> }> = [];
  for (const id of serverIds) {
    const config = await serverConfig(pool, secure, id);
    const path = join(workdir, `${id}.json`);
    await writeFile(path, JSON.stringify(config, null, 2), { mode: 0o644 });
    await chmod(path, 0o644);
    configs.push({ name: id, path, config });
  }
  const token = await firstToken(pool);
  const bundle = await bundleByToken(pool, token);
  if (!bundle) throw new Error("subscription token not found");
  const clientConfig = xrayClientSubscription(bundle, secure);
  const clientPath = join(workdir, "client.json");
  await writeFile(clientPath, JSON.stringify(clientConfig, null, 2), { mode: 0o644 });
  await chmod(clientPath, 0o644);
  configs.push({ name: "client", path: clientPath, config: clientConfig });

  const happRouting = decodeHappRoutingLink(happRoutingLink());
  console.log("Happ routing geo tags:", [...collectGeoTags(happRouting)].sort().join(", "));
  for (const item of configs) {
    console.log(`${item.name} geo tags:`, [...collectGeoTags(item.config)].sort().join(", "));
    xrayTest(item.path, workdir);
  }
  if (runtime) await runtimeCheck(clientConfig, workdir);
  console.log("validation OK");
} finally {
  await pool.end();
}

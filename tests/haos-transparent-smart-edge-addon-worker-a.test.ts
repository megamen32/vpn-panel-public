import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import dgram from "node:dgram";
import { once } from "node:events";
import { mkdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import net from "node:net";
import path from "node:path";
import test from "node:test";
import tls from "node:tls";

const root = process.cwd();
const addon = path.join(root, "deploy/haos/transparent-smart-edge-addon");

async function freePorts(count: number): Promise<number[]> {
  const servers: net.Server[] = [];
  try {
    for (let index = 0; index < count; index += 1) {
      const server = net.createServer();
      servers.push(server);
      server.listen(0, "127.0.0.1");
      await once(server, "listening");
    }
    return servers.map((server) => {
      const address = server.address();
      assert.ok(address && typeof address === "object");
      return address.port;
    });
  } finally {
    await Promise.all(servers.map((server) => new Promise<void>((resolve) => server.close(() => resolve()))));
  }
}

async function waitForTCP(port: number): Promise<void> {
  for (let attempt = 0; attempt < 80; attempt += 1) {
    const ready = await new Promise<boolean>((resolve) => {
      const socket = net.connect({ host: "127.0.0.1", port });
      socket.once("connect", () => { socket.destroy(); resolve(true); });
      socket.once("error", () => resolve(false));
    });
    if (ready) return;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  throw new Error(`listener 127.0.0.1:${port} did not become ready`);
}

function queryPacket(name: string): Buffer {
  const labels = name.split(".").map((label) => Buffer.concat([Buffer.from([label.length]), Buffer.from(label)]));
  const header = Buffer.alloc(12);
  header.writeUInt16BE(0x5a5a, 0);
  header.writeUInt16BE(0x0100, 2);
  header.writeUInt16BE(1, 4);
  return Buffer.concat([header, ...labels, Buffer.from([0, 0, 1, 0, 1])]);
}

async function queryUDP(port: number, name: string): Promise<Buffer> {
  const socket = dgram.createSocket("udp4");
  try {
    return await new Promise<Buffer>((resolve, reject) => {
      const timeout = setTimeout(() => reject(new Error("DNS query timed out")), 2000);
      socket.once("message", (message) => { clearTimeout(timeout); resolve(message); });
      socket.once("error", (error) => { clearTimeout(timeout); reject(error); });
      socket.send(queryPacket(name), port, "127.0.0.1");
    });
  } finally {
    socket.close();
  }
}

test("HAOS transparent Smart Edge add-on owns a pinned static sing-box and keeps final ports gated", async () => {
  const [config, dockerfile, run, healthcheck, validator, importer] = await Promise.all([
    readFile(path.join(addon, "config.yaml"), "utf8"),
    readFile(path.join(addon, "Dockerfile"), "utf8"),
    readFile(path.join(addon, "rootfs/usr/bin/run.sh"), "utf8"),
    readFile(path.join(addon, "rootfs/usr/bin/healthcheck.sh"), "utf8"),
    readFile(path.join(addon, "rootfs/usr/bin/validate-singbox-config.sh"), "utf8"),
    readFile(path.join(addon, "rootfs/usr/bin/prepare-singbox-config.sh"), "utf8"),
  ]);

  assert.match(config, /^  - aarch64$/m);
  assert.match(config, /^host_network: true$/m);
  assert.match(config, /^  dns_port: 1053$/m);
  assert.match(config, /^  edge_port: 10443$/m);
  assert.match(config, /^  edge_ipv4: "192\.168\.2\.1"$/m);
  assert.match(config, /^  singbox_internal_port: 23128$/m);
  assert.doesNotMatch(config, /^  singbox_internal_port: 13128$/m, "WAN DE owns 13128; private loopback must differ");
  assert.match(config, /^  singbox_outbound_tag: "world-auto"$/m);
  assert.match(config, /^  telegram_outbound_tag: "telegram-auto"$/m);
  assert.match(config, /^  require_singbox_config: false$/m);
  assert.match(config, /^  dns_port: "int\(1,65535\)"$/m);
  assert.match(config, /^  edge_port: "int\(1,65535\)"$/m);

  assert.match(dockerfile, /COPY smartdns\/ \.\//);
  assert.match(dockerfile, /COPY smartedge\/ \.\//);
  assert.match(dockerfile, /SING_BOX_VERSION=1\.13\.14/);
  assert.match(dockerfile, /CGO_ENABLED=0 go install -trimpath -tags with_utls/);
  assert.match(dockerfile, /-X github\.com\/sagernet\/sing-box\/constant\.Version=\$\{SING_BOX_VERSION\}/);
  assert.match(dockerfile, /github\.com\/sagernet\/sing-box\/cmd\/sing-box@v\$\{SING_BOX_VERSION\}/);
  assert.match(dockerfile, /file \/go\/bin\/sing-box \| grep -F "statically linked"/);
  assert.match(dockerfile, /COPY --from=builder \/go\/bin\/sing-box \/usr\/bin\/sing-box/);
  assert.match(dockerfile, /HEALTHCHECK[\s\S]*healthcheck\.sh/);

  assert.match(run, /CONFIG_PATH=\/data\/config\.json/);
  assert.match(run, /RUNTIME_CONFIG_PATH=\/data\/runtime-config\.json/);
  assert.match(run, /del\(\.dotListen, \.tls, \.publicDnsListen, \.sync\)/);
  assert.match(run, /\.udpListen = \{host: \$dns_host, port: \$dns_port, profile: "local"\}/);
  assert.match(run, /\.edgeProfiles\.local = \{enabled: true, ipv4: \$edge_ipv4, ttl: 60\}/);
  assert.match(run, /SINGBOX_CONFIG_PATH=\/data\/singbox\.json/);
  assert.match(run, /validate-singbox-config\.sh/);
  assert.match(run, /REQUIRE_SINGBOX_CONFIG.*DNS_PORT.*53.*EDGE_PORT.*443/s);
  assert.match(run, /\/usr\/bin\/sing-box run -c "\$SINGBOX_RUNTIME_PATH"/);
  assert.match(run, /export PROXY_HOST=127\.0\.0\.1/);
  assert.match(run, /export PROXY_PORT="\$SINGBOX_INTERNAL_PORT"/);
  assert.match(healthcheck, /nc -z -w 2 127\.0\.0\.1 "\$dns_port"/);
  assert.match(healthcheck, /nc -z -w 2 127\.0\.0\.1 "\$edge_port"/);
  assert.match(healthcheck, /nc -z -w 2 127\.0\.0\.1 "\$singbox_port"/);
  assert.match(healthcheck, /staging-no-transport/);

  assert.match(validator, /\.type == "vless"/);
  assert.match(validator, /\.tls\.utls\.enabled == true/);
  assert.match(validator, /\.transport\.type == "ws"/);
  assert.match(validator, /\.type == "urltest"/);
  assert.match(validator, /transparent-edge-http/);
  assert.match(validator, /ai-route/);
  assert.match(validator, /singbox_bin.*check -c/);
  assert.match(importer, /\.outbounds\[\]\? \| select/);
  assert.doesNotMatch(importer, /\buuid\s*:/);
});

test("deploy importer accepts complete regional groups without printing or broadening secret scope", async () => {
  const runtimeDir = path.join(root, ".tmp", "haos-addon-singbox-import-test");
  const destination = path.join(runtimeDir, "singbox.json");
  const fakeSingbox = path.join(runtimeDir, "sing-box");
  const importer = path.join(addon, "rootfs/usr/bin/prepare-singbox-config.sh");
  const validator = path.join(addon, "rootfs/usr/bin/validate-singbox-config.sh");
  const source = path.join(root, "deploy/server-44/sing-box/config.json");
  await rm(runtimeDir, { recursive: true, force: true });
  await mkdir(runtimeDir, { recursive: true });
  await writeFile(fakeSingbox, "#!/bin/sh\n[ \"$1\" = check ] && [ \"$2\" = -c ]\n", { mode: 0o700 });
  try {
    const result = spawnSync("bash", [importer, source, "de-regional", destination, "23128", "us-regional"], {
      encoding: "utf8",
      env: { ...process.env, SING_BOX_BIN: fakeSingbox, VALIDATOR_BIN: validator },
    });
    assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`);
    assert.equal(result.stderr, "");
    assert.match(result.stdout, /^sing-box transport config valid: outbound=de-regional telegram=us-regional loopback_port=23128( ai_route=(true|false))?\n/);
    assert.match(result.stdout, /sing-box transport installed at .* using automatic groups de-regional \/ us-regional\n$/);

    const generated = JSON.parse(await readFile(destination, "utf8")) as {
      inbounds?: Array<{ type?: string; tag?: string; listen?: string; listen_port?: number }>;
      outbounds?: Array<{ type?: string; tag?: string; tls?: { enabled?: boolean; utls?: { enabled?: boolean } }; transport?: { type?: string } }>;
      route?: { final?: string };
    };
    assert.equal(generated.inbounds?.length, 1);
    assert.equal(generated.inbounds?.[0]?.listen, "127.0.0.1");
    assert.equal(generated.inbounds?.[0]?.listen_port, 23128);
    const tags = new Set(generated.outbounds?.map((outbound) => outbound.tag));
    assert.ok(tags.has("de-regional"));
    assert.ok(tags.has("us-regional"));
    assert.ok((generated.outbounds?.filter((outbound) => outbound.type === "vless").length ?? 0) > 2);
    assert.equal(generated.route?.final, "de-regional");
    assert.equal((await stat(destination)).mode & 0o777, 0o600);
  } finally {
    await rm(runtimeDir, { recursive: true, force: true });
  }
});

test("runtime config sends Telegram DCs and web domains through auto failover beside independent LAN proxies", async () => {
  const runtimeDir = path.join(root, ".tmp", "haos-addon-runtime-inbounds-test");
  const source = path.join(runtimeDir, "source.json");
  const destination = path.join(runtimeDir, "runtime.json");
  const usersFile = path.join(runtimeDir, "fixture-proxy-users.json");
  const users = [{ username: "isolated-fixture", password: "isolated-fixture-password" }];
  const configurer = path.join(addon, "rootfs/usr/bin/configure-runtime-inbounds.sh");
  await rm(runtimeDir, { recursive: true, force: true });
  await mkdir(runtimeDir, { recursive: true });
  await writeFile(source, JSON.stringify({
    inbounds: [{ type: "http", tag: "private-http", listen: "127.0.0.1", listen_port: 23128 }],
    outbounds: [{ type: "direct", tag: "us-regional" }, { type: "direct", tag: "de-regional" },
      { type: "direct", tag: "telegram-auto" },
      { type: "direct", tag: "direct" }],
    route: { rules: [{ inbound: ["transparent-edge-http"], domain_suffix: ["telegram.org", "telegram.me", "t.me", "tdesktop.com", "telesco.pe", "telegra.ph"], outbound: "telegram-auto" }], final: "direct" },
  }));
  await writeFile(usersFile, JSON.stringify({ users }), { mode: 0o600 });
  try {
    const result = spawnSync("bash", [configurer, source, destination,
      "true", "12555", "telegram-auto", "true", "3127", "us-regional", "true", "3128", "de-regional",
      "false", "3129", "fi-helsinki", "false", "3130", "direct", usersFile, "false",
    ], { encoding: "utf8" });
    assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`);
    const runtime = JSON.parse(await readFile(destination, "utf8")) as {
      inbounds: Array<{ type: string; tag: string; listen: string; listen_port: number; users?: typeof users }>;
      route: { rules: Array<{ inbound: string[]; outbound: string }> };
    };
    assert.deepEqual(runtime.inbounds, [
      { type: "http", tag: "private-http", listen: "127.0.0.1", listen_port: 23128 },
      { type: "tproxy", tag: "telegram-tproxy", listen: "0.0.0.0", listen_port: 12555 },
      { type: "http", tag: "lan-us-http", listen: "0.0.0.0", listen_port: 3127 },
      { type: "http", tag: "wan-us-http", listen: "0.0.0.0", listen_port: 13127, users },
      { type: "http", tag: "lan-de-http", listen: "0.0.0.0", listen_port: 3128 },
      { type: "http", tag: "wan-de-http", listen: "0.0.0.0", listen_port: 13128, users },
    ]);
    assert.equal(new Set(runtime.inbounds.map((inbound) => inbound.listen_port)).size, runtime.inbounds.length);
    assert.deepEqual(runtime.route.rules, [
      { inbound: ["wan-de-http"], outbound: "de-regional" },
      { inbound: ["lan-de-http"], outbound: "de-regional" },
      { inbound: ["wan-us-http"], outbound: "us-regional" },
      { inbound: ["lan-us-http"], outbound: "us-regional" },
      { inbound: ["telegram-tproxy"], outbound: "telegram-auto" },
      { inbound: ["transparent-edge-http"], domain_suffix: ["telegram.org", "telegram.me", "t.me", "tdesktop.com", "telesco.pe", "telegra.ph"], outbound: "telegram-auto" },
    ]);
  } finally {
    await rm(runtimeDir, { recursive: true, force: true });
  }
});

test("vendored VPN Panel runtimes compile and Smart Edge CONNECT tests pass", () => {
  for (const component of ["smartdns", "smartedge"]) {
    const result = spawnSync("go", ["test", "./..."], {
      cwd: path.join(addon, component),
      encoding: "utf8",
      env: { ...process.env, CGO_ENABLED: "0" },
    });
    assert.equal(result.status, 0, `${component}:\n${result.stdout}\n${result.stderr}`);
  }
});

test("staging listeners synthesize the router IP and send TLS through HTTP CONNECT", async () => {
  const runtimeDir = path.join(addon, ".runtime-test");
  const smartdnsBinary = path.join(runtimeDir, "smartdns");
  const smartedgeBinary = path.join(runtimeDir, "smart-edge");
  const configPath = path.join(runtimeDir, "config.json");
  await rm(runtimeDir, { recursive: true, force: true });
  await mkdir(runtimeDir, { recursive: true });

  const builds = [
    [path.join(addon, "smartdns"), smartdnsBinary],
    [path.join(addon, "smartedge"), smartedgeBinary],
  ] as const;
  for (const [cwd, output] of builds) {
    const result = spawnSync("go", ["build", "-trimpath", "-o", output, "."], {
      cwd,
      encoding: "utf8",
      env: { ...process.env, CGO_ENABLED: "0" },
    });
    assert.equal(result.status, 0, `${cwd}:\n${result.stdout}\n${result.stderr}`);
  }

  const [dnsPort, dohPort, edgePort, proxyPort] = await freePorts(4);
  await writeFile(configPath, JSON.stringify({
    defaultClientId: "lan",
    clients: { lan: { enabled: true, mode: "direct", defaultRoute: "direct" } },
    defaultRoute: "direct",
    localDefaultRoute: "direct",
    rules: [{ id: "test-proxy", text: "example.com", match: "suffix", through: ["proxy"], conditions: ["internalDns"] }],
    directDns: { host: "1.1.1.1", port: 53, timeoutMs: 500 },
    httpProxy: { host: "127.0.0.1", port: proxyPort, timeoutMs: 500 },
    dohListen: { host: "127.0.0.1", port: dohPort, profile: "local" },
    udpListen: { host: "127.0.0.1", port: dnsPort, profile: "local" },
    edgeProfiles: { local: { enabled: true, ipv4: "192.168.2.1", ttl: 60 } },
  }), { mode: 0o600 });

  const proxySockets = new Set<net.Socket>();
  let connectRequest = "";
  let resolveConnect!: () => void;
  let resolveTunnel!: () => void;
  const connectSeen = new Promise<void>((resolve) => { resolveConnect = resolve; });
  const tunnelSeen = new Promise<void>((resolve) => { resolveTunnel = resolve; });
  const proxy = net.createServer((socket) => {
    proxySockets.add(socket);
    socket.once("close", () => proxySockets.delete(socket));
    let header = Buffer.alloc(0);
    let connected = false;
    socket.on("data", (chunk) => {
      if (connected) {
        if (chunk.length > 0 && chunk[0] === 0x16) resolveTunnel();
        return;
      }
      header = Buffer.concat([header, chunk]);
      const end = header.indexOf("\r\n\r\n");
      if (end < 0) return;
      connectRequest = header.subarray(0, end + 4).toString("latin1");
      connected = true;
      resolveConnect();
      socket.write("HTTP/1.1 200 Connection established\r\n\r\n");
      const remainder = header.subarray(end + 4);
      if (remainder.length > 0 && remainder[0] === 0x16) resolveTunnel();
    });
  });
  proxy.listen(proxyPort, "127.0.0.1");
  await once(proxy, "listening");

  const smartdns = spawn(smartdnsBinary, [], {
    env: { ...process.env, SMART_DNS_CONFIG: configPath },
    stdio: "ignore",
  });
  const smartedge = spawn(smartedgeBinary, [], {
    env: {
      ...process.env,
      LISTEN_HOST: "127.0.0.1",
      LISTEN_PORT: String(edgePort),
      CONNECT_PORT: "443",
      PROXY_HOST: "127.0.0.1",
      PROXY_PORT: String(proxyPort),
      STATS_INTERVAL_SECONDS: "3600",
    },
    stdio: "ignore",
  });

  try {
    await Promise.all([waitForTCP(dnsPort), waitForTCP(edgePort)]);
    const dnsAnswer = await queryUDP(dnsPort, "example.com");
    assert.deepEqual([...dnsAnswer.subarray(-4)], [192, 168, 2, 1]);

    const tlsClient = tls.connect({
      host: "127.0.0.1",
      port: edgePort,
      servername: "example.com",
      rejectUnauthorized: false,
    });
    tlsClient.on("error", () => {});
    await Promise.race([
      Promise.all([connectSeen, tunnelSeen]),
      new Promise((_, reject) => setTimeout(() => reject(new Error("CONNECT tunnel timed out")), 2000)),
    ]);
    tlsClient.destroy();
    assert.match(connectRequest, /^CONNECT example\.com:443 HTTP\/1\.1\r\n/m);
  } finally {
    smartdns.kill("SIGTERM");
    smartedge.kill("SIGTERM");
    for (const socket of proxySockets) socket.destroy();
    await new Promise<void>((resolve) => proxy.close(() => resolve()));
    await rm(runtimeDir, { recursive: true, force: true });
  }
});

import assert from "node:assert/strict";
import { chmod, mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import test from "node:test";

test("VUSA public H2 stream-up is preserved through nginx grpc_pass", async () => {
  const [nginx, ownership] = await Promise.all([
    readFile(new URL("../deploy/vusa/nginx/edge-https.conf", import.meta.url), "utf8"),
    readFile(new URL("../deploy/vusa/nginx/README.md", import.meta.url), "utf8"),
  ]);
  const location = nginx.match(/location \^~ \/xhttp-h2-443 \{[\s\S]*?^    \}/m)?.[0] || "";

  assert.match(location, /grpc_pass grpc:\/\/127\.0\.0\.1:20087;/);
  assert.match(location, /grpc_read_timeout 600s;/);
  assert.doesNotMatch(location, /proxy_http_version 1\.1/);
  assert.match(ownership, /product-owned remote VUSA transport vhost/i);
  assert.match(ownership, /ServersAdministartion\/infra\/vpn-remote-upstreams\.md/);
});

test("VUSA deploy stages and validates both candidates before one atomic activation", async () => {
  const script = await readFile(new URL("../scripts/deploy-all.sh", import.meta.url), "utf8");
  const start = script.indexOf("deploy_vusa() {");
  const end = script.indexOf("\ndeploy_server_44()", start);
  const deploy = script.slice(start, end);

  assert.ok(start >= 0 && end > start, "deploy_vusa function must exist");
  assert.match(deploy, /receipt_dir/);
  assert.match(deploy, /xray\.candidate/);
  assert.match(deploy, /edge-https\.candidate/);
  assert.match(deploy, /xray run -test/);
  assert.match(deploy, /nginx -t -c/);
  assert.match(deploy, /DRY_RUN/);
  assert.match(deploy, /VUSA_RECEIPT_ID/);
  assert.doesNotMatch(deploy, /DRY-RUN: skipping remote push/);

  const stage = deploy.indexOf("xray.candidate");
  const xrayPreflight = deploy.indexOf("xray run -test");
  const nginxPreflight = deploy.indexOf("nginx -t -c");
  const activate = deploy.indexOf("install -m 0644", nginxPreflight);
  assert.ok(stage >= 0 && xrayPreflight > stage && nginxPreflight > stage, "both remote preflights must follow staging");
  assert.ok(activate > xrayPreflight && activate > nginxPreflight, "activation must follow both remote preflights");

  assert.match(deploy, /config\.json\.before/);
  assert.match(deploy, /edge-https\.before/);
  assert.match(deploy, /restore_transaction/);
  assert.match(deploy, /systemctl restart xray/);
  assert.match(deploy, /systemctl (?:reload|restart) nginx/);
  assert.match(deploy, /for required_port in[\s\S]+20087/);
});

test("VUSA transaction restores both active files when a required listener is absent", async () => {
  const deployAll = await readFile(new URL("../scripts/deploy-all.sh", import.meta.url), "utf8");
  const remoteMatch = deployAll.match(/<<'REMOTE_VUSA'\n([\s\S]*?)\nREMOTE_VUSA/);
  assert.ok(remoteMatch, "embedded VUSA transaction must exist");

  const root = await mkdtemp(path.join(os.tmpdir(), "vusa-transaction-test-"));
  const bin = path.join(root, "bin");
  const xrayDir = path.join(root, "xray");
  const sitesAvailable = path.join(root, "sites-available");
  const sitesEnabled = path.join(root, "sites-enabled");
  const receipts = path.join(root, "receipts");
  await Promise.all([mkdir(bin), mkdir(xrayDir), mkdir(sitesAvailable), mkdir(sitesEnabled)]);
  const activeXray = path.join(xrayDir, "config.json");
  const activeNginx = path.join(sitesAvailable, "edge-https");
  const activeLink = path.join(sitesEnabled, "edge-https");
  await writeFile(activeXray, "old xray\n");
  await writeFile(activeNginx, "old nginx\n");

  await Promise.all([
    writeFile(path.join(bin, "xray"), "#!/usr/bin/env bash\necho 'Configuration OK.'\n"),
    writeFile(path.join(bin, "nginx"), "#!/usr/bin/env bash\nexit 0\n"),
    writeFile(path.join(bin, "systemctl"), "#!/usr/bin/env bash\nexit 0\n"),
    writeFile(path.join(bin, "ss"), `#!/usr/bin/env bash
if [[ "$*" == *":20087"* ]]; then exit 0; fi
echo 'LISTEN 0 4096 127.0.0.1:443 0.0.0.0:*'
`),
  ]);
  await Promise.all(["xray", "nginx", "systemctl", "ss"].map((file) => chmod(path.join(bin, file), 0o755)));

  const transaction = remoteMatch[1]
    .replace("remote_xray=/usr/local/etc/xray/config.json", `remote_xray=${activeXray}`)
    .replace("remote_nginx=/etc/nginx/sites-available/edge-https", `remote_nginx=${activeNginx}`)
    .replace("remote_nginx_link=/etc/nginx/sites-enabled/edge-https", `remote_nginx_link=${activeLink}`)
    .replace("receipt_root=/var/backups/vpn-panel/vusa", `receipt_root=${receipts}`)
    .replaceAll("/usr/local/bin/xray", "xray")
    .replaceAll("install -m 0644 -o root -g root", "install -m 0644");
  const transactionPath = path.join(root, "transaction.sh");
  await writeFile(transactionPath, transaction);

  const result = spawnSync("bash", [transactionPath], {
    encoding: "utf8",
    env: {
      ...process.env,
      PATH: `${bin}:${process.env.PATH}`,
      DRY_RUN: "false",
      VUSA_RECEIPT_ID: "test-vusa-transaction",
      XRAY_B64: Buffer.from("new xray\n").toString("base64"),
      NGINX_B64: Buffer.from("new nginx\n").toString("base64"),
    },
  });
  assert.notEqual(result.status, 0, "missing port 20087 must fail the transaction");
  assert.equal(await readFile(activeXray, "utf8"), "old xray\n");
  assert.equal(await readFile(activeNginx, "utf8"), "old nginx\n");
  assert.match(result.stderr, /restored both components/);
});

test("frozen VUSA mode verifies a two-file manifest and skips all canonical regeneration", async () => {
  const deployPath = new URL("../scripts/deploy-all.sh", import.meta.url);
  const deploy = await readFile(deployPath, "utf8");
  assert.match(deploy, /--frozen/);
  assert.match(deploy, /VUSA_FROZEN_MANIFEST/);
  assert.match(deploy, /sha256sum -c/);
  assert.match(deploy, /FROZEN_SNAPSHOT/);
  assert.match(deploy, /install -m 0600 "\$CFG" "\$FROZEN_SNAPSHOT\/xray-config\.json"/);
  assert.match(deploy, /CFG="\$FROZEN_SNAPSHOT\/xray-config\.json"/);
  assert.match(deploy, /invalid JSON"; return 1; \}[\s\S]*cleanup_vusa_snapshot|cleanup_vusa_snapshot; trap - ERR; log "  ERROR: invalid JSON"/);
  assert.match(deploy, /cleanup_vusa_snapshot; trap - ERR; log "  ERROR: missing canonical nginx config/);
  assert.match(deploy, /FROZEN[\s\S]*skip.*regenerat/i);

  const root = await mkdtemp(path.join(os.tmpdir(), "vusa-frozen-test-"));
  const bin = path.join(root, "bin");
  const manifest = path.join(root, "vusa.sha256");
  await mkdir(bin);
  await writeFile(path.join(bin, "ssh"), "#!/usr/bin/env bash\ncat >/dev/null\nexit 0\n");
  await chmod(path.join(bin, "ssh"), 0o755);

  const project = path.resolve(new URL("..", import.meta.url).pathname);
  const tracked = [
    "deploy/vpn2/xray/config.json",
    "deploy/server-44/sing-box/config.json",
    "deploy/server-88/xray/config.json",
    "deploy/vusa/xray/config.json",
    "deploy/vusa/nginx/edge-https.conf",
  ];
  const before = new Map<string, string>();
  for (const file of tracked) before.set(file, await readFile(path.join(project, file), "utf8"));
  const { createHash } = await import("node:crypto");
  const lines = ["deploy/vusa/xray/config.json", "deploy/vusa/nginx/edge-https.conf"].map((file) => {
    const digest = createHash("sha256").update(before.get(file)!).digest("hex");
    return `${digest}  ${file}`;
  });
  await writeFile(manifest, `${lines.join("\n")}\n`);

  const result = spawnSync("bash", [deployPath.pathname, "--frozen", "--dry-run", "vusa"], {
    cwd: project,
    encoding: "utf8",
    env: {
      ...process.env,
      PATH: `${bin}:${process.env.PATH}`,
      VUSA_FROZEN_MANIFEST: manifest,
      VUSA_RECEIPT_ID: "test-frozen-vusa",
    },
  });
  assert.equal(result.status, 0, result.stderr);
  for (const file of tracked) {
    assert.equal(await readFile(path.join(project, file), "utf8"), before.get(file), `${file} changed in frozen mode`);
  }
  assert.doesNotMatch(result.stdout, /Regenerating canonical configs/);
});

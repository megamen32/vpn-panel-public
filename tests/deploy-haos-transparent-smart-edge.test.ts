import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { chmod, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";

const root = process.cwd();
const deploy = path.join(root, "scripts/deploy-haos-transparent-smart-edge.sh");

test("deploy script supports transactional staging and live updates without local secret files", async () => {
  const source = await readFile(deploy, "utf8");
  assert.match(source, /root@192\.168\.2\.101/);
  assert.match(source, /HAOS_SMART_EDGE_PORT:-2228/);
  assert.match(source, /roomhacker@192\.168\.2\.5/);
  assert.match(source, /sudo -n cat -- '\$server44_config'/);
  assert.match(source, /roomhacker@192\.168\.2\.100/);
  assert.match(source, /HAOS_SMART_EDGE_POLICY_PORT:-22/);
  assert.match(source, /LAN_SMART_DNS_PUBLIC_EDGE_IP:-203\.0\.113\.1/);
  assert.match(source, /\.edge_ipv4 = \$smart_dns_public_edge_ip/);
  assert.match(source, /grep -Fx ['"]?\$smart_dns_public_edge_ip/);
  assert.doesNotMatch(source, /edge_ipv4\":\"192\.168\.2\.1\"/);
  assert.match(source, /\/mnt\/data\/supervisor\/addons\/local/);
  assert.doesNotMatch(source, /\/mnt\/data\/supervisor\/apps\/local/);
  assert.match(source, /\/mnt\/data\/supervisor\/apps\/data/);
  assert.match(source, /transparent_smart_edge/);
  assert.match(source, /27579e22_bezrabotnyi_transparent_smart_edge/);
  assert.match(source, /ha store reload/);
  assert.match(source, /ha apps (install|update)/);
  assert.match(source, /deploy-backups/);
  assert.match(source, /source\.before/);
  assert.match(source, /restore_transaction/);
  assert.match(source, /prepare-singbox-config\.sh/);
  assert.match(source, /de-regional/);
  assert.match(source, /us-regional/);
  assert.match(source, /telegram_outbound_tag(?:\\"|\")?[: =]+(?:\\"|\")?telegram-auto/);
  assert.match(source, /singbox_outbound_tag(?:\\"|\")?[: =]+(?:\\"|\")?world-auto/);
  assert.doesNotMatch(source, /telegram_outbound_tag(?:\\"|\")?[: =]+(?:\\"|\")?us-reality/);
  assert.match(source, /@192\.168\.2\.101 -p 1053 chatgpt\.com/);
  assert.match(source, /@192\.168\.2\.101 -p 1053 chatgpt\.com A \+tcp/);
  assert.match(source, /require_singbox_config\":true/);
  assert.match(source, /supervisor\/addons\/\$addon_slug\/options/);
  assert.doesNotMatch(source, /ha apps options/);
  assert.match(source, /chatgpt\.com:10443:192\.168\.2\.101/);
  assert.match(source, /--update-live/);
  assert.match(source, /--apply-transport/);
  assert.match(source, /--rollback-transport/);
  assert.match(source, /assert_runtime_groups/);
  assert.match(source, /preserved DNS/);
  assert.doesNotMatch(source, /--final|ha apps uninstall|192\.168\.2\.1:443/);
  assert.doesNotMatch(source, /mktemp|\/tmp\//);
  const runtimeOnly = source.slice(source.indexOf("run_transport_apply()"), source.indexOf("stream_transport()"));
  assert.match(runtimeOnly, /telegram-auto/);
  assert.match(runtimeOnly, /backup_data/);
  assert.match(runtimeOnly, /restore_data/);
  assert.doesNotMatch(runtimeOnly, /ha store reload|ha apps update|install_source/);
});

test("--check performs only read-only remote capability and source checks", async () => {
  const fixture = path.join(root, ".tmp", "haos-deploy-check-test");
  const bin = path.join(fixture, "bin");
  const log = path.join(fixture, "ssh.log");
  await rm(fixture, { recursive: true, force: true });
  await mkdir(bin, { recursive: true });
  const fakeSsh = path.join(bin, "ssh");
  await writeFile(fakeSsh, `#!/bin/sh\nprintf '%s\\n' "$*" >>"$SSH_LOG"\ncat >/dev/null || true\n`, { mode: 0o700 });
  await chmod(fakeSsh, 0o700);
  try {
    const result = spawnSync("bash", [deploy, "--check"], {
      cwd: root,
      encoding: "utf8",
      env: { ...process.env, SSH_BIN: fakeSsh, SSH_LOG: log },
    });
    assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`);
    assert.match(result.stdout, /CHECK OK/);
    const calls = await readFile(log, "utf8");
    assert.match(calls, /root@192\.168\.2\.101/);
    assert.match(calls, /roomhacker@192\.168\.2\.5/);
    assert.match(calls, /roomhacker@192\.168\.2\.100/);
    assert.doesNotMatch(calls, /docker run|ha store reload|ha apps (install|rebuild|start|restart|options)/);
  } finally {
    await rm(fixture, { recursive: true, force: true });
  }
});

test("--check rejects a private SmartDNS edge alias before remote access", () => {
  const result = spawnSync("bash", [deploy, "--check"], {
    cwd: root,
    encoding: "utf8",
    env: { ...process.env, LAN_SMART_DNS_PUBLIC_EDGE_IP: "192.168.2.1" },
  });
  assert.equal(result.status, 2);
  assert.match(result.stderr, /public SmartDNS edge IPv4 address must not be local/);
});

test("--staging uses helper source install, secure streams, staging options, and canaries", async () => {
  const fixture = path.join(root, ".tmp", "haos-deploy-staging-test");
  const bin = path.join(fixture, "bin");
  const log = path.join(fixture, "ssh.log");
  const secure = path.join(fixture, "secure.json");
  await rm(fixture, { recursive: true, force: true });
  await mkdir(bin, { recursive: true });
  await writeFile(secure, JSON.stringify({
    nodes: [],
    server_configs: { "regional-relays": { fi_connect_address: "198.51.100.10", fi_relay_uuid: "test-uuid", fi_public_key: "test-key", fi_short_id: "test-id" } },
  }));
  const fakeSsh = path.join(bin, "ssh");
  const fakeDig = path.join(bin, "dig");
  const fakeCurl = path.join(bin, "curl");
  await writeFile(fakeSsh, `#!/bin/sh
joined="$*"
printf '%s\\n' "$joined" >>"$SSH_LOG"
case "$joined" in
  *"http://supervisor/addons/27579e22_bezrabotnyi_transparent_smart_edge/options"*) body="$(cat)"; printf 'PAYLOAD %s\\n' "$body" >>"$SSH_LOG"; printf '%s\\n' '{"result":"ok"}'; exit 0 ;;
  *"http://supervisor/addons/27579e22_bezrabotnyi_transparent_smart_edge/info"*) printf '%s\\n' '{"result":"ok","data":{"state":"started","options":{"require_singbox_config":true,"dns_port":1053,"edge_port":10443}}}' ;;
  *"roomhacker@192.168.2.100"*"cat --"*) printf '%s\\n' '{"defaultClientId":"lan","clients":{"lan":{"enabled":true}},"rules":[]}' ;;
  *"roomhacker@192.168.2.5"*"cat --"*) printf '%s\\n' '{"outbounds":[]}' ;;
  *"cat /data/singbox.json"*) printf '%s\\n' '{"outbounds":[{"type":"vless","tag":"de-one"},{"type":"urltest","tag":"de-regional","outbounds":["de-one"]},{"type":"vless","tag":"us-one"},{"type":"urltest","tag":"us-regional","outbounds":["us-one"]}]}' ;;
  *"installed=0; running=0"*) printf '%s\\n' '0 0' ;;
  *"docker ps -a"*) printf '%s\\n' 'app_27579e22_bezrabotnyi_transparent_smart_edge' ;;
esac
cat >/dev/null || true
`, { mode: 0o700 });
  await writeFile(fakeDig, "#!/bin/sh\nprintf '%s\\n' 203.0.113.1\n", { mode: 0o700 });
  await writeFile(fakeCurl, "#!/bin/sh\nprintf '%s' 403\n", { mode: 0o700 });
  try {
    const result = spawnSync("bash", [deploy, "--staging"], {
      cwd: root,
      encoding: "utf8",
      env: { ...process.env, SSH_BIN: fakeSsh, SSH_LOG: log, DIG_BIN: fakeDig, CURL_BIN: fakeCurl, VPN_PANEL_SECURE_CONFIG: secure },
    });
    assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`);
    assert.match(result.stdout, /STAGING OK/);
    const calls = await readFile(log, "utf8");
    assert.match(calls, /docker run --rm -i.*supervisor\/addons\/local:\/apps/);
    assert.match(calls, /ha store reload/);
    assert.match(calls, /ha apps install '27579e22_bezrabotnyi_transparent_smart_edge'/);
    assert.match(calls, /PAYLOAD .*dns_port":1053.*edge_port":10443/);
    assert.match(calls, /PAYLOAD .*edge_ipv4":"203\.0\.113\.1"/);
    assert.match(calls, /PAYLOAD .*require_singbox_config":true/);
    assert.match(calls, /PAYLOAD .*telegram_outbound_tag":"telegram-auto"/);
    assert.match(calls, /PAYLOAD .*singbox_outbound_tag":"world-auto"/);
    assert.match(calls, /prepare-singbox-config\.sh/);
    assert.match(calls, /ha apps restart/);
    assert.doesNotMatch(calls, /apps uninstall|dns_port":53|edge_port":443/);
  } finally {
    await rm(fixture, { recursive: true, force: true });
  }
});

test("failed staging canary restores data/source and stops a newly installed app without uninstall", async () => {
  const fixture = path.join(root, ".tmp", "haos-deploy-rollback-test");
  const bin = path.join(fixture, "bin");
  const log = path.join(fixture, "ssh.log");
  const secure = path.join(fixture, "secure.json");
  await rm(fixture, { recursive: true, force: true });
  await mkdir(bin, { recursive: true });
  await writeFile(secure, JSON.stringify({
    nodes: [],
    server_configs: { "regional-relays": { fi_connect_address: "198.51.100.10", fi_relay_uuid: "test-uuid", fi_public_key: "test-key", fi_short_id: "test-id" } },
  }));
  const fakeSsh = path.join(bin, "ssh");
  const fakeDig = path.join(bin, "dig");
  const fakeCurl = path.join(bin, "curl");
  await writeFile(fakeSsh, `#!/bin/sh
joined="$*"
printf '%s\\n' "$joined" >>"$SSH_LOG"
case "$joined" in
  *"http://supervisor/addons/27579e22_bezrabotnyi_transparent_smart_edge/options"*) body="$(cat)"; printf 'PAYLOAD %s\\n' "$body" >>"$SSH_LOG"; printf '%s\\n' '{"result":"ok"}'; exit 0 ;;
  *"http://supervisor/addons/27579e22_bezrabotnyi_transparent_smart_edge/info"*) printf '%s\\n' '{"result":"ok","data":{"state":"started","options":{"require_singbox_config":true,"dns_port":1053,"edge_port":10443}}}' ;;
  *"roomhacker@192.168.2.100"*"cat --"*) printf '%s\\n' '{"defaultClientId":"lan","clients":{"lan":{"enabled":true}},"rules":[]}' ;;
  *"roomhacker@192.168.2.5"*"cat --"*) printf '%s\\n' '{"outbounds":[]}' ;;
  *"cat /data/singbox.json"*) printf '%s\\n' '{"outbounds":[{"type":"vless","tag":"de-one"},{"type":"urltest","tag":"de-regional","outbounds":["de-one"]},{"type":"vless","tag":"us-one"},{"type":"urltest","tag":"us-regional","outbounds":["us-one"]}]}' ;;
  *"installed=0; running=0"*) printf '%s\\n' '0 0' ;;
  *"docker ps -a"*) printf '%s\\n' 'app_27579e22_bezrabotnyi_transparent_smart_edge' ;;
esac
cat >/dev/null || true
`, { mode: 0o700 });
  await writeFile(fakeDig, "#!/bin/sh\nprintf '%s\\n' 203.0.113.9\n", { mode: 0o700 });
  await writeFile(fakeCurl, "#!/bin/sh\nprintf '%s' 000\n", { mode: 0o700 });
  try {
    const result = spawnSync("bash", [deploy, "--staging"], {
      cwd: root,
      encoding: "utf8",
      env: { ...process.env, SSH_BIN: fakeSsh, SSH_LOG: log, DIG_BIN: fakeDig, CURL_BIN: fakeCurl, VPN_PANEL_SECURE_CONFIG: secure },
    });
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /Staging failed; restoring receipt/);
    const calls = await readFile(log, "utf8");
    assert.match(calls, /docker run --rm -i.*supervisor\/apps\/data:\/apps-data.*sh -s -- '[0-9]{8}_[0-9]{6}'/);
    assert.match(calls, /source\.after/);
    assert.match(calls, /source\.before/);
    assert.match(calls, /ha store reload/);
    assert.match(calls, /ha apps stop '27579e22_bezrabotnyi_transparent_smart_edge'/);
    assert.doesNotMatch(calls, /apps uninstall/);
  } finally {
    await rm(fixture, { recursive: true, force: true });
  }
});

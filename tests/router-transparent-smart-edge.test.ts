import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import test from "node:test";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);
const root = process.cwd();
const routerApply = join(root, "deploy/router/transparent-smart-edge/apply.sh");

type Uci = Map<string, string>;

function parseUci(source: string): Uci {
  const result = new Map<string, string>();
  for (const line of source.trim().split("\n")) {
    const split = line.indexOf("=");
    if (split > 0) result.set(line.slice(0, split), line.slice(split + 1));
  }
  return result;
}

function transparentFlowWorks(config: Uci): boolean {
  const client = "192.168.2.50";
  const router = "192.168.2.1";
  const haos = "192.168.2.101";
  const dnat = "firewall.vpn_panel_transparent_https";
  const snat = "firewall.vpn_panel_transparent_https_return";

  if (
    config.get(`${dnat}.target`) !== "DNAT" ||
    config.get(`${dnat}.src_dip`) !== router ||
    config.get(`${dnat}.dest_ip`) !== haos ||
    config.get(`${dnat}.src_dport`) !== "443"
  ) return false;

  // After DNAT both peers are on 192.168.2.0/24. Without the scoped SNAT,
  // HAOS replies directly as .101 and the client rejects it because it opened
  // the connection to .1. With SNAT, HAOS replies to router and conntrack
  // reverses both translations, so the client sees the expected .1 peer.
  const sourceSeenByHaos =
    config.get(`${snat}.target`) === "SNAT" &&
    config.get(`${snat}.src_ip`) === "192.168.2.0/24" &&
    config.get(`${snat}.dest_ip`) === haos &&
    config.get(`${snat}.dest_port`) === "443" &&
    config.get(`${snat}.src_dip`) === router
      ? router
      : client;
  const responseNextHop = sourceSeenByHaos;
  const responsePeerAfterConntrack = responseNextHop === router ? router : haos;
  return responseNextHop === router && responsePeerAfterConntrack === router;
}

async function fixture() {
  await mkdir(join(root, ".tmp"), { recursive: true });
  const dir = await mkdtemp(join(root, ".tmp", "router-transparent-smart-edge-test."));
  const bin = join(dir, "bin");
  const config = join(dir, "config");
  const initd = join(dir, "init.d");
  const backups = join(dir, "backups");
  const uciState = join(dir, "uci.state");
  const calls = join(dir, "calls.log");
  await Promise.all([mkdir(bin), mkdir(config), mkdir(initd), mkdir(backups)]);
  await writeFile(join(config, "dhcp"), "original dhcp\n");
  await writeFile(join(config, "firewall"), "original firewall\n");
  await writeFile(uciState, "");

  const uci = `#!/bin/sh
set -eu
state="$UCI_STATE"
[ "\${1:-}" != -q ] || shift
command="\${1:-}"; shift || true
case "$command" in
  set|add_list)
    pair="$1"; key="\${pair%%=*}"; value="\${pair#*=}"
    awk -F= -v key="$key" '$1 != key' "$state" > "$state.next"
    printf '%s=%s\\n' "$key" "$value" >> "$state.next"
    mv "$state.next" "$state"
    ;;
  delete)
    key="$1"
    awk -F= -v key="$key" '$1 != key && index($1, key ".") != 1' "$state" > "$state.next"
    mv "$state.next" "$state"
    ;;
  get)
    key="$1"; awk -F= -v key="$key" '$1 == key { sub(/^[^=]*=/, ""); print; found=1 } END { exit !found }' "$state"
    ;;
  show)
    cat "$state"
    ;;
  commit) ;;
  *) exit 2 ;;
esac
`;
  const fw4 = `#!/bin/sh
set -eu
case "$1" in
  check) exit 0 ;;
  print)
    cat <<'RULES'
table inet fw4 {
  chain dstnat_lan { ip daddr 192.168.2.1 tcp dport 443 dnat 192.168.2.101:443 comment "!fw4: VPN Panel transparent Smart Edge HTTPS" }
  chain dstnat_public_alias { ip daddr 203.0.113.1 tcp dport 443 dnat 192.168.2.101:443 comment "!fw4: VPN Panel public Smart Edge HTTPS alias" }
  chain srcnat_lan { ip saddr 192.168.2.0/24 ip daddr 192.168.2.101 tcp dport 443 snat 192.168.2.1 comment "!fw4: VPN Panel transparent Smart Edge HTTPS return path" }
  chain dstnat_proxy { ip daddr 192.168.2.1 tcp dport 3127 dnat 192.168.2.101:3127 comment "!fw4: VPN Panel HAOS US proxy" }
  chain srcnat_proxy { ip saddr 192.168.2.0/24 ip daddr 192.168.2.101 tcp dport 3127 snat 192.168.2.1 comment "!fw4: VPN Panel HAOS US proxy return path" }
  chain dstnat_de_proxy { ip daddr 192.168.2.1 tcp dport 3128 dnat 192.168.2.101:3128 comment "!fw4: VPN Panel HAOS DE proxy" }
  chain srcnat_de_proxy { ip saddr 192.168.2.0/24 ip daddr 192.168.2.101 tcp dport 3128 snat 192.168.2.1 comment "!fw4: VPN Panel HAOS DE proxy return path" }
  chain dstnat_fi_proxy { ip daddr 192.168.2.1 tcp dport 3129 dnat 192.168.2.101:3129 comment "!fw4: VPN Panel HAOS Finland proxy" }
  chain srcnat_fi_proxy { ip saddr 192.168.2.0/24 ip daddr 192.168.2.101 tcp dport 3129 snat 192.168.2.1 comment "!fw4: VPN Panel HAOS Finland proxy return path" }
  chain dstnat_ru_proxy { ip daddr 192.168.2.1 tcp dport 3130 dnat 192.168.2.101:3130 comment "!fw4: VPN Panel HAOS Russia proxy" }
  chain srcnat_ru_proxy { ip saddr 192.168.2.0/24 ip daddr 192.168.2.101 tcp dport 3130 snat 192.168.2.1 comment "!fw4: VPN Panel HAOS Russia proxy return path" }
  chain dstnat_public_us { tcp dport 13127 dnat 192.168.2.101:13127 comment "!fw4: VPN Panel public US proxy" }
  chain dstnat_public_de { tcp dport 13128 dnat 192.168.2.101:13128 comment "!fw4: VPN Panel public DE proxy" }
  chain dstnat_public_fi { tcp dport 13129 dnat 192.168.2.101:13129 comment "!fw4: VPN Panel public Finland proxy" }
  chain dstnat_public_ru { tcp dport 13130 dnat 192.168.2.101:13130 comment "!fw4: VPN Panel public Russia proxy" }
}
RULES
    ;;
  *) exit 2 ;;
esac
`;
  const nft = `#!/bin/sh
cat <<'RULES'
table inet fw4 {
  chain dstnat_lan { ip daddr 192.168.2.1 tcp dport 443 dnat 192.168.2.101:443 comment "!fw4: VPN Panel transparent Smart Edge HTTPS" }
  chain dstnat_public_alias { ip daddr 203.0.113.1 tcp dport 443 dnat 192.168.2.101:443 comment "!fw4: VPN Panel public Smart Edge HTTPS alias" }
  chain srcnat_lan { ip saddr 192.168.2.0/24 ip daddr 192.168.2.101 tcp dport 443 snat 192.168.2.1 comment "!fw4: VPN Panel transparent Smart Edge HTTPS return path" }
  chain dstnat_proxy { ip daddr 192.168.2.1 tcp dport 3127 dnat 192.168.2.101:3127 comment "!fw4: VPN Panel HAOS US proxy" }
  chain srcnat_proxy { ip saddr 192.168.2.0/24 ip daddr 192.168.2.101 tcp dport 3127 snat 192.168.2.1 comment "!fw4: VPN Panel HAOS US proxy return path" }
  chain dstnat_de_proxy { ip daddr 192.168.2.1 tcp dport 3128 dnat 192.168.2.101:3128 comment "!fw4: VPN Panel HAOS DE proxy" }
  chain srcnat_de_proxy { ip saddr 192.168.2.0/24 ip daddr 192.168.2.101 tcp dport 3128 snat 192.168.2.1 comment "!fw4: VPN Panel HAOS DE proxy return path" }
  chain dstnat_fi_proxy { ip daddr 192.168.2.1 tcp dport 3129 dnat 192.168.2.101:3129 comment "!fw4: VPN Panel HAOS Finland proxy" }
  chain srcnat_fi_proxy { ip saddr 192.168.2.0/24 ip daddr 192.168.2.101 tcp dport 3129 snat 192.168.2.1 comment "!fw4: VPN Panel HAOS Finland proxy return path" }
  chain dstnat_ru_proxy { ip daddr 192.168.2.1 tcp dport 3130 dnat 192.168.2.101:3130 comment "!fw4: VPN Panel HAOS Russia proxy" }
  chain srcnat_ru_proxy { ip saddr 192.168.2.0/24 ip daddr 192.168.2.101 tcp dport 3130 snat 192.168.2.1 comment "!fw4: VPN Panel HAOS Russia proxy return path" }
  chain dstnat_public_us { tcp dport 13127 dnat 192.168.2.101:13127 comment "!fw4: VPN Panel public US proxy" }
  chain dstnat_public_de { tcp dport 13128 dnat 192.168.2.101:13128 comment "!fw4: VPN Panel public DE proxy" }
  chain dstnat_public_fi { tcp dport 13129 dnat 192.168.2.101:13129 comment "!fw4: VPN Panel public Finland proxy" }
  chain dstnat_public_ru { tcp dport 13130 dnat 192.168.2.101:13130 comment "!fw4: VPN Panel public Russia proxy" }
}
RULES
`;
  const curl = "#!/bin/sh\ncase \" $* \" in *\" --proxy \"*) printf '204' ;; *) printf '403' ;; esac\n";
  const nslookup = "#!/bin/sh\nprintf 'Name: ya.ru\\nAddress: 77.88.55.242\\n'\n";
  const nc = "#!/bin/sh\nexit 0\n";
  const service = "#!/bin/sh\nprintf '%s %s\\n' \"$(basename \"$0\")\" \"$*\" >> \"$CALLS\"\n";

  await Promise.all([
    writeFile(join(bin, "uci"), uci),
    writeFile(join(bin, "fw4"), fw4),
    writeFile(join(bin, "nft"), nft),
    writeFile(join(bin, "curl"), curl),
    writeFile(join(bin, "nslookup"), nslookup),
    writeFile(join(bin, "nc"), nc),
    writeFile(join(initd, "firewall"), service),
    writeFile(join(initd, "dnsmasq"), service),
  ]);
  await Promise.all([
    chmod(join(bin, "uci"), 0o755), chmod(join(bin, "fw4"), 0o755),
    chmod(join(bin, "nft"), 0o755), chmod(join(bin, "curl"), 0o755),
    chmod(join(bin, "nslookup"), 0o755), chmod(join(bin, "nc"), 0o755), chmod(join(initd, "firewall"), 0o755),
    chmod(join(initd, "dnsmasq"), 0o755), chmod(routerApply, 0o755),
  ]);
  return {
    dir, config, backups, uciState, calls,
    env: {
      ...process.env,
      PATH: `${bin}:${process.env.PATH}`,
      UCI_STATE: uciState,
      CALLS: calls,
      VPN_PANEL_CONFIG_DIR: config,
      VPN_PANEL_BACKUP_ROOT: backups,
      VPN_PANEL_INITD_DIR: initd,
    },
  };
}

test("router apply is idempotent and replaces the legacy 3128 chain with symmetric HAOS hairpin NAT", async () => {
  const f = await fixture();
  try {
    await writeFile(f.uciState, [
      "firewall.autoproxy_to_server100=redirect",
      "firewall.autoproxy_to_server100.dest_ip=192.168.2.100",
      "firewall.autoproxy_to_server100_hairpin=nat",
      "firewall.autoproxy_to_server100_hairpin.dest_ip=192.168.2.100",
      "",
    ].join("\n"));
    const first = await execFileAsync(routerApply, ["--apply"], { env: f.env });
    await execFileAsync(routerApply, ["--apply"], { env: f.env });
    const state = parseUci(await readFile(f.uciState, "utf8"));
    assert.equal(state.get("dhcp.@dnsmasq[0].server"), "192.168.2.101");
    assert.equal(state.get("dhcp.lan.dhcp_option"), "6,192.168.2.1");
    assert.equal(state.get("firewall.vpn_panel_transparent_https.src_dip"), "192.168.2.1");
    assert.equal(state.get("firewall.vpn_panel_transparent_https.dest_ip"), "192.168.2.101");
    assert.equal(state.get("firewall.vpn_panel_transparent_https.reflection"), "0");
    assert.equal(state.get("firewall.vpn_panel_public_smart_edge_https.src_dip"), "203.0.113.1");
    assert.equal(state.get("firewall.vpn_panel_public_smart_edge_https.dest_ip"), "192.168.2.101");
    assert.equal(state.get("firewall.vpn_panel_transparent_https_return.target"), "SNAT");
    assert.equal(state.get("firewall.vpn_panel_haos_us_proxy.src_dport"), "3127");
    assert.equal(state.get("firewall.vpn_panel_haos_us_proxy.dest_ip"), "192.168.2.101");
    assert.equal(state.get("firewall.vpn_panel_haos_us_proxy_return.target"), "SNAT");
    assert.equal(state.get("firewall.vpn_panel_haos_de_proxy.src_dport"), "3128");
    assert.equal(state.get("firewall.vpn_panel_haos_de_proxy.dest_ip"), "192.168.2.101");
    assert.equal(state.get("firewall.vpn_panel_haos_de_proxy_return.target"), "SNAT");
    assert.equal(state.get("firewall.vpn_panel_haos_fi_proxy.src_dport"), "3129");
    assert.equal(state.get("firewall.vpn_panel_haos_fi_proxy.dest_ip"), "192.168.2.101");
    assert.equal(state.get("firewall.vpn_panel_haos_ru_proxy.src_dport"), "3130");
    assert.equal(state.get("firewall.vpn_panel_haos_ru_proxy.dest_ip"), "192.168.2.101");
    for (const [section, port] of [["vpn_panel_public_us_proxy", "13127"], ["vpn_panel_public_de_proxy", "13128"], ["vpn_panel_public_fi_proxy", "13129"], ["vpn_panel_public_ru_proxy", "13130"]]) {
      assert.equal(state.get(`firewall.${section}.src`), "wan");
      assert.equal(state.get(`firewall.${section}.src_dport`), port);
      assert.equal(state.get(`firewall.${section}.dest_ip`), "192.168.2.101");
    }
    assert.equal(state.has("firewall.autoproxy_to_server100"), false);
    assert.equal(state.has("firewall.autoproxy_to_server100_hairpin"), false);
    assert.equal(transparentFlowWorks(state), true);

    const broken = new Map([...state].filter(([key]) => !key.startsWith("firewall.vpn_panel_transparent_https_return")));
    assert.equal(transparentFlowWorks(broken), false, "DNAT-only fixture must expose the asymmetric return path");

    const backup = first.stdout.match(/backup=(\S+)/)?.[1];
    assert.ok(backup, first.stdout);
    await execFileAsync(routerApply, ["--rollback", "192.168.2.101", "192.168.2.1", "192.168.2.0/24", "203.0.113.1", backup], { env: f.env });
    assert.equal(await readFile(join(f.config, "dhcp"), "utf8"), "original dhcp\n");
    assert.equal(await readFile(join(f.config, "firewall"), "utf8"), "original firewall\n");
    assert.match(await readFile(f.calls, "utf8"), /firewall reload/);
    assert.match(await readFile(f.calls, "utf8"), /dnsmasq restart/);
  } finally {
    await rm(f.dir, { recursive: true, force: true });
  }
});

test("deploy wrapper preserves the client DNS address and automatically rolls back a failed LAN canary", async () => {
  const source = await readFile("scripts/deploy-router-transparent-smart-edge.sh", "utf8");
  assert.match(source, /LAN_SMART_EDGE_ROUTER_IP:-192\.168\.2\.1/);
  assert.match(source, /LAN_SMART_EDGE_HAOS_IP:-192\.168\.2\.101/);
  assert.match(source, /nslookup ya\.ru "\$router_ip"/);
  assert.match(source, /nslookup chatgpt\.com "\$router_ip"[^\n]*Address: \$router_ip/);
  assert.match(source, /--resolve chatgpt\.com:443:"\$router_ip"/);
  assert.doesNotMatch(source, /--resolve chatgpt\.com:443:"\$public_edge_ip"/);
  assert.match(source, /--proxy "http:\/\/\$router_ip:3127"/);
  assert.match(source, /LAN canary failed; restoring \$backup/);
  assert.match(source, /remote_run --rollback "\$backup"/);
  assert.doesNotMatch(source, /haproxy|watchdog/i);
});

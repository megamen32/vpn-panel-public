import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

import { openWrtLocalAddressDomains, renderOpenWrtAddressRules } from "../src/openwrt-smart-dns.js";
import { normalizeSmartDnsPolicy } from "../src/smart-dns-policy.js";

test("OpenWrt address rules are generated from effective canonical LAN routes", () => {
  const policy = normalizeSmartDnsPolicy({
    defaultRoute: "proxy",
    localDefaultRoute: "direct",
    directSuffixes: ["ru"],
    directDomains: ["direct.example"],
    proxySuffixes: ["chatgpt.com", "direct.example"],
    proxyDomains: ["ifconfig.me"],
    localProxySuffixes: ["telegram.org", "chatgpt.com"],
    localProxyDomains: ["web.telegram.org"],
    vusaProxySuffixes: ["antigravity.google"],
    vusaProxyDomains: [],
    rules: [
      { id: "a", text: "antigravity.google", match: "suffix", through: ["vusa"], conditions: ["internalDns"] },
      { id: "b", text: "chatgpt.com", match: "suffix", through: ["vpn2"], conditions: ["internalDns"] },
      { id: "c", text: "hailuo.ai", match: "suffix", through: ["vpn2"], conditions: ["internalDns"] },
      { id: "d", text: "ifconfig.me", match: "exact", through: ["vpn2"], conditions: ["internalDns"] },
      { id: "e", text: "telegram.org", match: "suffix", through: ["vpn2"], conditions: ["internalDns"] },
      { id: "f", text: "ua", match: "suffix", through: ["vpn2"], conditions: ["internalDns"] },
      { id: "g", text: "web.telegram.org", match: "exact", through: ["vpn2"], conditions: ["internalDns"] },
    ],
  });

  assert.deepEqual(openWrtLocalAddressDomains(policy), ["antigravity.google", "chatgpt.com", "hailuo.ai", "ifconfig.me", "telegram.org", "ua", "web.telegram.org"]);
  assert.equal(renderOpenWrtAddressRules(policy), "antigravity.google\nchatgpt.com\nhailuo.ai\nifconfig.me\ntelegram.org\nua\nweb.telegram.org\n");
});

test("normalized .ua proxy suffix is rendered as a LAN edge address rule", () => {
  const policy = normalizeSmartDnsPolicy({
    directSuffixes: [".ua", "ru"],
    proxySuffixes: [],
    directDomains: [],
    proxyDomains: [],
    localProxySuffixes: [],
    localProxyDomains: [],
    vusaProxySuffixes: [],
    vusaProxyDomains: [],
    rules: [
      { id: "hailuo", text: "hailuo.ai", match: "suffix", through: ["vpn2"], conditions: ["internalDns"] },
      { id: "ua", text: "ua", match: "suffix", through: ["vpn2"], conditions: ["internalDns"] },
    ],
  });

  assert.equal(renderOpenWrtAddressRules(policy), "hailuo.ai\nua\n");
});

test("OpenWrt deploy consumes generated rules and advertises the stable router DNS", async () => {
  const [script, watchdog, watchdogInit, routeWatchdog, routeInit, deployAll, edgeDeploy] = await Promise.all([
    readFile("deploy/router/dhcp/configure-smart-dns.sh", "utf8"),
    readFile("deploy/router/dhcp/smart-dns-upstream-watchdog.sh", "utf8"),
    readFile("deploy/router/dhcp/smart-dns-upstream.init", "utf8"),
    readFile("deploy/router/dhcp/smart-dns-route-watchdog.sh", "utf8"),
    readFile("deploy/router/dhcp/smart-dns-route.init", "utf8"),
    readFile("scripts/deploy-all.sh", "utf8"),
    readFile("scripts/deploy-router-transparent-smart-edge.sh", "utf8"),
  ]);

  assert.ok(script.includes("rules_file="));
  assert.ok(script.includes('dhcp.lan.dhcp_option=6,$router_dns_ip'));
  assert.ok(script.includes('dhcp.@dnsmasq[0].confdir=$managed_confdir'));
  assert.ok(script.includes("printf 'rebind-domain-ok=/%s/\\n' \"$domain\""));
  assert.ok(!script.includes("printf 'local=/%s/\\naddress=/%s/%s\\nrebind-domain-ok=/%s/\\n'"));
  assert.ok(script.includes('rebind-domain-ok=/$first_domain/'));
  assert.ok(script.includes('! grep -Fq "address=/$first_domain/" "$managed_config"'));
  assert.ok(script.includes('! grep -Fq "local=/$first_domain/" "$managed_config"'));
  assert.ok(script.includes('mode="repair"'));
  assert.ok(script.includes('rules_file="$managed_rules"'));
  assert.ok(script.includes('rules_file="${3:-/etc/vpn-panel-smart-dns.domains}"'));
  assert.ok(script.includes('[ "$rules_file" = "$managed_rules" ] || cp "$rules_file" "$managed_rules"'));
  assert.ok(script.includes('backup_dir="/etc/vpn-panel-dnsmasq-backups"'));
  assert.ok(script.includes('config_backup="$backup_dir/smart-dns.conf.bak_${timestamp}"'));
  assert.ok(script.includes('"$managed_confdir"/smart-dns.conf.bak_*'));
  assert.ok(!script.includes('domains="'));
  assert.ok(script.includes("/etc/init.d/dnsmasq restart"));
  assert.ok(script.includes("fallback_dns_ip="));
  assert.match(watchdog, /FALLBACK_DNS_IP/);
  assert.match(watchdog, /set_upstream/);
  assert.match(watchdog, /probe_smartdns/);
  assert.match(watchdog, /failures.*-ge 2/);
  assert.match(watchdog, /successes.*-ge 2/);
  assert.match(watchdogInit, /USE_PROCD=1/);
  assert.match(watchdogInit, /procd_set_param respawn/);
  assert.match(routeWatchdog, /d3e54v103j8qbb\.cloudfront\.net/);
  assert.match(routeWatchdog, /"\$CONFIGURE" --repair/);
  assert.match(routeWatchdog, /\[ "\$failures" -ge 2 \]/);
  assert.match(routeInit, /USE_PROCD=1/);
  assert.match(routeInit, /procd_set_param command "\$SCRIPT" --watch/);
  assert.match(routeInit, /procd_set_param respawn 3600 5 5/);
  assert.match(deployAll, /smart-dns-upstream-watchdog/);
  assert.match(deployAll, /smart-dns-route-watchdog/);
  assert.ok(!script.includes("reboot"));
  assert.ok(deployAll.includes('"${TARGETS[0]}" == "router-dns"'));
  assert.ok(deployAll.includes("skipping unrelated Xray/HAProxy regeneration"));
  assert.ok(edgeDeploy.includes('public_edge_ip="${LAN_SMART_DNS_PUBLIC_EDGE_IP:-203.0.113.1}"'));
  assert.ok(edgeDeploy.includes("'$lan_cidr' '$public_edge_ip' '$backup'"));
  assert.ok(edgeDeploy.includes('src/cli/render-openwrt-smart-dns.ts'));
  assert.ok(edgeDeploy.includes("'$haos_ip' '$router_ip'"));
  assert.ok(!edgeDeploy.includes("nslookup chatgpt.com \"$router_ip\" 2>/dev/null | grep -Fq \"Address: $public_edge_ip\""));
  assert.ok(edgeDeploy.includes('remote_run --public-alias-check'));
  assert.ok(edgeDeploy.includes('remote_run --public-alias-apply'));
});

test("server-88 stale-lease listener is a temporary policy-free router forwarder", async () => {
  const [config, service, timer, deployScript] = await Promise.all([
    readFile("deploy/server-88/dnsmasq/lan-dns-compat.conf", "utf8"),
    readFile("deploy/server-88/systemd/lan-dns-compat.service", "utf8"),
    readFile("deploy/server-88/systemd/lan-dns-compat-retire.timer", "utf8"),
    readFile("scripts/deploy-server88-dns-compat.sh", "utf8"),
  ]);

  assert.match(config, /^server=192\.168\.2\.1$/m);
  assert.match(config, /^cache-size=0$/m);
  assert.match(config, /^pid-file=\/run\/lan-dns-compat\/dnsmasq\.pid$/m);
  assert.ok(!/^address=/m.test(config));
  assert.ok(!/^local=/m.test(config));
  assert.ok(service.includes("Compatibility DNS forwarder"));
  assert.match(service, /^RuntimeDirectory=lan-dns-compat$/m);
  assert.match(service, /^CapabilityBoundingSet=.*CAP_CHOWN/m);
  assert.ok(timer.includes("OnActiveSec=48h"));
  assert.ok(deployScript.includes("for _attempt in {1..10}"));
});

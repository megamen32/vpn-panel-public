import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import test from "node:test";

const topologyPath = new URL("../deploy/public-ingress/topology.json", import.meta.url);
const primaryConfigPath = new URL("../deploy/server-100/haproxy/public-ingress.cfg", import.meta.url);
const primaryDeployScriptPath = new URL("../scripts/deploy-server100-public-ingress.sh", import.meta.url);
const reserveConfigPath = new URL("../deploy/haos/recovery-haproxy/haproxy.cfg", import.meta.url);
const haosDeployScriptPath = new URL("../scripts/deploy-haos-recovery.sh", import.meta.url);
const regionalDeployScriptPath = new URL("../scripts/deploy-regional-relays.sh", import.meta.url);
const rendererPath = new URL("../scripts/render-public-ingress.mjs", import.meta.url).pathname;

test("public HTTPS ingress declares server-100 primary and HAOS reserve", () => {
  const topology = JSON.parse(readFileSync(topologyPath, "utf8"));

  assert.deepEqual(topology.policy, { primary: "server-100", reserve: "haos" });
  assert.equal(topology.publicHttps.listenPort, 443);
  assert.equal(topology.server100.defaultBackend, "127.0.0.1:8444");
  assert.equal(topology.haos.listenPort, 8443);
  assert.deepEqual(topology.router.redirectNames, ["srv100_https", "ha_https"]);
  assert.equal(topology.haos.configPath, "/data/haproxy.cfg");
  assert.equal(topology.haos.recoveryNginxMapPath, "/data/recovery-nginx-public.map");
  assert.equal(topology.haos.addonSlug, "local_bezrabotnyi_recovery_haproxy");
  assert.equal(topology.haos.container, "app_local_bezrabotnyi_recovery_haproxy");
});

test("both ingress configs implement the canonical Smart and Full route map", () => {
  const topology = JSON.parse(readFileSync(topologyPath, "utf8"));
  const primaryConfig = readFileSync(primaryConfigPath, "utf8");
  const reserveConfig = readFileSync(reserveConfigPath, "utf8");

  for (const route of topology.routes) {
    assert.match(primaryConfig, new RegExp(`req\\.ssl_sni -i ${route.sni.replaceAll(".", "\\.")}`));
    assert.match(primaryConfig, new RegExp(`server ${route.id} 127\\.0\\.0\\.1:${route.relayPort} check`));
    assert.match(reserveConfig, new RegExp(`req\\.ssl_sni -i ${route.sni.replaceAll(".", "\\.")}`));
    assert.match(reserveConfig, new RegExp(`server ${route.id} 192\\.168\\.2\\.100:${route.relayPort} check`));
  }
});

test("generated ingress route blocks match the topology source", () => {
  const result = spawnSync("node", [rendererPath, "--check"], { encoding: "utf8" });
  assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`);
});

test("server-100 keeps Search on its HTTP/1.1-only PROXY-v2 listener", () => {
  const primaryConfig = readFileSync(primaryConfigPath, "utf8");

  assert.match(primaryConfig, /acl sni_search req\.ssl_sni -i search\.bezrabotnyi\.com/);
  assert.match(primaryConfig, /use_backend be_search_http1 if sni_search/);
  assert.match(primaryConfig, /backend be_search_http1\s+server search_http1 127\.0\.0\.1:8445 send-proxy-v2 check/);
});

test("HAOS recovery-Nginx routes only explicitly declared anonymous services", () => {
  const topology = JSON.parse(readFileSync(topologyPath, "utf8"));
  const reserveConfig = readFileSync(reserveConfigPath, "utf8");
  const services = topology.ingressServicePlacement.services.filter((service: any) => service.allowedIngressNodes.includes("haos") && service.recoveryAuth === "anonymous");

  assert.deepEqual(services.map((service: any) => service.id), ["whisper", "books", "download"]);
  assert.equal(services[0].recoveryAuth, "anonymous");
  assert.match(reserveConfig, /sni_recovery_whisper req\.ssl_sni -i whisper\.bezrabotnyi\.com/);
  assert.match(reserveConfig, /host_recovery_whisper hdr\(host\),field\(1,:\),lower -i whisper\.bezrabotnyi\.com/);
  assert.match(reserveConfig, /sni_recovery_books req\.ssl_sni -i books\.bezrabotnyi\.com/);
  assert.match(reserveConfig, /host_recovery_download hdr\(host\),field\(1,:\),lower -i download\.bezrabotnyi\.com/);
  assert.match(reserveConfig, /server recovery_nginx_public 127\.0\.0\.1:18081 check/);
  assert.doesNotMatch(reserveConfig.match(/^\s*acl sni_recovery_.+$/gm)?.join("\n") ?? "", /cockpit/);
});

test("HAOS recovery ACL keeps Cockpit 88 and 44 out of the NanoKVM backend", () => {
  const reserveConfig = readFileSync(reserveConfigPath, "utf8");
  const remote44Acl = reserveConfig.match(/^\s*acl host_remote44 .+$/m)?.[0] ?? "";
  const remote44SniAcl = reserveConfig.match(/^\s*acl sni_remote44 .+$/m)?.[0] ?? "";

  assert.match(remote44Acl, /remote44\.bezrabotnyi\.com/);
  assert.match(remote44SniAcl, /remote44\.bezrabotnyi\.com/);
  assert.doesNotMatch(remote44Acl, /(?:^|\s)(?:88|44|cockpit-b)\.bezrabotnyi\.com/);
  assert.doesNotMatch(remote44SniAcl, /(?:^|\s)(?:88|44|cockpit-b)\.bezrabotnyi\.com/);
  const remote44Selection = reserveConfig.indexOf("use_backend be_remote44_http if host_remote44");
  const cockpit88Selection = reserveConfig.indexOf("use_backend be_cockpit88_https if host_cockpit88");
  const cockpit44Selection = reserveConfig.indexOf("use_backend be_cockpit44_https if host_cockpit44");
  assert.ok(remote44Selection >= 0 && cockpit88Selection >= 0 && cockpit44Selection >= 0);
  assert.ok(remote44Selection < cockpit88Selection && remote44Selection < cockpit44Selection);
});

test("server-100 deploy is cutover-safe and never mutates router or HAOS", () => {
  const script = readFileSync(primaryDeployScriptPath, "utf8");

  assert.match(script, /deploy\/public-ingress\/topology\.json/);
  assert.match(script, /127\.0\.0\.1:8444/);
  assert.match(script, /ss -H -ltn/);
  assert.match(script, /\$4 == "127\.0\.0\.1:8444"/);
  assert.match(script, /-v port=":\$\{relay_port\}"/);
  assert.match(script, /nginx still owns public :443/);
  assert.match(script, /haproxy\.cfg\.bak_/);
  assert.doesNotMatch(script, /uci (set|commit)|\/etc\/init\.d\/firewall/);
  assert.doesNotMatch(script, /ha apps|192\.168\.2\.101/);
});

test("all HAOS writers reuse the canonical HAOS deploy", () => {
  const haosScript = readFileSync(haosDeployScriptPath, "utf8");
  const regionalScript = readFileSync(regionalDeployScriptPath, "utf8");

  assert.match(haosScript, /deploy\/public-ingress\/topology\.json/);
  assert.match(regionalScript, /deploy-haos-recovery\.sh/);
  assert.doesNotMatch(regionalScript, /docker cp .*haproxy-regional\.pending/);
  assert.doesNotMatch(regionalScript, /systemctl disable --now haproxy/);
});

test("HAOS deploy skips a rebuild when the canonical config is already live", () => {
  const script = readFileSync(haosDeployScriptPath, "utf8");
  assert.match(script, /cmp -s "\$CONFIG_PATH" \/tmp\/haproxy\.cfg\.pending/);
  assert.match(script, /HAOS recovery config is already current; certificates synced and rebuild skipped/);
});

test("HAOS config deploy never overwrites the infrastructure-owned addon entrypoint", () => {
  const topology = JSON.parse(readFileSync(topologyPath, "utf8"));
  const script = readFileSync(haosDeployScriptPath, "utf8");

  assert.equal("addonRunSource" in topology.haos, false);
  assert.doesNotMatch(script, /run\.sh\.pending/);
  assert.doesNotMatch(script, /ADDON_SOURCE/);
  assert.match(script, /-f "\$AUTH_PATH"/);
});

test("HAOS config deploy waits for the rebuilt addon instead of assuming a fixed startup time", () => {
  const script = readFileSync(haosDeployScriptPath, "utf8");

  assert.match(script, /for attempt in \$\(seq 1 120\)/);
  assert.match(script, /ha apps info "\$SLUG" --raw-json/);
  assert.match(script, /pgrep -a haproxy/);
  assert.match(script, /pgrep -a nginx/);
  assert.match(script, /nginx -t -c \/etc\/nginx\/recovery-nginx\.conf/);
  assert.match(script, /RECOVERY_PROBE_HOSTS/);
  assert.match(script, /for host in "\$\{recovery_probe_hosts\[@\]\}"/);
  assert.match(script, /-verify_hostname "\$host"/);
  assert.match(script, /recoveryNginxMapPath/);
  assert.match(script, /http:\/\/127\.0\.0\.1:8404\/stats/);
  assert.match(script, /-servername vpn\.bezrabotnyi\.com/);
  assert.doesNotMatch(script, /-servername runet\.bezrabotnyi\.com/);
});

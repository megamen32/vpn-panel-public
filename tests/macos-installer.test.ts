import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { spawnSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { bezMacInstallerScript, macHostsScript, macosBezWebUiPython } from "../src/macos-installer.js";
import { MACOS_CONFIG_TOKEN } from "../src/macos-token.js";

test("bez bootstrap installs a rootless Xray system-proxy CLI", () => {
  const script = bezMacInstallerScript("https://vpn.bezrabotnyi.com");

  assert.match(script, /^#!\/bin\/bash/);
  for (const command of ["install", "update", "smart", "full", "all", "off", "status", "logs", "proxy", "unproxy", "codex"]) {
    assert.match(script, new RegExp(`\\b${command}\\b`));
  }
  assert.match(script, /\.local\/bin\/bez/);
  assert.match(script, /https:\/\/github\.com\/megamen32\/bez\/releases\/latest\/download\/bez/);
  assert.doesNotMatch(script, /\$BASE_URL\/install\/bez/);
  assert.match(script, /client-xray-config\?mode=/);
  assert.ok(script.includes(`CONFIG_TOKEN="${MACOS_CONFIG_TOKEN}"`));
  assert.match(script, /Authorization: Bearer/);
  assert.ok(script.includes("LaunchAgents/com.bezrabotnyi.bez.plist"));
  assert.match(script, /networksetup/);
  assert.match(script, /launchctl (bootstrap|bootout|kickstart)/);
  assert.match(script, /run -test/);
  assert.match(script, /x86_64\) asset=Xray-macos-64\.zip/);
  assert.doesNotMatch(script, /security (find|add)-generic-password/);
  assert.doesNotMatch(script, /password for|read -r -s/);
  assert.doesNotMatch(script, /autoSystemRoutingTable/);
  assert.match(script, /atomic|mv|rename/i);

  // Rootless bootstrap stays rootless; the TUN tunnel is a separate opt-in elevated path.
  const installPath = script.slice(script.indexOf("install_bez()"), script.indexOf("update_bez()"));
  assert.doesNotMatch(installPath, /exec sudo|sudo HOME|LaunchDaemons/);
  const vpnPath = script.slice(script.indexOf("download_singbox()"), script.indexOf("fetch_config()"));
  assert.ok(script.includes('VPN_PLIST_PATH="/Library/LaunchDaemons/com.bezrabotnyi.bez-vpn.plist"'));
  assert.match(vpnPath, /exec sudo HOME="\$HOME" USER="\$USER" "\$CLI_PATH" vpn on/);
  assert.match(vpnPath, /sing-box SHA-256 verification failed/);
});

test("bez avoids a local proxy that already owns the default ports", () => {
  const script = bezMacInstallerScript("https://vpn.bezrabotnyi.com");

  assert.match(script, /choose_ports/);
  assert.match(script, /28108/);
  assert.match(script, /PORT_STATE/);
  assert.match(script, /python3/);
  assert.match(script, /SOCKS_PORT/);
  assert.match(script, /HTTP_PORT/);
  assert.match(script, /status_bez\(\) \{[\s\S]*read_ports/);
});

test("bez restores macOS proxy states using networksetup on/off values", () => {
  const script = bezMacInstallerScript("https://vpn.bezrabotnyi.com");

  assert.match(script, /case \"\$web_state\"/);
  assert.match(script, /web_state=on/);
  assert.match(script, /web_state=off/);
  assert.match(script, /setwebproxystate \"\$service\" \"\$web_state\"/);
});

test("bez restores previous macOS proxy endpoints, not only enabled states", () => {
  const script = bezMacInstallerScript("https://vpn.bezrabotnyi.com");

  assert.match(script, /proxy_field\(\)/);
  assert.match(script, /Server/);
  assert.match(script, /Port/);
  assert.match(script, /setwebproxy \"\$service\" \"\$web_server\" \"\$web_port\"/);
  assert.match(script, /setsecurewebproxy \"\$service\" \"\$secure_server\" \"\$secure_port\"/);
  assert.match(script, /setsocksfirewallproxy \"\$service\" \"\$socks_server\" \"\$socks_port\"/);
});

test("bez codex installs rootlessly when absent and always launches with proxy variables", () => {
  const script = bezMacInstallerScript("https://vpn.bezrabotnyi.com");
  const codexFunction = script.slice(script.indexOf("codex_bez()"), script.indexOf("unproxy_bez()"));

  assert.match(script, /codex\) shift; codex_bez/);
  assert.match(script, /https:\/\/chatgpt\.com\/codex\/install\.sh/);
  assert.match(script, /CODEX_INSTALL_DIR=\"\$HOME\/\.local\/bin\"/);
  assert.match(script, /CODEX_NON_INTERACTIVE=1/);
  assert.match(script, /http_proxy=http:\/\/127\.0\.0\.1:\$HTTP_PORT/);
  assert.match(script, /https_proxy=http:\/\/127\.0\.0\.1:\$HTTP_PORT/);
  assert.match(script, /all_proxy=socks5h:\/\/127\.0\.0\.1:\$SOCKS_PORT/);
  assert.doesNotMatch(codexFunction, /sudo/);
});

test("bez supports activating the bundled config without network access", () => {
  const script = bezMacInstallerScript("https://vpn.bezrabotnyi.com");

  assert.match(script, /smart\|all\)\n\s+shift\n\s+activate "\$command" "\$@"/);
  assert.match(script, /case "\$offline" in[\s\S]*--offline\) prepare_bundled_config/);
  assert.match(script, /config-\$mode\.json/);
  assert.match(script, /Xray rejected the bundled config/);
});

test("bez can run locally without changing macOS system proxy settings", () => {
  const script = bezMacInstallerScript("https://vpn.bezrabotnyi.com");

  assert.match(script, /--local/);
  assert.match(script, /system_proxy=1/);
  assert.ok(script.includes("if (( system_proxy )); then"));
  assert.match(script, /temp_json\(\)/);
  assert.doesNotMatch(script, /mktemp "\$APP_DIR\/\.config\.XXXXXX\.json"/);
  assert.doesNotMatch(script, /mktemp "\$APP_DIR\/\.bundled-config\.XXXXXX\.json"/);
});

test("bez is webUI-first after installation and keeps the setup menu for first use", () => {
  const script = bezMacInstallerScript("https://vpn.bezrabotnyi.com");

  assert.match(script, /interactive_bez\(\)/);
  assert.match(script, /Bez — текущий статус/);
  assert.match(script, /Выбери профиль и область применения/);
  assert.match(script, /activate_local_bez smart/);
  assert.match(script, /activate_local_bez all/);
  assert.match(script, /if \[\[ \$# -eq 0 \]\]; then\n\s+if installed; then web_bez; else interactive_bez; fi/);
});

test("private bundle stays offline and local after the daemon is restarted", () => {
  const script = bezMacInstallerScript("https://vpn.bezrabotnyi.com");
  const codexFunction = script.slice(script.indexOf("codex_bez()"), script.indexOf("unproxy_bez()"));

  assert.match(script, /BUNDLE_MARKER=.*bundle-offline/);
  assert.match(script, /bundle_mode\(\)/);
  assert.match(script, /bundle_mode[\s\S]*prepare_bundled_config/);
  assert.match(script, /bundle_mode[\s\S]*--local/);
  assert.match(script, /restore_requested_scope\(\)[\s\S]*bundle_mode[\s\S]*--offline --global/);
  assert.match(codexFunction, /restore_requested_scope/);
});

test("offline bundle update fails closed without attempting a network download", () => {
  const script = bezMacInstallerScript("https://vpn.bezrabotnyi.com");
  const updateFunction = script.slice(script.indexOf("update_bez()"), script.indexOf("off_bez()"));

  assert.match(updateFunction, /bundle_mode/);
  assert.match(updateFunction, /private release/i);
  assert.match(updateFunction, /if bundle_mode; then[\s\S]*die .*private release/);
});

test("bez update preserves Local scope instead of enabling the macOS system proxy", () => {
  const script = bezMacInstallerScript("https://vpn.bezrabotnyi.com");
  const updateFunction = script.slice(script.indexOf("update_bez()"), script.indexOf("off_bez()"));

  assert.match(updateFunction, /if \[\[ -e "\$PROXY_STATE" \]\]; then ensure_requested_scope; fi/);
  assert.doesNotMatch(updateFunction, /then apply_proxies/);
});

test("bez check returns a failure status when a checked service is unavailable", () => {
  const script = bezMacInstallerScript("https://vpn.bezrabotnyi.com");
  const checkFunction = script.slice(script.indexOf("check_bez()"), script.indexOf("cline_bez()"));

  assert.match(checkFunction, /failed=0/);
  assert.match(checkFunction, /failed=\$\(\(failed \+ 1\)\)/);
  assert.match(checkFunction, /return 1/);
});

test("fetch_config cleans authorization and temporary response files on exit", () => {
  const script = bezMacInstallerScript("https://vpn.bezrabotnyi.com");
  const fetchFunction = script.slice(script.indexOf("fetch_config()"), script.indexOf("prepare_bundled_config()"));

  assert.match(fetchFunction, /trap .*rm -f .*EXIT/);
});

test("offline bundle Codex launch fails closed when its embedded binary is missing", () => {
  const script = bezMacInstallerScript("https://vpn.bezrabotnyi.com");
  const codexFunction = script.slice(script.indexOf("codex_bez()"), script.indexOf("unproxy_bez()"));

  assert.match(codexFunction, /if bundle_mode; then/);
  assert.match(codexFunction, /bundled Codex is missing/);
});

test("private bundle installer selects a matching Codex architecture", async () => {
  const installer = await readFile("scripts/bez-bundle-install.sh", "utf8");

  assert.equal(spawnSync("bash", ["-n", "scripts/bez-bundle-install.sh"]).status, 0);
  assert.match(installer, /codex-release-\$\{BEZ_RELEASE_VERSION\}-\$\{ARCH\}/);
  assert.match(installer, /file "\$PAYLOAD_DIR\/codex-release\/bin\/codex"/);
  assert.match(installer, /grep -q "\$ARCH"/);
  assert.match(installer, /bundle-offline/);
  assert.match(installer, /BACKUP_ROOT/);
  assert.match(installer, /cp -PpR/);
  assert.doesNotMatch(installer, /sudo/);
});

test("bez exposes a Russian interactive app menu and a global proxy override", () => {
  const script = bezMacInstallerScript("https://vpn.bezrabotnyi.com");

  assert.match(script, /Bez — текущий статус/);
  assert.match(script, /Smart/);
  assert.match(script, /Full/);
  assert.match(script, /Custom/);
  assert.match(script, /Local/);
  assert.match(script, /Global/);
  assert.match(script, /Проверить Cline\/ChatGPT\/Claude/);
  assert.match(script, /Настройка приложений/);
  assert.match(script, /while true/);
  assert.match(script, /--global\) system_proxy=1/);
  assert.match(script, /read -r choice/);
});

test("bez includes Cline diagnostics and app-specific proxy instructions", () => {
  const script = bezMacInstallerScript("https://vpn.bezrabotnyi.com");
  const checkFunction = script.slice(script.indexOf("check_bez()"), script.indexOf("cline_bez()"));

  assert.match(script, /check_bez\(\)/);
  assert.match(checkFunction, /https:\/\/t\.me\//);
  assert.match(checkFunction, /VPN exit IP/);
  assert.match(checkFunction, /state_mode\).*== all/);
  assert.match(checkFunction, /for attempt in 1 2 3 4 5 6/);
  assert.match(checkFunction, /sleep 3/);
  assert.doesNotMatch(checkFunction, /chatgpt\.com|claude\.ai|cline\.bot/);
  assert.match(script, /cline_bez\(\)/);
  assert.match(script, /http\.proxy/);
  assert.match(script, /bez check/);
  assert.match(script, /check\) check_bez/);
  assert.match(script, /cline\) cline_bez/);
});

test("bez opens with status and presents three profiles across local and global scopes", () => {
  const script = bezMacInstallerScript("https://vpn.bezrabotnyi.com");
  const menu = script.slice(script.indexOf("interactive_bez()"), script.indexOf("if [[ $# -eq 0 &&"));

  assert.match(menu, /status_bez/);
  assert.match(menu, /Smart/);
  assert.match(menu, /Full/);
  assert.match(menu, /Custom/);
  assert.match(menu, /Local/);
  assert.match(menu, /Global/);
  assert.match(menu, /Выбери профиль/);
});

test("macOS Bez WebUI manages only its Xray SNI hosts block", () => {
  const webUi = macosBezWebUiPython("https://vpn.bezrabotnyi.com");
  const hosts = macHostsScript();

  for (const target of ["vpn2", "vusa", "off"]) assert.match(webUi, new RegExp(`hosts-${target}`));
  assert.match(webUi, /hosts-preview/);
  assert.match(webUi, /\/api\/hosts-preview/);
  assert.match(webUi, /hosts_preview/);
  assert.match(webUi, /\/api\/hosts/);
  assert.match(webUi, /apply_hosts/);
  assert.match(hosts, /TARGET="\$\{1:-vpn2\}"/);
  assert.match(hosts, /vusa\).*VUSA_IP/);
  assert.match(hosts, /"--remove" \|\| "\$TARGET" == "off"/);
  assert.match(hosts, /# >>> bez vpn2 sni hosts >>>/);
});

test("macOS Bez installs a native menu-bar tray with quick controls", () => {
  const script = bezMacInstallerScript("https://vpn.bezrabotnyi.com");
  assert.match(script, /TRAY_LABEL="com\.bezrabotnyi\.bez-tray"/);
  assert.match(script, /swiftc "\$TRAY_SOURCE" -o "\$TRAY_BIN"/);
  assert.match(script, /NSStatusBar\.system/);
  assert.match(script, /statusIcon\(mode: "off"\)/);
  assert.match(script, /mode == "local"/);
  assert.match(script, /mode == "global"/);
  assert.match(script, /mode == "vpn"/);
  assert.match(script, /Сеть: ⌂ Домашняя/);
  assert.match(script, /gateway: 192\.168\.2\.1/);
  assert.match(script, /VPN tunnel — включить/);
  assert.match(script, /smart --global/);
  assert.match(script, /smart --local/);
  assert.match(script, /start_tray/);
});

test("bez accepts Full as the clear alias for the legacy all profile", () => {
  const script = bezMacInstallerScript("https://vpn.bezrabotnyi.com");

  assert.match(script, /smart\|all\)/);
  assert.match(script, /\[\[ "\$command" == full \]\] && command=all/);
});

test("bez custom profile is backed by a local JSON policy and can open the web editor", () => {
  const script = bezMacInstallerScript("https://vpn.bezrabotnyi.com");

  assert.match(script, /CUSTOM_POLICY_PATH="\$APP_DIR\/custom-policy\.json"/);
  assert.match(script, /custom\) shift; custom_bez/);
  assert.match(script, /custom_policy_bez\(\)/);
  assert.match(script, /\/admin\/smart-dns/);
  assert.match(script, /Xray rejected custom policy/);
});

test("bez check restarts the last requested scope instead of downgrading global proxy to local", () => {
  const script = bezMacInstallerScript("https://vpn.bezrabotnyi.com");
  const checkFunction = script.slice(script.indexOf("check_bez()"), script.indexOf("cline_bez()"));

  assert.doesNotMatch(checkFunction, /activate_local_bez/);
  assert.match(checkFunction, /restore_requested_scope/);
  assert.match(script, /--global\) system_proxy=1/);
});

test("bez waits for usable traffic after switching a profile", () => {
  const script = bezMacInstallerScript("https://vpn.bezrabotnyi.com");
  const activateFunction = script.slice(script.indexOf("activate()"), script.indexOf("install_bez()"));

  assert.match(script, /wait_traffic\(\)/);
  assert.match(script, /https:\/\/t\.me\//);
  assert.match(activateFunction, /wait_proxy\n\s+wait_traffic "\$mode"/);
  assert.match(script, /wait_proxy\(\) \{[\s\S]*seq 1 120/);
});

test("bez status and checks detect when a requested global proxy is no longer applied", () => {
  const script = bezMacInstallerScript("https://vpn.bezrabotnyi.com");
  const statusFunction = script.slice(script.indexOf("status_bez()"), script.indexOf("logs_bez()"));
  const checkFunction = script.slice(script.indexOf("check_bez()"), script.indexOf("cline_bez()"));
  const restoreScopeFunction = script.slice(script.indexOf("ensure_requested_scope()"), script.indexOf("check_bez()"));

  assert.match(script, /system_proxy_active\(\)/);
  assert.match(statusFunction, /Global requested, proxy is not applied/);
  assert.match(statusFunction, /HTTP\/HTTPS:/);
  assert.match(statusFunction, /SOCKS \(только для приложений\):/);
  assert.match(statusFunction, /DNS: системный resolver не меняется/);
  assert.match(checkFunction, /ensure_requested_scope/);
  assert.match(restoreScopeFunction, /read_ports \|\| die "Bez proxy ports are unavailable"/);
});

test("bez global honours the http|socks system proxy mode", () => {
  const script = bezMacInstallerScript("https://vpn.bezrabotnyi.com");
  const systemProxyFunction = script.slice(script.indexOf("system_proxy_active()"), script.indexOf("snapshot_proxies()"));
  const applyFunction = script.slice(script.indexOf("apply_proxies()"), script.indexOf("restore_proxies()"));

  assert.match(script, /active_network_services\(\)/);
  assert.match(applyFunction, /mode="\$\(proxy_mode\)"/);
  assert.match(applyFunction, /if \[\[ "\$mode" == socks \]\]/);
  assert.match(applyFunction, /setsocksfirewallproxy "\$service" 127\.0\.0\.1 "\$SOCKS_PORT"/);
  assert.match(applyFunction, /setwebproxy "\$service" 127\.0\.0\.1 "\$HTTP_PORT"/);
  assert.match(applyFunction, /setsecurewebproxy "\$service" 127\.0\.0\.1 "\$HTTP_PORT"/);
  assert.match(applyFunction, /done < <\(active_network_services\)/);
  assert.match(systemProxyFunction, /proxy_mode/);
  assert.match(script, /proxy-mode\) shift; proxy_mode_bez "\$@"/);
});

test("bez exposes rootless local heal controls without central DNS mutation", () => {
  const script = bezMacInstallerScript("https://vpn.bezrabotnyi.com");
  const healFunctionStart = script.indexOf("heal_host()");
  const healFunctionEnd = script.indexOf("help_bez()");
  const healFunctions = script.slice(healFunctionStart, healFunctionEnd);

  assert.ok(healFunctionStart >= 0, "heal command functions must exist");
  assert.match(script, /HEAL_RULES_PATH="\$APP_DIR\/heal-rules\.json"/);
  assert.match(script, /HEAL_AUDIT_PATH="\$APP_DIR\/heal-audit\.log"/);
  assert.match(script, /heal\) shift; heal_bez "\$@"/);
  for (const command of ["on", "off", "status", "list", "test", "replay", "drop"]) {
    assert.match(healFunctions, new RegExp(`\\b${command}\\b`));
  }
  assert.match(healFunctions, /curl .*--proxy/);
  assert.match(healFunctions, /curl .*--noproxy '\*'/);
  assert.doesNotMatch(healFunctions, /sudo|networksetup|smart-dns|\/etc\/hosts/i);
});

test("bez exposes a loopback-only local dashboard with status and endpoint controls", () => {
  const script = bezMacInstallerScript("https://vpn.bezrabotnyi.com");
  const webUi = macosBezWebUiPython('"https://vpn.bezrabotnyi.com"', '"test-token"');

  assert.match(script, /WEB_UI_PATH="\$APP_DIR\/web-ui\.py"/);
  assert.match(script, /WEB_PLIST_PATH=.*com\.bezrabotnyi\.bez-web\.plist/);
  assert.match(script, /ENDPOINT_STATE="\$APP_DIR\/endpoint"/);
  assert.match(script, /TELEMETRY_STATE="\$APP_DIR\/telemetry"/);
  assert.match(script, /endpoint_bez\(\)/);
  assert.match(script, /endpoint\) shift; endpoint_bez/);
  assert.match(script, /telemetry\) shift; telemetry_bez/);
  assert.match(script, /telemetry_bez\(\)/);
  assert.match(script, /web\) web_bez/);
  assert.match(script, /Endpoint:/);
  assert.match(script, /RoutingService/);
  assert.match(script, /xray.*api bi|"\$XRAY_BIN" api bi/);
  assert.match(script, /rule\.pop\("balancerTag", None\)/);
  assert.match(script, /rule\["outboundTag"\] = endpoint/);
  assert.match(webUi, /report_diagnostic/);
  assert.match(webUi, /api\/telemetry\/vpn-tests\/events/);
  assert.match(script, /materialize_config [01] "\$tmp"/);
  assert.match(script, /restored '\$previous'/);
  assert.match(script, /set_endpoint_bez\(\) \{[\s\S]*read_ports \|\| die "Bez proxy ports are unavailable"/);
  assert.match(script, /wait_web\(\)/);
  assert.match(script, /start_web_daemon\n\s+wait_web/);
  assert.match(script, /web_bez\(\) \{[\s\S]*nc -z 127\.0\.0\.1 "\$API_PORT"[\s\S]*materialize_current_config/);

  assert.match(webUi, /ThreadingHTTPServer\(\("127\.0\.0\.1", args\.port\)/);
  assert.doesNotMatch(webUi, /ThreadingHTTPServer\(\("0\.0\.0\.0"/);
  assert.match(webUi, /\/api\/status/);
  assert.match(webUi, /\/api\/profile/);
  assert.match(webUi, /\/api\/endpoint/);
  assert.match(webUi, /X-Bez-CSRF/);
  assert.match(webUi, /data-profile="smart" data-scope="local"/);
  assert.match(webUi, /data-profile="custom" data-scope="global"/);
  assert.match(webUi, /Auto \(leastPing\)/);
  assert.match(webUi, /active_endpoints/);
  assert.match(webUi, /active = active_endpoints\(config\) if selected == "auto" else \{\}/);
});

test("bez dashboard exposes non-disruptive endpoint diagnostics and Smart PAC controls", () => {
  const webUi = macosBezWebUiPython('"https://vpn.bezrabotnyi.com"', '"test-token"');

  assert.match(webUi, /DIAGNOSTICS_PATH = APP_DIR \/ "endpoint-diagnostics\.json"/);
  assert.match(webUi, /CUSTOM_POLICY_PATH = APP_DIR \/ "custom-policy\.json"/);
  assert.match(webUi, /def probe_endpoint\(endpoint, config, quick=False, probe_urls=None\):/);
  assert.match(webUi, /speed\.cloudflare\.com\/__down\?bytes=1000000/);
  assert.match(webUi, /api\.ipify\.org/);
  assert.match(webUi, /"latencyMs"/);
  assert.match(webUi, /"speedMbps"/);
  assert.match(webUi, /"exitIp"/);
  assert.match(webUi, /threading\.Thread\(target=run_diagnostics/);
  assert.match(webUi, /candidates = \[selected\] if selection_mode == "manual" else endpoint_candidates\(config\)/);
  assert.match(webUi, /\/api\/diagnostics/);
  assert.match(webUi, /\/api\/diagnostics\/run/);

  assert.match(webUi, /def validate_policy\(payload\):/);
  assert.match(webUi, /def pac_script\(\):/);
  assert.match(webUi, /FindProxyForURL/);
  assert.match(webUi, /PROXY 127\.0\.0\.1:/);
  assert.match(webUi, /\/api\/policy/);
  assert.match(webUi, /\/proxy\.pac/);
  assert.match(webUi, /id="diagnostics-table"/);
  assert.match(webUi, /id="diagnostics-run"/);
  assert.match(webUi, /id="smart-save"/);
  assert.match(webUi, /id="smart-apply"/);
  assert.match(webUi, /id="pac-url"/);
});

test("bez Smart editor uses three ordered block, direct, proxy lists and reads legacy rules", () => {
  const script = bezMacInstallerScript("https://vpn.bezrabotnyi.com");
  const webUi = macosBezWebUiPython('"https://vpn.bezrabotnyi.com"', '"test-token"');

  assert.match(webUi, /id="block-domains"/);
  assert.match(webUi, /id="direct-domains"/);
  assert.match(webUi, /id="proxy-domains"/);
  assert.match(webUi, /Приоритет: блокировать → напрямую → через VPN/);
  assert.match(webUi, /function bezMatch\(host, values\)/);
  assert.match(webUi, /bezPolicy\.block/);
  assert.match(webUi, /for key in \("block", "direct", "proxy"\):/);
  assert.match(script, /custom_block = xray_domains\("block"\)/);
  assert.match(script, /"block": \[\],\n  "direct": \[\],\n  "proxy": \[\]/);
  assert.match(script, /routing\["rules"\] = custom_overlay \+ heal_overlay \+ base_rules/);
  assert.ok(webUi.indexOf("bezPolicy.block") < webUi.indexOf("bezPolicy.direct"));
  assert.ok(webUi.indexOf("bezPolicy.direct") < webUi.indexOf("bezPolicy.proxy"));
});

test("bez background checks use isolated real HTTP latency and switch only from a degraded route", async () => {
  const webUi = macosBezWebUiPython('"https://vpn.bezrabotnyi.com"', '"test-token"');
  const directory = await mkdtemp(join(tmpdir(), "bez-auto-heal-"));
  const modulePath = join(directory, "web_ui.py");
  const harnessPath = join(directory, "harness.py");

  try {
    await writeFile(modulePath, webUi);
    await writeFile(harnessPath, `
import importlib.util
import json

spec = importlib.util.spec_from_file_location("bez_web", ${JSON.stringify(modulePath)})
module = importlib.util.module_from_spec(spec)
spec.loader.exec_module(module)

calls = []
module.AUTO_HEAL_COOLDOWN = 0
module.auto_heal_settings = lambda: {"enabled": True}
module.save_auto_heal_state = lambda: None
module.append_auto_heal_log = lambda event, payload: None
module.is_running = lambda: True
module.config_data = lambda: {"outbounds": [
    {"tag": "broken", "protocol": "vless"},
    {"tag": "good", "protocol": "vless"},
]}
module.endpoint_selection = lambda config: ("manual", "broken")
measurements = [
    {"ok": True, "latencyMs": 800, "samples": [{"url": url, "ok": True, "latencyMs": 800} for url in module.AUTO_HEAL_SAMPLE_URLS]},
    {"ok": True, "latencyMs": 45, "samples": [{"url": url, "ok": True, "latencyMs": 45} for url in module.AUTO_HEAL_SAMPLE_URLS]},
]
module.route_measurement = lambda urls, socks_port=None: measurements.pop(0)
module.recent_xray_error = lambda: None
module.probe_endpoint = lambda endpoint, config, quick=False, probe_urls=None: {
    "endpoint": endpoint,
    "ok": endpoint == "good",
    "latencyMs": 45 if endpoint == "good" else None,
    "checkedAt": "now",
}
module.run_cli = lambda arguments: calls.append(arguments) or "ok"

module.auto_heal_check()
assert calls == [["endpoint", "good"]], calls
assert module.AUTO_HEAL_STATE["consecutiveFailures"] == 0
assert module.AUTO_HEAL_STATE["lastSwitch"]["to"] == "good"
print(json.dumps({"calls": calls, "state": module.AUTO_HEAL_STATE["status"]}))
`);
    const result = spawnSync("python3", [harnessPath], {
      encoding: "utf8",
      env: { ...process.env, HOME: directory },
    });
    assert.equal(result.status, 0, result.stderr || result.stdout);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }

  assert.match(webUi, /AUTO_HEAL_INTERVAL =/);
  assert.match(webUi, /AUTO_HEAL_LATENCY_LIMIT_MS = 500/);
  assert.match(webUi, /AUTO_HEAL_SAMPLE_URLS = \("https:\/\/t\.me\/"/);
  assert.match(webUi, /def http_sample\(url, socks_port=None\):/);
  assert.match(webUi, /def recent_xray_error\(\):/);
  assert.match(webUi, /def next_auto_heal_url\(\):/);
  assert.match(webUi, /urls = \(next_auto_heal_url\(\),\)/);
  assert.doesNotMatch(webUi, /def relevant_probe_urls/);
  assert.match(webUi, /backgroundEnabled/);
  assert.match(webUi, /def auto_heal_check\(force=False\):/);
  assert.match(webUi, /threading\.Thread\(target=auto_heal_loop/);
  assert.match(webUi, /\/api\/auto-heal/);
  assert.match(webUi, /id="auto-heal-toggle"/);
  assert.match(webUi, /id="auto-heal-status"/);
});

test("bez auto-heal never overwrites a manual endpoint change during recovery", async () => {
  const directory = await mkdtemp(join(tmpdir(), "bez-auto-heal-race-"));
  const modulePath = join(directory, "web_ui.py");
  const harnessPath = join(directory, "harness.py");

  try {
    await writeFile(modulePath, macosBezWebUiPython('"https://vpn.bezrabotnyi.com"', '"test-token"'));
    await writeFile(harnessPath, `
import importlib.util

spec = importlib.util.spec_from_file_location("bez_web", ${JSON.stringify(modulePath)})
module = importlib.util.module_from_spec(spec)
spec.loader.exec_module(module)

selection = {"value": ("manual", "broken")}
calls = []
class UserChangeLock:
    def __enter__(self):
        selection["value"] = ("manual", "user-choice")
    def __exit__(self, *args):
        return False

module.AUTO_HEAL_COOLDOWN = 0
module.auto_heal_settings = lambda: {"enabled": True}
module.save_auto_heal_state = lambda: None
module.append_auto_heal_log = lambda event, payload: None
module.is_running = lambda: True
module.route_measurement = lambda urls, socks_port=None: {"ok": True, "latencyMs": 900, "samples": [{"url": url, "ok": True, "latencyMs": 900} for url in module.AUTO_HEAL_SAMPLE_URLS]} if socks_port is not None else {"ok": False, "latencyMs": None, "samples": [{"url": url, "ok": False} for url in module.AUTO_HEAL_SAMPLE_URLS]}
module.recent_xray_error = lambda: None
module.config_data = lambda: {"outbounds": [
    {"tag": "broken", "protocol": "vless"},
    {"tag": "good", "protocol": "vless"},
]}
module.endpoint_selection = lambda config: selection["value"]
module.probe_endpoint = lambda endpoint, config, quick=False, probe_urls=None: {"endpoint": endpoint, "ok": True, "latencyMs": 20, "checkedAt": "now"}
module.run_cli = lambda arguments: calls.append(arguments) or "ok"
module.COMMAND_LOCK = UserChangeLock()

result = module.auto_heal_check()
assert calls == [], calls
assert result["state"]["status"] == "cancelled", result
`);
    const result = spawnSync("python3", [harnessPath], {
      encoding: "utf8",
      env: { ...process.env, HOME: directory },
    });
    assert.equal(result.status, 0, result.stderr || result.stdout);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("bez dashboard exposes the server policy, proxy mode and VPN tunnel controls", () => {
  const webUi = macosBezWebUiPython('"https://vpn.bezrabotnyi.com"', '"test-token"');
  assert.equal(spawnSync("python3", ["-c", "import ast,sys; ast.parse(sys.stdin.read())"], { input: webUi }).status, 0);

  assert.match(webUi, /def fetch_server_policy\(\)/);
  assert.match(webUi, /\/api\/user\/client-policy/);
  assert.match(webUi, /def server_policy_payload\(\)/);
  assert.match(webUi, /elif path == "\/api\/server-policy"/);
  assert.match(webUi, /def proxy_mode_state\(\)/);
  assert.match(webUi, /elif path == "\/api\/proxy-mode"/);
  assert.match(webUi, /elif path == "\/api\/vpn"/);
  assert.match(webUi, /def run_elevated\(arguments\)/);
  assert.match(webUi, /with administrator privileges/);
  assert.match(webUi, /def vpn_state\(\)/);
  assert.match(webUi, /id="server-policy-groups"/);
  assert.match(webUi, /id="proxy-mode-socks"/);
  assert.match(webUi, /id="vpn-on"/);
  assert.match(webUi, /BASE_URL = "https:\/\/vpn\.bezrabotnyi\.com"/);
  assert.match(webUi, /CONFIG_TOKEN = "test-token"/);
});

test("bez CLI ships an elevated utun tunnel with a pinned sing-box build", () => {
  const script = bezMacInstallerScript("https://vpn.bezrabotnyi.com");
  assert.equal(spawnSync("bash", ["-n"], { input: script }).status, 0);
  assert.match(script, /SINGBOX_VERSION="1\.13\.14"/);
  assert.match(script, /73e8967b0fc08e17bce4263ca56ebc394822401a16497a1c4e02316c888202ab/);
  assert.match(script, /5245d645e847f90bb708da74bc020ae078c28489690756419685c04f56b4e3bb/);
  assert.match(script, /"action": "sniff"/);
  assert.match(script, /"auto_route": True/);
  assert.match(script, /"server_port": socks_port/);
  assert.match(script, /vpn\) shift; vpn_tunnel "\$@"/);
  assert.match(script, /proxy-mode\) shift; proxy_mode_bez "\$@"/);
  assert.match(script, /<key>RunAtLoad<\/key><false\/><key>KeepAlive<\/key><false\/>/);
  assert.match(script, /launchctl enable "system\/\$VPN_LABEL"/);
  assert.match(script, /launchctl bootstrap system "\$VPN_PLIST_PATH"/);
  assert.match(script, /launchctl kickstart "system\/\$VPN_LABEL"/);
});

test("mac hosts script manages an idempotent vpn2 SNI block for OpenAI/Claude", () => {
  const script = macHostsScript();

  assert.match(script, /^#!\/bin\/bash/);
  assert.equal(spawnSync("bash", ["-n"], { input: script }).status, 0);
  assert.match(script, /# >>> bez vpn2 sni hosts >>>/);
  assert.match(script, /# <<< bez vpn2 sni hosts <<</);
  assert.match(script, /VPN2_IP="212\.192\.31\.128"/);
  assert.match(script, /VUSA_IP="185\.240\.120\.152"/);
  assert.match(script, /EDGE_IP=.*VPN2_IP/);
  assert.match(script, /echo "\$EDGE_IP\\topenai\.com"/);
  assert.match(script, /--remove/);
  assert.match(script, /dscacheutil -flushcache/);
  assert.match(script, /killall -HUP mDNSResponder/);
  assert.match(script, /chmod 644 \/etc\/hosts/);
  // Idempotency: re-running removes the previous block before appending a new one.
  assert.match(script, /remove_block\(\)/);
  assert.match(script, /drop_managed_lines\(\)/);
  // Backup retention keeps the five most recent host backups.
  assert.match(script, /tail -n \+6 \| xargs rm -f/);
});

test("mac hosts script pins a custom edge IP and never widens the domain set", () => {
  const script = macHostsScript("203.0.113.9");

  assert.match(script, /VPN2_IP="203\.0\.113\.9"/);
  assert.match(script, /EDGE_IP=.*VPN2_IP/);
  assert.doesNotMatch(script, /proton/);
  assert.doesNotMatch(script, /telegram|youtube|discord/);
});

test("bez traffic pre-check probes the proxy kind that is about to become system-wide", () => {
  const script = bezMacInstallerScript("https://vpn.bezrabotnyi.com");
  const waitFunction = script.slice(script.indexOf("wait_traffic()"), script.indexOf("activate()"));

  assert.match(waitFunction, /probe_proxy="http:\/\/127\.0\.0\.1:\$HTTP_PORT"/);
  assert.match(waitFunction, /socks5h:\/\/127\.0\.0\.1:\$SOCKS_PORT/);
  assert.match(waitFunction, /if \[\[ "\$\(proxy_mode\)" == socks \]\]/);
  assert.match(waitFunction, /--proxy "\$probe_proxy"/);
  // The pre-check runs before any networksetup mutation inside activate().
  const activateFunction = script.slice(script.indexOf("activate()"), script.indexOf("install_bez()"));
  assert.match(activateFunction, /wait_proxy\n\s+wait_traffic "\$mode"\n\s+if \(\( system_proxy \)\); then/);
});

test("bez uses high non-conflicting ports by default", () => {
  const script = bezMacInstallerScript("https://vpn.bezrabotnyi.com");
  const webUi = macosBezWebUiPython('"https://vpn.bezrabotnyi.com"', '"test-token"');

  assert.match(script, /SOCKS_PORT=28108/);
  assert.match(script, /HTTP_PORT=28109/);
  assert.match(script, /WEB_PORT=28110/);
  assert.match(script, /API_PORT=28111/);
  assert.match(script, /local base=28108/);
  assert.match(webUi, /XRAY_API_PORT = 28111/);
  assert.match(webUi, /default=28110/);
  // Low port ranges stay reserved for other VPN clients on the same Mac.
  assert.doesNotMatch(script, /local base=10808/);
  assert.doesNotMatch(webUi, /127\.0\.0\.1:11810/);
});

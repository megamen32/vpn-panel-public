import test from "node:test";
import assert from "node:assert/strict";
import { bezWindowsInstallerScript } from "../src/windows-installer.js";
import { MACOS_CONFIG_TOKEN } from "../src/macos-token.js";

test("bez windows bootstrap installs a rootless Xray user-proxy CLI", () => {
  const script = bezWindowsInstallerScript("https://vpn.bezrabotnyi.com");

  for (const command of ["install", "update", "smart", "all", "off", "status", "logs", "proxy", "unproxy", "web", "web-serve"]) {
    assert.match(script, new RegExp(`'${command}'`));
  }
  assert.ok(script.includes("$BaseUrl = 'https://vpn.bezrabotnyi.com'"));
  assert.ok(script.includes(`$ConfigToken = '${MACOS_CONFIG_TOKEN}'`));
  assert.match(script, /LOCALAPPDATA/);
  assert.match(script, /BezVPN/);
  assert.match(script, /install\/bez-windows/);
  assert.match(script, /client-xray-config\?mode=/);
  assert.match(script, /Authorization = 'Bearer '/);
  assert.match(script, /CurrentVersion\\Run/);
  assert.match(script, /CurrentVersion\\Internet Settings/);
  assert.match(script, /Get-FileHash -Path \$zip -Algorithm SHA256/);
  assert.match(script, /Expand-Archive/);
  assert.match(script, /run -test -config/);
  assert.match(script, /AMD64.*Xray-windows-64\.zip/);
  assert.match(script, /ARM64.*Xray-windows-arm64-v8a\.zip/);
  assert.match(script, /InternetSetOption/);
  assert.match(script, /Stop-Process/);
  assert.match(script, /bez-daemon\.ps1/);
  assert.match(script, /10808/);
  assert.match(script, /10809/);
  assert.doesNotMatch(script, /schtasks|Register-ScheduledTask/);
  assert.doesNotMatch(script, /HKLM:/);
  assert.match(script, /Set-BezHosts/);
  assert.match(script, /-Verb RunAs/);
  assert.doesNotMatch(script, /sing-box/);
});

test("bez web dashboard mirrors the macOS local dashboard core", () => {
  const script = bezWindowsInstallerScript("https://vpn.bezrabotnyi.com");

  assert.match(script, /TcpListener/);
  assert.match(script, /\$WebPort = 28110/);
  assert.match(script, /BezVPN-Web/);
  assert.match(script, /'\/api\/status'/);
  assert.match(script, /'\/api\/profile'/);
  assert.match(script, /'\/api\/off'/);
  assert.match(script, /'\/api\/update'/);
  assert.match(script, /'\/api\/check'/);
  assert.match(script, /'\/proxy\.pac'/);
  assert.match(script, /x-bez-csrf/);
  assert.match(script, /FromBase64String\(\$DashboardHtmlB64\)/);
  assert.match(script, /https:\/\/t\.me\//);
  assert.match(script, /PROXY 127\.0\.0\.1:10809/);
  const blob = script.match(/\$DashboardHtmlB64 = '([A-Za-z0-9+/=]+)'/);
  assert.ok(blob, "dashboard html base64 blob present");
  const html = Buffer.from(blob[1], "base64").toString("utf8");
  assert.match(html, /<html lang="ru">/);
  assert.match(html, /X-Bez-CSRF/);
  assert.match(html, /__BEZ_CSRF__/);
  for (const label of ["Включить Smart", "Включить Full", "Выключить", "Обновить конфиг", "Проверить Telegram", "Xray запущен", "PAC URL скопирован"]) {
    assert.ok(html.includes(label), `dashboard html misses ${label}`);
  }
  for (const target of ["vpn2", "vusa", "off"]) assert.match(html, new RegExp(`hosts-${target}`));
  assert.match(html, /hosts-preview/);
  assert.match(html, /\/api\/hosts-preview/);
  assert.match(html, /\/api\/hosts/);
  assert.match(script, /Get-BezHostsPreview/);
  assert.ok(!html.includes("`"), "dashboard js must avoid backticks");
});

test("bez windows script is plain ASCII without PowerShell escape hazards", () => {
  const script = bezWindowsInstallerScript("https://vpn.bezrabotnyi.com");
  for (const character of script) {
    assert.ok(character.charCodeAt(0) < 128, `non-ascii character: ${JSON.stringify(character)}`);
  }
  assert.ok(!script.includes("`"), "backtick is a PowerShell escape hazard");
  assert.ok(!script.includes("${"), "dollar-brace would break the generator template");
  assert.ok(script.endsWith("\n"));
});

test("bez windows script strips trailing slashes and quotes from the base URL", () => {
  const script = bezWindowsInstallerScript("https://vpn.bezrabotnyi.com///");
  assert.ok(script.includes("$BaseUrl = 'https://vpn.bezrabotnyi.com'"));
  assert.ok(!script.includes(" bez.ps1'''"));
});

test("Bez Windows installs a native system tray with quick controls", () => {
  const script = bezWindowsInstallerScript("https://vpn.bezrabotnyi.com");
  assert.match(script, /System\.Windows\.Forms\.NotifyIcon/);
  assert.match(script, /Start-BezTray/);
  assert.match(script, /tray-serve/);
  assert.match(script, /Enable Smart/);
});

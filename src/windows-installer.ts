import { MACOS_CONFIG_TOKEN } from "./macos-token.js";

/**
 * Dashboard HTML served by the Windows bez client at http://127.0.0.1:28110/.
 * Embedded into the PowerShell script as UTF-8 base64 so the .ps1 itself stays
 * plain ASCII (Windows PowerShell 5.1 parses BOM-less UTF-8 as ANSI).
 * __BEZ_CSRF__ is replaced at runtime by the web server.
 */
const DASHBOARD_HTML = `<!doctype html>
<html lang="ru">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Bez VPN</title>
<style>
:root { color-scheme: dark; }
* { box-sizing: border-box; }
body { font-family: -apple-system, "Segoe UI", system-ui, sans-serif; background: #0f1115; color: #e6e8ec; margin: 0; }
.wrap { max-width: 720px; margin: 0 auto; padding: 24px 16px 48px; }
header { display: flex; align-items: center; gap: 12px; padding-bottom: 16px; border-bottom: 1px solid #232733; }
header h1 { font-size: 22px; margin: 0; }
.dot { width: 12px; height: 12px; border-radius: 50%; background: #58606e; display: inline-block; flex: none; }
.dot.running { background: #2ea043; box-shadow: 0 0 8px #2ea043aa; }
section { margin-top: 20px; }
h2 { font-size: 14px; color: #9aa4b2; text-transform: uppercase; letter-spacing: .04em; margin: 0 0 10px; }
.facts { display: grid; grid-template-columns: repeat(auto-fit, minmax(150px, 1fr)); gap: 8px; }
.fact { background: #161a22; border: 1px solid #232733; border-radius: 10px; padding: 10px 12px; }
.fact .k { color: #8b94a3; font-size: 12px; }
.fact .v { font-size: 15px; margin-top: 2px; word-break: break-all; }
.actions { display: flex; flex-wrap: wrap; gap: 8px; }
button { border: 0; border-radius: 8px; padding: 9px 14px; font-size: 14px; cursor: pointer; background: #21262d; color: #e6e8ec; }
button:disabled { opacity: .5; cursor: default; }
button.primary { background: #238636; }
button.secondary { background: #30363d; }
button.danger { background: #b62324; }
.pac-row { display: flex; gap: 8px; margin-top: 12px; }
.pac-row input { flex: 1; background: #161a22; border: 1px solid #232733; border-radius: 8px; color: #e6e8ec; padding: 8px 10px; font-size: 14px; }
.notice { margin-top: 10px; min-height: 18px; font-size: 13px; color: #9aa4b2; }
.notice.error { color: #f85149; }
.hint { color: #8b94a3; font-size: 13px; }
</style>
</head>
<body>
<div class="wrap">
<header><span class="dot" id="status-dot"></span><h1>Bez VPN</h1><span class="hint" id="status-text">Загрузка…</span></header>
<section>
<h2>Состояние</h2>
<div class="facts">
<div class="fact"><div class="k">Режим</div><div class="v" id="fact-profile">—</div></div>
<div class="fact"><div class="k">Прокси</div><div class="v" id="fact-proxy">—</div></div>
<div class="fact"><div class="k">Системный прокси</div><div class="v" id="fact-system">—</div></div>
</div>
</section>
<section>
<h2>Управление</h2>
<div class="actions">
<button class="primary" id="smart">Включить Smart</button>
<button class="primary" id="full">Включить Full</button>
<button class="secondary" id="update">Обновить конфиг</button>
<button class="danger" id="off">Выключить</button>
</div>
<div class="notice" id="notice"></div>
</section>
<section>
<h2>Проверка</h2>
<div class="actions"><button class="secondary" id="check">Проверить Telegram</button></div>
<div class="notice" id="check-notice"></div>
</section>
<section>
<h2>Hosts: Xray SNI edge</h2>
<p class="hint">Закрепляет только AI-домены Bez за выбранным edge. Потребуется подтверждение UAC; «Выключить» удаляет только записи Bez.</p>
<div class="actions"><button class="secondary" id="hosts-vpn2">vpn2</button><button class="secondary" id="hosts-vusa">vusa</button><button class="secondary" id="hosts-preview">Предпросмотр</button><button class="danger" id="hosts-off">Выключить hosts</button></div>
<div class="notice" id="hosts-notice"></div>
<pre class="output" id="hosts-preview-output" hidden></pre>
</section>
<section>
<h2>PAC</h2>
<p class="hint">Для приложений и браузеров без системного прокси можно указать PAC-файл вручную.</p>
<div class="pac-row"><input id="pac-url" readonly value="http://127.0.0.1:28110/proxy.pac"><button class="secondary" id="pac-copy">Копировать</button></div>
</section>
</div>
<script>
var csrf = "__BEZ_CSRF__";
function notice(id, message, error) { var n = document.getElementById(id); n.textContent = message || ""; n.className = "notice" + (error ? " error" : ""); }
function setBusy(v) { var b = document.querySelectorAll("button"); for (var i = 0; i < b.length; i++) b[i].disabled = v; }
function request(path, body) {
  var options = body === undefined ? {} : {method: "POST", headers: {"Content-Type": "application/json", "X-Bez-CSRF": csrf}, body: JSON.stringify(body)};
  return fetch(path, options).then(function (r) { return r.json().then(function (d) { if (!r.ok) throw new Error(d.error || "Команда не выполнена"); return d; }); });
}
var profileNames = {smart: "Smart", all: "Full"};
function render(data) {
  document.getElementById("status-dot").className = "dot" + (data.running ? " running" : "");
  document.getElementById("status-text").textContent = data.running ? "Xray запущен" : "Xray выключен";
  document.getElementById("fact-profile").textContent = profileNames[data.profile] || data.profile;
  document.getElementById("fact-proxy").textContent = "HTTP " + data.proxy.http + " · SOCKS " + data.proxy.socks;
  document.getElementById("fact-system").textContent = data.proxyManaged ? "управляется bez" : "не управляется";
}
function refresh() { request("/api/status").then(render).catch(function (e) { notice("notice", e.message, true); }); }
function mutate(path, body, message) {
  setBusy(true); notice("notice", message || "");
  return request(path, body).then(function (d) { setBusy(false); refresh(); return d; }).catch(function (e) { setBusy(false); notice("notice", e.message, true); });
}
document.getElementById("smart").addEventListener("click", function () { mutate("/api/profile", {profile: "smart"}, "Включаю Smart…"); });
document.getElementById("full").addEventListener("click", function () { mutate("/api/profile", {profile: "all"}, "Включаю Full…"); });
document.getElementById("update").addEventListener("click", function () { mutate("/api/update", {}, "Обновляю конфиг…"); });
document.getElementById("off").addEventListener("click", function () { mutate("/api/off", {}, "Выключаю…"); });
document.getElementById("hosts-vpn2").addEventListener("click", function () { mutate("/api/hosts", {target: "vpn2"}, "Применяю hosts через UAC…").then(function(d){ notice("hosts-notice", d.detail || "Готово"); }); });
document.getElementById("hosts-vusa").addEventListener("click", function () { mutate("/api/hosts", {target: "vusa"}, "Применяю hosts через UAC…").then(function(d){ notice("hosts-notice", d.detail || "Готово"); }); });
document.getElementById("hosts-preview").addEventListener("click", function () { request("/api/hosts-preview").then(function(d){ var output = document.getElementById("hosts-preview-output"); output.hidden = false; output.textContent = "Текущий блок Bez:\\n" + (d.current || "(не установлен)") + "\\n\\nБудет записано для vpn2:\\n" + d.vpn2 + "\\n\\nБудет записано для vusa:\\n" + d.vusa; }).catch(function(e){ notice("hosts-notice", e.message, true); }); });
document.getElementById("hosts-off").addEventListener("click", function () { mutate("/api/hosts", {target: "off"}, "Удаляю записи Bez через UAC…").then(function(d){ notice("hosts-notice", d.detail || "Готово"); }); });
document.getElementById("check").addEventListener("click", function () {
  setBusy(true); notice("check-notice", "Проверяю Telegram…");
  request("/api/check", {}).then(function (d) {
    setBusy(false);
    notice("check-notice", d.ok ? "Telegram доступен (HTTP " + d.code + ")" : "Telegram недоступен (HTTP " + d.code + ")", !d.ok);
  }).catch(function (e) { setBusy(false); notice("check-notice", e.message, true); });
});
document.getElementById("pac-copy").addEventListener("click", function () {
  var input = document.getElementById("pac-url");
  input.select();
  if (navigator.clipboard) { navigator.clipboard.writeText(input.value); }
  notice("notice", "PAC URL скопирован");
});
refresh();
setInterval(refresh, 4000);
</script>
</body>
</html>
`;

/**
 * Rootless Windows bez client. Mirrors the macOS installer command surface
 * (install|smart|all|update|off|status|logs|proxy|unproxy plus a local web
 * dashboard on 127.0.0.1:28110 like `bez web` on macOS) with user-only
 * mechanisms: per-user Xray under LOCALAPPDATA, autostart via HKCU Run keys,
 * and the per-user WinINET proxy instead of networksetup. The Xray config is
 * platform independent, so the client reuses the fixed
 * /api/user/client-xray-config endpoint.
 *
 * The generated script must stay plain ASCII: Windows PowerShell 5.1 parses
 * BOM-less UTF-8 as ANSI, and the bootstrap path pipes it through iex. The
 * dashboard HTML travels inside the script as UTF-8 base64 for that reason.
 */
export function bezWindowsInstallerScript(publicBaseUrl: string): string {
  const script = String.raw`# Bez rootless Windows client (generated; run: bez install)
$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'
try { [Net.ServicePointManager]::SecurityProtocol = [Net.ServicePointManager]::SecurityProtocol -bor [Net.SecurityProtocolType]::Tls12 } catch {}

function Die([string]$Message) {
  Write-Host ('bez: ' + $Message)
  exit 1
}
function Test-Windows {
  if ($env:OS -ne 'Windows_NT' -or -not $env:LOCALAPPDATA) { Die 'Windows user session only' }
}
Test-Windows

$BaseUrl = '__BEZ_BASE_URL__'
$ConfigToken = '__BEZ_CONFIG_TOKEN__'
$XrayVersion = '26.5.9'
$WebPort = 28110

$AppDir = Join-Path $env:LOCALAPPDATA 'BezVPN'
$BinDir = Join-Path $AppDir 'bin'
$XrayBin = Join-Path $BinDir 'xray.exe'
$ConfigPath = Join-Path $AppDir 'config.json'
$StatePath = Join-Path $AppDir 'state'
$ProxyStatePath = Join-Path $AppDir 'proxy-state.json'
$DaemonPath = Join-Path $AppDir 'bez-daemon.ps1'
$LogPath = Join-Path $AppDir 'bez.log'
$ErrLogPath = Join-Path $AppDir 'bez-err.log'
$WebLogPath = Join-Path $AppDir 'bez-web.log'
$DashboardHtmlB64 = '__BEZ_HTML_B64__'
$RunKeyName = 'BezVPN'
$WebRunKeyName = 'BezVPN-Web'
$TrayRunKeyName = 'BezVPN-Tray'
$InternetSettings = 'HKCU:\Software\Microsoft\Windows\CurrentVersion\Internet Settings'
$RunKey = 'HKCU:\Software\Microsoft\Windows\CurrentVersion\Run'

function Test-Installed {
  ((Test-Path $XrayBin) -and (Test-Path $ConfigPath) -and
    $null -ne (Get-ItemProperty -Path $RunKey -Name $RunKeyName -ErrorAction SilentlyContinue))
}
function Get-Mode {
  $mode = 'smart'
  if (Test-Path $StatePath) {
    $first = Get-Content -Path $StatePath -ErrorAction SilentlyContinue | Select-Object -First 1
    $mode = ([string]$first) -replace '^mode=', ''
  }
  if ($mode -ne 'smart' -and $mode -ne 'all') { $mode = 'smart' }
  return $mode
}
function Add-UserPath([string]$Dir) {
  $current = (Get-ItemProperty -Path 'HKCU:\Environment' -Name Path -ErrorAction SilentlyContinue).Path
  if ($current -and $current.ToLower().Contains($Dir.ToLower())) { return }
  $newPath = if ($current) { ($current.TrimEnd(';') + ';' + $Dir) } else { $Dir }
  New-ItemProperty -Path 'HKCU:\Environment' -Name Path -Value $newPath -PropertyType String -Force | Out-Null
  if (-not ($script:NativeType)) {
    $script:NativeType = Add-Type -Namespace Bez -Name Native -MemberDefinition '[DllImport("user32.dll", SetLastError=true, CharSet=CharSet.Auto)] public static extern IntPtr SendMessageTimeout(IntPtr hWnd, uint Msg, UIntPtr wParam, string lParam, uint fuFlags, uint uTimeout, out UIntPtr lpdwResult);' -PassThru
  }
  $result = [UIntPtr]::Zero
  [void]$script:NativeType::SendMessageTimeout([IntPtr]0xffff, 0x1A, [UIntPtr]::Zero, 'Environment', 2, 5000, [ref]$result)
}
function Install-Cli {
  New-Item -ItemType Directory -Path $BinDir -Force | Out-Null
  Invoke-WebRequest -UseBasicParsing -Uri ($BaseUrl + '/install/bez-windows') -OutFile (Join-Path $BinDir 'bez.ps1')
  $bezCmd = '@echo off' + [char]13 + [char]10 + 'powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0bez.ps1" %*'
  Set-Content -Path (Join-Path $BinDir 'bez.cmd') -Value $bezCmd -Encoding ASCII
  Add-UserPath $BinDir
  Write-Host ('bez installed at ' + (Join-Path $BinDir 'bez.cmd'))
  Write-Host 'No administrator password is required. Open a NEW terminal and run: bez install'
}
function Get-XrayAsset {
  switch ($env:PROCESSOR_ARCHITECTURE) {
    'AMD64' { return 'Xray-windows-64.zip' }
    'ARM64' { return 'Xray-windows-arm64-v8a.zip' }
    default { Die 'unsupported Windows architecture' }
  }
}
function Invoke-Download([string]$Uri, [string]$OutFile) {
  Invoke-WebRequest -UseBasicParsing -Uri $Uri -OutFile $OutFile
}
function Get-Xray {
  $asset = Get-XrayAsset
  $work = Join-Path $AppDir ('.xray-' + [Guid]::NewGuid().ToString('N'))
  New-Item -ItemType Directory -Path $work -Force | Out-Null
  try {
    $zip = Join-Path $work 'xray.zip'
    $dgst = Join-Path $work 'xray.dgst'
    $unpacked = Join-Path $work 'unpacked'
    $release = 'https://github.com/XTLS/Xray-core/releases/download/v' + $XrayVersion
    Invoke-Download ($release + '/' + $asset) $zip
    Invoke-Download ($release + '/' + $asset + '.dgst') $dgst
    $match = Select-String -Path $dgst -Pattern '[0-9a-f]{64}' | Select-Object -First 1
    $expected = if ($match) { $match.Matches[0].Value } else { '' }
    $actual = (Get-FileHash -Path $zip -Algorithm SHA256).Hash.ToLower()
    if (-not $expected -or $expected -ne $actual) { Die 'Xray SHA-256 verification failed' }
    Expand-Archive -Path $zip -DestinationPath $unpacked -Force
    $exe = Join-Path $unpacked 'xray.exe'
    if (-not (Test-Path $exe)) { Die 'Xray archive has no executable' }
    New-Item -ItemType Directory -Path $BinDir -Force | Out-Null
    Move-Item -Path $exe -Destination $XrayBin -Force
  } finally {
    Remove-Item -Path $work -Recurse -Force -ErrorAction SilentlyContinue
  }
}
function Get-Config([string]$Mode) {
  New-Item -ItemType Directory -Path $AppDir -Force | Out-Null
  $tmp = Join-Path $AppDir ('.config.' + [Guid]::NewGuid().ToString('N') + '.json')
  try {
    Invoke-WebRequest -UseBasicParsing -Uri ($BaseUrl + '/api/user/client-xray-config?mode=' + $Mode) -Headers @{ Authorization = 'Bearer ' + $ConfigToken } -OutFile $tmp
    & $XrayBin run -test -config $tmp *> $null
    if ($LASTEXITCODE -ne 0) { Die ('Xray rejected the downloaded ' + $Mode + ' config') }
    Move-Item -Path $tmp -Destination $ConfigPath -Force
  } finally {
    if (Test-Path $tmp) { Remove-Item $tmp -Force -ErrorAction SilentlyContinue }
  }
}
function Write-Daemon {
  $daemon = @'
# Bez Xray daemon (generated): keeps xray running and appends its log.
$ErrorActionPreference = 'SilentlyContinue'
$base = if ($PSScriptRoot) { $PSScriptRoot } else { Split-Path -Parent $MyInvocation.MyCommand.Path }
$xray = Join-Path (Join-Path $base 'bin') 'xray.exe'
$config = Join-Path $base 'config.json'
$log = Join-Path $base 'bez.log'
$err = Join-Path $base 'bez-err.log'
while ($true) {
  & $xray run -config $config 1>> $log 2>> $err
  Start-Sleep -Seconds 2
}
'@
  Set-Content -Path $DaemonPath -Value $daemon -Encoding ASCII
}
function Set-Autostart {
  $daemonCmd = 'powershell.exe -NoProfile -ExecutionPolicy Bypass -WindowStyle Hidden -File "' + $DaemonPath + '"'
  New-ItemProperty -Path $RunKey -Name $RunKeyName -Value $daemonCmd -PropertyType String -Force | Out-Null
}
function Remove-Autostart {
  Remove-ItemProperty -Path $RunKey -Name $RunKeyName -ErrorAction SilentlyContinue
}
function Stop-Daemon {
  Get-CimInstance -ClassName Win32_Process -Filter "Name = 'powershell.exe'" -ErrorAction SilentlyContinue |
    Where-Object { $_.CommandLine -and $_.CommandLine.Contains('bez-daemon.ps1') } |
    ForEach-Object { Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue }
}
function Stop-XrayProcess {
  Get-CimInstance -ClassName Win32_Process -Filter "Name = 'xray.exe'" -ErrorAction SilentlyContinue |
    Where-Object { $_.ExecutablePath -and $_.ExecutablePath.StartsWith($BinDir, [StringComparison]::OrdinalIgnoreCase) } |
    ForEach-Object { Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue }
}
function Start-Xray {
  Write-Daemon
  Stop-Daemon
  Stop-XrayProcess
  Start-Process -FilePath 'powershell.exe' -ArgumentList @('-NoProfile', '-ExecutionPolicy', 'Bypass', '-WindowStyle', 'Hidden', '-File', $DaemonPath) -WindowStyle Hidden
}
function Test-LocalPort([int]$Port) {
  $client = New-Object Net.Sockets.TcpClient
  try {
    $async = $client.BeginConnect('127.0.0.1', $Port, $null, $null)
    if ($async.AsyncWaitHandle.WaitOne(500)) {
      $client.EndConnect($async) | Out-Null
      return $true
    }
    return $false
  } catch { return $false } finally { $client.Close() }
}
function Wait-Proxy {
  for ($i = 0; $i -lt 40; $i++) {
    if ((Test-LocalPort 10808) -and (Test-LocalPort 10809)) { return $true }
    Start-Sleep -Milliseconds 250
  }
  Write-Host 'bez: Xray did not open local proxy ports; see bez logs'
  return $false
}
function Invoke-WinInetRefresh {
  if (-not ($script:WinInetType)) {
    $script:WinInetType = Add-Type -Namespace Bez -Name WinInet -MemberDefinition '[DllImport("wininet.dll", SetLastError=true)] public static extern bool InternetSetOption(IntPtr hInternet, int dwOption, IntPtr lpBuffer, int dwBufferLength);' -PassThru
  }
  [void]$script:WinInetType::InternetSetOption([IntPtr]::Zero, 95, [IntPtr]::Zero, 0)
  [void]$script:WinInetType::InternetSetOption([IntPtr]::Zero, 37, [IntPtr]::Zero, 0)
}
function Save-ProxySnapshot {
  if (Test-Path $ProxyStatePath) { return }
  $item = Get-ItemProperty -Path $InternetSettings
  $snapshot = [ordered]@{
    ProxyEnable = [int]$item.ProxyEnable
    ProxyServer = [string]$item.ProxyServer
    AutoConfigURL = [string]$item.AutoConfigURL
    ProxyOverride = [string]$item.ProxyOverride
  }
  $snapshot | ConvertTo-Json | Set-Content -Path $ProxyStatePath -Encoding ASCII
}
function Enable-SystemProxy {
  Save-ProxySnapshot
  Set-ItemProperty -Path $InternetSettings -Name ProxyServer -Value 'http=127.0.0.1:10809;https=127.0.0.1:10809;socks=127.0.0.1:10808'
  $bypass = (Get-ItemProperty -Path $InternetSettings -Name ProxyOverride -ErrorAction SilentlyContinue).ProxyOverride
  if (-not $bypass) { Set-ItemProperty -Path $InternetSettings -Name ProxyOverride -Value 'localhost;127.*;<local>' }
  Set-ItemProperty -Path $InternetSettings -Name ProxyEnable -Value 1
  Invoke-WinInetRefresh
}
function Restore-SystemProxy {
  if (-not (Test-Path $ProxyStatePath)) { return }
  $snapshot = Get-Content -Path $ProxyStatePath -Raw | ConvertFrom-Json
  Set-ItemProperty -Path $InternetSettings -Name ProxyEnable -Value ([int]$snapshot.ProxyEnable)
  foreach ($name in @('ProxyServer', 'AutoConfigURL', 'ProxyOverride')) {
    $value = $snapshot.$name
    if ($value) {
      Set-ItemProperty -Path $InternetSettings -Name $name -Value $value
    } else {
      Remove-ItemProperty -Path $InternetSettings -Name $name -ErrorAction SilentlyContinue
    }
  }
  Remove-Item -Path $ProxyStatePath -Force -ErrorAction SilentlyContinue
  Invoke-WinInetRefresh
}
function Activate-Bez([string]$Mode) {
  if (-not (Test-Installed)) { Die 'run bez install first' }
  Get-Config $Mode
  Set-Content -Path $StatePath -Value ('mode=' + $Mode) -Encoding ASCII
  Set-Autostart
  Start-Xray
  [void](Wait-Proxy)
  Enable-SystemProxy
  Write-Host ('bez: ' + $Mode + ' enabled (Windows user proxy, no admin)')
}
function Install-Bez {
  Test-Windows
  Write-Host 'bez: passwordless rootless mode; no administrator rights or VPN password required'
  Write-Host 'bez: Xray will run as your user and the per-user Windows proxy will be changed'
  New-Item -ItemType Directory -Path $AppDir -Force | Out-Null
  Get-Xray
  Get-Config 'smart'
  Set-Content -Path $StatePath -Value 'mode=smart' -Encoding ASCII
  Set-Autostart
  Start-Xray
  [void](Wait-Proxy)
  Enable-SystemProxy
  Write-Host 'bez: installed and smart mode enabled'
  Write-Host 'bez: run bez web for the local dashboard'
}
function Update-Bez {
  Test-Windows
  if (-not (Test-Installed)) { Die 'run bez install first' }
  $mode = Get-Mode
  Get-Config $mode
  Start-Xray
  [void](Wait-Proxy)
  Enable-SystemProxy
  Write-Host ('bez: ' + $mode + ' config updated')
}
function Off-Bez {
  Test-Windows
  Remove-Autostart
  Stop-Daemon
  Stop-XrayProcess
  Restore-SystemProxy
  Write-Host 'bez: off; previous Windows proxy settings restored'
}
function Status-Bez {
  Test-Windows
  $running = [bool](Get-CimInstance -ClassName Win32_Process -Filter "Name = 'xray.exe'" -ErrorAction SilentlyContinue |
    Where-Object { $_.ExecutablePath -and $_.ExecutablePath.StartsWith($BinDir, [StringComparison]::OrdinalIgnoreCase) })
  if ($running) { Write-Host 'bez: running' } else { Write-Host 'bez: off' }
  Write-Host ('mode: ' + (Get-Mode))
  Write-Host ('xray: ' + $XrayBin)
  Write-Host 'socks: 127.0.0.1:10808'
  Write-Host 'http: 127.0.0.1:10809'
  Write-Host ('web: http://127.0.0.1:' + $WebPort + '/' + $(if (Test-LocalPort $WebPort) { ' (running)' } else { '' }))
  Write-Host ('system proxy state: ' + $(if (Test-Path $ProxyStatePath) { 'managed' } else { 'not-managed' }))
  Write-Host 'note: rootless mode uses the Windows user proxy; apps that ignore it need app-specific setup'
}
function Logs-Bez {
  $found = $false
  foreach ($file in @($LogPath, $ErrLogPath, $WebLogPath)) {
    if (Test-Path $file) {
      $found = $true
      Write-Host ('--- ' + $file)
      Get-Content -Path $file -Tail 100
    }
  }
  if (-not $found) { Write-Host 'bez: no log yet' }
}
function Proxy-Bez {
  Write-Host '$env:HTTP_PROXY=''http://127.0.0.1:10809'''
  Write-Host '$env:HTTPS_PROXY=''http://127.0.0.1:10809'''
  Write-Host '$env:ALL_PROXY=''socks5h://127.0.0.1:10808'''
}
function Unproxy-Bez {
  Write-Host 'Remove-Item Env:HTTP_PROXY, Env:HTTPS_PROXY, Env:ALL_PROXY -ErrorAction SilentlyContinue'
}

function Send-BezResponse($Stream, [int]$Code, [string]$ContentType, [byte[]]$Body) {
  $statusText = switch ($Code) {
    200 { 'OK' }
    400 { 'Bad Request' }
    403 { 'Forbidden' }
    404 { 'Not Found' }
    405 { 'Method Not Allowed' }
    default { 'OK' }
  }
  $head = 'HTTP/1.1 ' + $Code + ' ' + $statusText + [char]13 + [char]10 +
    'Content-Type: ' + $ContentType + [char]13 + [char]10 +
    'Content-Length: ' + $Body.Length + [char]13 + [char]10 +
    'Cache-Control: no-store' + [char]13 + [char]10 +
    'Connection: close' + [char]13 + [char]10 + [char]13 + [char]10
  $headBytes = [Text.Encoding]::ASCII.GetBytes($head)
  $Stream.Write($headBytes, 0, $headBytes.Length)
  if ($Body.Length -gt 0) { $Stream.Write($Body, 0, $Body.Length) }
  $Stream.Flush()
}
function Send-BezJson($Stream, [int]$Code, $Object) {
  $json = $Object | ConvertTo-Json -Compress
  $bytes = [Text.Encoding]::UTF8.GetBytes($json)
  Send-BezResponse $Stream $Code 'application/json; charset=utf-8' $bytes
}
function Read-BezRequest($Stream) {
  $crlf2 = [String]::Concat([char]13, [char]10, [char]13, [char]10)
  $buffer = New-Object Byte[] 4096
  $bytes = New-Object System.Collections.Generic.List[byte]
  $headerText = $null
  while ($null -eq $headerText) {
    $read = $Stream.Read($buffer, 0, $buffer.Length)
    if ($read -le 0) { return $null }
    for ($i = 0; $i -lt $read; $i++) { $bytes.Add($buffer[$i]) }
    $text = [Text.Encoding]::ASCII.GetString($bytes.ToArray())
    $at = $text.IndexOf($crlf2)
    if ($at -ge 0) { $headerText = $text.Substring(0, $at); $bodyOffset = $at + 4 }
  }
  $lines = $headerText -split ([String]::Concat([char]13, [char]10))
  $parts = $lines[0] -split ' '
  $headers = @{}
  for ($i = 1; $i -lt $lines.Count; $i++) {
    $colon = $lines[$i].IndexOf(':')
    if ($colon -gt 0) { $headers[$lines[$i].Substring(0, $colon).Trim().ToLower()] = $lines[$i].Substring($colon + 1).Trim() }
  }
  $body = ''
  $length = 0
  if ($headers.ContainsKey('content-length')) { [void][int]::TryParse($headers['content-length'], [ref]$length) }
  if ($length -gt 0) {
    while ($bytes.Count -lt ($bodyOffset + $length)) {
      $read = $Stream.Read($buffer, 0, $buffer.Length)
      if ($read -le 0) { break }
      for ($i = 0; $i -lt $read; $i++) { $bytes.Add($buffer[$i]) }
    }
    $bodyBytes = $bytes.GetRange($bodyOffset, [Math]::Min($length, $bytes.Count - $bodyOffset)).ToArray()
    $body = [Text.Encoding]::UTF8.GetString($bodyBytes)
  }
  $path = $parts[1]
  $question = $path.IndexOf('?')
  if ($question -ge 0) { $path = $path.Substring(0, $question) }
  return @{ method = $parts[0]; path = $path; headers = $headers; body = $body }
}
function Invoke-BezCli([string[]]$BezArgs) {
  $output = & powershell.exe -NoProfile -ExecutionPolicy Bypass -File $PSCommandPath @BezArgs 2>&1
  return @{ code = $LASTEXITCODE; output = ([string]($output -join [char]10)) }
}
function Get-DashboardHtml {
  $html = [Text.Encoding]::UTF8.GetString([Convert]::FromBase64String($DashboardHtmlB64))
  return $html.Replace('__BEZ_CSRF__', $script:WebCsrf)
}
function Get-PacText {
  return 'function FindProxyForURL(url, host) {' + [char]10 +
    '  if (isPlainHostName(host) || shExpMatch(host, "localhost") || shExpMatch(host, "127.*")) { return "DIRECT"; }' + [char]10 +
    '  return "PROXY 127.0.0.1:10809";' + [char]10 +
    '}' + [char]10
}
function Invoke-TelegramCheck {
  $code = 0
  try {
    $response = Invoke-WebRequest -UseBasicParsing -Proxy 'http://127.0.0.1:10809' -Uri 'https://t.me/' -TimeoutSec 20
    $code = [int]$response.StatusCode
  } catch {
    if ($_.Exception.Response) { $code = [int]$_.Exception.Response.StatusCode } else { $code = 0 }
  }
  $ok = ($code -ge 200 -and $code -lt 400) -or $code -eq 401 -or $code -eq 403
  return @{ ok = $ok; code = $code }
}
function Set-BezHosts([string]$Target) {
  if ($Target -notin @('vpn2', 'vusa', 'off')) { throw 'invalid hosts target' }
  $ip = if ($Target -eq 'vpn2') { '212.192.31.128' } elseif ($Target -eq 'vusa') { '185.240.120.152' } else { '' }
  $domains = @('openai.com','www.openai.com','chatgpt.com','www.chatgpt.com','api.openai.com','auth.openai.com','platform.openai.com','claude.ai','www.claude.ai','claude.com','anthropic.com','www.anthropic.com','console.anthropic.com','api.anthropic.com')
  $job = Join-Path $env:TEMP ('bez-hosts-' + [Guid]::NewGuid().ToString('N') + '.ps1')
  $result = Join-Path $env:TEMP ('bez-hosts-' + [Guid]::NewGuid().ToString('N') + '.txt')
  $script = '$hosts="$env:SystemRoot\System32\drivers\etc\hosts"' + [Environment]::NewLine +
    '$begin="# >>> bez xray sni hosts >>>"; $end="# <<< bez xray sni hosts <<<"' + [Environment]::NewLine +
    '$content=Get-Content -LiteralPath $hosts -ErrorAction Stop; $out=@(); $inside=$false; foreach($line in $content){ if($line -eq $begin){$inside=$true;continue}; if($line -eq $end){$inside=$false;continue}; if(-not $inside){$out+=$line} }' + [Environment]::NewLine +
    (if ($Target -eq 'off') { '' } else { '$out+=$begin; $out+="# Bez Xray SNI edge: ' + $Target + '"; ' + (($domains | ForEach-Object { '$out+="' + $ip + ' ' + $_ + '"' }) -join '; ') + '; $out+=$end' }) + [Environment]::NewLine +
    'Set-Content -LiteralPath $hosts -Value $out -Encoding ASCII; ipconfig /flushdns | Out-Null; Set-Content -LiteralPath "' + $result.Replace('\','\\') + '" -Value "hosts ' + $Target + ' applied" -Encoding ASCII'
  Set-Content -LiteralPath $job -Value $script -Encoding UTF8
  try {
    $process = Start-Process -FilePath 'powershell.exe' -Verb RunAs -Wait -PassThru -ArgumentList @('-NoProfile','-ExecutionPolicy','Bypass','-File',$job)
    if ($process.ExitCode -ne 0) { throw 'UAC hosts command failed or was cancelled' }
    return (Get-Content -LiteralPath $result -Raw -ErrorAction SilentlyContinue).Trim()
  } finally { Remove-Item -LiteralPath $job,$result -Force -ErrorAction SilentlyContinue }
}
function Get-BezHostsPreview {
  $begin = '# >>> bez xray sni hosts >>>'; $end = '# <<< bez xray sni hosts <<<'
  $current = @(); $inside = $false
  try { foreach ($line in (Get-Content -LiteralPath "$env:SystemRoot\System32\drivers\etc\hosts" -ErrorAction Stop)) { if ($line -eq $begin) { $inside = $true }; if ($inside) { $current += $line }; if ($line -eq $end) { $inside = $false } } } catch { throw ('cannot read hosts: ' + $_.Exception.Message) }
  $domains = @('openai.com','www.openai.com','chatgpt.com','www.chatgpt.com','api.openai.com','auth.openai.com','platform.openai.com','claude.ai','www.claude.ai','claude.com','anthropic.com','www.anthropic.com','console.anthropic.com','api.anthropic.com')
  $render = { param($target, $ip) (@($begin, ('# OpenAI/Claude via ' + $target + ' Xray SNI edge')) + @($domains | ForEach-Object { $ip + ' ' + $_ }) + @($end)) -join [Environment]::NewLine }
  return @{ current = ($current -join [Environment]::NewLine); vpn2 = (& $render 'vpn2' '212.192.31.128'); vusa = (& $render 'vusa' '185.240.120.152') }
}
function Handle-BezClient($Client) {
  $Client.ReceiveTimeout = 120000
  $stream = $Client.GetStream()
  $request = Read-BezRequest $stream
  if ($null -eq $request) { return }
  $method = [string]$request.method
  $path = [string]$request.path
  if ($path -eq '/') {
    if ($method -ne 'GET') { Send-BezJson $stream 405 @{ error = 'method not allowed' }; return }
    $html = Get-DashboardHtml
    Send-BezResponse $stream 200 'text/html; charset=utf-8' ([Text.Encoding]::UTF8.GetBytes($html))
    return
  }
  if ($path -eq '/proxy.pac') {
    Send-BezResponse $stream 200 'application/x-ns-proxy-autoconfig' ([Text.Encoding]::ASCII.GetBytes((Get-PacText)))
    return
  }
  if ($path -eq '/api/status') {
    if ($method -ne 'GET') { Send-BezJson $stream 405 @{ error = 'method not allowed' }; return }
    $payload = [ordered]@{
      running = ((Test-LocalPort 10808) -and (Test-LocalPort 10809))
      profile = Get-Mode
      proxy = @{ http = '127.0.0.1:10809'; socks = '127.0.0.1:10808' }
      proxyManaged = (Test-Path $ProxyStatePath)
    }
    Send-BezJson $stream 200 $payload
    return
  }
  if ($path -eq '/api/hosts-preview') {
    if ($method -ne 'GET') { Send-BezJson $stream 405 @{ error = 'method not allowed' }; return }
    try { Send-BezJson $stream 200 (Get-BezHostsPreview) } catch { Send-BezJson $stream 400 @{ error = $_.Exception.Message } }
    return
  }
  if ($path -eq '/api/profile' -or $path -eq '/api/off' -or $path -eq '/api/update' -or $path -eq '/api/check' -or $path -eq '/api/hosts') {
    if ($method -ne 'POST') { Send-BezJson $stream 405 @{ error = 'method not allowed' }; return }
    $token = [string]$request.headers['x-bez-csrf']
    if ($token -ne $script:WebCsrf) { Send-BezJson $stream 403 @{ error = 'csrf' }; return }
    if ($path -eq '/api/check') {
      Send-BezJson $stream 200 (Invoke-TelegramCheck)
      return
    }
    if ($path -eq '/api/hosts') {
      try { $parsed = $request.body | ConvertFrom-Json; $detail = Set-BezHosts ([string]$parsed.target); Send-BezJson $stream 200 @{ ok = $true; detail = $detail } }
      catch { Send-BezJson $stream 400 @{ error = $_.Exception.Message } }
      return
    }
    if ($path -eq '/api/profile') {
      $parsed = $null
      try { $parsed = $request.body | ConvertFrom-Json } catch {}
      $profile = if ($parsed) { [string]$parsed.profile } else { '' }
      if ($profile -ne 'smart' -and $profile -ne 'all') { Send-BezJson $stream 400 @{ error = 'profile must be smart or all' }; return }
      $result = Invoke-BezCli @($profile)
      Send-BezJson $stream 200 @{ ok = ($result.code -eq 0); detail = $result.output }
      return
    }
    if ($path -eq '/api/off') {
      $result = Invoke-BezCli @('off')
      Send-BezJson $stream 200 @{ ok = ($result.code -eq 0); detail = $result.output }
      return
    }
    $result = Invoke-BezCli @('update')
    Send-BezJson $stream 200 @{ ok = ($result.code -eq 0); detail = $result.output }
    return
  }
  Send-BezJson $stream 404 @{ error = 'not found' }
}
function Start-WebServe {
  $script:WebCsrf = [Guid]::NewGuid().ToString('N')
  $listener = New-Object Net.Sockets.TcpListener([Net.IPAddress]::Loopback, $WebPort)
  $listener.Start()
  Write-Host ('bez web: listening on http://127.0.0.1:' + $WebPort + '/')
  while ($true) {
    $client = $listener.AcceptTcpClient()
    try { Handle-BezClient $client } catch { Write-Host ('bez web: ' + $_.Exception.Message) } finally { $client.Close() }
  }
}
function Web-Bez {
  if (-not (Test-Installed)) { Die 'run bez install first' }
  $trayCmd = 'powershell.exe -NoProfile -ExecutionPolicy Bypass -STA -WindowStyle Hidden -File "' + $PSCommandPath + '" tray-serve'
  New-ItemProperty -Path $RunKey -Name $TrayRunKeyName -Value $trayCmd -PropertyType String -Force | Out-Null
  if (-not (Test-LocalPort $WebPort)) {
    Start-Process -FilePath 'powershell.exe' -ArgumentList @('-NoProfile', '-ExecutionPolicy', 'Bypass', '-WindowStyle', 'Hidden', '-File', $PSCommandPath, 'web-serve') -WindowStyle Hidden
    $ready = $false
    for ($i = 0; $i -lt 40; $i++) {
      if (Test-LocalPort $WebPort) { $ready = $true; break }
      Start-Sleep -Milliseconds 250
    }
    if (-not $ready) { Die 'web dashboard did not start; run bez logs' }
  }
  Start-Process ('http://127.0.0.1:' + $WebPort + '/')
  Write-Host ('bez: local dashboard opened at http://127.0.0.1:' + $WebPort + '/')
}
function Start-BezTray {
  Add-Type -AssemblyName System.Windows.Forms
  Add-Type -AssemblyName System.Drawing
  if (-not (Test-LocalPort $WebPort)) { Start-Process -FilePath 'powershell.exe' -ArgumentList @('-NoProfile','-ExecutionPolicy','Bypass','-WindowStyle','Hidden','-File',$PSCommandPath,'web-serve') -WindowStyle Hidden }
  $icon = New-Object System.Windows.Forms.NotifyIcon
  $icon.Icon = [System.Drawing.SystemIcons]::Shield
  $icon.Visible = $true
  $menu = New-Object System.Windows.Forms.ContextMenuStrip
  $open = $menu.Items.Add('Open Bez'); $open.add_Click({ Start-Process ('http://127.0.0.1:' + $WebPort + '/') })
  $smart = $menu.Items.Add('Enable Smart'); $smart.add_Click({ Start-Process -FilePath 'powershell.exe' -ArgumentList @('-NoProfile','-ExecutionPolicy','Bypass','-WindowStyle','Hidden','-File',$PSCommandPath,'smart') -WindowStyle Hidden })
  $full = $menu.Items.Add('Enable Full'); $full.add_Click({ Start-Process -FilePath 'powershell.exe' -ArgumentList @('-NoProfile','-ExecutionPolicy','Bypass','-WindowStyle','Hidden','-File',$PSCommandPath,'all') -WindowStyle Hidden })
  $off = $menu.Items.Add('Turn off'); $off.add_Click({ Start-Process -FilePath 'powershell.exe' -ArgumentList @('-NoProfile','-ExecutionPolicy','Bypass','-WindowStyle','Hidden','-File',$PSCommandPath,'off') -WindowStyle Hidden })
  [void]$menu.Items.Add('-')
  $quit = $menu.Items.Add('Quit'); $quit.add_Click({ $icon.Visible = $false; [System.Windows.Forms.Application]::Exit() })
  $icon.ContextMenuStrip = $menu
  $timer = New-Object System.Windows.Forms.Timer; $timer.Interval = 5000
  $timer.add_Tick({ $running = (Test-LocalPort 10808) -and (Test-LocalPort 10809); $icon.Text = if ($running) { 'Bez: VPN enabled' } else { 'Bez: off' } })
  $timer.Start(); [System.Windows.Forms.Application]::Run()
}

if (-not $PSScriptRoot) { Install-Cli; exit 0 }
Test-Windows
$Command = 'help'
if ($args.Count -gt 0) { $Command = [string]$args[0] }
switch ($Command) {
  'install' { Install-Bez }
  'smart' { Activate-Bez 'smart' }
  'all' { Activate-Bez 'all' }
  'update' { Update-Bez }
  'web' { Web-Bez }
  'web-serve' { Start-WebServe }
  'tray-serve' { Start-BezTray }
  'off' { Off-Bez }
  'status' { Status-Bez }
  'logs' { Logs-Bez }
  'proxy' { Proxy-Bez }
  'unproxy' { Unproxy-Bez }
  default { Write-Host 'usage: bez install|smart|all|web|update|off|status|logs|proxy|unproxy' }
}
`;
  const baseUrl = publicBaseUrl.replace(/\/+$/, "").replace(/['\r\n]/g, "");
  const configToken = MACOS_CONFIG_TOKEN.replace(/['\r\n]/g, "");
  const dashboardB64 = Buffer.from(DASHBOARD_HTML, "utf8").toString("base64");
  return script
    .replace(`$BaseUrl = '__BEZ_BASE_URL__'`, `$BaseUrl = '${baseUrl}'`)
    .replace(`$ConfigToken = '__BEZ_CONFIG_TOKEN__'`, `$ConfigToken = '${configToken}'`)
    .replace(`$DashboardHtmlB64 = '__BEZ_HTML_B64__'`, `$DashboardHtmlB64 = '${dashboardB64}'`) + "\n";
}

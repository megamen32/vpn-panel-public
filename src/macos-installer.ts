import { MACOS_CONFIG_TOKEN } from "./macos-token.js";

/** Domains the vpn2 SNI edge proxies for RF-blocked AI services. */
const SNI_EDGE_DOMAINS = [
  "openai.com",
  "www.openai.com",
  "chatgpt.com",
  "www.chatgpt.com",
  "api.openai.com",
  "auth.openai.com",
  "platform.openai.com",
  "status.openai.com",
  "help.openai.com",
  "claude.ai",
  "www.claude.ai",
  "claude.com",
  "anthropic.com",
  "www.anthropic.com",
  "console.anthropic.com",
  "platform.claude.com",
  "api.anthropic.com",
  "statsig.anthropic.com",
  "s-cdn.anthropic.com",
  "status.anthropic.com",
] as const;

const HOSTS_BLOCK_BEGIN = "# >>> bez vpn2 sni hosts >>>";
const HOSTS_BLOCK_END = "# <<< bez vpn2 sni hosts <<<";

export function macHostsScript(vpn2Ip = "212.192.31.128", vusaIp = "185.240.120.152"): string {
  return `#!/bin/bash
set -euo pipefail

# Manages /etc/hosts entries that route OpenAI/Claude traffic through the
# vpn2 SNI edge (smart-edge). Idempotent; supports --remove.
if [[ "$(uname -s)" != Darwin ]]; then echo "macOS only" >&2; exit 1; fi
[[ \${EUID:-$(id -u)} -eq 0 ]] || { echo "run with sudo" >&2; exit 1; }

VPN2_IP="${vpn2Ip}"
VUSA_IP="${vusaIp}"
BEGIN="${HOSTS_BLOCK_BEGIN}"
END="${HOSTS_BLOCK_END}"
MANAGED_DOMAINS="${SNI_EDGE_DOMAINS.join(" ")}"

flush_dns() { dscacheutil -flushcache; killall -HUP mDNSResponder 2>/dev/null || true; }

remove_block() {
  awk -v begin="$BEGIN" -v end="$END" '
    $0 == begin { in_block = 1 }
    !in_block { print }
    $0 == end { in_block = 0 }
  ' /etc/hosts
}

# Drop single managed lines outside the block (legacy hand-added entries).
drop_managed_lines() {
  local domains_regex
  domains_regex="^\${VPN2_IP}[[:space:]]+(\$(echo "\$MANAGED_DOMAINS" | tr " " "|"))[[:space:]]*$"
  grep -Ev "$domains_regex" || true
}

TARGET="\${1:-vpn2}"
if [[ "$TARGET" == "--remove" || "$TARGET" == "off" ]]; then
  { remove_block | drop_managed_lines; } > /etc/hosts.bez-new
  cat /etc/hosts.bez-new > /etc/hosts && rm -f /etc/hosts.bez-new
  flush_dns
  echo "bez-hosts: removed vpn2 SNI entries for OpenAI/Claude"
  exit 0
fi
case "$TARGET" in vpn2) EDGE_IP="$VPN2_IP";; vusa) EDGE_IP="$VUSA_IP";; *) echo "usage: bez-hosts [vpn2|vusa|off]" >&2; exit 2;; esac

cp /etc/hosts "/etc/hosts.bak.bez-$(date +%Y%m%d%H%M%S)"
ls -t /etc/hosts.bak.bez-* 2>/dev/null | tail -n +6 | xargs rm -f 2>/dev/null || true

{
  remove_block | drop_managed_lines
  echo "$BEGIN"
  echo "# OpenAI/Claude via $TARGET Xray SNI edge"
  ${SNI_EDGE_DOMAINS.map((domain) => `echo "$EDGE_IP\\t${domain}"`).join("\n  ")}
  echo "$END"
} > /etc/hosts.bez-new

cat /etc/hosts.bez-new > /etc/hosts && rm -f /etc/hosts.bez-new
chmod 644 /etc/hosts
flush_dns

resolved="$(dscacheutil -q host -a name chatgpt.com | awk '/ip_address/ { print $2; exit }')"
if [[ "$resolved" == "$EDGE_IP" ]]; then
  echo "bez-hosts: chatgpt.com -> $EDGE_IP OK (OpenAI/Claude now exit via $TARGET)"
else
  echo "bez-hosts: warning: chatgpt.com resolved to '$resolved' (DNS cache may lag)" >&2
fi
`;
}

export function macosBezWebUiPython(baseUrl: string, configToken: string): string {
  const python = String.raw`#!/usr/bin/env python3
import argparse
import copy
import json
import os
import re
import secrets
import socket
import statistics
import subprocess
import tempfile
import threading
import time
from concurrent.futures import ThreadPoolExecutor, as_completed
from datetime import datetime, timezone
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from urllib.parse import urlparse
from urllib.request import urlopen

APP_DIR = Path.home() / "Library/Application Support/BezVPN"
CLI_PATH = Path.home() / ".local/bin/bez"
CONFIG_PATH = APP_DIR / "config.json"
BASE_CONFIG_PATH = APP_DIR / "config-base.json"
STATE_PATH = APP_DIR / "state"
PROXY_STATE = APP_DIR / "proxy-state"
PORT_STATE = APP_DIR / "ports"
ENDPOINT_STATE = APP_DIR / "endpoint"
DIAGNOSTICS_PATH = APP_DIR / "endpoint-diagnostics.json"
TELEMETRY_PATH = APP_DIR / "telemetry"
CUSTOM_POLICY_PATH = APP_DIR / "custom-policy.json"
AUTO_HEAL_SETTINGS_PATH = APP_DIR / "auto-heal.json"
AUTO_HEAL_STATE_PATH = APP_DIR / "auto-heal-state.json"
AUTO_HEAL_LOG_PATH = APP_DIR / "auto-heal.log"
XRAY_BIN = APP_DIR / "bin/xray"
XRAY_LABEL = "com.bezrabotnyi.bez"
XRAY_API_PORT = 28111
CSRF_TOKEN = secrets.token_urlsafe(32)
COMMAND_LOCK = threading.Lock()
DIAGNOSTICS_LOCK = threading.Lock()
DIAGNOSTICS_STATE = {"running": False, "startedAt": None, "finishedAt": None, "results": []}
AUTO_HEAL_LOCK = threading.RLock()
AUTO_HEAL_RUN_LOCK = threading.Lock()
AUTO_HEAL_INTERVAL = 300
AUTO_HEAL_LATENCY_LIMIT_MS = 500
AUTO_HEAL_IMPROVEMENT_MS = 75
AUTO_HEAL_COOLDOWN = 300
AUTO_HEAL_SAMPLE_URLS = ("https://t.me/", "https://web.telegram.org/", "https://discord.com/")
XRAY_LOG_PATH = Path.home() / "Library/Logs/BezVPN.log"
AUTO_HEAL_STATE = {"status": "idle", "consecutiveFailures": 0, "lastCheck": None, "detail": None, "lastSwitch": None, "lastAttemptEpoch": 0, "healing": False}
BASE_URL = __BEZ_BASE_URL__
CONFIG_TOKEN = __BEZ_CONFIG_TOKEN__
PROXY_MODE_PATH = APP_DIR / "proxy-mode"
VPN_CONFIG_PATH = APP_DIR / "vpn-tun.json"
VPN_DAEMON_PLIST = "/Library/LaunchDaemons/com.bezrabotnyi.bez-vpn.plist"
VPN_DAEMON_LABEL = "com.bezrabotnyi.bez-vpn"
SERVER_POLICY_LOCK = threading.Lock()
SERVER_POLICY_CACHE = {"policy": None, "fetchedAt": None, "error": None}

PAGE = r'''<!doctype html>
<html lang="ru">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>Bez VPN</title>
  <style>
    :root { color-scheme: light; font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif; background: #f4f5f7; color: #17191c; }
    * { box-sizing: border-box; }
    body { margin: 0; min-width: 320px; }
    button, select, textarea, input { font: inherit; letter-spacing: 0; }
    button { cursor: pointer; }
    .shell { min-height: 100vh; display: grid; grid-template-columns: 190px minmax(0, 1fr); }
    aside { background: #17191c; color: #fff; padding: 24px 18px; position: sticky; top: 0; height: 100vh; }
    .brand { font-size: 24px; font-weight: 750; letter-spacing: 0; }
    .local { color: #aeb4bc; font-size: 12px; margin-top: 3px; }
    nav { display: grid; gap: 4px; margin-top: 34px; }
    nav a { color: #d8dce1; text-decoration: none; padding: 9px 10px; border-radius: 6px; }
    nav a:hover { background: #2a2d32; color: #fff; }
    main { min-width: 0; }
    header { min-height: 84px; padding: 20px clamp(20px, 4vw, 48px); background: #fff; border-bottom: 1px solid #dfe2e6; display: flex; align-items: center; justify-content: space-between; gap: 16px; }
    h1, h2 { margin: 0; letter-spacing: 0; }
    h1 { font-size: 25px; }
    h2 { font-size: 18px; }
    .header-actions { display: flex; gap: 8px; }
    .icon-button { width: 38px; height: 38px; border: 1px solid #c8cdd3; border-radius: 6px; background: #fff; font-size: 20px; }
    .danger { border: 1px solid #d7a2a2; color: #9b2020; background: #fff; border-radius: 6px; padding: 8px 13px; }
    section { padding: 30px clamp(20px, 4vw, 48px); border-bottom: 1px solid #dfe2e6; background: #fff; }
    section:nth-of-type(even) { background: #f8f9fa; }
    .status-line { display: flex; align-items: center; gap: 10px; margin-top: 18px; font-weight: 650; }
    .dot { width: 11px; height: 11px; border-radius: 50%; background: #aeb4bc; flex: 0 0 auto; }
    .dot.running { background: #159447; box-shadow: 0 0 0 4px #dff3e7; }
    .facts { display: grid; grid-template-columns: repeat(4, minmax(120px, 1fr)); border-top: 1px solid #dfe2e6; margin-top: 22px; }
    .fact { padding: 16px 16px 16px 0; min-width: 0; }
    .fact + .fact { padding-left: 16px; border-left: 1px solid #dfe2e6; }
    .label { display: block; color: #626a73; font-size: 12px; margin-bottom: 5px; }
    .value { display: block; font-weight: 650; overflow-wrap: anywhere; }
    .matrix { display: grid; grid-template-columns: minmax(88px, 0.7fr) repeat(2, minmax(130px, 1fr)); max-width: 650px; margin-top: 20px; border: 1px solid #cfd4da; border-radius: 6px; overflow: hidden; }
    .matrix > * { min-height: 48px; display: flex; align-items: center; justify-content: center; border: 0; border-right: 1px solid #cfd4da; border-bottom: 1px solid #cfd4da; }
    .matrix > *:nth-child(3n) { border-right: 0; }
    .matrix > *:nth-last-child(-n + 3) { border-bottom: 0; }
    .matrix .head { background: #eef0f2; color: #4d545c; font-size: 12px; font-weight: 700; }
    .matrix .row-label { justify-content: flex-start; padding-left: 14px; font-weight: 700; background: #fff; }
    .profile-button { background: #fff; color: #1c2024; }
    .profile-button:hover { background: #eef6ff; }
    .profile-button.active { background: #1769aa; color: #fff; }
    .endpoint-control { display: grid; grid-template-columns: minmax(180px, 430px) auto auto; gap: 8px; align-items: center; margin-top: 20px; }
    select { width: 100%; min-height: 42px; border: 1px solid #bfc5cc; border-radius: 6px; background: #fff; padding: 8px 34px 8px 10px; }
    .primary, .secondary { min-height: 42px; border-radius: 6px; padding: 8px 14px; font-weight: 650; }
    .primary { border: 1px solid #1769aa; color: #fff; background: #1769aa; }
    .secondary { border: 1px solid #bfc5cc; color: #25292e; background: #fff; }
    .primary:disabled, .secondary:disabled, .profile-button:disabled { opacity: .55; cursor: wait; }
    .candidate-list { display: flex; flex-wrap: wrap; gap: 7px; margin-top: 18px; }
    .candidate { border: 1px solid #cfd4da; background: #fff; border-radius: 6px; padding: 6px 9px; font-size: 12px; color: #454b52; }
    .candidate.current { border-color: #159447; color: #0d7335; background: #eaf7ef; }
    .heal-bar { display: flex; align-items: center; gap: 12px; flex-wrap: wrap; margin-top: 18px; padding-top: 16px; border-top: 1px solid #dfe2e6; }
    .toggle-label { display: inline-flex; align-items: center; gap: 8px; font-weight: 700; }
    .toggle-label input { width: 18px; height: 18px; accent-color: #1769aa; }
    .heal-state { color: #4f5862; font-size: 13px; flex: 1 1 260px; }
    .section-bar { display: flex; align-items: center; justify-content: space-between; gap: 12px; }
    .table-wrap { overflow-x: auto; margin-top: 18px; border: 1px solid #cfd4da; border-radius: 6px; background: #fff; }
    table { width: 100%; border-collapse: collapse; min-width: 640px; }
    th, td { padding: 11px 12px; border-bottom: 1px solid #e2e5e9; text-align: left; white-space: nowrap; }
    th { color: #626a73; font-size: 12px; background: #f3f5f6; }
    tbody tr:last-child td { border-bottom: 0; }
    .health { display: inline-flex; align-items: center; gap: 7px; }
    .health .dot { width: 8px; height: 8px; }
    .health.ok .dot { background: #159447; }
    .health.failed .dot { background: #b52b2b; }
    .smart-grid { display: grid; grid-template-columns: repeat(3, minmax(0, 1fr)); gap: 16px 20px; margin-top: 20px; max-width: 1120px; }
    .hint { color: #5b636c; font-size: 13px; margin: 12px 0 0; max-width: 860px; }
    .server-groups { display: grid; gap: 14px; margin-top: 16px; max-width: 960px; }
    .server-group h3 { font-size: 13px; margin: 0 0 8px; color: #3d434b; }
    .server-group .chips { display: flex; flex-wrap: wrap; gap: 6px; }
    .mode-button { min-height: 38px; padding: 6px 12px; border: 1px solid #bfc5cc; border-radius: 6px; background: #fff; font-weight: 650; }
    .field { min-width: 0; }
    .field label { display: block; font-size: 13px; font-weight: 700; margin-bottom: 7px; }
    textarea { width: 100%; min-height: 116px; resize: vertical; border: 1px solid #bfc5cc; border-radius: 6px; background: #fff; padding: 10px; line-height: 1.45; }
    .smart-actions, .pac-row { display: flex; align-items: center; gap: 8px; margin-top: 16px; flex-wrap: wrap; }
    .pac-row input { min-width: min(100%, 370px); min-height: 42px; border: 1px solid #bfc5cc; border-radius: 6px; background: #f7f8f9; padding: 8px 10px; }
    .notice { min-height: 22px; margin-top: 14px; color: #5c636b; font-size: 13px; }
    .notice.error { color: #a32626; }
    @media (max-width: 760px) {
      .shell { grid-template-columns: 1fr; }
      aside { position: static; height: auto; padding: 15px 18px; display: flex; align-items: center; justify-content: space-between; }
      nav { display: flex; margin: 0; gap: 2px; }
      nav a { padding: 7px; font-size: 13px; }
      .local { display: none; }
      .facts { grid-template-columns: repeat(2, 1fr); }
      .fact:nth-child(3) { border-left: 0; }
      .endpoint-control { grid-template-columns: 1fr 1fr; }
      .endpoint-control select { grid-column: 1 / -1; }
      .smart-grid { grid-template-columns: 1fr; }
    }
    @media (max-width: 470px) {
      nav { display: none; }
      header { align-items: flex-start; }
      .facts { grid-template-columns: 1fr; }
      .fact + .fact { border-left: 0; border-top: 1px solid #dfe2e6; padding-left: 0; }
      .matrix { grid-template-columns: 76px repeat(2, minmax(0, 1fr)); }
      .matrix .row-label { padding-left: 9px; }
    }
  </style>
</head>
<body>
<div class="shell">
  <aside>
    <div><div class="brand">BEZ</div><div class="local">Локальный Mac</div></div>
    <nav><a href="#status">Статус</a><a href="#profiles">Профиль</a><a href="#endpoints">Endpoint</a><a href="#diagnostics">Проверка</a><a href="#smart">Smart</a><a href="#hosts">Hosts</a><a href="#server">Сервер</a><a href="#vpn">VPN</a></nav>
  </aside>
  <main>
    <header>
      <h1>Bez VPN</h1>
      <div class="header-actions">
        <button class="icon-button" id="refresh" title="Обновить" aria-label="Обновить">↻</button>
        <button class="danger" id="off">Выключить</button>
      </div>
    </header>
    <section id="status">
      <h2>Состояние</h2>
      <div class="status-line"><span class="dot" id="status-dot"></span><span id="status-text">Загрузка…</span></div>
      <div class="facts">
        <div class="fact"><span class="label">Профиль</span><span class="value" id="fact-profile">—</span></div>
        <div class="fact"><span class="label">Область</span><span class="value" id="fact-scope">—</span></div>
        <div class="fact"><span class="label">Endpoint</span><span class="value" id="fact-endpoint">—</span></div>
        <div class="fact"><span class="label">Локальный proxy</span><span class="value" id="fact-proxy">—</span></div>
        <div class="fact"><span class="label">Системный proxy</span><span class="value" id="fact-proxy-mode">—</span></div>
        <div class="fact"><span class="label">VPN-туннель</span><span class="value" id="fact-vpn">—</span></div>
      </div>
    </section>
    <section id="profiles">
      <h2>Профиль и область</h2>
      <div class="matrix">
        <div class="head"></div><div class="head">Local</div><div class="head">Global</div>
        <div class="row-label">Smart</div><button class="profile-button" data-profile="smart" data-scope="local">Включить</button><button class="profile-button" data-profile="smart" data-scope="global">Включить</button>
        <div class="row-label">Full</div><button class="profile-button" data-profile="full" data-scope="local">Включить</button><button class="profile-button" data-profile="full" data-scope="global">Включить</button>
        <div class="row-label">Custom</div><button class="profile-button" data-profile="custom" data-scope="local">Включить</button><button class="profile-button" data-profile="custom" data-scope="global">Включить</button>
      </div>
      <div class="heal-bar">
        <span class="toggle-label">Системный proxy в режиме Global:</span>
        <button class="profile-button mode-button" id="proxy-mode-http">HTTP</button>
        <button class="profile-button mode-button" id="proxy-mode-socks">SOCKS</button>
        <span class="heal-state" id="proxy-mode-note">Меняет тип системного proxy macOS для области Global.</span>
      </div>
    </section>
    <section id="endpoints">
      <h2>Endpoint</h2>
      <div class="endpoint-control">
        <select id="endpoint-select" aria-label="Endpoint"></select>
        <button class="primary" id="endpoint-apply">Выбрать</button>
        <button class="secondary" id="endpoint-auto">Auto (leastPing)</button>
      </div>
      <div class="candidate-list" id="candidate-list"></div>
      <div class="heal-bar">
        <label class="toggle-label"><input type="checkbox" id="auto-heal-toggle">Фоновая проверка маршрутов</label>
        <span class="heal-state" id="auto-heal-status">Загрузка…</span>
        <button class="secondary" id="auto-heal-run">Проверить сейчас</button>
      </div>
      <div class="notice" id="notice" role="status"></div>
    </section>
    <section id="diagnostics">
      <div class="section-bar"><h2>Проверка endpoint</h2><button class="primary" id="diagnostics-run">Проверить все</button></div>
      <div class="table-wrap">
        <table id="diagnostics-table">
          <thead><tr><th>Endpoint</th><th>Состояние</th><th>Реальная задержка</th><th>Внешний IP</th><th>Скорость</th><th>Проверен</th></tr></thead>
          <tbody id="diagnostics-body"><tr><td colspan="6">Нет данных</td></tr></tbody>
        </table>
      </div>
      <div class="notice" id="diagnostics-notice" role="status"></div>
    </section>
    <section id="smart">
      <h2>Smart правила</h2>
      <p class="hint">По одному домену в строке. <code>example.com</code> включает домен и поддомены; <code>=example.com</code> — только точный домен. Приоритет: блокировать → напрямую → через VPN.</p>
      <div class="smart-grid">
        <div class="field"><label for="block-domains">Блокировать</label><textarea id="block-domains" spellcheck="false" placeholder="ads.example.com"></textarea></div>
        <div class="field"><label for="direct-domains">Напрямую</label><textarea id="direct-domains" spellcheck="false" placeholder="example.ru"></textarea></div>
        <div class="field"><label for="proxy-domains">Через VPN</label><textarea id="proxy-domains" spellcheck="false" placeholder="chatgpt.com"></textarea></div>
      </div>
      <div class="smart-actions">
        <button class="secondary" id="smart-save">Сохранить</button>
        <button class="primary" id="smart-apply">Сохранить и применить Custom</button>
      </div>
      <div class="pac-row"><input id="pac-url" readonly value="http://127.0.0.1:28110/proxy.pac"><button class="secondary" id="pac-copy">Копировать PAC URL</button></div>
      <div class="notice" id="smart-notice" role="status"></div>
    </section>
    <section id="hosts">
      <div class="section-bar"><h2>Hosts: Xray SNI edge</h2></div>
      <p class="hint">Закрепляет только AI-домены Bez за выбранным edge. macOS попросит системный пароль; «Выключить» удаляет только блок Bez.</p>
      <div class="smart-actions"><button class="secondary" id="hosts-vpn2">vpn2</button><button class="secondary" id="hosts-vusa">vusa</button><button class="secondary" id="hosts-preview">Предпросмотр</button><button class="danger" id="hosts-off">Выключить hosts</button></div>
      <div class="notice" id="hosts-notice" role="status"></div>
      <pre class="output" id="hosts-preview-output" hidden></pre>
    </section>
    <section id="server">
      <div class="section-bar"><h2>Smart на сервере</h2><button class="secondary" id="server-policy-refresh">Обновить</button></div>
      <p class="hint">Политика приходит с vpn.bezrabotnyi.com и задаёт, какие домены идут через VPN в режимах Smart и Full. Локально её менять нельзя — редактируйте в админке.</p>
      <div class="server-groups" id="server-policy-groups"><div class="hint">Загрузка…</div></div>
      <div class="notice" id="server-notice" role="status"></div>
    </section>
    <section id="vpn">
      <div class="section-bar"><h2>VPN-туннель (TUN)</h2><div class="header-actions"><button class="secondary" id="vpn-refresh">Обновить</button><button class="primary" id="vpn-on">Включить</button><button class="danger" id="vpn-off">Выключить</button></div></div>
      <p class="hint">Туннель заворачивает весь TCP/UDP Mac в локальный Xray — работает даже для приложений, которые игнорируют системный proxy. Использует utun и sing-box, без Apple-лицензии разработчика; при включении macOS запросит пароль администратора.</p>
      <div class="status-line"><span class="dot" id="vpn-dot"></span><span id="vpn-text">Загрузка…</span></div>
      <div class="notice" id="vpn-notice" role="status"></div>
    </section>
  </main>
</div>
<script>
const csrf = "__BEZ_CSRF__";
let current = null;
const profileNames = {smart: "Smart", all: "Full", custom: "Custom"};
const scopeNames = {local: "Local", global: "Global"};
function setBusy(value) {
  document.querySelectorAll("button, select").forEach(function (node) { node.disabled = value; });
}
function notice(message, error) {
  const node = document.getElementById("notice");
  node.textContent = message || "";
  node.classList.toggle("error", Boolean(error));
}
function sectionNotice(id, message, error) {
  const node = document.getElementById(id);
  node.textContent = message || "";
  node.classList.toggle("error", Boolean(error));
}
async function request(path, body) {
  const options = body === undefined ? {} : {method: "POST", headers: {"Content-Type": "application/json", "X-Bez-CSRF": csrf}, body: JSON.stringify(body)};
  const response = await fetch(path, options);
  const data = await response.json();
  if (!response.ok) throw new Error(data.error || "Команда не выполнена");
  return data;
}
function render(data) {
  current = data;
  const running = data.running;
  document.getElementById("status-dot").classList.toggle("running", running);
  document.getElementById("status-text").textContent = running ? "Xray запущен" : "Xray выключен";
  document.getElementById("fact-profile").textContent = profileNames[data.profile] || data.profile;
  document.getElementById("fact-scope").textContent = scopeNames[data.scope] || data.scope;
  const active = data.endpoint.mode === "auto" ? Object.values(data.endpoint.active || {}) : [];
  document.getElementById("fact-endpoint").textContent = data.endpoint.mode === "manual" ? data.endpoint.selected : (active.length ? active.join(" · ") : "Auto (leastPing)");
  document.getElementById("fact-proxy").textContent = "HTTP " + data.proxy.http + " · SOCKS " + data.proxy.socks;
  document.getElementById("fact-proxy-mode").textContent = data.proxyMode === "socks" ? "SOCKS" : "HTTP";
  const vpnRunning = Boolean(data.vpn && data.vpn.running);
  document.getElementById("fact-vpn").textContent = data.vpn && data.vpn.installed ? (vpnRunning ? "Включён (TUN)" : "Выключен") : "Не установлен";
  document.getElementById("proxy-mode-http").classList.toggle("active", data.proxyMode !== "socks");
  document.getElementById("proxy-mode-socks").classList.toggle("active", data.proxyMode === "socks");
  document.getElementById("vpn-dot").classList.toggle("running", vpnRunning);
  document.getElementById("vpn-text").textContent = data.vpn && data.vpn.installed ? (vpnRunning ? "Туннель поднят, весь трафик идёт через Xray" : "Туннель выключен") : "Компоненты туннеля не установлены";
  document.querySelectorAll(".profile-button").forEach(function (button) {
    button.classList.toggle("active", running && button.dataset.profile === (data.profile === "all" ? "full" : data.profile) && button.dataset.scope === data.scope);
    button.textContent = button.classList.contains("active") ? "Активен" : "Включить";
  });
  const select = document.getElementById("endpoint-select");
  select.replaceChildren();
  data.endpoint.candidates.forEach(function (tag) {
    const option = document.createElement("option");
    option.value = tag; option.textContent = tag;
    if (data.endpoint.mode === "manual" && data.endpoint.selected === tag) option.selected = true;
    select.appendChild(option);
  });
  const list = document.getElementById("candidate-list");
  list.replaceChildren();
  data.endpoint.candidates.forEach(function (tag) {
    const node = document.createElement("span");
    node.className = "candidate" + ((data.endpoint.mode === "manual" && data.endpoint.selected === tag) || active.includes(tag) ? " current" : "");
    node.textContent = tag; list.appendChild(node);
  });
}
function renderAutoHeal(data) {
  document.getElementById("auto-heal-toggle").checked = Boolean(data.enabled);
  const state = data.state || {};
  let message = data.enabled ? "Ленивый контроль включён" : "Контроль выключен";
  if (state.healing) message = "Ищу рабочий endpoint…";
  else if (state.status === "healthy") message = "Работает · " + (state.detail || "HTTP probe успешен");
  else if (state.status === "not-applicable") message = state.detail || "Проверочные URL не отличаются от прямого маршрута";
  else if (state.status === "switched" && state.lastSwitch) message = "Переключено: " + state.lastSwitch.from + " → " + state.lastSwitch.to;
  else if (state.status === "unavailable") message = "Рабочий endpoint не найден";
  else if (state.status === "error") message = state.detail || "Ошибка автолечения";
  document.getElementById("auto-heal-status").textContent = message;
  document.getElementById("auto-heal-run").disabled = Boolean(state.healing);
}
async function refreshAutoHeal() {
  try { renderAutoHeal(await request("/api/auto-heal")); }
  catch (error) { document.getElementById("auto-heal-status").textContent = error.message; }
}
async function refresh() {
  try { render(await request("/api/status")); }
  catch (error) { notice(error.message, true); }
}
function formatChecked(value) {
  if (!value) return "—";
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? value : date.toLocaleTimeString("ru-RU", {hour: "2-digit", minute: "2-digit", second: "2-digit"});
}
function renderDiagnostics(data) {
  const body = document.getElementById("diagnostics-body");
  body.replaceChildren();
  (data.results || []).forEach(function (item) {
    const row = document.createElement("tr");
    const state = item.ok ? "Работает" : (item.error || "Ошибка");
    [item.endpoint, state, item.latencyMs == null ? "—" : item.latencyMs + " ms", item.exitIp || "—", item.speedMbps == null ? "—" : item.speedMbps + " Mbit/s", formatChecked(item.checkedAt)].forEach(function (value, index) {
      const cell = document.createElement("td");
      if (index === 1) {
        const status = document.createElement("span"); status.className = "health " + (item.ok ? "ok" : "failed");
        const dot = document.createElement("span"); dot.className = "dot";
        const text = document.createElement("span"); text.textContent = value;
        status.append(dot, text); cell.appendChild(status);
      } else cell.textContent = value;
      row.appendChild(cell);
    });
    body.appendChild(row);
  });
  if (!(data.results || []).length) { const row = document.createElement("tr"); const cell = document.createElement("td"); cell.colSpan = 6; cell.textContent = data.running ? "Проверка запускается…" : "Нет данных"; row.appendChild(cell); body.appendChild(row); }
  document.getElementById("diagnostics-run").disabled = Boolean(data.running);
  sectionNotice("diagnostics-notice", data.running ? "Проверка выполняется…" : (data.finishedAt ? "Последняя проверка завершена" : ""), false);
}
async function refreshDiagnostics() {
  try { renderDiagnostics(await request("/api/diagnostics")); }
  catch (error) { sectionNotice("diagnostics-notice", error.message, true); }
}
function lines(id) { return document.getElementById(id).value.split(/\\r?\\n/).map(function (value) { return value.trim(); }).filter(Boolean); }
function policyPayload() { return {block: lines("block-domains"), direct: lines("direct-domains"), proxy: lines("proxy-domains")}; }
function renderPolicy(policy) {
  [["block-domains", "block"], ["direct-domains", "direct"], ["proxy-domains", "proxy"]].forEach(function (pair) { document.getElementById(pair[0]).value = (policy[pair[1]] || []).join("\n"); });
}
async function loadPolicy() {
  try { renderPolicy(await request("/api/policy")); }
  catch (error) { sectionNotice("smart-notice", error.message, true); }
}
async function savePolicy(apply) {
  setBusy(true); sectionNotice("smart-notice", apply ? "Применение правил…" : "Сохранение правил…", false);
  try {
    const data = await request("/api/policy", {policy: policyPayload(), apply: Boolean(apply), scope: current && current.scope === "local" ? "local" : "global"});
    renderPolicy(data.policy); if (data.status) render(data.status); sectionNotice("smart-notice", data.message, false);
  } catch (error) { sectionNotice("smart-notice", error.message, true); }
  finally { setBusy(false); }
}
async function mutate(path, body, pending) {
  setBusy(true); notice(pending, false);
  try { const data = await request(path, body); render(data.status); notice(data.message, false); }
  catch (error) { notice(error.message, true); }
  finally { setBusy(false); }
}
document.querySelectorAll(".profile-button").forEach(function (button) {
  button.addEventListener("click", function () { mutate("/api/profile", {profile: button.dataset.profile, scope: button.dataset.scope}, "Переключение профиля…"); });
});
document.getElementById("endpoint-apply").addEventListener("click", function () { mutate("/api/endpoint", {endpoint: document.getElementById("endpoint-select").value}, "Переключение endpoint…"); });
document.getElementById("endpoint-auto").addEventListener("click", function () { mutate("/api/endpoint", {endpoint: "auto"}, "Возврат к автоматическому выбору…"); });
document.getElementById("auto-heal-toggle").addEventListener("change", async function () {
  try { renderAutoHeal(await request("/api/auto-heal", {enabled: this.checked})); }
  catch (error) { this.checked = !this.checked; document.getElementById("auto-heal-status").textContent = error.message; }
});
document.getElementById("auto-heal-run").addEventListener("click", async function () {
  try { renderAutoHeal(await request("/api/auto-heal/run", {})); }
  catch (error) { document.getElementById("auto-heal-status").textContent = error.message; }
});
document.getElementById("diagnostics-run").addEventListener("click", async function () {
  try { renderDiagnostics(await request("/api/diagnostics/run", {})); } catch (error) { sectionNotice("diagnostics-notice", error.message, true); }
});
document.getElementById("smart-save").addEventListener("click", function () { savePolicy(false); });
document.getElementById("smart-apply").addEventListener("click", function () { savePolicy(true); });
function setHosts(target) { setBusy(true); sectionNotice("hosts-notice", "Применение hosts — подтвердите пароль macOS…", false); request("/api/hosts", {target: target}).then(function(data) { setBusy(false); sectionNotice("hosts-notice", data.message, false); }).catch(function(error) { setBusy(false); sectionNotice("hosts-notice", error.message, true); }); }
document.getElementById("hosts-vpn2").addEventListener("click", function () { setHosts("vpn2"); });
document.getElementById("hosts-vusa").addEventListener("click", function () { setHosts("vusa"); });
document.getElementById("hosts-preview").addEventListener("click", function () { request("/api/hosts-preview").then(function(data) { var output = document.getElementById("hosts-preview-output"); output.hidden = false; output.textContent = "Текущий блок Bez:\n" + (data.current || "(не установлен)") + "\n\nБудет записано для vpn2:\n" + data.vpn2 + "\n\nБудет записано для vusa:\n" + data.vusa; }).catch(function(error) { sectionNotice("hosts-notice", error.message, true); }); });
document.getElementById("hosts-off").addEventListener("click", function () { setHosts("off"); });
document.getElementById("pac-copy").addEventListener("click", async function () { try { await navigator.clipboard.writeText(document.getElementById("pac-url").value); sectionNotice("smart-notice", "PAC URL скопирован", false); } catch (error) { sectionNotice("smart-notice", "Не удалось скопировать PAC URL", true); } });
document.getElementById("off").addEventListener("click", function () { mutate("/api/off", {}, "Выключение Xray…"); });
document.getElementById("proxy-mode-http").addEventListener("click", function () { mutate("/api/proxy-mode", {mode: "http"}, "Переключение системного proxy на HTTP…"); });
document.getElementById("proxy-mode-socks").addEventListener("click", function () { mutate("/api/proxy-mode", {mode: "socks"}, "Переключение системного proxy на SOCKS…"); });
document.getElementById("server-policy-refresh").addEventListener("click", refreshServerPolicy);
const serverGroupTitles = [
  ["proxySuffixes", "Через VPN (DE-выход): домены и поддомены"],
  ["proxyDomains", "Через VPN (DE-выход): точные домены"],
  ["vusaProxySuffixes", "Через VPN (US-выход, vusa): домены и поддомены"],
  ["vusaProxyDomains", "Через VPN (US-выход, vusa): точные домены"],
  ["localProxySuffixes", "Через VPN в Smart/LAN (DPI-блокируемые): домены и поддомены"],
  ["localProxyDomains", "Через VPN в Smart/LAN (DPI-блокируемые): точные домены"],
  ["directSuffixes", "Напрямую (RU и локальные): домены и поддомены"],
  ["directDomains", "Напрямую (RU и локальные): точные домены"]
];
function renderServerPolicy(data) {
  const container = document.getElementById("server-policy-groups");
  const policy = data.policy;
  if (!policy) { container.replaceChildren(); sectionNotice("server-notice", data.error || "Политика недоступна", true); return; }
  container.replaceChildren();
  serverGroupTitles.forEach(function (pair) {
    const values = policy[pair[0]] || [];
    if (!values.length) return;
    const group = document.createElement("div"); group.className = "server-group";
    const title = document.createElement("h3"); title.textContent = pair[1] + " (" + values.length + ")";
    const chips = document.createElement("div"); chips.className = "chips";
    values.forEach(function (value) { const chip = document.createElement("span"); chip.className = "candidate"; chip.textContent = value; chips.appendChild(chip); });
    group.append(title, chips); container.appendChild(group);
  });
  sectionNotice("server-notice", data.fetchedAt ? "Получено с сервера: " + new Date(data.fetchedAt).toLocaleString("ru-RU") : "", false);
}
async function refreshServerPolicy() {
  document.getElementById("server-policy-groups").innerHTML = "<div class=\"hint\">Загрузка…</div>";
  try { renderServerPolicy(await request("/api/server-policy")); }
  catch (error) { sectionNotice("server-notice", error.message, true); }
}
async function vpnToggle(enabled) {
  setBusy(true); sectionNotice("vpn-notice", enabled ? "Включаю туннель — подтвердите пароль администратора в диалоге macOS…" : "Выключаю туннель…", false);
  try {
    const data = await request("/api/vpn", {enabled: enabled});
    if (data.status) render(data.status);
    sectionNotice("vpn-notice", data.message, false);
  } catch (error) { sectionNotice("vpn-notice", error.message, true); }
  finally { setBusy(false); }
}
document.getElementById("vpn-on").addEventListener("click", function () { vpnToggle(true); });
document.getElementById("vpn-off").addEventListener("click", function () { vpnToggle(false); });
document.getElementById("vpn-refresh").addEventListener("click", refresh);
document.getElementById("refresh").addEventListener("click", refresh);
refresh();
refreshDiagnostics();
refreshAutoHeal();
loadPolicy();
refreshServerPolicy();
setInterval(refresh, 5000);
setInterval(refreshDiagnostics, 2500);
setInterval(refreshAutoHeal, 5000);
</script>
</body>
</html>'''


def read_value(path, key, default):
    try:
        for line in path.read_text(encoding="utf-8").splitlines():
            if line.startswith(key + "="):
                return line.split("=", 1)[1]
    except OSError:
        pass
    return default


def config_data():
    for path in (BASE_CONFIG_PATH, CONFIG_PATH):
        try:
            return json.loads(path.read_text(encoding="utf-8"))
        except (OSError, ValueError):
            pass
    return {}


def utc_now():
    return datetime.now(timezone.utc).isoformat().replace("+00:00", "Z")


def atomic_json(path, payload):
    path.parent.mkdir(parents=True, exist_ok=True)
    temporary = path.with_name(path.name + ".tmp-" + secrets.token_hex(4))
    temporary.write_text(json.dumps(payload, ensure_ascii=False, separators=(",", ":")) + "\n", encoding="utf-8")
    os.chmod(temporary, 0o600)
    temporary.replace(path)


def validate_policy(payload):
    if not isinstance(payload, dict):
        raise ValueError("Smart policy должна быть объектом")
    def legacy_values(key):
        values = payload.get(key, [])
        return values if isinstance(values, list) else []
    legacy = {
        "direct": legacy_values("directSuffixes") + ["=" + value for value in legacy_values("directDomains") if isinstance(value, str)],
        "proxy": legacy_values("proxySuffixes") + ["=" + value for value in legacy_values("proxyDomains") if isinstance(value, str)],
    }
    policy = {}
    for key in ("block", "direct", "proxy"):
        values = payload.get(key, legacy.get(key, []))
        if not isinstance(values, list) or len(values) > 500:
            raise ValueError("Некорректный список " + key)
        normalized = []
        for value in values:
            if not isinstance(value, str):
                raise ValueError("Некорректный домен в " + key)
            exact = value.strip().startswith("=")
            host = value.strip().lower().lstrip("=").strip(".")
            if not host or len(host) > 253 or "/" in host or "*" in host or any(char.isspace() for char in host) or host.endswith((".local", ".lan")):
                raise ValueError("Некорректный домен: " + value)
            host = ("=" if exact else "") + host
            if host not in normalized:
                normalized.append(host)
        policy[key] = normalized
    return policy


def policy_data():
    try:
        return validate_policy(json.loads(CUSTOM_POLICY_PATH.read_text(encoding="utf-8")))
    except OSError:
        return validate_policy({})
    except (ValueError, json.JSONDecodeError) as error:
        raise ValueError("Smart policy повреждена: " + str(error))


def pac_script():
    policy = policy_data()
    for rule in config_data().get("routing", {}).get("rules", []):
        if not rule.get("balancerTag"):
            continue
        for value in rule.get("domain", []):
            if not isinstance(value, str):
                continue
            if value.startswith("full:"):
                key, host = "proxy", "=" + value[5:]
            elif value.startswith("domain:"):
                key, host = "proxy", value[7:]
            else:
                continue
            host = host.strip().lower().strip(".")
            if host and host not in policy[key]:
                policy[key].append(host)
    http_port = read_value(PORT_STATE, "http", "28109")
    socks_port = read_value(PORT_STATE, "socks", "28108")
    serialized = json.dumps(policy, ensure_ascii=False, separators=(",", ":"))
    return """var bezPolicy = {policy};
function bezMatch(host, values) {{
  for (var i = 0; i < values.length; i++) {{
    var value = values[i];
    if (value.charAt(0) === \"=\" ? host === value.slice(1) : (host === value || dnsDomainIs(host, \".\" + value))) return true;
  }}
  return false;
}}
function FindProxyForURL(url, host) {{
  host = host.toLowerCase().replace(/\\.$/, \"\");
  if (bezMatch(host, bezPolicy.block)) return \"PROXY 127.0.0.1:9\";
  if (isPlainHostName(host) || shExpMatch(host, \"localhost\") || shExpMatch(host, \"127.*\") || shExpMatch(host, \"10.*\") || shExpMatch(host, \"192.168.*\")) return \"DIRECT\";
  if (bezMatch(host, bezPolicy.direct)) return \"DIRECT\";
  if (bezMatch(host, bezPolicy.proxy)) return \"PROXY 127.0.0.1:{http_port}; SOCKS5 127.0.0.1:{socks_port}\";
  return \"DIRECT\";
}}
""".format(policy=serialized, http_port=http_port, socks_port=socks_port)


def endpoint_candidates(config):
    return [str(item.get("tag")) for item in config.get("outbounds", []) if item.get("protocol") == "vless" and item.get("tag")]


def is_running():
    try:
        return subprocess.run(
            ["launchctl", "print", "gui/{}/{}".format(os.getuid(), XRAY_LABEL)],
            stdout=subprocess.DEVNULL,
            stderr=subprocess.DEVNULL,
            check=False,
        ).returncode == 0
    except OSError:
        return False


def active_endpoints(config):
    if not XRAY_BIN.exists() or not is_running():
        return {}
    active = {}
    for balancer in config.get("routing", {}).get("balancers", []):
        tag = str(balancer.get("tag", ""))
        if not tag:
            continue
        try:
            result = subprocess.run(
                [str(XRAY_BIN), "api", "bi", "--server=127.0.0.1:{}".format(XRAY_API_PORT), "--timeout=1", tag],
                text=True,
                stdout=subprocess.PIPE,
                stderr=subprocess.DEVNULL,
                timeout=2,
                check=False,
            )
        except (OSError, subprocess.TimeoutExpired):
            continue
        matches = re.findall(r"^\s+\d+\s+(\S+)\s*$", result.stdout, flags=re.MULTILINE)
        if result.returncode == 0 and matches:
            active[tag] = matches[-1]
    return active


def free_loopback_port():
    with socket.socket(socket.AF_INET, socket.SOCK_STREAM) as stream:
        stream.bind(("127.0.0.1", 0))
        return stream.getsockname()[1]


def curl_probe(port, url, output_format, timeout):
    result = subprocess.run(
        ["/usr/bin/curl", "--socks5-hostname", "127.0.0.1:{}".format(port), "--silent", "--show-error", "--connect-timeout", "6", "--max-time", str(timeout), "--output", "/dev/null", "--write-out", output_format, url],
        text=True,
        stdout=subprocess.PIPE,
        stderr=subprocess.PIPE,
        timeout=timeout + 2,
        check=False,
    )
    if result.returncode:
        raise RuntimeError(result.stderr.strip().splitlines()[-1] if result.stderr.strip() else "curl error")
    return result.stdout.strip()


def curl_body(port, url, timeout):
    result = subprocess.run(
        ["/usr/bin/curl", "--socks5-hostname", "127.0.0.1:{}".format(port), "--silent", "--show-error", "--connect-timeout", "6", "--max-time", str(timeout), url],
        text=True,
        stdout=subprocess.PIPE,
        stderr=subprocess.PIPE,
        timeout=timeout + 2,
        check=False,
    )
    if result.returncode:
        raise RuntimeError(result.stderr.strip().splitlines()[-1] if result.stderr.strip() else "curl error")
    return result.stdout.strip()


def http_sample(url, socks_port=None):
    command = ["/usr/bin/curl", "--silent", "--show-error", "--location", "--output", "/dev/null", "--connect-timeout", "5", "--max-time", "12", "--write-out", "%{http_code} %{time_total}"]
    if socks_port is not None:
        command += ["--socks5-hostname", "127.0.0.1:{}".format(socks_port)]
    command.append(url)
    try:
        result = subprocess.run(command, text=True, stdout=subprocess.PIPE, stderr=subprocess.PIPE, timeout=14, check=False)
    except (OSError, subprocess.TimeoutExpired) as error:
        return {"url": url, "ok": False, "error": str(error)[:160]}
    parts = result.stdout.strip().split()
    code = parts[0] if parts else "000"
    try:
        latency_ms = round(float(parts[1]) * 1000) if len(parts) == 2 else None
    except ValueError:
        latency_ms = None
    ok = result.returncode == 0 and latency_ms is not None and re.fullmatch(r"(?:2\\d\\d|3\\d\\d|401|403)", code) is not None
    detail = result.stderr.strip().splitlines()[-1] if result.stderr.strip() else "HTTP " + code
    return {"url": url, "ok": ok, "latencyMs": latency_ms, "code": code, "error": None if ok else detail[:160]}


def route_measurement(urls, socks_port=None):
    samples = [http_sample(url, socks_port) for url in urls]
    successful = [item["latencyMs"] for item in samples if item.get("ok") and isinstance(item.get("latencyMs"), int)]
    return {"ok": len(successful) == len(samples) and bool(samples), "latencyMs": round(statistics.median(successful)) if successful else None, "samples": samples}


def probe_endpoint(endpoint, config, quick=False, probe_urls=None):
    checked_at = utc_now()
    process = None
    try:
        if not XRAY_BIN.exists():
            raise RuntimeError("Xray не найден")
        outbound = next((copy.deepcopy(item) for item in config.get("outbounds", []) if item.get("tag") == endpoint and item.get("protocol") == "vless"), None)
        if outbound is None:
            raise RuntimeError("Endpoint отсутствует в конфиге")
        port = free_loopback_port()
        probe_config = copy.deepcopy(config)
        probe_config.pop("api", None)
        probe_config.pop("observatory", None)
        probe_config.pop("burstObservatory", None)
        probe_config.pop("stats", None)
        probe_config.pop("metrics", None)
        probe_config["inbounds"] = [{"tag": "bez-probe", "listen": "127.0.0.1", "port": port, "protocol": "socks", "settings": {"auth": "noauth", "udp": True}}]
        probe_config["outbounds"] = [outbound] + [copy.deepcopy(item) for item in config.get("outbounds", []) if item.get("protocol") in ("freedom", "blackhole")]
        probe_config["routing"] = {"domainStrategy": "AsIs", "rules": [{"type": "field", "network": "tcp,udp", "outboundTag": endpoint}]}
        with tempfile.TemporaryDirectory(prefix="bez-probe-") as directory:
            path = Path(directory) / "config.json"
            path.write_text(json.dumps(probe_config, separators=(",", ":")) + "\n", encoding="utf-8")
            process = subprocess.Popen([str(XRAY_BIN), "run", "-config", str(path)], stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
            deadline = time.monotonic() + 6
            while time.monotonic() < deadline:
                if process.poll() is not None:
                    raise RuntimeError("Xray отклонил endpoint")
                try:
                    with socket.create_connection(("127.0.0.1", port), timeout=0.2):
                        break
                except OSError:
                    time.sleep(0.1)
            else:
                raise RuntimeError("Xray не открыл тестовый proxy")
            measurement = route_measurement(probe_urls or AUTO_HEAL_SAMPLE_URLS, port)
            if not measurement["ok"]:
                raise RuntimeError("Нет полного HTTP-ответа от безопасных проверочных URL")
            latency = measurement["latencyMs"] / 1000
            if quick:
                return {"endpoint": endpoint, "ok": True, "latencyMs": round(latency * 1000), "exitIp": None, "speedMbps": None, "checkedAt": checked_at}
            exit_ip = curl_body(port, "https://api.ipify.org", 15)
            if not re.fullmatch(r"[0-9a-fA-F:.]{3,64}", exit_ip):
                raise RuntimeError("Некорректный внешний IP")
            speed = curl_probe(port, "https://speed.cloudflare.com/__down?bytes=1000000", "%{size_download} %{time_total}", 25).split()
            if len(speed) != 2 or float(speed[1]) <= 0:
                raise RuntimeError("Некорректный ответ speed test")
            speed_mbps = float(speed[0]) * 8 / float(speed[1]) / 1_000_000
        return {"endpoint": endpoint, "ok": True, "latencyMs": round(latency * 1000), "exitIp": exit_ip, "speedMbps": round(speed_mbps, 1), "checkedAt": checked_at}
    except (OSError, ValueError, RuntimeError, subprocess.TimeoutExpired) as error:
        return {"endpoint": endpoint, "ok": False, "latencyMs": None, "exitIp": None, "speedMbps": None, "checkedAt": checked_at, "error": str(error)[:180]}
    finally:
        if process is not None and process.poll() is None:
            process.terminate()
            try:
                process.wait(timeout=2)
            except subprocess.TimeoutExpired:
                process.kill()
                process.wait(timeout=2)


def diagnostics_payload():
    with DIAGNOSTICS_LOCK:
        payload = copy.deepcopy(DIAGNOSTICS_STATE)
    if not payload["results"] and DIAGNOSTICS_PATH.exists():
        try:
            cached = json.loads(DIAGNOSTICS_PATH.read_text(encoding="utf-8"))
            if isinstance(cached, dict) and isinstance(cached.get("results"), list):
                payload.update({"finishedAt": cached.get("finishedAt"), "results": cached["results"]})
        except (OSError, ValueError):
            pass
    return payload


def telemetry_enabled():
    try:
        return TELEMETRY_PATH.read_text(encoding="utf-8").strip().lower() != "off"
    except OSError:
        return True

def report_diagnostic(result, run_id, sequence):
    if not telemetry_enabled():
        return
    payload = {
        "schemaVersion": 1,
        "eventId": "bez-{}-{}".format(run_id, sequence),
        "runId": "bez-{}".format(run_id),
        "sequence": sequence,
        "timestamp": result.get("checkedAt") or utc_now(),
        "type": "endpoint_finished",
        "profile": "health",
        "target": {
            "id": "macos-bez",
            "networkClass": "external-unknown",
            "client": "xray",
            "accessMethod": "socks-proxy",
            "wireMethod": "unknown",
            "hostRole": "mac",
        },
        "endpoint": result["endpoint"],
        "payload": {
            "eligible": bool(result.get("ok")),
            "reachable": bool(result.get("ok")),
            "latencyMs": result.get("latencyMs"),
            "exitIp": result.get("exitIp"),
            "speedMbps": result.get("speedMbps"),
            "diagnosticError": result.get("error"),
        },
    }
    try:
        subprocess.run(
            ["/usr/bin/curl", "--silent", "--show-error", "--output", "/dev/null", "--connect-timeout", "4", "--max-time", "8", "-X", "POST", "-H", "Authorization: Bearer " + CONFIG_TOKEN, "-H", "Content-Type: application/json", "--data-binary", "@-", BASE_URL + "/api/telemetry/vpn-tests/events"],
            input=json.dumps(payload, separators=(",", ":")), text=True, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL, timeout=10, check=False,
        )
    except (OSError, subprocess.TimeoutExpired):
        pass

def run_diagnostics():
    config = config_data()
    selection_mode, selected = endpoint_selection(config)
    candidates = [selected] if selection_mode == "manual" else endpoint_candidates(config)
    results = []
    try:
        with ThreadPoolExecutor(max_workers=2) as executor:
            futures = {executor.submit(probe_endpoint, endpoint, config): endpoint for endpoint in candidates}
            for future in as_completed(futures):
                results.append(future.result())
                order = {endpoint: index for index, endpoint in enumerate(candidates)}
                with DIAGNOSTICS_LOCK:
                    DIAGNOSTICS_STATE["results"] = sorted(results, key=lambda item: order.get(item["endpoint"], 9999))
    finally:
        finished_at = utc_now()
        with DIAGNOSTICS_LOCK:
            DIAGNOSTICS_STATE.update({"running": False, "finishedAt": finished_at})
            snapshot = copy.deepcopy(DIAGNOSTICS_STATE)
        atomic_json(DIAGNOSTICS_PATH, snapshot)
        run_id = str(int(time.time() * 1000))
        for sequence, result in enumerate(snapshot["results"], start=1):
            report_diagnostic(result, run_id, sequence)


def start_diagnostics():
    with DIAGNOSTICS_LOCK:
        if DIAGNOSTICS_STATE["running"]:
            return copy.deepcopy(DIAGNOSTICS_STATE)
        DIAGNOSTICS_STATE.update({"running": True, "startedAt": utc_now(), "finishedAt": None, "results": []})
        snapshot = copy.deepcopy(DIAGNOSTICS_STATE)
    threading.Thread(target=run_diagnostics, daemon=True, name="bez-endpoint-diagnostics").start()
    return snapshot


def auto_heal_settings():
    settings = {"enabled": False}
    try:
        saved = json.loads(AUTO_HEAL_SETTINGS_PATH.read_text(encoding="utf-8"))
        if isinstance(saved, dict) and isinstance(saved.get("backgroundEnabled"), bool):
            settings["enabled"] = saved["backgroundEnabled"]
    except (OSError, ValueError):
        pass
    return settings


def save_auto_heal_settings(settings):
    atomic_json(AUTO_HEAL_SETTINGS_PATH, {"backgroundEnabled": bool(settings["enabled"])})


def save_auto_heal_state():
    atomic_json(AUTO_HEAL_STATE_PATH, AUTO_HEAL_STATE)


def restore_auto_heal_state():
    try:
        saved = json.loads(AUTO_HEAL_STATE_PATH.read_text(encoding="utf-8"))
    except (OSError, ValueError):
        return
    if not isinstance(saved, dict):
        return
    for key in ("status", "consecutiveFailures", "lastCheck", "detail", "lastSwitch", "lastAttemptEpoch", "probeIndex"):
        if key in saved:
            AUTO_HEAL_STATE[key] = saved[key]
    AUTO_HEAL_STATE["healing"] = False


def append_auto_heal_log(event, payload):
    APP_DIR.mkdir(parents=True, exist_ok=True)
    if AUTO_HEAL_LOG_PATH.exists() and AUTO_HEAL_LOG_PATH.stat().st_size > 262144:
        AUTO_HEAL_LOG_PATH.replace(AUTO_HEAL_LOG_PATH.with_suffix(".log.1"))
    record = {"at": utc_now(), "event": event, **payload}
    with AUTO_HEAL_LOG_PATH.open("a", encoding="utf-8") as stream:
        stream.write(json.dumps(record, ensure_ascii=False, separators=(",", ":")) + "\n")
    os.chmod(AUTO_HEAL_LOG_PATH, 0o600)


def endpoint_selection(config):
    candidates = endpoint_candidates(config)
    try:
        selected = ENDPOINT_STATE.read_text(encoding="utf-8").strip() or "auto"
    except OSError:
        selected = "auto"
    if selected != "auto" and selected not in candidates:
        selected = "auto"
    return ("auto" if selected == "auto" else "manual", selected)


def recent_xray_error():
    try:
        if time.time() - XRAY_LOG_PATH.stat().st_mtime > AUTO_HEAL_INTERVAL * 2:
            return None
        with XRAY_LOG_PATH.open("rb") as stream:
            stream.seek(max(0, XRAY_LOG_PATH.stat().st_size - 65536))
            tail = stream.read().decode("utf-8", "replace")
    except OSError:
        return None
    matches = re.findall(r"^.*(?:failed|error|timeout|EOF|connection reset).*$", tail, flags=re.IGNORECASE | re.MULTILINE)
    return matches[-1][-180:] if matches else None


def next_auto_heal_url():
    index = int(AUTO_HEAL_STATE.get("probeIndex", 0)) % len(AUTO_HEAL_SAMPLE_URLS)
    AUTO_HEAL_STATE["probeIndex"] = (index + 1) % len(AUTO_HEAL_SAMPLE_URLS)
    return AUTO_HEAL_SAMPLE_URLS[index]


def auto_heal_payload():
    with AUTO_HEAL_LOCK:
        state = copy.deepcopy(AUTO_HEAL_STATE)
    return {"enabled": auto_heal_settings()["enabled"], "intervalSeconds": AUTO_HEAL_INTERVAL, "latencyLimitMs": AUTO_HEAL_LATENCY_LIMIT_MS, "state": state}


def auto_heal_check(force=False):
    if not AUTO_HEAL_RUN_LOCK.acquire(blocking=False):
        return auto_heal_payload()
    try:
        settings = auto_heal_settings()
        if not settings["enabled"] and not force:
            AUTO_HEAL_STATE.update({"status": "disabled", "healing": False})
            save_auto_heal_state()
            return auto_heal_payload()
        AUTO_HEAL_STATE["lastCheck"] = utc_now()
        if not is_running():
            AUTO_HEAL_STATE.update({"status": "stopped", "detail": "Xray выключен", "consecutiveFailures": 0, "healing": False})
            save_auto_heal_state()
            return auto_heal_payload()
        socks_port = read_value(PORT_STATE, "socks", "28108")
        urls = (next_auto_heal_url(),)
        current = route_measurement(urls, socks_port)
        xray_error = recent_xray_error()
        current_latency = current.get("latencyMs")
        degraded = not current.get("ok") or xray_error is not None or (isinstance(current_latency, int) and current_latency > AUTO_HEAL_LATENCY_LIMIT_MS)
        AUTO_HEAL_STATE["detail"] = ("ошибка Xray: " + xray_error) if xray_error else ("реальная задержка {} мс".format(current_latency) if current_latency is not None else "нет полного HTTP-ответа")
        if not degraded:
            AUTO_HEAL_STATE.update({"status": "healthy", "consecutiveFailures": 0, "healing": False})
            save_auto_heal_state()
            return auto_heal_payload()
        now = time.time()
        if not force and now - float(AUTO_HEAL_STATE.get("lastAttemptEpoch", 0)) < AUTO_HEAL_COOLDOWN:
            save_auto_heal_state()
            return auto_heal_payload()
        AUTO_HEAL_STATE.update({"healing": True, "lastAttemptEpoch": now})
        save_auto_heal_state()
        config = config_data()
        original_mode, original_endpoint = endpoint_selection(config)
        if original_mode == "auto":
            AUTO_HEAL_STATE.update({"status": "healthy", "detail": "Auto (leastPing) уже выбирает маршрут без перезапуска", "consecutiveFailures": 0, "healing": False})
            save_auto_heal_state()
            return auto_heal_payload()
        candidates = [endpoint for endpoint in endpoint_candidates(config) if endpoint != original_endpoint]
        results = []
        with ThreadPoolExecutor(max_workers=2) as executor:
            futures = [executor.submit(probe_endpoint, endpoint, config, True, urls) for endpoint in candidates]
            for future in as_completed(futures):
                results.append(future.result())
        if not force and not auto_heal_settings()["enabled"]:
            AUTO_HEAL_STATE.update({"status": "disabled", "detail": None, "consecutiveFailures": 0, "healing": False})
            save_auto_heal_state()
            return auto_heal_payload()
        working = sorted((item for item in results if item.get("ok")), key=lambda item: item.get("latencyMs") if item.get("latencyMs") is not None else 999999)
        if not working:
            AUTO_HEAL_STATE.update({"status": "unavailable", "detail": "Рабочий endpoint не найден", "healing": False})
            append_auto_heal_log("no-endpoint", {"from": original_endpoint, "results": results})
            save_auto_heal_state()
            return auto_heal_payload()
        target = working[0]["endpoint"]
        target_latency = working[0].get("latencyMs")
        if not xray_error and isinstance(current_latency, int) and isinstance(target_latency, int) and target_latency + AUTO_HEAL_IMPROVEMENT_MS >= current_latency:
            AUTO_HEAL_STATE.update({"status": "healthy", "detail": "Лучший запасной endpoint недостаточно быстрее", "consecutiveFailures": 0, "healing": False})
            save_auto_heal_state()
            return auto_heal_payload()
        with COMMAND_LOCK:
            current_mode, current_endpoint = endpoint_selection(config_data())
            if (current_mode, current_endpoint) != (original_mode, original_endpoint):
                AUTO_HEAL_STATE.update({"status": "cancelled", "detail": "Endpoint изменён вручную", "healing": False})
                save_auto_heal_state()
                return auto_heal_payload()
            run_cli(["endpoint", target])
            switched = route_measurement(urls, socks_port)
            if not switched.get("ok"):
                rollback_target = "auto" if original_mode == "auto" else original_endpoint
                run_cli(["endpoint", rollback_target])
                raise RuntimeError("После переключения нет полного HTTP-ответа")
        switch = {"at": utc_now(), "from": original_endpoint, "to": target, "latencyMs": working[0].get("latencyMs")}
        AUTO_HEAL_STATE.update({"status": "switched", "detail": "Переключение подтверждено реальным HTTP-ответом", "consecutiveFailures": 0, "lastSwitch": switch, "healing": False})
        append_auto_heal_log("switched", switch)
        save_auto_heal_state()
        return auto_heal_payload()
    except Exception as error:
        AUTO_HEAL_STATE.update({"status": "error", "detail": str(error)[:180], "healing": False})
        append_auto_heal_log("error", {"detail": str(error)[:180]})
        save_auto_heal_state()
        return auto_heal_payload()
    finally:
        AUTO_HEAL_RUN_LOCK.release()


def auto_heal_loop():
    while True:
        time.sleep(AUTO_HEAL_INTERVAL)
        auto_heal_check()


def start_auto_heal_check():
    if AUTO_HEAL_RUN_LOCK.locked() or AUTO_HEAL_STATE.get("healing"):
        return auto_heal_payload()
    threading.Thread(target=auto_heal_check, kwargs={"force": True}, daemon=True, name="bez-auto-heal-now").start()
    return auto_heal_payload()


def status_payload():
    config = config_data()
    candidates = endpoint_candidates(config)
    selection_mode, selected = endpoint_selection(config)
    active = active_endpoints(config) if selected == "auto" else {}
    return {
        "running": is_running(),
        "profile": read_value(STATE_PATH, "mode", "smart"),
        "scope": "global" if PROXY_STATE.exists() else "local",
        "proxy": {
            "socks": "127.0.0.1:" + read_value(PORT_STATE, "socks", "28108"),
            "http": "127.0.0.1:" + read_value(PORT_STATE, "http", "28109"),
        },
        "proxyMode": proxy_mode_state(),
        "vpn": vpn_state(),
        "endpoint": {
            "mode": selection_mode,
            "selected": selected,
            "candidates": candidates,
            "active": active,
        },
    }


def proxy_mode_state():
    value = read_value(PROXY_MODE_PATH, "mode", "http").strip().lower()
    return value if value in ("http", "socks") else "http"


def fetch_server_policy():
    auth_file = None
    try:
        with tempfile.NamedTemporaryFile("w", suffix=".curl", delete=False) as handle:
            auth_file = handle.name
            handle.write('header = "Authorization: Bearer %s"\n' % CONFIG_TOKEN)
            os.chmod(auth_file, 0o600)
        result = subprocess.run(
            ["curl", "--config", auth_file, "-fsSL", "-m", "12", BASE_URL + "/api/user/client-policy"],
            text=True, stdout=subprocess.PIPE, stderr=subprocess.PIPE, timeout=15, check=False,
        )
        if result.returncode:
            raise RuntimeError("сервер недоступен: " + (result.stderr.strip() or ("HTTP " + str(result.returncode))))
        return json.loads(result.stdout)
    except json.JSONDecodeError as error:
        raise RuntimeError("сервер вернул некорректный ответ: " + str(error))
    finally:
        if auth_file:
            try:
                os.unlink(auth_file)
            except OSError:
                pass


def server_policy_payload():
    with SERVER_POLICY_LOCK:
        cached_at = SERVER_POLICY_CACHE["fetchedAt"]
        fresh = False
        if cached_at:
            try:
                fresh = (datetime.now(timezone.utc) - datetime.fromisoformat(cached_at)).total_seconds() < 300
            except ValueError:
                fresh = False
        if not fresh:
            try:
                SERVER_POLICY_CACHE["policy"] = fetch_server_policy()
                SERVER_POLICY_CACHE["fetchedAt"] = datetime.now(timezone.utc).isoformat()
                SERVER_POLICY_CACHE["error"] = None
            except (RuntimeError, OSError, subprocess.SubprocessError) as error:
                SERVER_POLICY_CACHE["error"] = str(error)
        return {
            "policy": SERVER_POLICY_CACHE["policy"],
            "fetchedAt": SERVER_POLICY_CACHE["fetchedAt"],
            "error": SERVER_POLICY_CACHE["error"],
        }


def vpn_state():
    try:
        probe = subprocess.run(["pgrep", "-f", "sing-box run -c " + str(VPN_CONFIG_PATH)],
                               text=True, stdout=subprocess.PIPE, timeout=5, check=False)
        running = probe.returncode == 0
    except (OSError, subprocess.SubprocessError):
        running = False
    installed = (APP_DIR / "bin/sing-box").exists() and VPN_CONFIG_PATH.exists()
    return {"running": running, "installed": installed, "config": str(VPN_CONFIG_PATH)}


def run_elevated(arguments):
    if not CLI_PATH.exists():
        raise RuntimeError("bez CLI не найден")
    command = str(CLI_PATH) + " " + " ".join(arguments)
    apple_script = 'do shell script "%s" with administrator privileges' % command.replace("\\", "\\\\").replace('"', '\\"')
    result = subprocess.run(["osascript", "-e", apple_script],
                            text=True, stdout=subprocess.PIPE, stderr=subprocess.PIPE, timeout=300, check=False)
    message = (result.stdout or "").strip() or (result.stderr or "").strip()
    if result.returncode:
        if "User canceled" in (result.stderr or "") or "user canceled" in (result.stderr or ""):
            raise RuntimeError("Запрос на повышение прав отменён")
        raise RuntimeError(message or "Не удалось выполнить команду с правами администратора")
    return message.splitlines()[-1] if message else "Готово"


def apply_hosts(target):
    if target not in ("vpn2", "vusa", "off"):
        raise ValueError("Некорректный hosts target")
    with urlopen(BASE_URL + "/install/mac-hosts.sh", timeout=20) as response:
        script = response.read()
    with tempfile.NamedTemporaryFile(prefix="bez-hosts-", suffix=".sh", delete=False) as handle:
        handle.write(script)
        script_path = handle.name
    os.chmod(script_path, 0o700)
    try:
        command = "/bin/bash " + script_path + " " + target
        apple_script = 'do shell script "%s" with administrator privileges' % command.replace("\\", "\\\\").replace('"', '\\"')
        result = subprocess.run(["osascript", "-e", apple_script], text=True, stdout=subprocess.PIPE, stderr=subprocess.PIPE, timeout=300, check=False)
        if result.returncode:
            raise RuntimeError((result.stderr or result.stdout or "hosts command failed").strip())
        return (result.stdout or "Hosts обновлён").strip().splitlines()[-1]
    finally:
        Path(script_path).unlink(missing_ok=True)

def hosts_preview():
    begin = ${JSON.stringify(HOSTS_BLOCK_BEGIN)}
    end = ${JSON.stringify(HOSTS_BLOCK_END)}
    domains = ${JSON.stringify(SNI_EDGE_DOMAINS)}
    current = []
    inside = False
    try:
        for line in Path("/etc/hosts").read_text(encoding="utf-8", errors="replace").splitlines():
            if line == begin:
                inside = True
            if inside:
                current.append(line)
            if line == end:
                inside = False
    except OSError as error:
        raise RuntimeError("Не удалось прочитать /etc/hosts: " + str(error))
    def plan(target, ip):
        return "\\n".join([begin, "# OpenAI/Claude via " + target + " Xray SNI edge", *[ip + "\\t" + domain for domain in domains], end])
    return {"current": "\\n".join(current), "vpn2": plan("vpn2", "212.192.31.128"), "vusa": plan("vusa", "185.240.120.152")}


def run_cli(arguments):
    if not CLI_PATH.exists():
        raise RuntimeError("bez CLI не найден")
    result = subprocess.run(
        [str(CLI_PATH), *arguments],
        text=True,
        stdout=subprocess.PIPE,
        stderr=subprocess.STDOUT,
        timeout=120,
        check=False,
    )
    message = result.stdout.strip()
    if result.returncode:
        raise RuntimeError(message or "bez завершился с ошибкой")
    return message.splitlines()[-1] if message else "Готово"


class Handler(BaseHTTPRequestHandler):
    server_version = "BezLocal/1"

    def allowed_host(self):
        host = self.headers.get("Host", "").split(":", 1)[0]
        return host in ("127.0.0.1", "localhost")

    def send_bytes(self, status, content_type, body):
        self.send_response(status)
        self.send_header("Content-Type", content_type)
        self.send_header("Content-Length", str(len(body)))
        self.send_header("Cache-Control", "no-store")
        self.send_header("X-Content-Type-Options", "nosniff")
        self.send_header("Content-Security-Policy", "default-src 'self'; style-src 'unsafe-inline'; script-src 'unsafe-inline'; connect-src 'self'; frame-ancestors 'none'")
        self.send_header("Referrer-Policy", "no-referrer")
        self.end_headers()
        self.wfile.write(body)

    def send_json(self, status, payload):
        self.send_bytes(status, "application/json; charset=utf-8", json.dumps(payload, ensure_ascii=False).encode("utf-8"))

    def do_GET(self):
        if not self.allowed_host():
            self.send_json(403, {"error": "Недопустимый Host"})
            return
        path = urlparse(self.path).path
        if path == "/":
            body = PAGE.replace("__BEZ_CSRF__", CSRF_TOKEN).encode("utf-8")
            self.send_bytes(200, "text/html; charset=utf-8", body)
        elif path == "/api/status":
            self.send_json(200, status_payload())
        elif path == "/api/diagnostics":
            self.send_json(200, diagnostics_payload())
        elif path == "/api/hosts-preview":
            self.send_json(200, hosts_preview())
        elif path == "/api/auto-heal":
            self.send_json(200, auto_heal_payload())
        elif path == "/api/policy":
            self.send_json(200, policy_data())
        elif path == "/api/server-policy":
            self.send_json(200, server_policy_payload())
        elif path == "/api/vpn":
            self.send_json(200, vpn_state())
        elif path == "/proxy.pac":
            self.send_bytes(200, "application/x-ns-proxy-autoconfig; charset=utf-8", pac_script().encode("utf-8"))
        else:
            self.send_json(404, {"error": "Не найдено"})

    def do_POST(self):
        if not self.allowed_host() or not secrets.compare_digest(self.headers.get("X-Bez-CSRF", ""), CSRF_TOKEN):
            self.send_json(403, {"error": "Команда отклонена"})
            return
        try:
            length = int(self.headers.get("Content-Length", "0"))
            if length < 0 or length > 131072:
                raise ValueError("Некорректный запрос")
            payload = json.loads(self.rfile.read(length) or b"{}")
            if not isinstance(payload, dict):
                raise ValueError("Некорректный запрос")
            path = urlparse(self.path).path
            if path == "/api/profile":
                profile = payload.get("profile")
                scope = payload.get("scope")
                if profile not in ("smart", "full", "custom") or scope not in ("local", "global"):
                    raise ValueError("Некорректный профиль")
                command = ["custom", scope] if profile == "custom" else [profile, "--" + scope]
                with COMMAND_LOCK:
                    message = run_cli(command)
            elif path == "/api/endpoint":
                endpoint = payload.get("endpoint")
                if not isinstance(endpoint, str) or not endpoint:
                    raise ValueError("Endpoint не выбран")
                with COMMAND_LOCK:
                    message = run_cli(["endpoint", endpoint])
            elif path == "/api/diagnostics/run":
                self.send_json(202, start_diagnostics())
                return
            elif path == "/api/auto-heal":
                enabled = payload.get("enabled")
                if not isinstance(enabled, bool):
                    raise ValueError("Некорректная настройка автолечения")
                save_auto_heal_settings({"enabled": enabled})
                if enabled:
                    AUTO_HEAL_STATE.update({"status": "idle", "detail": None})
                else:
                    AUTO_HEAL_STATE.update({"status": "disabled", "consecutiveFailures": 0, "detail": None})
                save_auto_heal_state()
                self.send_json(200, auto_heal_payload())
                return
            elif path == "/api/auto-heal/run":
                self.send_json(202, start_auto_heal_check())
                return
            elif path == "/api/policy":
                policy = validate_policy(payload.get("policy"))
                apply_policy = payload.get("apply", False)
                scope = payload.get("scope", "global")
                if not isinstance(apply_policy, bool) or scope not in ("local", "global"):
                    raise ValueError("Некорректные параметры Smart policy")
                previous = CUSTOM_POLICY_PATH.read_bytes() if CUSTOM_POLICY_PATH.exists() else None
                atomic_json(CUSTOM_POLICY_PATH, policy)
                message = "Smart правила сохранены"
                if apply_policy:
                    try:
                        with COMMAND_LOCK:
                            message = run_cli(["custom", scope])
                    except (RuntimeError, subprocess.TimeoutExpired):
                        if previous is None:
                            CUSTOM_POLICY_PATH.unlink(missing_ok=True)
                        else:
                            CUSTOM_POLICY_PATH.write_bytes(previous)
                            os.chmod(CUSTOM_POLICY_PATH, 0o600)
                        raise
                    message = "Smart правила сохранены и применены"
                self.send_json(200, {"message": message, "policy": policy, "status": status_payload() if apply_policy else None})
                return
            elif path == "/api/off":
                with COMMAND_LOCK:
                    message = run_cli(["off"])
            elif path == "/api/proxy-mode":
                mode = payload.get("mode")
                if mode not in ("http", "socks"):
                    raise ValueError("mode must be http or socks")
                with COMMAND_LOCK:
                    message = run_cli(["proxy-mode", mode])
            elif path == "/api/vpn":
                enabled = payload.get("enabled")
                if not isinstance(enabled, bool):
                    raise ValueError("Некорректный запрос VPN")
                with COMMAND_LOCK:
                    message = run_elevated(["vpn", "on" if enabled else "off"])
            elif path == "/api/hosts":
                target = payload.get("target")
                if not isinstance(target, str):
                    raise ValueError("Некорректный hosts target")
                with COMMAND_LOCK:
                    message = apply_hosts(target)
            else:
                self.send_json(404, {"error": "Не найдено"})
                return
            self.send_json(200, {"message": message, "status": status_payload()})
        except (ValueError, RuntimeError, subprocess.TimeoutExpired) as error:
            self.send_json(400, {"error": str(error)})

    def log_message(self, format, *args):
        return


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--port", type=int, default=28110)
    args = parser.parse_args()
    restore_auto_heal_state()
    threading.Thread(target=auto_heal_loop, daemon=True, name="bez-auto-heal").start()
    server = ThreadingHTTPServer(("127.0.0.1", args.port), Handler)
    server.serve_forever()


if __name__ == "__main__":
    main()
`;
  return python
    .replace("__BEZ_BASE_URL__", () => baseUrl)
    .replace("__BEZ_CONFIG_TOKEN__", () => configToken);
}

export function bezMacInstallerScript(publicBaseUrl: string): string {
  const script = String.raw`#!/bin/bash
set -euo pipefail

# Rootless MVP: Xray listens on localhost and macOS network services use its
# HTTP/SOCKS proxy. A transparent TUN would require administrator privileges.
BASE_URL="__BEZ_BASE_URL__"
CONFIG_TOKEN="__BEZ_CONFIG_TOKEN__"
BOOTSTRAP_URL="https://github.com/megamen32/bez/releases/latest/download/bez"
PROFILE="vpn2-07"
CLI_DIR="$HOME/.local/bin"
CLI_PATH="$HOME/.local/bin/bez"
APP_DIR="$HOME/Library/Application Support/BezVPN"
XRAY_BIN="$APP_DIR/bin/xray"
CONFIG_PATH="$APP_DIR/config.json"
BUNDLE_MARKER="$APP_DIR/bundle-offline"
STATE_PATH="$APP_DIR/state"
PROXY_STATE="$APP_DIR/proxy-state"
PORT_STATE="$APP_DIR/ports"
BASE_CONFIG_PATH="$APP_DIR/config-base.json"
HEAL_RULES_PATH="$APP_DIR/heal-rules.json"
HEAL_AUDIT_PATH="$APP_DIR/heal-audit.log"
CUSTOM_POLICY_PATH="$APP_DIR/custom-policy.json"
ENDPOINT_STATE="$APP_DIR/endpoint"
TELEMETRY_STATE="$APP_DIR/telemetry"
WEB_UI_PATH="$APP_DIR/web-ui.py"
TRAY_SOURCE="$APP_DIR/bez-tray.swift"
TRAY_BIN="$APP_DIR/bez-tray"
PROXY_MODE_STATE="$APP_DIR/proxy-mode"
VPN_CONFIG_PATH="$APP_DIR/vpn-tun.json"
VPN_PLIST_PATH="/Library/LaunchDaemons/com.bezrabotnyi.bez-vpn.plist"
VPN_LABEL="com.bezrabotnyi.bez-vpn"
SINGBOX_BIN="$APP_DIR/bin/sing-box"
SINGBOX_VERSION="1.13.14"
PLIST_PATH="$HOME/Library/LaunchAgents/com.bezrabotnyi.bez.plist"
LABEL="com.bezrabotnyi.bez"
WEB_PLIST_PATH="$HOME/Library/LaunchAgents/com.bezrabotnyi.bez-web.plist"
WEB_LABEL="com.bezrabotnyi.bez-web"
TRAY_PLIST_PATH="$HOME/Library/LaunchAgents/com.bezrabotnyi.bez-tray.plist"
TRAY_LABEL="com.bezrabotnyi.bez-tray"
LAUNCH_DOMAIN="gui/$(id -u)"
LOG_PATH="$HOME/Library/Logs/BezVPN.log"
WEB_LOG_PATH="$HOME/Library/Logs/BezVPN-web.log"
WEB_PORT=28110
API_PORT=28111
XRAY_VERSION="26.6.1"
SOCKS_PORT=28108
HTTP_PORT=28109
CODEX_INSTALL_DIR="$HOME/.local/bin"

die() { echo "bez: $*" >&2; exit 1; }
need_macos() { [[ "$(uname -s)" == Darwin ]] || die "macOS only"; }
installed() { [[ -x "$XRAY_BIN" && -f "$CONFIG_PATH" && -f "$PLIST_PATH" ]]; }
state_mode() {
  local mode="smart"
  if [[ -r "$STATE_PATH" ]]; then
    mode="$(sed -n 's/^mode=//p' "$STATE_PATH" | head -n 1)"
  fi
  [[ "$mode" == smart || "$mode" == all || "$mode" == custom ]] || mode=smart
  printf '%s\n' "$mode"
}
read_ports() {
  [[ -r "$PORT_STATE" ]] || return 1
  local socks http
  socks="$(sed -n 's/^socks=//p' "$PORT_STATE" | head -n 1)"
  http="$(sed -n 's/^http=//p' "$PORT_STATE" | head -n 1)"
  [[ "$socks" =~ ^[0-9]+$ && "$http" =~ ^[0-9]+$ ]] || return 1
  [[ "$socks" != "$WEB_PORT" && "$socks" != "$API_PORT" && "$http" != "$WEB_PORT" && "$http" != "$API_PORT" ]] || return 1
  SOCKS_PORT="$socks"
  HTTP_PORT="$http"
}
port_busy() { lsof -nP -iTCP:"$1" -sTCP:LISTEN >/dev/null 2>&1; }
bundle_mode() { [[ -f "$BUNDLE_MARKER" ]]; }
temp_json() {
  local path
  path="$(mktemp "$APP_DIR/$1.XXXXXX")"
  mv "$path" "$path.json"
  printf '%s\n' "$path.json"
}
choose_ports() {
  local base=28108
  while port_busy "$base" || port_busy "$((base + 1))" || (( base <= API_PORT && base + 1 >= WEB_PORT )); do
    [[ "$base" == 28108 ]] && base=29108 || base=$((base + 2))
    [[ "$base" -lt 20000 ]] || die "no free local proxy ports found"
  done
  SOCKS_PORT="$base"
  HTTP_PORT="$((base + 1))"
  printf 'socks=%s\nhttp=%s\n' "$SOCKS_PORT" "$HTTP_PORT" > "$PORT_STATE"
  chmod 600 "$PORT_STATE"
  echo "bez: using local proxy ports SOCKS=$SOCKS_PORT HTTP=$HTTP_PORT"
}
ensure_ports() {
  if read_ports && loaded; then return 0; fi
  if read_ports && ! port_busy "$SOCKS_PORT" && ! port_busy "$HTTP_PORT"; then return 0; fi
  choose_ports
}
install_cli() {
  mkdir -p "$CLI_DIR" || die "cannot create $CLI_DIR"
  local tmp
  tmp="$(mktemp)"
  curl -fsSL "$BOOTSTRAP_URL" -o "$tmp" || die "cannot download bez from GitHub"
  chmod 700 "$tmp"
  mv "$tmp" "$CLI_PATH" || die "cannot install $CLI_PATH"
  case ":$PATH:" in *":$CLI_DIR:"*) ;; *) printf '\nexport PATH="$HOME/.local/bin:$PATH"\n' >> "$HOME/.zprofile" ;; esac
  echo "bez installed at $CLI_PATH"
  echo "No administrator password is required. Run: bez install"
}
download_xray() {
  local asset tmp expected actual
  case "$(uname -m)" in
    arm64) asset=Xray-macos-arm64-v8a.zip ;;
    x86_64) asset=Xray-macos-64.zip ;;
    *) die "unsupported macOS architecture" ;;
  esac
  tmp="$(mktemp -d)"
  curl -fsSL "https://github.com/XTLS/Xray-core/releases/download/v$XRAY_VERSION/$asset" -o "$tmp/xray.zip" || die "cannot download official Xray"
  curl -fsSL "https://github.com/XTLS/Xray-core/releases/download/v$XRAY_VERSION/$asset.dgst" -o "$tmp/xray.dgst" || die "cannot download Xray checksum"
  expected="$(grep -Eio '[0-9a-f]{64}' "$tmp/xray.dgst" | head -n 1)"
  actual="$(shasum -a 256 "$tmp/xray.zip" | awk '{print $1}')"
  [[ "$expected" =~ ^[0-9a-fA-F]{64}$ && "$actual" == "$expected" ]] || die "Xray SHA-256 verification failed"
  unzip -q "$tmp/xray.zip" -d "$tmp/unpacked"
  [[ -x "$tmp/unpacked/xray" ]] || die "Xray archive has no executable"
  mkdir -p "$APP_DIR/bin"
  install -m 755 "$tmp/unpacked/xray" "$XRAY_BIN"
  rm -rf "$tmp"
}
download_singbox() {
  local asset archive_sha tmp expected actual
  case "$(uname -m)" in
    arm64) asset="sing-box-$SINGBOX_VERSION-darwin-arm64.tar.gz"; archive_sha="73e8967b0fc08e17bce4263ca56ebc394822401a16497a1c4e02316c888202ab" ;;
    x86_64) asset="sing-box-$SINGBOX_VERSION-darwin-amd64.tar.gz"; archive_sha="5245d645e847f90bb708da74bc020ae078c28489690756419685c04f56b4e3bb" ;;
    *) die "unsupported macOS architecture" ;;
  esac
  [[ -x "$SINGBOX_BIN" ]] && return 0
  tmp="$(mktemp -d)"
  curl -fsSL "https://github.com/SagerNet/sing-box/releases/download/v$SINGBOX_VERSION/$asset" -o "$tmp/sing-box.tar.gz" || die "cannot download sing-box"
  actual="$(shasum -a 256 "$tmp/sing-box.tar.gz" | awk '{print $1}')"
  [[ "$actual" == "$archive_sha" ]] || die "sing-box SHA-256 verification failed"
  tar -xzf "$tmp/sing-box.tar.gz" -C "$tmp"
  [[ -x "$tmp/sing-box-$SINGBOX_VERSION-darwin-$(uname -m)/sing-box" ]] || die "sing-box archive has no executable"
  mkdir -p "$APP_DIR/bin"
  install -m 755 "$tmp/sing-box-$SINGBOX_VERSION-darwin-$(uname -m)/sing-box" "$SINGBOX_BIN"
  rm -rf "$tmp"
}

write_vpn_config() {
  read_ports || die "Bez proxy ports are unavailable"
  python3 - "$VPN_CONFIG_PATH" "$SOCKS_PORT" <<'PY'
import json
import sys
import os
import tempfile

path, socks_port = sys.argv[1], int(sys.argv[2])
config = {
    "log": {"level": "warn", "timestamp": True},
    "inbounds": [{
        "type": "tun",
        "tag": "tun-in",
        "mtu": 1500,
        "address": ["172.19.0.1/30"],
        "auto_route": True,
        "strict_route": False,
        "stack": "system",
    }],
    "outbounds": [
        {"type": "socks", "tag": "bez-xray", "server": "127.0.0.1", "server_port": socks_port},
        {"type": "direct", "tag": "direct"},
    ],
    "route": {
        "rules": [
            {"inbound": ["tun-in"], "action": "sniff"},
            # Everything Xray itself dials (smart-routing legs and direct legs)
            # must bypass the tunnel, otherwise non-family traffic loops back.
            {"process_name": ["xray"], "outbound": "direct"},
            {"ip_cidr": [
                "127.0.0.0/8", "10.0.0.0/8", "172.16.0.0/12", "192.168.0.0/16",
                "169.254.0.0/16", "224.0.0.0/4", "255.255.255.255/32", "::1/128", "fe80::/10",
                "212.192.31.128/32", "185.240.120.152/32", "95.165.165.65/32", "95.31.7.115/32",
            ], "outbound": "direct"},
        ],
        "final": "bez-xray",
        "auto_detect_interface": True,
    },
}
directory = os.path.dirname(path)
fd, tmp = tempfile.mkstemp(dir=directory, prefix=".vpn-tun.", suffix=".json")
with os.fdopen(fd, "w", encoding="utf-8") as stream:
    json.dump(config, stream, indent=2)
    stream.write("\n")
os.chmod(tmp, 0o600)
os.replace(tmp, path)
PY
  "$SINGBOX_BIN" check -c "$VPN_CONFIG_PATH" >/dev/null || die "sing-box rejected the VPN tunnel config"
}

write_vpn_plist() {
  local tmp
  tmp="$(mktemp)"
  cat > "$tmp" <<PLIST
<?xml version="1.0" encoding="UTF-8"?><plist version="1.0"><dict>
<key>Label</key><string>$VPN_LABEL</string>
<key>ProgramArguments</key><array><string>$SINGBOX_BIN</string><string>run</string><string>-c</string><string>$VPN_CONFIG_PATH</string></array>
<key>RunAtLoad</key><false/><key>KeepAlive</key><false/>
<key>StandardOutPath</key><string>$HOME/Library/Logs/BezVPN-tun.log</string><key>StandardErrorPath</key><string>$HOME/Library/Logs/BezVPN-tun.log</string>
</dict></plist>
PLIST
  plutil -lint "$tmp" >/dev/null || { rm -f "$tmp"; die "VPN daemon plist is invalid"; }
  install -m 644 "$tmp" "$VPN_PLIST_PATH" || { rm -f "$tmp"; die "cannot install $VPN_PLIST_PATH"; }
  rm -f "$tmp"
}

vpn_daemon_loaded() { launchctl print "system/$VPN_LABEL" >/dev/null 2>&1; }

vpn_tunnel_on() {
  need_macos
  if [[ ${"$"}{EUID:-$(id -u)} -ne 0 ]]; then
    exec sudo HOME="$HOME" USER="$USER" "$CLI_PATH" vpn on
  fi
  # Root path must not touch the user launchd domain: it manages ports and the
  # Xray agent for gui/$(id -u) of the logged-in user only.
  installed || die "run bez install first"
  read_ports || die "Bez proxy ports are unavailable"
  port_busy "$SOCKS_PORT" || die "local Xray is not listening on $SOCKS_PORT; run: bez smart --local (as the user)"
  download_singbox
  write_vpn_config
  write_vpn_plist
  if vpn_daemon_loaded; then
    launchctl bootout "system/$VPN_LABEL" >/dev/null 2>&1 || true
    sleep 1
  fi
  launchctl enable "system/$VPN_LABEL" >/dev/null 2>&1 || true
  launchctl bootstrap system "$VPN_PLIST_PATH" || die "cannot bootstrap VPN daemon"
  launchctl kickstart "system/$VPN_LABEL" || { launchctl bootout "system/$VPN_LABEL" >/dev/null 2>&1 || true; die "cannot start VPN daemon"; }
  local i
  for i in $(seq 1 20); do
    pgrep -f "sing-box run -c $VPN_CONFIG_PATH" >/dev/null 2>&1 && break
    sleep 0.5
  done
  pgrep -f "sing-box run -c $VPN_CONFIG_PATH" >/dev/null 2>&1 || { launchctl bootout "system/$VPN_LABEL" >/dev/null 2>&1 || true; die "VPN daemon did not start; see $LOG_PATH and /var/log/system.log"; }
  echo "bez: VPN tunnel enabled (utun via sing-box -> local Xray)"
}

vpn_tunnel_off() {
  need_macos
  if [[ ${"$"}{EUID:-$(id -u)} -ne 0 ]]; then
    exec sudo HOME="$HOME" USER="$USER" "$CLI_PATH" vpn off
  fi
  if vpn_daemon_loaded; then
    launchctl bootout "system/$VPN_LABEL" || true
  fi
  pkill -f "sing-box run -c $VPN_CONFIG_PATH" 2>/dev/null || true
  rm -f "$VPN_PLIST_PATH"
  echo "bez: VPN tunnel disabled"
}

vpn_tunnel_status() {
  if pgrep -f "sing-box run -c $VPN_CONFIG_PATH" >/dev/null 2>&1; then
    echo "VPN tunnel: enabled (utun via sing-box)"
  elif [[ -e "$VPN_PLIST_PATH" ]]; then
    echo "VPN tunnel: installed but not running"
  else
    echo "VPN tunnel: disabled"
  fi
}

vpn_tunnel() {
  local action="${"$"}{1:-status}"
  case "$action" in
    on) vpn_tunnel_on ;;
    off) vpn_tunnel_off ;;
    status) vpn_tunnel_status ;;
    *) die "usage: bez vpn on|off|status" ;;
  esac
}

fetch_config() {
  local mode="$1" use_custom="${"$"}{2:-0}"
  mkdir -p "$APP_DIR"
  ensure_ports
  (
    local auth_file response
    auth_file="$(mktemp)"
    response="$(temp_json .config)"
    trap 'rm -f "$auth_file" "$response"' EXIT
    chmod 600 "$auth_file" "$response"
    printf 'header = "Authorization: Bearer %s"\n' "$CONFIG_TOKEN" > "$auth_file"
    curl --config "$auth_file" -fsSL -H "accept: application/json" "$BASE_URL/api/user/client-xray-config?mode=$mode" -o "$response" || die "cannot download $mode config"
    python3 - "$response" "$SOCKS_PORT" "$HTTP_PORT" <<'PY'
import json
import sys

path, socks_port, http_port = sys.argv[1], int(sys.argv[2]), int(sys.argv[3])
with open(path, encoding="utf-8") as stream:
    config = json.load(stream)
for inbound in config.get("inbounds", []):
    if inbound.get("protocol") == "socks":
        inbound["port"] = socks_port
    elif inbound.get("protocol") == "http":
        inbound["port"] = http_port
with open(path, "w", encoding="utf-8") as stream:
    json.dump(config, stream, separators=(",", ":"))
    stream.write("\n")
PY
    "$XRAY_BIN" run -test -config "$response" >/dev/null || die "Xray rejected the downloaded config"
    chmod 600 "$response"
    mv "$response" "$BASE_CONFIG_PATH" || die "cannot atomically install base config"
    materialize_config "$use_custom"
  )
}
prepare_bundled_config() {
  local mode="$1" use_custom="${"$"}{2:-0}" source response
  source="$APP_DIR/config-$mode.json"
  [[ -f "$source" ]] || source="$CONFIG_PATH"
  [[ -f "$source" ]] || die "bundled config is missing"
  mkdir -p "$APP_DIR"
  ensure_ports
  response="$(temp_json .bundled-config)"
  chmod 600 "$response"
  python3 - "$source" "$response" "$SOCKS_PORT" "$HTTP_PORT" <<'PY'
import json
import sys

source, target, socks_port, http_port = sys.argv[1], sys.argv[2], int(sys.argv[3]), int(sys.argv[4])
with open(source, encoding="utf-8") as stream:
    config = json.load(stream)
for inbound in config.get("inbounds", []):
    if inbound.get("protocol") == "socks":
        inbound["port"] = socks_port
    elif inbound.get("protocol") == "http":
        inbound["port"] = http_port
with open(target, "w", encoding="utf-8") as stream:
    json.dump(config, stream, separators=(",", ":"))
    stream.write("\n")
PY
  "$XRAY_BIN" run -test -config "$response" >/dev/null || die "Xray rejected the bundled config"
  mv "$response" "$BASE_CONFIG_PATH" || die "cannot atomically install bundled base config"
  materialize_config "$use_custom"
}
materialize_config() {
  local use_custom="${"$"}{1:-0}" endpoint_path="${"$"}{2:-$ENDPOINT_STATE}"
  if [[ ! -f "$BASE_CONFIG_PATH" && -f "$CONFIG_PATH" ]]; then
    cp "$CONFIG_PATH" "$BASE_CONFIG_PATH" || die "cannot migrate current Bez config"
    chmod 600 "$BASE_CONFIG_PATH"
  fi
  [[ -f "$BASE_CONFIG_PATH" ]] || die "bez base config is missing"
  local response
  response="$(temp_json .materialized-config)"
  python3 - "$BASE_CONFIG_PATH" "$HEAL_RULES_PATH" "$CUSTOM_POLICY_PATH" "$endpoint_path" "$API_PORT" "$use_custom" "$response" <<'PY'
import json, sys, time
from pathlib import Path

base_path, rules_path, custom_policy_path, endpoint_path, api_port, use_custom, target_path = sys.argv[1:]
base_path, rules_path, custom_policy_path, endpoint_path, target_path = map(Path, (base_path, rules_path, custom_policy_path, endpoint_path, target_path))
config = json.loads(base_path.read_text(encoding="utf-8"))
api_port = int(api_port)
now = int(time.time())
rules = []
if rules_path.exists():
    state = json.loads(rules_path.read_text(encoding="utf-8"))
    for item in state.get("rules", []):
        if item.get("route") == "proxy" and int(item.get("expiresAt", 0)) > now:
            rules.append(item)
    state["rules"] = rules
    rules_path.write_text(json.dumps(state, separators=(",", ":")) + "\n", encoding="utf-8")
routing = config.setdefault("routing", {})
base_rules = routing.setdefault("rules", [])
config["api"] = {"tag": "bez-api", "services": ["RoutingService"]}
config["inbounds"] = [item for item in config.get("inbounds", []) if item.get("tag") != "bez-api"]
config["inbounds"].append({"tag": "bez-api", "listen": "127.0.0.1", "port": api_port, "protocol": "dokodemo-door", "settings": {"address": "127.0.0.1"}})
base_rules[:] = [item for item in base_rules if item.get("ruleTag") != "bez-api"]
base_rules.insert(0, {"ruleTag": "bez-api", "type": "field", "inboundTag": ["bez-api"], "outboundTag": "bez-api"})
balancer_tags = {str(item.get("tag")) for item in routing.get("balancers", [])}
proxy_balancer = "bez-de" if "bez-de" in balancer_tags else "bez-all"
if proxy_balancer not in balancer_tags:
    raise SystemExit("custom policy requires a Bez proxy balancer")
endpoint = endpoint_path.read_text(encoding="utf-8").strip() if endpoint_path.exists() else "auto"
if endpoint != "auto":
    outbound_tags = {str(item.get("tag")) for item in config.get("outbounds", []) if item.get("protocol") == "vless"}
    if endpoint not in outbound_tags:
        raise SystemExit(f"unknown Bez endpoint: {endpoint}")

def hosts(key):
    if use_custom != "1" or not custom_policy_path.exists():
        return []
    policy = json.loads(custom_policy_path.read_text(encoding="utf-8"))
    legacy = {
        "direct": list(policy.get("directSuffixes", [])) + ["=" + value for value in policy.get("directDomains", []) if isinstance(value, str)],
        "proxy": list(policy.get("proxySuffixes", [])) + ["=" + value for value in policy.get("proxyDomains", []) if isinstance(value, str)],
    }
    values = policy.get(key, legacy.get(key, []))
    if not isinstance(values, list) or any(not isinstance(value, str) for value in values):
        raise SystemExit(f"custom policy {key} must be an array of strings")
    normalized = []
    for value in values:
        exact = value.strip().startswith("=")
        host = value.strip().lower().lstrip("=").strip(".")
        if not host or "/" in host or "*" in host or " " in host or host.endswith((".local", ".lan")):
            raise SystemExit(f"invalid custom policy host: {value!r}")
        host = ("=" if exact else "") + host
        if host not in normalized:
            normalized.append(host)
    return normalized

def xray_domains(key):
    return [("full:" if host.startswith("=") else "domain:") + host.lstrip("=") for host in hosts(key)]

custom_block = xray_domains("block")
custom_direct = xray_domains("direct")
custom_proxy = xray_domains("proxy")
heal_overlay = [{"type": "field", "domain": ["full:" + item["host"]], "balancerTag": proxy_balancer} for item in rules]
custom_overlay = []
if custom_block:
    block_tags = [str(item.get("tag")) for item in config.get("outbounds", []) if item.get("protocol") == "blackhole" and item.get("tag")]
    if not block_tags:
        config.setdefault("outbounds", []).append({"tag": "bez-block", "protocol": "blackhole"})
        block_tags = ["bez-block"]
    custom_overlay.append({"type": "field", "domain": custom_block, "outboundTag": block_tags[0]})
if custom_direct:
    custom_overlay.append({"type": "field", "domain": custom_direct, "outboundTag": "direct"})
if custom_proxy:
    custom_overlay.append({"type": "field", "domain": custom_proxy, "balancerTag": proxy_balancer})
routing["rules"] = custom_overlay + heal_overlay + base_rules
if endpoint != "auto":
    for rule in routing["rules"]:
        if rule.pop("balancerTag", None) is not None:
            rule["outboundTag"] = endpoint
target_path.write_text(json.dumps(config, separators=(",", ":")) + "\n", encoding="utf-8")
PY
  "$XRAY_BIN" run -test -config "$response" >/dev/null || { rm -f "$response"; die "Xray rejected custom policy"; }
  chmod 600 "$response"
  mv "$response" "$CONFIG_PATH" || die "cannot atomically install materialized config"
}
materialize_current_config() {
  if [[ "$(state_mode)" == custom ]]; then
    materialize_config 1
  else
    materialize_config 0
  fi
}
write_plist() {
  mkdir -p "$(dirname "$PLIST_PATH")" "$HOME/Library/Logs"
  local tmp
  tmp="$(mktemp)"
  cat > "$tmp" <<PLIST
<?xml version="1.0" encoding="UTF-8"?><plist version="1.0"><dict>
<key>Label</key><string>$LABEL</string>
<key>ProgramArguments</key><array><string>$XRAY_BIN</string><string>run</string><string>-config</string><string>$CONFIG_PATH</string></array>
<key>RunAtLoad</key><true/><key>KeepAlive</key><true/>
<key>StandardOutPath</key><string>$LOG_PATH</string><key>StandardErrorPath</key><string>$LOG_PATH</string>
</dict></plist>
PLIST
  mv "$tmp" "$PLIST_PATH"
  chmod 600 "$PLIST_PATH"
}
write_web_ui() {
  mkdir -p "$APP_DIR"
  cat > "$WEB_UI_PATH" <<'PY'
__BEZ_WEB_UI_PYTHON__
PY
  chmod 700 "$WEB_UI_PATH"
}
write_web_plist() {
  write_web_ui
  mkdir -p "$(dirname "$WEB_PLIST_PATH")" "$HOME/Library/Logs"
  local python_bin tmp
  python_bin="$(command -v python3)"
  [[ -n "$python_bin" ]] || die "python3 is required for the local Bez dashboard"
  tmp="$(mktemp)"
  cat > "$tmp" <<PLIST
<?xml version="1.0" encoding="UTF-8"?><plist version="1.0"><dict>
<key>Label</key><string>$WEB_LABEL</string>
<key>ProgramArguments</key><array><string>$python_bin</string><string>$WEB_UI_PATH</string><string>--port</string><string>$WEB_PORT</string></array>
<key>RunAtLoad</key><true/><key>KeepAlive</key><true/>
<key>StandardOutPath</key><string>$WEB_LOG_PATH</string><key>StandardErrorPath</key><string>$WEB_LOG_PATH</string>
</dict></plist>
PLIST
  mv "$tmp" "$WEB_PLIST_PATH"
  chmod 600 "$WEB_PLIST_PATH"
}
loaded() { launchctl print "$LAUNCH_DOMAIN/$LABEL" >/dev/null 2>&1; }
web_loaded() { launchctl print "$LAUNCH_DOMAIN/$WEB_LABEL" >/dev/null 2>&1; }
tray_loaded() { launchctl print "$LAUNCH_DOMAIN/$TRAY_LABEL" >/dev/null 2>&1; }
write_tray_app() {
  command -v swiftc >/dev/null 2>&1 || { echo "bez: tray requires swiftc (install Xcode Command Line Tools)" >&2; return 1; }
  cat > "$TRAY_SOURCE" <<'SWIFT'
import Cocoa

final class BezTray: NSObject, NSApplicationDelegate {
  private let item = NSStatusBar.system.statusItem(withLength: NSStatusItem.variableLength)
  private let cli = ("~/.local/bin/bez" as NSString).expandingTildeInPath
  private var stateItem: NSMenuItem!
  private var localItem: NSMenuItem!
  private var globalItem: NSMenuItem!
  private var vpnItem: NSMenuItem!
  private var networkItem: NSMenuItem!

  func applicationDidFinishLaunching(_ notification: Notification) {
    item.button?.title = ""
    item.button?.image = statusIcon(mode: "off")
    let menu = NSMenu()
    stateItem = actionItem("Проверка статуса…", #selector(refresh))
    menu.addItem(stateItem)
    networkItem = NSMenuItem(title: "Сеть: проверка…", action: nil, keyEquivalent: "")
    menu.addItem(networkItem)
    menu.addItem(NSMenuItem.separator())
    localItem = actionItem("Local", #selector(local))
    globalItem = actionItem("Global", #selector(global))
    vpnItem = actionItem("VPN tunnel", #selector(toggleVPN))
    menu.addItem(localItem)
    menu.addItem(globalItem)
    menu.addItem(vpnItem)
    menu.addItem(actionItem("Выключить всё", #selector(off)))
    menu.addItem(NSMenuItem.separator())
    menu.addItem(actionItem("Открыть Bez", #selector(openWeb)))
    menu.addItem(actionItem("Выйти из меню", #selector(quit)))
    item.menu = menu
    refresh()
    Timer.scheduledTimer(timeInterval: 5, target: self, selector: #selector(refresh), userInfo: nil, repeats: true)
  }

  private func statusIcon(mode: String) -> NSImage {
    let size = NSSize(width: 18, height: 18)
    let image = NSImage(size: size)
    image.lockFocus()
    defer { image.unlockFocus() }

    let color = NSColor.labelColor
    if mode == "off" {
      let path = NSBezierPath(ovalIn: NSRect(x: 4.0, y: 4.0, width: 10.0, height: 10.0))
      path.lineWidth = 1.8
      color.setStroke()
      path.stroke()
    } else {
      let paragraph = NSMutableParagraphStyle()
      paragraph.alignment = .center
      let attrs: [NSAttributedString.Key: Any] = [
        .font: NSFont.systemFont(ofSize: 11, weight: .semibold),
        .foregroundColor: color,
        .paragraphStyle: paragraph
      ]
      ("B" as NSString).draw(in: NSRect(x: 1, y: 6, width: 16, height: 11), withAttributes: attrs)

      color.setStroke()
      color.setFill()
      if mode == "local" {
        let mark = NSBezierPath()
        mark.move(to: NSPoint(x: 6, y: 4))
        mark.line(to: NSPoint(x: 12, y: 4))
        mark.lineWidth = 1.8
        mark.stroke()
      } else if mode == "global" {
        NSBezierPath(ovalIn: NSRect(x: 7, y: 2.5, width: 4, height: 4)).fill()
      } else if mode == "vpn" {
        let mark = NSBezierPath()
        mark.move(to: NSPoint(x: 5.5, y: 4))
        mark.line(to: NSPoint(x: 8, y: 2.2))
        mark.line(to: NSPoint(x: 12.5, y: 6.2))
        mark.lineWidth = 1.7
        mark.lineCapStyle = .round
        mark.lineJoinStyle = .round
        mark.stroke()
      }
    }
    image.isTemplate = true
    return image
  }

  private func actionItem(_ title: String, _ action: Selector) -> NSMenuItem {
    let menuItem = NSMenuItem(title: title, action: action, keyEquivalent: "")
    menuItem.target = self
    return menuItem
  }

  private func shell(_ command: String) -> String {
    let process = Process()
    let pipe = Pipe()
    process.executableURL = URL(fileURLWithPath: "/bin/bash")
    process.arguments = ["-lc", command]
    process.standardOutput = pipe
    process.standardError = Pipe()
    do { try process.run(); process.waitUntilExit() } catch { return "" }
    return String(data: pipe.fileHandleForReading.readDataToEndOfFile(), encoding: .utf8) ?? ""
  }

  private func run(_ command: String) {
    DispatchQueue.global(qos: .userInitiated).async {
      _ = self.shell("\(self.cli) \(command) >/dev/null 2>&1")
      DispatchQueue.main.asyncAfter(deadline: .now() + 0.3) { self.refresh() }
    }
  }

  @objc private func refresh() {
    DispatchQueue.global(qos: .utility).async {
      let text = self.shell("\(self.cli) status 2>/dev/null")
      let running = text.contains("Состояние: запущен")
      let global = text.contains("Область: Global (системный proxy macOS)")
      let vpn = text.contains("VPN tunnel: enabled")
      let profile = text.split(separator: "\n").first(where: { $0.hasPrefix("Профиль: ") })?.replacingOccurrences(of: "Профиль: ", with: "") ?? "—"
      let mode: String
      let detail: String
      if vpn { mode = "vpn"; detail = "VPN tunnel · \(profile)" }
      else if running && global { mode = "global"; detail = "Global · \(profile)" }
      else if running { mode = "local"; detail = "Local · \(profile)" }
      else { mode = "off"; detail = "Выключен" }
      let route = self.shell("route -n get default 2>/dev/null")
      let home = route.contains("gateway: 192.168.2.1")
      DispatchQueue.main.async {
        self.item.button?.title = ""
        self.item.button?.image = self.statusIcon(mode: mode)
        self.stateItem.title = "Статус: \(detail)"
        self.networkItem.title = home ? "Сеть: ⌂ Домашняя" : "Сеть: Внешняя"
        self.localItem.state = running && !global && !vpn ? .on : .off
        self.globalItem.state = running && global && !vpn ? .on : .off
        self.vpnItem.state = vpn ? .on : .off
        self.vpnItem.title = vpn ? "VPN tunnel — выключить" : "VPN tunnel — включить"
      }
    }
  }

  @objc private func openWeb() { run("web"); NSWorkspace.shared.open(URL(string: "http://127.0.0.1:28110/")!) }
  @objc private func local() { run("smart --local") }
  @objc private func global() { run("smart --global") }
  @objc private func toggleVPN() { run(vpnItem.state == .on ? "vpn off" : "vpn on") }
  @objc private func off() { run("vpn off; \(cli) off") }
  @objc private func quit() { NSApp.terminate(nil) }
}
let app = NSApplication.shared
let delegate = BezTray()
app.delegate = delegate
app.setActivationPolicy(.accessory)
app.run()
SWIFT
  swiftc "$TRAY_SOURCE" -o "$TRAY_BIN" || return 1
  local tmp
  tmp="$(mktemp)"
  cat > "$tmp" <<PLIST
<?xml version="1.0" encoding="UTF-8"?><!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd"><plist version="1.0"><dict><key>Label</key><string>$TRAY_LABEL</string><key>ProgramArguments</key><array><string>$TRAY_BIN</string></array><key>RunAtLoad</key><true/><key>KeepAlive</key><true/><key>StandardOutPath</key><string>$HOME/Library/Logs/BezVPN-tray.log</string><key>StandardErrorPath</key><string>$HOME/Library/Logs/BezVPN-tray.log</string></dict></plist>
PLIST
  mv "$tmp" "$TRAY_PLIST_PATH"; chmod 600 "$TRAY_PLIST_PATH"
}
start_tray() {
  write_tray_app || return 0
  if tray_loaded; then launchctl kickstart -k "$LAUNCH_DOMAIN/$TRAY_LABEL"; else launchctl bootstrap "$LAUNCH_DOMAIN" "$TRAY_PLIST_PATH"; fi
}
start_daemon() {
  if loaded; then
    launchctl kickstart -k "$LAUNCH_DOMAIN/$LABEL"
  else
    launchctl bootstrap "$LAUNCH_DOMAIN" "$PLIST_PATH"
  fi
}
restart_daemon() {
  if loaded; then
    launchctl bootout "$LAUNCH_DOMAIN/$LABEL" >/dev/null 2>&1 || true
    for _ in $(seq 1 20); do loaded || break; sleep 0.25; done
  fi
  start_daemon
}
start_web_daemon() {
  # launchd caches the loaded plist, so an updated --port needs a full
  # bootout/bootstrap cycle; kickstart -k would keep the stale port.
  if web_loaded; then
    launchctl bootout "$LAUNCH_DOMAIN/$WEB_LABEL" >/dev/null 2>&1 || true
    for _ in $(seq 1 20); do web_loaded || break; sleep 0.25; done
  fi
  launchctl bootstrap "$LAUNCH_DOMAIN" "$WEB_PLIST_PATH"
}
wait_web() {
  for _ in $(seq 1 20); do
    if curl -fsS --max-time 1 "http://127.0.0.1:$WEB_PORT/" >/dev/null 2>&1; then return 0; fi
    sleep 0.25
  done
  die "local dashboard did not start; see $WEB_LOG_PATH"
}
network_services() {
  networksetup -listallnetworkservices | awk 'NR > 1 && $0 !~ /^\*/ && length($0) { print }'
}
active_network_services() {
  local active_devices
  active_devices="$(scutil --nwi 2>/dev/null | awk '/^Network interfaces:/ { for (i = 3; i <= NF; i++) print $i }')"
  [[ -n "$active_devices" ]] || return 0
  networksetup -listnetworkserviceorder | awk '
    /^\([0-9]+\)/ { service = $0; sub(/^\([0-9]+\) /, "", service); next }
    /Device: / { device = $0; sub(/.*Device: /, "", device); sub(/\).*/, "", device); print service "\t" device }
  ' | while IFS=$'\t' read -r service device; do
    grep -Fxq "$device" <<< "$active_devices" && printf '%s\n' "$service"
  done
}
proxy_enabled() {
  networksetup "$1" "$2" 2>/dev/null | awk -F': ' '$1 == "Enabled" { print $2; exit }'
}
proxy_field() {
  networksetup "$1" "$2" 2>/dev/null | awk -F': ' -v field="$3" '$1 == field { print $2; exit }'
}
proxy_mode() {
  local mode="http"
  if [[ -r "$PROXY_MODE_STATE" ]]; then
    mode="$(sed -n 's/^mode=//p' "$PROXY_MODE_STATE" | head -n 1)"
  fi
  [[ "$mode" == http || "$mode" == socks ]] || mode=http
  printf '%s\n' "$mode"
}

system_proxy_active() {
  local service checked=0 web_state web_server web_port secure_state secure_server secure_port socks_state socks_server socks_port
  if [[ "$(proxy_mode)" == socks ]]; then
    while IFS= read -r service; do
      socks_state="$(proxy_enabled -getsocksfirewallproxy "$service")"
      socks_server="$(proxy_field -getsocksfirewallproxy "$service" Server)"
      socks_port="$(proxy_field -getsocksfirewallproxy "$service" Port)"
      [[ -n "$socks_state" ]] || continue
      checked=$((checked + 1))
      [[ "$socks_state" == Yes && "$socks_server" == 127.0.0.1 && "$socks_port" == "$SOCKS_PORT" ]] || return 1
    done < <(active_network_services)
    (( checked > 0 ))
    return
  fi
  while IFS= read -r service; do
    web_state="$(proxy_enabled -getwebproxy "$service")"
    web_server="$(proxy_field -getwebproxy "$service" Server)"
    web_port="$(proxy_field -getwebproxy "$service" Port)"
    secure_state="$(proxy_enabled -getsecurewebproxy "$service")"
    secure_server="$(proxy_field -getsecurewebproxy "$service" Server)"
    secure_port="$(proxy_field -getsecurewebproxy "$service" Port)"
    [[ -n "$web_state$secure_state" ]] || continue
    checked=$((checked + 1))
    [[ "$web_state" == Yes && "$web_server" == 127.0.0.1 && "$web_port" == "$HTTP_PORT" ]] || return 1
    [[ "$secure_state" == Yes && "$secure_server" == 127.0.0.1 && "$secure_port" == "$HTTP_PORT" ]] || return 1
  done < <(active_network_services)
  (( checked > 0 ))
}
snapshot_proxies() {
  if [[ -r "$PROXY_STATE" ]] && awk 'NR > 1 && NF { found = 1; exit } END { exit !found }' "$PROXY_STATE"; then return 0; fi
  mkdir -p "$APP_DIR"
  printf '# bez-proxy-state-v2\n' > "$PROXY_STATE"
  local service web_state web_server web_port secure_state secure_server secure_port socks_state socks_server socks_port
  while IFS= read -r service; do
    web_state="$(proxy_enabled -getwebproxy "$service")"
    web_server="$(proxy_field -getwebproxy "$service" Server)"
    web_port="$(proxy_field -getwebproxy "$service" Port)"
    secure_state="$(proxy_enabled -getsecurewebproxy "$service")"
    secure_server="$(proxy_field -getsecurewebproxy "$service" Server)"
    secure_port="$(proxy_field -getsecurewebproxy "$service" Port)"
    socks_state="$(proxy_enabled -getsocksfirewallproxy "$service")"
    socks_server="$(proxy_field -getsocksfirewallproxy "$service" Server)"
    socks_port="$(proxy_field -getsocksfirewallproxy "$service" Port)"
    printf '%s\t%s\t%s\t%s\t%s\t%s\t%s\t%s\t%s\t%s\n' "$service" "$web_state" "$web_server" "$web_port" "$secure_state" "$secure_server" "$secure_port" "$socks_state" "$socks_server" "$socks_port" >> "$PROXY_STATE"
  done < <(active_network_services)
  chmod 600 "$PROXY_STATE"
}
is_bez_proxy() {
  local getter="$1" service="$2" port="$3"
  [[ "$(proxy_field "$getter" "$service" Server)" == 127.0.0.1 && "$(proxy_field "$getter" "$service" Port)" == "$port" ]]
}
clear_legacy_bez_proxies() {
  local service
  while IFS= read -r service; do
    if is_bez_proxy -getwebproxy "$service" "$HTTP_PORT"; then networksetup -setwebproxystate "$service" off >/dev/null 2>&1 || true; fi
    if is_bez_proxy -getsecurewebproxy "$service" "$HTTP_PORT"; then networksetup -setsecurewebproxystate "$service" off >/dev/null 2>&1 || true; fi
    if is_bez_proxy -getsocksfirewallproxy "$service" "$SOCKS_PORT"; then networksetup -setsocksfirewallproxystate "$service" off >/dev/null 2>&1 || true; fi
  done < <(network_services)
}
apply_proxies() {
  clear_legacy_bez_proxies
  snapshot_proxies
  local service failed=0 mode
  mode="$(proxy_mode)"
  if [[ "$mode" == socks ]]; then
    while IFS= read -r service; do
      networksetup -setsocksfirewallproxy "$service" 127.0.0.1 "$SOCKS_PORT" || failed=1
      networksetup -setsocksfirewallproxystate "$service" on || failed=1
      networksetup -setwebproxystate "$service" off >/dev/null 2>&1 || true
      networksetup -setsecurewebproxystate "$service" off >/dev/null 2>&1 || true
    done < <(active_network_services)
    if (( failed )); then
      echo "bez: some macOS services rejected SOCKS proxy settings" >&2
      echo "bez: manual: networksetup -setsocksfirewallproxy <service> 127.0.0.1 $SOCKS_PORT" >&2
      return 1
    fi
    return 0
  fi
  while IFS= read -r service; do
    networksetup -setwebproxy "$service" 127.0.0.1 "$HTTP_PORT" || failed=1
    networksetup -setsecurewebproxy "$service" 127.0.0.1 "$HTTP_PORT" || failed=1
    networksetup -setwebproxystate "$service" on || failed=1
    networksetup -setsecurewebproxystate "$service" on || failed=1
    networksetup -setsocksfirewallproxystate "$service" off >/dev/null 2>&1 || true
  done < <(active_network_services)
  if (( failed )); then
    echo "bez: some macOS services rejected proxy settings" >&2
    echo "bez: manual: networksetup -setwebproxy <service> 127.0.0.1 $HTTP_PORT" >&2
    return 1
  fi
}

proxy_mode_bez() {
  local mode="${"$"}{1:-}"
  if [[ -z "$mode" ]]; then
    echo "proxy mode: $(proxy_mode)"
    return 0
  fi
  [[ "$mode" == http || "$mode" == socks ]] || die "usage: bez proxy-mode [http|socks]"
  mkdir -p "$APP_DIR"
  printf 'mode=%s\n' "$mode" > "$PROXY_MODE_STATE"
  chmod 600 "$PROXY_MODE_STATE"
  if [[ -e "$PROXY_STATE" ]]; then
    read_ports || die "Bez proxy ports are unavailable"
    apply_proxies || return 1
    echo "bez: system proxy mode set to $mode and applied"
  else
    echo "bez: system proxy mode set to $mode (applies on next --global activation)"
  fi
}
restore_proxies() {
  [[ -r "$PROXY_STATE" ]] || return 0
  local line service web_state web_server web_port secure_state secure_server secure_port socks_state socks_server socks_port
  while IFS= read -r line; do
    [[ "$line" == \#* || -z "$line" ]] && continue
    if [[ "$(awk -F '\t' '{ print NF }' <<< "$line")" -ge 10 ]]; then
      IFS=$'\t' read -r service web_state web_server web_port secure_state secure_server secure_port socks_state socks_server socks_port <<< "$line"
    else
      local legacy_web legacy_secure legacy_socks
      IFS=$'\t' read -r service legacy_web legacy_secure legacy_socks <<< "$line"
      web_state="$legacy_web"
      secure_state="$legacy_secure"
      socks_state="$legacy_socks"
      web_server=""; web_port=""; secure_server=""; secure_port=""; socks_server=""; socks_port=""
    fi
    [[ -n "$service" ]] || continue
    if [[ -n "$web_server" && "$web_port" =~ ^[0-9]+$ ]]; then networksetup -setwebproxy "$service" "$web_server" "$web_port" >/dev/null 2>&1 || true; fi
    if [[ -n "$secure_server" && "$secure_port" =~ ^[0-9]+$ ]]; then networksetup -setsecurewebproxy "$service" "$secure_server" "$secure_port" >/dev/null 2>&1 || true; fi
    if [[ -n "$socks_server" && "$socks_port" =~ ^[0-9]+$ ]]; then networksetup -setsocksfirewallproxy "$service" "$socks_server" "$socks_port" >/dev/null 2>&1 || true; fi
    case "$web_state" in Yes|yes|on|On) web_state=on ;; *) web_state=off ;; esac
    case "$secure_state" in Yes|yes|on|On) secure_state=on ;; *) secure_state=off ;; esac
    case "$socks_state" in Yes|yes|on|On) socks_state=on ;; *) socks_state=off ;; esac
    networksetup -setwebproxystate "$service" "$web_state" >/dev/null 2>&1 || true
    networksetup -setsecurewebproxystate "$service" "$secure_state" >/dev/null 2>&1 || true
    networksetup -setsocksfirewallproxystate "$service" "$socks_state" >/dev/null 2>&1 || true
  done < "$PROXY_STATE"
  rm -f "$PROXY_STATE"
}
wait_proxy() {
  for _ in $(seq 1 120); do
    if nc -z 127.0.0.1 "$SOCKS_PORT" >/dev/null 2>&1 && nc -z 127.0.0.1 "$HTTP_PORT" >/dev/null 2>&1; then return 0; fi
    sleep 0.25
  done
  echo "bez: Xray did not open local proxy ports; see bez logs" >&2
  return 1
}
wait_traffic() {
  local mode="$1" code exit_ip probe_url
  # Probe through the same proxy kind that is about to become the system proxy,
  # so a broken SOCKS (or HTTP) path can never be applied to macOS settings.
  local probe_proxy="http://127.0.0.1:$HTTP_PORT"
  if [[ "$(proxy_mode)" == socks ]]; then
    probe_proxy="socks5h://127.0.0.1:$SOCKS_PORT"
  fi
  for _ in $(seq 1 10); do
    code="$(curl --silent --show-error --max-time 8 --proxy "$probe_proxy" -o /dev/null -w '%{http_code}' https://t.me/ 2>/dev/null || true)"
    if [[ "$code" =~ ^(2|3) ]]; then
      if [[ "$mode" != all ]]; then return 0; fi
      exit_ip="$(curl --silent --show-error --max-time 8 --proxy "$probe_proxy" https://api.ipify.org 2>/dev/null || true)"
      [[ -n "$exit_ip" ]] && return 0
    fi
    sleep 2
  done
  echo "bez: proxy ports opened but traffic is not ready; see bez logs" >&2
  return 1
}
activate() {
  local mode="$1" config_mode="$1" use_custom=0 offline="" system_proxy=1 option
  if [[ "$mode" == custom ]]; then
    config_mode=smart
    use_custom=1
  fi
  if bundle_mode; then
    offline=--offline
    system_proxy=0
  fi
  shift
  while [[ $# -gt 0 ]]; do
    option="$1"
    case "$option" in
      --offline) offline=--offline ;;
      --local|--no-system-proxy) system_proxy=0 ;;
      --global) system_proxy=1 ;;
      *) die "unknown activation option: $option" ;;
    esac
    shift
  done
  installed || die "run bez install first"
  case "$offline" in
    "") fetch_config "$config_mode" "$use_custom" ;;
    --offline) prepare_bundled_config "$config_mode" "$use_custom" ;;
    *) die "unknown activation option: $offline" ;;
  esac
  printf 'mode=%s\n' "$mode" > "$STATE_PATH"
  restart_daemon
  wait_proxy
  wait_traffic "$mode"
  if (( system_proxy )); then
    apply_proxies
    echo "bez: $mode enabled (macOS system proxy, no root)"
  else
    echo "bez: $mode enabled (local proxy only; macOS system settings unchanged)"
    echo "bez: run: eval \"\$(bez proxy)\""
  fi
}
install_bez() {
  need_macos
  if bundle_mode; then
    prepare_bundled_config smart
    write_plist
    write_web_plist
    printf 'mode=smart\n' > "$STATE_PATH"
    start_daemon
    start_web_daemon
    wait_web
    wait_proxy
    echo "bez: bundled smart mode enabled (local proxy only; no network or root required)"
    return 0
  fi
  echo "bez: passwordless rootless mode; no sudo or VPN password is required"
  echo "bez: Xray will run as your user and macOS proxy settings will be changed for your user"
  mkdir -p "$APP_DIR"
  download_xray
  fetch_config smart
  write_plist
  write_web_plist
  printf 'mode=smart\n' > "$STATE_PATH"
  start_daemon
  start_web_daemon
  wait_web
  start_tray
  wait_proxy
  apply_proxies
  echo "bez: installed and smart mode enabled"
}
update_bez() {
  need_macos
  installed || die "run bez install first"
  local mode
  mode="$(state_mode)"
  if bundle_mode; then
    die "офлайн-бандл не скачивает конфигурацию: установи новый private release для обновления"
  fi
  if [[ "$mode" == custom ]]; then
    fetch_config smart 1
  else
    fetch_config "$mode" 0
  fi
  restart_daemon
  write_web_plist
  start_web_daemon
  wait_web
  wait_proxy
  if [[ -e "$PROXY_STATE" ]]; then ensure_requested_scope; fi
  echo "bez: $mode config updated"
}
off_bez() {
  need_macos
  if loaded; then launchctl bootout "$LAUNCH_DOMAIN/$LABEL" >/dev/null 2>&1 || true; fi
  restore_proxies
  echo "bez: off; previous macOS proxy settings restored"
}
status_bez() {
  need_macos
  read_ports || true
  echo "Bez — текущий статус"
  if loaded; then
    echo "Состояние: запущен"
  else
    echo "Состояние: выключен"
  fi
  echo "Профиль: $(state_mode)"
  if [[ -e "$PROXY_STATE" ]]; then
    if system_proxy_active; then
      echo "Область: Global (системный proxy macOS)"
    else
      echo "Область: Global requested, proxy is not applied"
    fi
  else
    echo "Область: Local (только приложения с proxy)"
  fi
  echo "HTTP/HTTPS: 127.0.0.1:$HTTP_PORT (системный proxy только в Global)"
  echo "SOCKS (только для приложений): 127.0.0.1:$SOCKS_PORT"
  echo "Режим системного proxy (Global): $(proxy_mode)"
  vpn_tunnel_status
  echo "DNS: системный resolver не меняется; Smart — policy через Xray"
  if [[ -r "$ENDPOINT_STATE" && "$(cat "$ENDPOINT_STATE")" != auto ]]; then
    echo "Endpoint: $(cat "$ENDPOINT_STATE") (ручной выбор)"
  else
    echo "Endpoint: Auto (leastPing)"
    local active
    active="$(active_endpoint_selection || true)"
    [[ -n "$active" ]] && echo "Active endpoint: $active"
  fi
  echo "Web: http://127.0.0.1:$WEB_PORT"
  echo "Custom policy: $CUSTOM_POLICY_PATH"
}
endpoint_candidates() {
  python3 - "$BASE_CONFIG_PATH" <<'PY'
import json, sys
from pathlib import Path

path = Path(sys.argv[1])
if not path.exists():
    raise SystemExit("bez base config is missing")
config = json.loads(path.read_text(encoding="utf-8"))
for outbound in config.get("outbounds", []):
    if outbound.get("protocol") == "vless" and outbound.get("tag"):
        print(outbound["tag"])
PY
}
active_endpoint_selection() {
  loaded || return 0
  local tags
  tags="$(python3 - "$CONFIG_PATH" <<'PY'
import json, sys
from pathlib import Path

path = Path(sys.argv[1])
if path.exists():
    config = json.loads(path.read_text(encoding="utf-8"))
    print(" ".join(str(item["tag"]) for item in config.get("routing", {}).get("balancers", []) if item.get("tag")))
PY
)"
  [[ -n "$tags" ]] || return 0
  # Xray's local RoutingService reports the actual leastPing winner.
  "$XRAY_BIN" api bi --server="127.0.0.1:$API_PORT" --timeout=1 $tags 2>/dev/null \
    | awk '/^[[:space:]]+[0-9]+[[:space:]]+[^[:space:]]+[[:space:]]*$/ { values = values (values ? ", " : "") $2 } END { print values }'
}
endpoint_selection() {
  if [[ -r "$ENDPOINT_STATE" ]]; then
    head -n 1 "$ENDPOINT_STATE"
  else
    echo auto
  fi
}
set_endpoint_bez() {
  local endpoint="$1" previous tmp
  installed || die "run bez install first"
  read_ports || die "Bez proxy ports are unavailable"
  if [[ "$endpoint" != auto ]] && ! endpoint_candidates | grep -Fxq "$endpoint"; then
    die "unknown endpoint '$endpoint'; run: bez endpoint list"
  fi
  previous="$(endpoint_selection)"
  tmp="$(mktemp "$APP_DIR/.endpoint.XXXXXX")"
  printf '%s\n' "$endpoint" > "$tmp"
  chmod 600 "$tmp"
  if [[ "$(state_mode)" == custom ]]; then
    materialize_config 1 "$tmp"
  else
    materialize_config 0 "$tmp"
  fi
  mv "$tmp" "$ENDPOINT_STATE"
  if ! restart_daemon || ! wait_proxy || ! wait_traffic "$(state_mode)"; then
    printf '%s\n' "$previous" > "$ENDPOINT_STATE"
    chmod 600 "$ENDPOINT_STATE"
    materialize_current_config
    restart_daemon
    wait_proxy || true
    die "endpoint '$endpoint' did not pass the traffic check; restored '$previous'"
  fi
  if [[ "$endpoint" == auto ]]; then
    echo "bez: endpoint selection is Auto (leastPing)"
  else
    echo "bez: endpoint pinned to $endpoint"
  fi
}
endpoint_bez() {
  local action="${"$"}{1:-status}"
  case "$action" in
    status) endpoint_selection ;;
    list) endpoint_candidates ;;
    auto) set_endpoint_bez auto ;;
    *) set_endpoint_bez "$action" ;;
  esac
}
telemetry_bez() {
  local action="${"$"}{1:-status}"
  case "$action" in
    on) printf 'on\n' > "$TELEMETRY_STATE"; chmod 600 "$TELEMETRY_STATE"; echo "bez: телеметрия endpoint-проверок включена" ;;
    off) printf 'off\n' > "$TELEMETRY_STATE"; chmod 600 "$TELEMETRY_STATE"; echo "bez: телеметрия endpoint-проверок выключена" ;;
    status) [[ -r "$TELEMETRY_STATE" && "$(head -n 1 "$TELEMETRY_STATE")" == off ]] && echo off || echo on ;;
    *) die "usage: bez telemetry [on|off|status]" ;;
  esac
}
web_bez() {
  installed || die "run bez install first"
  if ! nc -z 127.0.0.1 "$API_PORT" >/dev/null 2>&1; then
    read_ports || die "Bez proxy ports are unavailable"
    materialize_current_config
    restart_daemon
    wait_proxy
  fi
  write_web_plist
  start_web_daemon
  wait_web
  open "http://127.0.0.1:$WEB_PORT/"
  echo "bez: local dashboard opened at http://127.0.0.1:$WEB_PORT/"
}
logs_bez() { [[ -f "$LOG_PATH" ]] && tail -n 100 "$LOG_PATH" || echo "bez: no log yet"; }
proxy_bez() {
  ensure_ports
  echo "export http_proxy=http://127.0.0.1:$HTTP_PORT"
  echo "export https_proxy=http://127.0.0.1:$HTTP_PORT"
  echo "export all_proxy=socks5h://127.0.0.1:$SOCKS_PORT"
  echo "export HTTP_PROXY=http://127.0.0.1:$HTTP_PORT"
  echo "export HTTPS_PROXY=http://127.0.0.1:$HTTP_PORT"
  echo "export ALL_PROXY=socks5h://127.0.0.1:$SOCKS_PORT"
}
activate_local_bez() {
  local mode="$1"
  if bundle_mode; then
    activate "$mode" --offline --local
  else
    activate "$mode" --local
  fi
}
restore_requested_scope() {
  local mode
  mode="$(state_mode)"
  if [[ -e "$PROXY_STATE" ]]; then
    if bundle_mode; then
      activate "$mode" --offline --global
    else
      activate "$mode" --global
    fi
  elif bundle_mode; then
    activate "$mode" --offline --local
  else
    activate "$mode" --local
  fi
}
ensure_requested_scope() {
  [[ -e "$PROXY_STATE" ]] || return 0
  read_ports || die "Bez proxy ports are unavailable"
  if ! system_proxy_active; then
    apply_proxies
  fi
}
check_bez() {
  need_macos
  installed || die "сначала выбери установку в меню или выполни bez install"
  if ! loaded; then restore_requested_scope; fi
  ensure_requested_scope
  ensure_ports
  echo "Проверка Telegram через HTTP proxy 127.0.0.1:$HTTP_PORT"
  local label url code attempt failed=0
  while IFS='|' read -r label url; do
    code=000
    for attempt in 1 2 3 4 5 6; do
      code="$(curl -sS -o /dev/null --proxy "http://127.0.0.1:$HTTP_PORT" --connect-timeout 10 --max-time 20 -w '%{http_code}' "$url" 2>/dev/null || printf '000')"
      [[ "$code" =~ ^(2|3|401|403) ]] && break
      if (( attempt < 6 )); then sleep 3; fi
    done
    case "$code" in
      2*|3*|401|403) echo "✓ $label: HTTP $code" ;;
      *) echo "✗ $label: HTTP $code (проверь 'bez logs')"; failed=$((failed + 1)) ;;
    esac
  done <<'CHECKS'
Telegram|https://t.me/
CHECKS
  if (( failed > 0 )); then
    echo "Проверка завершена с ошибками" >&2
    return 1
  fi
  if [[ "$(state_mode)" == all ]]; then
    local exit_ip
    exit_ip="$(curl -4 -sS --proxy "http://127.0.0.1:$HTTP_PORT" --connect-timeout 10 --max-time 20 https://api.ipify.org 2>/dev/null || true)"
    [[ "$exit_ip" =~ ^[0-9a-fA-F:.]+$ ]] || { echo "Не удалось получить VPN exit IP" >&2; return 1; }
    echo "VPN exit IP: $exit_ip"
  else
    echo "Smart: Telegram проверен через policy. VPN exit IP показывается только в Full."
  fi
  echo "Проверка завершена успешно"
}
cline_bez() {
  need_macos
  installed || die "сначала выбери установку в меню или выполни bez install"
  if ! loaded; then restore_requested_scope; fi
  ensure_requested_scope
  ensure_ports
  cat <<EOF
Cline / VS Code через Bez

SmartDNS на этом Mac не нужен: Cline должен использовать локальный HTTP proxy.

HTTP proxy:  http://127.0.0.1:$HTTP_PORT
SOCKS5:      127.0.0.1:$SOCKS_PORT

Для VS Code открой Settings → Open User Settings (JSON) и добавь:
{
  "http.proxy": "http://127.0.0.1:$HTTP_PORT",
  "http.proxySupport": "override"
}

Для браузерного расширения выбери SOCKS5, адрес 127.0.0.1, порт $SOCKS_PORT.
Для CLI в текущем терминале выполни:
  eval "\$(bez proxy)"

Проверка:
  bez check
EOF
}
ensure_custom_policy() {
  [[ -f "$CUSTOM_POLICY_PATH" ]] && return 0
  mkdir -p "$APP_DIR"
  local tmp
  tmp="$(temp_json .custom-policy)"
  cat > "$tmp" <<'JSON'
{
  "block": [],
  "direct": [],
  "proxy": []
}
JSON
  chmod 600 "$tmp"
  mv "$tmp" "$CUSTOM_POLICY_PATH"
}
custom_policy_bez() {
  local action="${"$"}{1:-show}"
  ensure_custom_policy
  case "$action" in
    show) cat "$CUSTOM_POLICY_PATH" ;;
    path) echo "$CUSTOM_POLICY_PATH" ;;
    edit)
      if [[ -n "${"$"}{EDITOR:-}" ]]; then "$EDITOR" "$CUSTOM_POLICY_PATH"; else open -e "$CUSTOM_POLICY_PATH"; fi
      echo "Сохрани файл и выполни bez custom local или bez custom global, чтобы применить изменения."
      ;;
    web)
      open "$BASE_URL/admin/smart-dns"
      echo "Открыт редактор общей Smart-политики. Локальный Custom-файл: $CUSTOM_POLICY_PATH"
      ;;
    *) die "usage: bez custom [local|global|show|path|edit|web]" ;;
  esac
}
custom_bez() {
  local action="${"$"}{1:-global}"
  case "$action" in
    local) activate custom --local ;;
    global) activate custom --global ;;
    show|path|edit|web) custom_policy_bez "$action" ;;
    *) die "usage: bez custom [local|global|show|path|edit|web]" ;;
  esac
}
heal_host() {
  python3 - "$1" <<'PY'
import ipaddress, sys
from urllib.parse import urlparse

raw = sys.argv[1]
parsed = urlparse(raw if "://" in raw else "https://" + raw)
if parsed.scheme != "https" or parsed.username or parsed.password or parsed.port not in (None, 443):
    raise SystemExit(2)
host = (parsed.hostname or "").lower().rstrip(".")
try:
    ipaddress.ip_address(host)
    raise SystemExit(2)
except ValueError:
    pass
if not host or host == "localhost" or host.endswith((".local", ".lan")) or "*" in host or "." not in host:
    raise SystemExit(2)
print(host)
PY
}
heal_audit() { printf '%s\t%s\t%s\n' "$(date -u +%FT%TZ)" "$1" "$2" >> "$HEAL_AUDIT_PATH"; chmod 600 "$HEAL_AUDIT_PATH"; }
heal_add_proxy() {
  local host="$1"
  python3 - "$HEAL_RULES_PATH" "$host" <<'PY'
import json, sys, time
from pathlib import Path

path, host = Path(sys.argv[1]), sys.argv[2]
state = json.loads(path.read_text(encoding="utf-8")) if path.exists() else {"enabled": True, "rules": []}
now = int(time.time())
rules = [item for item in state.get("rules", []) if int(item.get("expiresAt", 0)) > now and item.get("host") != host]
if len(rules) >= 25:
    raise SystemExit("bez heal: maximum of 25 local rules reached")
rules.append({"host": host, "route": "proxy", "createdAt": now, "expiresAt": now + 86400, "directFailures": 2, "proxySuccesses": 2})
state["enabled"] = True
state["rules"] = rules
path.write_text(json.dumps(state, separators=(",", ":")) + "\n", encoding="utf-8")
PY
  chmod 600 "$HEAL_RULES_PATH"
  materialize_current_config
  restart_daemon
  wait_proxy
}
heal_remove_proxy() {
  local host="$1"
  python3 - "$HEAL_RULES_PATH" "$host" <<'PY'
import json, sys
from pathlib import Path
p = Path(sys.argv[1])
if p.exists():
    state = json.loads(p.read_text(encoding="utf-8"))
    state["rules"] = [r for r in state.get("rules", []) if r.get("host") != sys.argv[2]]
    p.write_text(json.dumps(state, separators=(",", ":")) + "\n", encoding="utf-8")
PY
  materialize_current_config
  restart_daemon
  wait_proxy
}
heal_test() {
  local url="$1" host direct_ok=0 proxy_ok=0 code
  host="$(heal_host "$url")" || die "heal accepts one public HTTPS hostname on port 443"
  installed || die "run bez install first"
  read_ports || die "Bez proxy ports are unavailable"
  for _ in 1 2; do
    code="$(curl -4 -sS -o /dev/null --noproxy '*' --connect-timeout 5 --max-time 5 -w '%{http_code}' "$url" 2>/dev/null || printf 000)"
    [[ "$code" =~ ^(2|3|401|403) ]] && direct_ok=$((direct_ok + 1))
  done
  if (( direct_ok > 0 )); then
    heal_audit "$host" "no-change direct=$direct_ok/2"
    echo "bez heal: no rule for $host (direct=$direct_ok/2)"
    return 0
  fi
  heal_add_proxy "$host"
  for _ in 1 2; do
    code="$(curl -4 -sS -o /dev/null --proxy "http://127.0.0.1:$HTTP_PORT" --connect-timeout 5 --max-time 5 -w '%{http_code}' "$url" 2>/dev/null || printf 000)"
    [[ "$code" =~ ^(2|3|401|403) ]] && proxy_ok=$((proxy_ok + 1))
  done
  if (( proxy_ok == 2 )); then
    heal_audit "$host" "proxy ttl=86400"
    echo "bez heal: $host -> proxy for 24h"
  else
    heal_remove_proxy "$host"
    heal_audit "$host" "no-change direct=0/2 proxy=$proxy_ok/2"
    echo "bez heal: no rule for $host (proxy=$proxy_ok/2)"
  fi
}
heal_replay() {
  local har="$1" url count=0
  [[ -r "$har" ]] || die "cannot read HAR file"
  while IFS= read -r url; do
    heal_test "$url"
    count=$((count + 1)); (( count < 25 )) || break
  done < <(python3 - "$har" <<'PY'
import json, sys
data = json.load(open(sys.argv[1], encoding="utf-8"))
seen = set()
for entry in data.get("log", {}).get("entries", []):
    response = entry.get("response", {})
    url = entry.get("request", {}).get("url", "")
    if response.get("status") == 0 and url.startswith("https://"):
        host = url.split("/", 3)[2].lower()
        if host not in seen:
            seen.add(host); print(url)
PY
)
}
heal_bez() {
  local action="$1" host
  [[ -n "$action" ]] || action=status
  mkdir -p "$APP_DIR"
  case "$action" in
    on) [[ -f "$HEAL_RULES_PATH" ]] || printf '{"enabled":true,"rules":[]}\n' > "$HEAL_RULES_PATH"; chmod 600 "$HEAL_RULES_PATH"; echo "bez heal: enabled (use test URL or replay HAR)" ;;
    off) rm -f "$HEAL_RULES_PATH"; materialize_current_config; restart_daemon; echo "bez heal: disabled; local overlays removed" ;;
    status|list) [[ -f "$HEAL_RULES_PATH" ]] && cat "$HEAL_RULES_PATH" || echo '{"enabled":false,"rules":[]}' ;;
    test) [[ $# -eq 2 ]] || die "usage: bez heal test https://host/path"; heal_test "$2" ;;
    replay) [[ $# -eq 2 ]] || die "usage: bez heal replay file.har"; heal_replay "$2" ;;
    drop) [[ $# -eq 2 ]] || die "usage: bez heal drop host"; host="$(heal_host "$2")" || die "invalid host"; heal_remove_proxy "$host"; echo "bez heal: removed $host" ;;
    *) die "usage: bez heal on|off|status|list|test URL|replay HAR|drop HOST" ;;
  esac
}
help_bez() {
  cat <<'HELP'
Как работает Bez:

  локальный proxy — Xray работает на 127.0.0.1; Telegram, браузер, VS Code
                    и другие приложения настраиваются на этот proxy отдельно.
  системный proxy — Bez меняет proxy macOS; приложения, которые уважают
                    системные настройки, начинают использовать VPN автоматически.
  Smart            — только нужные сервисы через VPN, остальное напрямую.
  Full             — весь внешний TCP/UDP через VPN, LAN/private напрямую.
  Custom           — твои правила из custom-policy.json поверх Smart.
  Endpoint Auto     — Xray выбирает рабочий маршрут через leastPing.
  Endpoint manual   — один выбранный маршрут до возврата в Auto.

Локальная панель: bez web (только http://127.0.0.1:28110).

Без sudo Bez не создаёт TUN. Корпоративный VPN подключай первым.
HELP
}
codex_binary() {
  if [[ -x "$CODEX_INSTALL_DIR/codex" ]]; then
    printf '%s\n' "$CODEX_INSTALL_DIR/codex"
  else
    command -v codex || true
  fi
}
install_codex() {
  command -v curl >/dev/null 2>&1 || die "curl is required to install Codex"
  echo "bez: Codex is not installed; installing it for this user without root"
  HTTP_PROXY="http://127.0.0.1:$HTTP_PORT" \
  HTTPS_PROXY="http://127.0.0.1:$HTTP_PORT" \
  ALL_PROXY="socks5h://127.0.0.1:$SOCKS_PORT" \
  CODEX_NON_INTERACTIVE=1 CODEX_INSTALL_DIR="$CODEX_INSTALL_DIR" \
    sh -c 'curl -fsSL https://chatgpt.com/codex/install.sh | sh' || die "Codex installation failed"
}
codex_bez() {
  need_macos
      if ! installed; then
        install_bez
      elif ! loaded; then
        restore_requested_scope
      fi
  ensure_ports
  local codex_bin
  codex_bin="$(codex_binary)"
  if [[ -z "$codex_bin" ]]; then
    if bundle_mode; then
      die "bundled Codex is missing; reinstall the private bundle"
    fi
    install_codex
    codex_bin="$CODEX_INSTALL_DIR/codex"
  fi
  [[ -x "$codex_bin" ]] || die "Codex executable was not found after installation"
  http_proxy="http://127.0.0.1:$HTTP_PORT" \
  https_proxy="http://127.0.0.1:$HTTP_PORT" \
  all_proxy="socks5h://127.0.0.1:$SOCKS_PORT" \
  HTTP_PROXY="http://127.0.0.1:$HTTP_PORT" \
  HTTPS_PROXY="http://127.0.0.1:$HTTP_PORT" \
  ALL_PROXY="socks5h://127.0.0.1:$SOCKS_PORT" \
    "$codex_bin" "$@"
}
unproxy_bez() { echo 'unset http_proxy https_proxy all_proxy HTTP_PROXY HTTPS_PROXY ALL_PROXY'; }
interactive_bez() {
  need_macos
  [[ -t 0 ]] || die "bez without a command requires an interactive terminal"
  if ! installed; then
    echo "Bez ещё не установлен в этом пользователе."
    printf 'Установить сейчас без sudo? [Д/н]: '
    local install_choice
    IFS= read -r install_choice || return 0
    case "$install_choice" in
      н|Н|n|N) return 0 ;;
      *) install_bez ;;
    esac
  fi
  local choice
  while true; do
    echo
    status_bez
    echo
    echo "Выбери профиль и область применения"
    echo "                 Local                         Global"
    echo "  1) Smart     только приложения с proxy   2) весь Mac через system proxy"
    echo "  3) Full      только приложения с proxy   4) весь Mac через system proxy"
    echo "  5) Custom    правила из файла            6) правила из файла, весь Mac"
    echo
    echo "  e) Открыть Custom-файл    w) Открыть локальную веб-панель"
    echo "  a) Настройка приложений    t) Проверить Cline/ChatGPT/Claude"
    echo "  o) Выключить Bez           h) Справка             q) Выйти"
    printf 'Выбор [1-6/e/w/a/t/o/h/q]: '
    IFS= read -r choice || break
    case "$choice" in
      1) activate_local_bez smart ;;
      2) activate smart --global ;;
      3) activate_local_bez all ;;
      4) activate all --global ;;
      5) custom_bez local ;;
      6) custom_bez global ;;
      e|E) custom_policy_bez edit ;;
      w|W) web_bez ;;
      a|A) cline_bez ;;
      t|T) check_bez ;;
      o|O) off_bez ;;
      h|H) help_bez ;;
      q|Q|'') break ;;
      *) echo "Не понял выбор '$choice'. Введи 1-6, e, w, a, t, o, h или q." ;;
    esac
    [[ "$choice" == o || "$choice" == O || "$choice" == q || "$choice" == Q ]] && break
    printf '\nНажми Enter, чтобы вернуться в меню...'
    IFS= read -r || true
  done
}

if [[ $# -eq 0 && "$0" != "$CLI_PATH" ]]; then install_cli; exit 0; fi
need_macos
if [[ $# -eq 0 ]]; then
  if installed; then web_bez; else interactive_bez; fi
  exit 0
fi
command=help
[[ $# -gt 0 ]] && command="$1"
[[ "$command" == full ]] && command=all
case "$command" in
  install) install_bez ;;
  smart|all)
    shift
    activate "$command" "$@"
    ;;
  custom) shift; custom_bez "$@" ;;
  endpoint) shift; endpoint_bez "$@" ;;
  telemetry) shift; telemetry_bez "$@" ;;
  web) web_bez ;;
  update) update_bez ;;
  off) off_bez ;;
  status) status_bez ;;
  logs) logs_bez ;;
  check) check_bez ;;
  cline) cline_bez ;;
  proxy) proxy_bez ;;
  proxy-mode) shift; proxy_mode_bez "$@" ;;
  unproxy) unproxy_bez ;;
  vpn) shift; vpn_tunnel "$@" ;;
  heal) shift; heal_bez "$@" ;;
  codex) shift; codex_bez "$@" ;;
  *) echo "usage: bez [interactive]|install|smart|all|custom|endpoint|telemetry|web|update|off|status|logs|check|cline|proxy|proxy-mode|unproxy|vpn|heal|codex" ;;
esac
`;
  const baseUrl = JSON.stringify(publicBaseUrl.replace(/\/+$/, ""));
  const configToken = JSON.stringify(MACOS_CONFIG_TOKEN);
  return script
    .replace('BASE_URL="__BEZ_BASE_URL__"', "BASE_URL=" + baseUrl)
    .replace('CONFIG_TOKEN="__BEZ_CONFIG_TOKEN__"', "CONFIG_TOKEN=" + configToken)
    .replace("__BEZ_WEB_UI_PYTHON__", () => macosBezWebUiPython(baseUrl, configToken)) + "\n";
}

function requireHttpsBaseUrl(publicBaseUrl: string): URL {
  const baseUrl = new URL(publicBaseUrl);
  if (baseUrl.protocol !== "https:") throw new Error("macOS installer requires an HTTPS public base URL");
  return baseUrl;
}

/** @deprecated Legacy per-user sing-box command; new clients should use /install/bez. */
export function macosInstallerCommand(publicBaseUrl: string, token: string): string {
  const installerUrl = new URL("/install/macos.sh", requireHttpsBaseUrl(publicBaseUrl));
  installerUrl.searchParams.set("token", token);
  return `curl -fsSL '${installerUrl.toString()}' | zsh`;
}

/** @deprecated Kept for existing Masha links while /install/bez is the supported Xray bootstrap. */
export function macosInstallerScript(publicBaseUrl: string, token: string): string {
  const installerUrl = new URL("/api/user/macos-config", requireHttpsBaseUrl(publicBaseUrl));
  installerUrl.searchParams.set("token", token);
  const configUrl = JSON.stringify(installerUrl.toString());
  return `#!/usr/bin/env sh
set -eu
umask 077

if [ "$(uname -s)" != "Darwin" ]; then
  echo "This installer is for macOS only." >&2
  exit 1
fi
if ! command -v sing-box >/dev/null 2>&1; then
  echo "Install sing-box first (for example: brew install sing-box)." >&2
  exit 1
fi

CONFIG_DIR="$HOME/.config/sing-box"
CONFIG_PATH="$CONFIG_DIR/config.json"
PLIST_PATH="$HOME/Library/LaunchAgents/com.bezrabotnyi.macos-sing-box.plist"
LABEL="com.bezrabotnyi.macos-sing-box"
TMP_CONFIG="$(mktemp "\${TMPDIR:-/tmp}/bezvpn-macos.XXXXXX.json")"
trap 'rm -f "$TMP_CONFIG"' EXIT
curl -fsSL --retry 3 ${configUrl} -o "$TMP_CONFIG"
sing-box check -c "$TMP_CONFIG"
mkdir -p "$CONFIG_DIR" "$HOME/Library/LaunchAgents" "$HOME/Library/Logs"
install -m 600 "$TMP_CONFIG" "$CONFIG_PATH"
cat > "$PLIST_PATH" <<PLIST
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
  <key>Label</key><string>$LABEL</string>
  <key>ProgramArguments</key><array><string>$(command -v sing-box)</string><string>run</string><string>-c</string><string>$CONFIG_PATH</string></array>
  <key>RunAtLoad</key><true/><key>KeepAlive</key><true/>
  <key>StandardOutPath</key><string>$HOME/Library/Logs/bezvpn-macos-sing-box.log</string>
  <key>StandardErrorPath</key><string>$HOME/Library/Logs/bezvpn-macos-sing-box.log</string>
</dict></plist>
PLIST
launchctl bootout "gui/$(id -u)/$LABEL" 2>/dev/null || true
launchctl bootstrap "gui/$(id -u)" "$PLIST_PATH"
launchctl kickstart -k "gui/$(id -u)/$LABEL"
echo "Legacy sing-box profile installed; use /install/bez for the rootless Xray client."
`;
}

import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import test from "node:test";
import {
  loadTelegramTransparentLaneConfig,
  renderTelegramTransparentLaneCandidate,
  renderTelegramTransparentLaneValidation,
  validateTelegramTransparentLane,
} from "../src/telegram-transparent-lane.js";

test("Telegram transparent lane stays validation-only and carries the official IP-set", async () => {
  const config = await loadTelegramTransparentLaneConfig();
  validateTelegramTransparentLane(config);

  assert.equal(config.status, "validation-only");
  assert.equal(config.deployment.liveApply, false);
  assert.equal(config.ipSet.source, "https://core.telegram.org/resources/cidr.txt");
  assert.deepEqual(config.ipSet.ipv4, [
    "91.108.56.0/22",
    "91.108.4.0/22",
    "91.108.8.0/22",
    "91.108.16.0/22",
    "91.108.12.0/22",
    "149.154.160.0/20",
    "91.105.192.0/23",
    "91.108.20.0/22",
    "185.76.151.0/24",
  ]);
  assert.deepEqual(config.ipSet.ipv6, [
    "2001:b28:f23d::/48",
    "2001:b28:f23f::/48",
    "2001:67c:4e8::/48",
    "2001:b28:f23c::/48",
    "2a0a:f280::/32",
  ]);
  assert.equal(config.tproxy.enabled, false);
  assert.equal(config.tproxy.required, true);
  assert.equal(config.rollback.required, true);
});

test("Telegram transparent lane validation rejects an accidental live apply", async () => {
  const config = await loadTelegramTransparentLaneConfig();
  assert.throws(
    () => validateTelegramTransparentLane({ ...config, deployment: { ...config.deployment, liveApply: true } }),
    /liveApply must remain false/,
  );
});

test("Telegram transparent lane renderer emits an explicit dry-run artifact", async () => {
  const config = await loadTelegramTransparentLaneConfig();
  const rendered = renderTelegramTransparentLaneValidation(config);
  assert.equal(rendered.kind, "telegram-transparent-lane-validation");
  assert.equal(rendered.liveApply, false);
  assert.match(rendered.command, /validate:telegram-lane/);
  assert.match(rendered.requirements.join("\n"), /TPROXY/);
  assert.match(rendered.rollback.join("\n"), /backup/);
});

test("deploy-all exposes validation-only Telegram lane without a live target", async () => {
  const [packageJson, deployAll] = await Promise.all([
    readFile(new URL("../package.json", import.meta.url), "utf8"),
    readFile(new URL("../scripts/deploy-all.sh", import.meta.url), "utf8"),
  ]);
  const scripts = (JSON.parse(packageJson) as { scripts: Record<string, string> }).scripts;
  assert.equal(scripts["validate:telegram-lane"], "tsx src/cli/validate-telegram-transparent-lane.ts");
  assert.match(deployAll, /validate:telegram-lane/);
  assert.doesNotMatch(deployAll, /deploy_telegram_transparent_lane/);
});

test("Telegram lane candidate adds only the Telegram TPROXY inbound and proxy route", async () => {
  const config = await loadTelegramTransparentLaneConfig();
  const base = {
    inbounds: [{ tag: "in-http-all", port: 3128, protocol: "http" }],
    routing: { rules: [{ type: "field", inboundTag: ["in-http-all"], balancerTag: "proxy" }] },
  };

  const candidate = renderTelegramTransparentLaneCandidate(base, config);
  assert.equal(candidate.inbounds.at(-1)?.tag, "in-tproxy-telegram");
  assert.equal(candidate.inbounds.at(-1)?.protocol, "dokodemo-door");
  assert.equal(candidate.inbounds.at(-1)?.settings.followRedirect, true);
  assert.deepEqual(candidate.inbounds.at(-1)?.sniffing, {
    enabled: true,
    destOverride: ["http", "tls"],
    routeOnly: false,
  });
  assert.deepEqual(candidate.routing.rules[0], {
    type: "field",
    inboundTag: ["in-tproxy-telegram"],
    network: "tcp,udp",
    balancerTag: "proxy",
    comment: "vpn-panel:telegram-transparent-lane",
  });
  assert.equal(candidate.routing.rules.some((rule) => rule.comment === "vpn-panel:github-transparent-route"), false);
  assert.equal(candidate.metadata.liveApply, false);
});

test("Telegram lane candidate is idempotent and rejects an unavailable outbound", async () => {
  const config = await loadTelegramTransparentLaneConfig();
  const base = {
    inbounds: [{ tag: "in-tproxy-telegram", port: 12555, protocol: "dokodemo-door" }],
    routing: { rules: [] },
  };
  const once = renderTelegramTransparentLaneCandidate(base, config);
  const twice = renderTelegramTransparentLaneCandidate(once, config);
  assert.equal(twice.inbounds.filter((item) => item.tag === "in-tproxy-telegram").length, 1);
  assert.equal(twice.routing.rules.filter((rule) => rule.comment === "vpn-panel:telegram-transparent-lane").length, 1);
  assert.throws(
    () => renderTelegramTransparentLaneCandidate({ ...base, outbounds: [{ tag: "direct" }] }, config),
    /outbound.*proxy/,
  );
});

test("OpenWrt Telegram lane deploy script remains dry-run-only with rollback primitives", async () => {
  const script = await readFile(new URL("../deploy/router/telegram-transparent-lane.sh", import.meta.url), "utf8");
  assert.match(script, /--dry-run/);
  assert.match(script, /ipset/);
  assert.match(script, /LEGACY_GITHUB_SET4="github_v4"/);
  assert.doesNotMatch(script, /185\.199\.108\.0\/22/);
  assert.match(script, /ip rule/);
  assert.match(script, /rollback/);
  assert.match(script, /LIVE_APPLY=0/);
  assert.doesNotMatch(script, /systemctl .*xray/);
});

test("router watchdog probes the real Telegram DC port instead of a proxy-only CONNECT", async () => {
  const script = await readFile(new URL("../deploy/router/telegram-dc-failover.sh", import.meta.url), "utf8");
  assert.match(script, /HEALTH_IP=149\.154\.167\.51/);
  assert.match(script, /HEALTH_PORT=80/);
  assert.match(script, /nc "\$HEALTH_IP" "\$HEALTH_PORT"/);
});

test("transparent lane deploy exposes a portable edge contract", async () => {
  const script = await readFile(new URL("../scripts/deploy-telegram-transparent-lane.sh", import.meta.url), "utf8");
  assert.match(script, /TELEGRAM_EDGE_SSH/);
  assert.match(script, /TELEGRAM_EDGE_CONFIG/);
  assert.match(script, /TELEGRAM_BASE_CONFIG/);
  assert.match(script, /TELEGRAM_EDGE_POLICY/);
});

test("Telegram lane watchdog is procd-supervised and retries a failed startup", async () => {
  const [lane, init] = await Promise.all([
    readFile(new URL("../deploy/router/telegram-transparent-lane.sh", import.meta.url), "utf8"),
    readFile(new URL("../deploy/router/telegram-transparent-lane.init", import.meta.url), "utf8"),
  ]);

  assert.doesNotMatch(init, /port_open \|\|/);
  assert.doesNotMatch(init, /nohup/);
  assert.match(init, /USE_PROCD=1/);
  assert.match(init, /procd_set_param command "\$SCRIPT" --watchdog/);
  assert.match(init, /procd_set_param respawn/);
  assert.match(init, /stop_service\(\)/);
  assert.match(lane, /probe_edge\(\)/);
  assert.match(lane, /if probe_edge; then/);
  assert.match(lane, /if ! lane_active; then/);
  assert.match(lane, /LIVE_APPLY=1 apply/);
  assert.match(lane, /lane_configured\(\)/);
  assert.match(lane, /elif lane_configured; then/);
  assert.match(lane, /leaving Telegram steering unchanged/);
});

test("Telegram lane init gives procd the watchdog command and respawn policy", () => {
  const initPath = fileURLToPath(new URL("../deploy/router/telegram-transparent-lane.init", import.meta.url));
  const output = execFileSync(
    "sh",
    [
      "-c",
      `
        procd_open_instance() { printf 'open\\n'; }
        procd_set_param() { printf 'param'; for value in "$@"; do printf ' %s' "$value"; done; printf '\\n'; }
        procd_close_instance() { printf 'close\\n'; }
        . "$1"
        start_service
      `,
      "sh",
      initPath,
    ],
    { encoding: "utf8" },
  );

  assert.match(output, /^open$/m);
  assert.match(output, /^param command \/usr\/sbin\/telegram-transparent-lane --watchdog$/m);
  assert.match(output, /^param respawn 3600 5 5$/m);
  assert.match(output, /^close$/m);
});

test("server-100 Telegram self-heal bounds every remote command", async () => {
  const script = await readFile(new URL("../scripts/telegram-lane-self-heal.sh", import.meta.url), "utf8");
  assert.match(script, /router_command_timeout=.*10/);
  assert.match(script, /ssh_command_timeout=.*15/);
  assert.match(script, /restart_command_timeout=.*30/);
  assert.match(script, /timeout "\$router_command_timeout" ssh/);
  assert.match(script, /timeout "\$ssh_command_timeout" ssh -p "\$haos_ssh_port"/);
  assert.match(script, /timeout "\$restart_command_timeout" ssh -p "\$haos_ssh_port"/);
});

import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import path from "node:path";

const generatorUrl = new URL("../src/cli/_gen-server88-config.ts", import.meta.url);

test("server-88 generator keeps Telegram TPROXY opt-in and wires the candidate renderer", async () => {
  const source = await readFile(generatorUrl, "utf8");

  assert.match(source, /TELEGRAM_TPROXY_ENABLE/);
  assert.match(source, /renderTelegramTransparentLaneCandidate/);
  assert.match(source, /telegramTproxyEnabled/);
  assert.match(source, /if \(telegramTproxyEnabled\)/);
});

test("server-88 generator does not unconditionally add the Telegram TPROXY inbound", async () => {
  const source = await readFile(generatorUrl, "utf8");

  assert.doesNotMatch(source, /generated\.inbounds\.push\(\{[\s\S]*in-tproxy-telegram/);
  assert.doesNotMatch(source, /in-tproxy-telegram[\s\S]*TELEGRAM_TPROXY_ENABLE.*if/s);
});

test("Telegram TPROXY policy artifacts are guarded and reversible", async () => {
  const [policy, unit, nft, failover, init] = await Promise.all([
    readFile(path.join(process.cwd(), "deploy/server-44/xray-lan-edge/telegram-transparent-policy.sh"), "utf8"),
    readFile(path.join(process.cwd(), "deploy/server-44/xray-lan-edge/telegram-transparent-policy.service"), "utf8"),
    readFile(path.join(process.cwd(), "deploy/server-44/xray-lan-edge/telegram-transparent-lane.nft"), "utf8"),
    readFile(path.join(process.cwd(), "deploy/router/telegram-dc-failover.sh"), "utf8"),
    readFile(path.join(process.cwd(), "deploy/router/telegram-dc-failover.init"), "utf8"),
  ]);

  assert.match(policy, /--rollback/);
  assert.match(policy, /ip rule add (priority \d+ )?fwmark/);
  assert.match(policy, /ip route replace local 0\.0\.0\.0\/0 dev lo table/);
  assert.match(unit, /Requires=xray-lan-edge\.service/);
  assert.match(unit, /ExecStart=.*xray-lan-edge-telegram-policy\.sh --apply/);
  assert.match(nft, /table inet telegram_transparent/);
  assert.match(nft, /set telegram_v4/);
  assert.doesNotMatch(nft, /set github_v4/);
  assert.doesNotMatch(nft, /185\.199\.108\.0\/22/);
  assert.match(nft, /tproxy ip to :12555/);
  assert.match(failover, /PRIMARY=192\.168\.2\.75/);
  assert.match(failover, /BACKUP=192\.168\.2\.5/);
  assert.match(failover, /PORT=12555/);
  assert.match(failover, /HEALTH_TABLE=101/);
  assert.match(failover, /iptables -t mangle -A OUTPUT/);
  assert.match(failover, /nc "\$HEALTH_IP" "\$HEALTH_PORT"/);
  assert.match(failover, /CONNECT telegram\.org:443 HTTP\/1\.1/);
  assert.match(failover, /LEGACY_GITHUB_SET4=github_v4/);
  assert.doesNotMatch(failover, /185\.199\.108\.0\/22/);
  assert.match(failover, /probe_proxy_outbound "\$target" \|\| return 1/);
  assert.match(init, /start_service\(\) \{ :; \}/);
  assert.match(init, /stop_service\(\) \{ :; \}/);
});

test("repository deploy target is dry-run by default and explicitly approval-gated", async () => {
  const [packageJson, script] = await Promise.all([
    readFile(path.join(process.cwd(), "package.json"), "utf8"),
    readFile(path.join(process.cwd(), "scripts/deploy-telegram-transparent-lane.sh"), "utf8"),
  ]);
  const scripts = (JSON.parse(packageJson) as { scripts: Record<string, string> }).scripts;
  assert.equal(scripts["deploy:telegram-lane"], "bash scripts/deploy-telegram-transparent-lane.sh");
  assert.match(script, /--dry-run/);
  assert.match(script, /TELEGRAM_TPROXY_LIVE_APPROVED/);
  assert.match(script, /--rollback/);
  assert.match(script, /telegram-transparent-lane\.init/);
  assert.match(script, /systemctl restart telegram-transparent-policy\.service/);
});

import assert from "node:assert/strict";
import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { spawnSync } from "node:child_process";
import path from "node:path";
import test from "node:test";

const root = path.resolve(new URL("..", import.meta.url).pathname);
const artifacts = path.join(root, "deploy/server-44/codex-proxy-autoheal");
const probeScript = path.join(artifacts, "codex-proxy-autoheal.sh");

async function makeExecutable(file: string, body: string) {
  await writeFile(file, body);
  await chmod(file, 0o755);
}

async function createHarness(name: string, failures: number) {
  const tempRoot = await mkdir(path.join(root, ".tmp"), { recursive: true })
    .then(() => mkdtemp(path.join(root, ".tmp", "codex-proxy-autoheal-" + name + "-")));
  const bin = path.join(tempRoot, "bin");
  const state = path.join(tempRoot, "state");
  await Promise.all([mkdir(bin), mkdir(state)]);
  const curlLog = path.join(tempRoot, "curl.log");
  const systemctlLog = path.join(tempRoot, "systemctl.log");
  const logger = path.join(bin, "logger");
  const systemctl = path.join(bin, "systemctl");
  const curl = path.join(bin, "curl");
  const sleep = path.join(bin, "sleep");
  const flock = path.join(bin, "flock");
  await Promise.all([
    makeExecutable(logger, "#!/usr/bin/env bash\nexit 0\n"),
    makeExecutable(sleep, "#!/usr/bin/env bash\nexit 0\n"),
    makeExecutable(flock, "#!/usr/bin/env bash\nexit 0\n"),
    makeExecutable(
      systemctl,
      "#!/usr/bin/env bash\nprintf '%s\\n' \"$*\" >> \"" + systemctlLog + "\"\nexit 0\n",
    ),
    makeExecutable(
      curl,
      "#!/usr/bin/env bash\n" +
        "count=0\n" +
        "if [[ -f \"" + curlLog + "\" ]]; then count=$(wc -l < \"" + curlLog + "\"); fi\n" +
        "printf 'probe\\n' >> \"" + curlLog + "\"\n" +
        "if (( count < " + failures + " )); then\n" +
        "  printf '000'\n" +
        "  exit 28\n" +
        "fi\n" +
        "printf '401'\n",
    ),
  ]);
  return { tempRoot, state, curl, logger, systemctl, sleep, curlLog, systemctlLog };
}

function runHarness(harness: Awaited<ReturnType<typeof createHarness>>, overrides: Record<string, string> = {}) {
  return spawnSync("bash", [probeScript], {
    encoding: "utf8",
    env: {
      ...process.env,
      PATH: path.join(harness.tempRoot, "bin") + ":" + process.env.PATH,
      CODEX_PROXY_AUTOHEAL_STATE_DIR: harness.state,
      CODEX_PROXY_AUTOHEAL_CURL: harness.curl,
      CODEX_PROXY_AUTOHEAL_LOGGER: harness.logger,
      CODEX_PROXY_AUTOHEAL_SYSTEMCTL: harness.systemctl,
      CODEX_PROXY_AUTOHEAL_SLEEP: harness.sleep,
      CODEX_PROXY_AUTOHEAL_RETRY_DELAY_SECONDS: "0",
      CODEX_PROXY_AUTOHEAL_REPAIR_COOLDOWN_SECONDS: "900",
      ...overrides,
    },
  });
}

test("Codex proxy autoheal units use a bounded persistent five-minute timer", async () => {
  const [service, timer, deploy] = await Promise.all([
    readFile(path.join(artifacts, "codex-proxy-autoheal.service"), "utf8"),
    readFile(path.join(artifacts, "codex-proxy-autoheal.timer"), "utf8"),
    readFile(path.join(root, "scripts/deploy-codex-proxy-autoheal.sh"), "utf8"),
  ]);
  assert.match(service, /^Type=oneshot$/m);
  assert.match(service, /^After=network-online\.target$/m);
  assert.match(service, /^Environment=CODEX_PROXY_AUTOHEAL_SERVICE=sing-box$/m);
  assert.match(service, /^TimeoutStartSec=2min$/m);
  assert.match(timer, /^OnUnitActiveSec=5min$/m);
  assert.match(timer, /^Persistent=true$/m);
  assert.match(timer, /^WantedBy=timers\.target$/m);
  assert.match(deploy, /CODEX_PROXY_AUTOHEAL_LIVE_APPROVED/);
  assert.match(deploy, /ExecStart=\/bin\/true/);
  assert.match(deploy, /systemd-analyze verify/);
  assert.match(deploy, /codex-proxy-autoheal-rendered\.service/);
  assert.match(deploy, /codex-proxy-autoheal-verify/);
  assert.match(deploy, /rollback receipt/);
});

test("healthy OpenAI proxy canary does not restart sing-box", async () => {
  const harness = await createHarness("healthy", 0);
  try {
    const result = runHarness(harness);
    assert.equal(result.status, 0, result.stderr);
    const systemctlCalls = await readFile(harness.systemctlLog, "utf8").catch(() => "");
    assert.equal(systemctlCalls, "");
    assert.match(await readFile(path.join(harness.state, "state"), "utf8"), /^status=healthy$/m);
  } finally {
    await rm(harness.tempRoot, { recursive: true, force: true });
  }
});

test("two failed proxy probes restart sing-box and verify recovery", async () => {
  const harness = await createHarness("recovery", 2);
  try {
    const result = runHarness(harness);
    assert.equal(result.status, 0, result.stderr);
    assert.match(await readFile(harness.systemctlLog, "utf8"), /^restart sing-box$/m);
    assert.match(await readFile(path.join(harness.state, "state"), "utf8"), /^status=repaired$/m);
    assert.equal((await readFile(harness.curlLog, "utf8")).trim().split("\n").length, 3);
  } finally {
    await rm(harness.tempRoot, { recursive: true, force: true });
  }
});

test("a target service override repairs the Xray proxy pool member", async () => {
  const harness = await createHarness("xray", 2);
  try {
    const result = runHarness(harness, { CODEX_PROXY_AUTOHEAL_SERVICE: "xray" });
    assert.equal(result.status, 0, result.stderr);
    assert.match(await readFile(harness.systemctlLog, "utf8"), /^restart xray$/m);
  } finally {
    await rm(harness.tempRoot, { recursive: true, force: true });
  }
});

test("repair cooldown prevents repeated restarts during an upstream outage", async () => {
  const harness = await createHarness("cooldown", 99);
  try {
    await writeFile(
      path.join(harness.state, "state"),
      "status=failed\nlast_repair=" + Math.floor(Date.now() / 1000) + "\nchecked_at=test\n",
    );
    const result = runHarness(harness);
    assert.equal(result.status, 1);
    const systemctlCalls = await readFile(harness.systemctlLog, "utf8").catch(() => "");
    assert.equal(systemctlCalls, "");
    assert.match(await readFile(path.join(harness.state, "state"), "utf8"), /^status=degraded$/m);
  } finally {
    await rm(harness.tempRoot, { recursive: true, force: true });
  }
});

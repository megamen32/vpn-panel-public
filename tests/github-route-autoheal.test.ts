import assert from "node:assert/strict";
import { chmod, mkdtemp, readFile, writeFile } from "node:fs/promises";
import test from "node:test";
import path from "node:path";
import os from "node:os";
import { spawnSync } from "node:child_process";

test("GitHub route auto-heal probes the real LAN edge and redeploys canonical server-88 config", async () => {
  const [watchdog, service, timer, deployer] = await Promise.all([
    readFile("scripts/github-route-autoheal.sh", "utf8"),
    readFile("deploy/server-100/systemd/github-route-autoheal.service", "utf8"),
    readFile("deploy/server-100/systemd/github-route-autoheal.timer", "utf8"),
    readFile("scripts/deploy-github-route-autoheal.sh", "utf8"),
  ]);

  assert.match(watchdog, /github\.com:443:192\.168\.2\.1/);
  assert.match(watchdog, /https:\/\/github\.com\/login\/oauth\/authorize/);
  assert.match(watchdog, /https:\/\/github\.com\/meanwebuser/);
  assert.match(watchdog, /meanwebuser\/whitetransport-public/);
  assert.match(watchdog, /Whoa there!|Fastly error|Gateway Time-out/);
  assert.match(watchdog, /FAILURES_BEFORE_REPAIR.*:-2/);
  assert.match(watchdog, /failures.*-lt.*FAILURES_BEFORE_REPAIR/);
  assert.match(watchdog, /GITHUB_ROUTE_DEPLOY/);
  assert.match(watchdog, /"\$DEPLOY" server-88/);
  assert.match(watchdog, /flock/);
  assert.match(service, /^User=roomhacker$/m);
  assert.match(service, /github-route-autoheal\.sh --once/);
  assert.match(timer, /OnUnitInactiveSec=1min/);
  assert.match(timer, /Persistent=true/);
  assert.match(deployer, /systemd-analyze.*verify/);
  assert.match(deployer, /github-route-autoheal\.timer/);
  assert.match(deployer, /rollback/);
});

test("GitHub route auto-heal repairs a broken OAuth page even when profile and repository are healthy", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "github-profile-autoheal-"));
  const state = path.join(directory, "state");
  const repaired = path.join(directory, "repaired");
  const deployLog = path.join(directory, "deploy.log");
  const curl = path.join(directory, "curl");
  const deploy = path.join(directory, "deploy");
  const logger = path.join(directory, "logger");

  await writeFile(curl, `#!/bin/sh
out=""
url=""
while [ "$#" -gt 0 ]; do
  if [ "$1" = --output ]; then out="$2"; shift 2; else url="$1"; shift; fi
done
if [ "$url" = "https://github.com/login/oauth/authorize" ] && [ ! -e ${JSON.stringify(repaired)} ]; then
  printf 'Fastly error: unknown domain: github.com' > "$out"
else
  printf 'Sign in to GitHub meanwebuser whitetransport-public repository-content' > "$out"
fi
printf 200
`);
  await writeFile(deploy, `#!/bin/sh
printf '%s\\n' "$*" >> ${JSON.stringify(deployLog)}
touch ${JSON.stringify(repaired)}
`);
  await writeFile(logger, "#!/bin/sh\nexit 0\n");
  await Promise.all([chmod(curl, 0o755), chmod(deploy, 0o755), chmod(logger, 0o755)]);

  const env = {
    ...process.env,
    GITHUB_ROUTE_STATE_FILE: state,
    GITHUB_ROUTE_LOCK_FILE: path.join(directory, "lock"),
    GITHUB_ROUTE_FAILURES_BEFORE_REPAIR: "1",
    GITHUB_ROUTE_CURL: curl,
    GITHUB_ROUTE_DEPLOY: deploy,
    GITHUB_ROUTE_LOGGER: logger,
  };
  const result = spawnSync("bash", ["scripts/github-route-autoheal.sh", "--once"], { env, encoding: "utf8" });

  assert.equal(result.status, 0, result.stderr);
  assert.equal((await readFile(deployLog, "utf8")).trim(), "server-88");
  assert.match(await readFile(state, "utf8"), /failures=0\nstatus=repaired/);
});

test("GitHub route auto-heal waits for two semantic failures and verifies the repaired path", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "github-route-autoheal-"));
  const state = path.join(directory, "state");
  const repaired = path.join(directory, "repaired");
  const deployLog = path.join(directory, "deploy.log");
  const curl = path.join(directory, "curl");
  const deploy = path.join(directory, "deploy");
  const logger = path.join(directory, "logger");

  await writeFile(curl, `#!/bin/sh\nout=\"\"\nwhile [ \"$#\" -gt 0 ]; do\n  if [ \"$1\" = --output ]; then out=\"$2\"; shift 2; else shift; fi\ndone\nif [ -e ${JSON.stringify(repaired)} ]; then printf 'Sign in to GitHub meanwebuser whitetransport-public repository-content' > \"$out\"; printf 200; else printf '<h1>504 Gateway Time-out</h1>' > \"$out\"; printf 504; fi\n`);
  await writeFile(deploy, `#!/bin/sh\nprintf '%s\\n' \"$*\" >> ${JSON.stringify(deployLog)}\ntouch ${JSON.stringify(repaired)}\n`);
  await writeFile(logger, "#!/bin/sh\nexit 0\n");
  await Promise.all([chmod(curl, 0o755), chmod(deploy, 0o755), chmod(logger, 0o755)]);

  const env = {
    ...process.env,
    GITHUB_ROUTE_STATE_FILE: state,
    GITHUB_ROUTE_LOCK_FILE: path.join(directory, "lock"),
    GITHUB_ROUTE_CURL: curl,
    GITHUB_ROUTE_DEPLOY: deploy,
    GITHUB_ROUTE_LOGGER: logger,
  };
  const first = spawnSync("bash", ["scripts/github-route-autoheal.sh", "--once"], { env, encoding: "utf8" });
  assert.equal(first.status, 1);
  assert.match(await readFile(state, "utf8"), /failures=1\nstatus=degraded/);

  const second = spawnSync("bash", ["scripts/github-route-autoheal.sh", "--once"], { env, encoding: "utf8" });
  assert.equal(second.status, 0, second.stderr);
  assert.equal((await readFile(deployLog, "utf8")).trim(), "server-88");
  assert.match(await readFile(state, "utf8"), /failures=0\nstatus=repaired/);
});

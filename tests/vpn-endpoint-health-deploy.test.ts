import assert from "node:assert/strict";
import { chmod, mkdir, mkdtemp, readFile, readdir, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import test from "node:test";

const readUnit = async (name: string) =>
  readFile(new URL(`../deploy/server-100/systemd/${name}`, import.meta.url), "utf8");

/** systemd accepts a bare number of minutes; anything else is a unit contract bug. */
const minutes = (text: string) => {
  const match = /^TimeoutStartSec=(\d+)min$/m.exec(text);
  assert.ok(match, `TimeoutStartSec must be expressed in whole minutes, got:\n${text}`);
  return Number(match[1]);
};

test("endpoint health units use bounded unprivileged measurement-only checks", async () => {
  const [service, timer] = await Promise.all([
    readUnit("vpn-endpoint-check.service"),
    readUnit("vpn-endpoint-check.timer"),
  ]);

  assert.match(service, /^User=roomhacker$/m);
  assert.match(service, /^Group=roomhacker$/m);
  assert.match(service, /^Type=oneshot$/m);
  assert.match(service, /ExecStart=\/usr\/local\/lib\/vpn-panel\/auto-endpoint-check\.sh/);
  assert.match(service, /^Environment=HEALTH_APPLY_PROFILES=0$/m);
  assert.doesNotMatch(service, /^User=root$/m);
  assert.match(timer, /^OnUnitInactiveSec=5min$/m);
  assert.match(timer, /^Persistent=true$/m);
  assert.match(timer, /^WantedBy=timers\.target$/m);
});

test("systemd kills the unit only after the probe's own budget has expired", async () => {
  // run-network-test.sh aborts the remote probe at REMOTE_RUN_TIMEOUT_SECONDS
  // and publishes nothing. If systemd's own TimeoutStartSec is the smaller of
  // the two, the run dies with status 124 having measured the fleet for
  // nothing, which is exactly how the exploration pass failed on its first run.
  for (const name of ["vpn-endpoint-check.service", "vpn-endpoint-check-explore.service"]) {
    const unit = await readUnit(name);
    const remote = /^Environment=REMOTE_RUN_TIMEOUT_SECONDS=(\d+)$/m.exec(unit);
    assert.ok(remote, `${name} must state its remote probe budget explicitly`);
    assert.ok(
      minutes(unit) * 60 > Number(remote[1]),
      `${name}: TimeoutStartSec must exceed REMOTE_RUN_TIMEOUT_SECONDS`,
    );
  }
});

test("the recurring pass measures the sold catalog and exploration covers the rest", async () => {
  const [sold, explore] = await Promise.all([
    readUnit("vpn-endpoint-check.service"),
    readUnit("vpn-endpoint-check-explore.service"),
  ]);
  const exploreTimer = await readUnit("vpn-endpoint-check-explore.timer");

  // A sold endpoint that no run measures ages into a stale verdict, so the
  // recurring pass must ask the panel what it offers rather than pin a list.
  assert.match(sold, /^Environment=DIAGNOSTIC_SUBSCRIPTION=0$/m);
  assert.doesNotMatch(sold, /^Environment=ENDPOINTS=/m);
  assert.match(explore, /^Environment=DIAGNOSTIC_SUBSCRIPTION=1$/m);
  assert.doesNotMatch(explore, /^Environment=ENDPOINTS=/m);

  // Both passes share one profile name, so they cannot share a results
  // directory: the wider run would otherwise publish the recurring run's
  // measurements, and the reverse.
  assert.doesNotMatch(sold, /^Environment=RESULTS_DIR=/m);
  assert.match(explore, /^Environment=RESULTS_DIR=\/home\/roomhacker\/apps\/vpn-panel\/vpn-testing\/results\/explore$/m);

  // Six hours matches the window a verdict is decided over.
  assert.match(exploreTimer, /^OnCalendar=\*-\*-\* 01,07,13,19:/m);
  assert.match(exploreTimer, /^Persistent=true$/m);
  assert.match(exploreTimer, /^WantedBy=timers\.target$/m);
});

test("the endpoint health deploy owns every unit it ships", async () => {
  const script = await readFile(new URL("../scripts/deploy-vpn-endpoint-health.sh", import.meta.url), "utf8");

  // A unit installed by hand and not owned by the deploy path is the next
  // deploy's silent loss, so every shipped unit has to be named here.
  for (const name of [
    "vpn-endpoint-check.service",
    "vpn-endpoint-check.timer",
    "vpn-endpoint-check-explore.service",
    "vpn-endpoint-check-explore.timer",
  ]) {
    assert.match(script, new RegExp(`\\b${name.replaceAll(".", "\\.")}\\b`));
  }
  assert.match(script, /enable --now vpn-endpoint-check\.timer vpn-endpoint-check-explore\.timer/);
});

test("endpoint health deployment is preview-first, least-privilege, and reversible", async () => {
  const script = await readFile(new URL("../scripts/deploy-vpn-endpoint-health.sh", import.meta.url), "utf8");

  assert.match(script, /ACTION="\$\{1:-preview\}"/);
  assert.match(script, /VPN_ENDPOINT_HEALTH_LIVE_APPROVED/);
  assert.match(script, /VPN_ENDPOINT_HEALTH_RECEIPT_ID/);
  assert.match(script, /SYSTEMD_ANALYZE.*systemd-analyze/);
  assert.match(script, /getfacl -p "\$SECURE_DIR"/);
  assert.match(script, /setfacl -m u:roomhacker:--x "\$SECURE_DIR"/);
  assert.doesNotMatch(script, /chmod\s+[^\n]*\/etc\/vpn-panel/);
  assert.doesNotMatch(script, /chgrp\s+[^\n]*\/etc\/vpn-panel/);
  assert.match(script, /sudo -u roomhacker test -r "\$SECURE_FILE"/);
  assert.match(script, /systemctl enable --now vpn-endpoint-check\.timer/);
  assert.match(script, /setfacl --restore/);
  // Receipts are keyed by unit name so two timers cannot overwrite each
  // other's enabled/active state and make rollback restore the wrong unit.
  assert.match(script, /restore_unit "\$receipt\/\$unit\.before" "\$SYSTEMD_DIR\/\$unit" "\$receipt\/\$unit\.missing"/);
  assert.match(script, /sudo cp -a "\$SYSTEMD_DIR\/\$unit" "\$receipt\/\$unit\.before"/);
  assert.match(script, /restore_unit_state "\$state_unit" "\$state_unit" "\$receipt"/);
});

test("operator deploy can render the secret-backed test plan before the ACL repair is applied", async () => {
  const script = await readFile(new URL("../scripts/deploy-all.sh", import.meta.url), "utf8");
  assert.match(
    script,
    /sudo env DATABASE_URL="\$DATABASE_URL" "\$PANEL_DIR\/node_modules\/\.bin\/tsx" src\/cli\/render-vpn-test-plan\.ts/,
  );
});

test("health rollback restores disabled and enabled timer states", async () => {
  const scriptPath = new URL("../scripts/deploy-vpn-endpoint-health.sh", import.meta.url);
  const script = await readFile(scriptPath, "utf8");
  assert.match(script, /VPN_ENDPOINT_HEALTH_SYSTEMD_DIR/);
  assert.match(script, /\$prefix\.enabled\.before/);
  assert.match(script, /\$prefix\.active\.before/);
  assert.match(script, /capture_unit_state "\$state_unit" "\$state_unit" "\$receipt"/);
  assert.match(script, /is-enabled "\$unit"[^\n]*\| sudo tee "\$receipt\/\$prefix\.enabled\.before"/);
  assert.match(script, /is-active "\$unit"[^\n]*\| sudo tee "\$receipt\/\$prefix\.active\.before"/);

  for (const initial of ["disabled:inactive", "enabled:active"]) {
    const root = await mkdtemp(path.join(os.tmpdir(), "vpn-health-deploy-test-"));
    const bin = path.join(root, "bin");
    const systemd = path.join(root, "systemd");
    const secure = path.join(root, "secure");
    const receipts = path.join(root, "receipts");
    const state = path.join(root, "state");
    await Promise.all([mkdir(bin), mkdir(systemd), mkdir(secure), mkdir(state)]);
    await writeFile(path.join(secure, "secure.json"), "{}\n");
    await writeFile(path.join(systemd, "vpn-endpoint-check.service"), "old service\n");
    await writeFile(path.join(systemd, "vpn-endpoint-check.timer"), "old timer\n");
    const [enabled, active] = initial.split(":");
    await writeFile(path.join(state, "vpn-endpoint-check.timer.enabled"), `${enabled}\n`);
    await writeFile(path.join(state, "vpn-endpoint-check.timer.active"), `${active}\n`);
    await writeFile(path.join(state, "vpn-endpoint-check.service.enabled"), "disabled\n");
    await writeFile(path.join(state, "vpn-endpoint-check.service.active"), "inactive\n");

    const sudo = `#!/usr/bin/env bash
set -e
if [[ "\${1:-}" == "-u" ]]; then shift 2; fi
if [[ "\${1:-}" == "install" ]]; then
  args=(); shift
  while [[ $# -gt 0 ]]; do
    case "$1" in -o|-g) shift 2 ;; *) args+=("$1"); shift ;; esac
  done
  exec install "\${args[@]}"
fi
exec "$@"
`;
    const systemctl = `#!/usr/bin/env bash
set -e
state=${JSON.stringify(state)}
cmd="$1"; shift || true
unit="\${*: -1}"
key="\${unit}."
case "$cmd" in
  is-enabled) value=$(cat "$state/\${key}enabled"); echo "$value"; [[ "$value" == enabled ]] ;;
  is-active) value=$(cat "$state/\${key}active"); echo "$value"; [[ "$value" == active ]] ;;
  is-failed) exit 1 ;;
  enable) echo enabled > "$state/\${key}enabled"; [[ " $* " == *" --now "* ]] && echo active > "$state/\${key}active" || true ;;
  disable) echo disabled > "$state/\${key}enabled"; [[ " $* " == *" --now "* ]] && echo inactive > "$state/\${key}active" || true ;;
  start|try-restart) echo active > "$state/\${key}active" ;;
  stop) echo inactive > "$state/\${key}active" ;;
  daemon-reload) : ;;
  *) : ;;
esac
`;
    await Promise.all([
      writeFile(path.join(bin, "sudo"), sudo),
      writeFile(path.join(bin, "systemctl"), systemctl),
      writeFile(path.join(bin, "systemd-analyze"), "#!/usr/bin/env bash\nexit 0\n"),
      writeFile(path.join(bin, "getfacl"), "#!/usr/bin/env bash\necho '# file: test'\necho 'user::rwx'\n"),
      writeFile(path.join(bin, "setfacl"), "#!/usr/bin/env bash\nexit 0\n"),
    ]);
    await Promise.all((await readdir(bin)).map((file) => chmod(path.join(bin, file), 0o755)));

    const env = {
      ...process.env,
      PATH: `${bin}:${process.env.PATH}`,
      VPN_ENDPOINT_HEALTH_LIVE_APPROVED: "1",
      VPN_ENDPOINT_HEALTH_SYSTEMD_DIR: systemd,
      VPN_ENDPOINT_HEALTH_RUNTIME_DIR: path.join(root, "runtime"),
      VPN_ENDPOINT_HEALTH_SECURE_DIR: secure,
      VPN_ENDPOINT_HEALTH_RECEIPT_ROOT: receipts,
      VPN_ENDPOINT_HEALTH_RECEIPT_ID: `test-${enabled}-${active}`,
    };
    const applied = spawnSync("bash", [scriptPath.pathname, "apply"], { env, encoding: "utf8" });
    assert.equal(applied.status, 0, applied.stderr);
    const [receiptName] = await readdir(receipts);
    assert.equal(receiptName, `test-${enabled}-${active}`);
    const rolledBack = spawnSync("bash", [scriptPath.pathname, "rollback", path.join(receipts, receiptName)], { env, encoding: "utf8" });
    assert.equal(rolledBack.status, 0, rolledBack.stderr);
    assert.equal((await readFile(path.join(state, "vpn-endpoint-check.timer.enabled"), "utf8")).trim(), enabled);
    assert.equal((await readFile(path.join(state, "vpn-endpoint-check.timer.active"), "utf8")).trim(), active);
    assert.equal((await readFile(path.join(state, "vpn-endpoint-check.service.active"), "utf8")).trim(), "inactive");
    assert.equal(await readFile(path.join(systemd, "vpn-endpoint-check.service"), "utf8"), "old service\n");
    assert.equal(await readFile(path.join(systemd, "vpn-endpoint-check.timer"), "utf8"), "old timer\n");
  }
});

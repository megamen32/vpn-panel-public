import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";

const scriptPath = new URL("../scripts/apply-endpoint-health.py", import.meta.url).pathname;

function runHealthAssertion(eligible: boolean) {
  const directory = mkdtempSync(path.join(tmpdir(), "vpn-health-test-"));
  const resultPath = path.join(directory, "result.json");
  writeFileSync(resultPath, JSON.stringify({
    endpoints: [
      { endpoint: "smart-de-relay", eligible, checks: [] },
      { endpoint: "full-de-relay", eligible: false, checks: [] },
      { endpoint: "smart-us-relay", eligible: false, checks: [] },
      { endpoint: "full-us-relay", eligible: false, checks: [] },
      { endpoint: "de-xhttp", eligible: true, checks: [] },
    ],
  }));
  const result = spawnSync("python3", [scriptPath, resultPath, "--require-canonical-relays"], { encoding: "utf8" });
  rmSync(directory, { recursive: true, force: true });
  return result;
}

test("health policy fails loudly instead of treating 0/4 canonical relays as healthy", () => {
  const result = runHealthAssertion(false);

  assert.equal(result.status, 3);
  assert.match(result.stderr, /0\/4 canonical relays are eligible/);
});

test("zero canonical relays fail closed before profile application or panel restart", () => {
  const directory = mkdtempSync(path.join(tmpdir(), "vpn-health-test-"));
  const resultPath = path.join(directory, "result.json");
  const binDirectory = path.join(directory, "bin");
  const callsPath = path.join(directory, "calls.log");
  const statePath = path.join(directory, "working-state");
  try {
    writeFileSync(resultPath, JSON.stringify({
      endpoints: [
        { endpoint: "smart-de-relay", eligible: false, checks: [] },
        { endpoint: "full-de-relay", eligible: false, checks: [] },
        { endpoint: "smart-us-relay", eligible: false, checks: [] },
        { endpoint: "full-us-relay", eligible: false, checks: [] },
      ],
    }));
    mkdirSync(binDirectory);
    for (const command of ["psql", "sudo"]) {
      const commandPath = path.join(binDirectory, command);
      writeFileSync(commandPath, `#!/bin/sh\nprintf '%s\\n' '${command}' >> "$HEALTH_CALLS"\n`);
      chmodSync(commandPath, 0o755);
    }

    const result = spawnSync("python3", [scriptPath, resultPath, "--apply-profiles", "--require-canonical-relays"], {
      encoding: "utf8",
      env: {
        ...process.env,
        DATABASE_URL: "postgresql://test",
        HEALTH_CALLS: callsPath,
        PATH: `${binDirectory}:${process.env.PATH}`,
        WORKING_STATE_FILE: statePath,
      },
    });

    assert.equal(result.status, 3, result.stderr);
    assert.equal(existsSync(callsPath), false, "profile application or restart was invoked");
    assert.equal(existsSync(statePath), false, "working profile state was written");
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test("health policy accepts a run with at least one eligible canonical relay", () => {
  const result = runHealthAssertion(true);

  assert.equal(result.status, 0, result.stderr);
});

test("hourly health job enables the canonical relay assertion", () => {
  const script = readFileSync(new URL("../scripts/auto-endpoint-check.sh", import.meta.url), "utf8");
  assert.match(script, /--require-canonical-relays/);
});

test("automatic profile updates always retain Finland alongside the full relay", () => {
  const code = [
    "import importlib.util, sys",
    "spec = importlib.util.spec_from_file_location('health', sys.argv[1])",
    "module = importlib.util.module_from_spec(spec)",
    "spec.loader.exec_module(module)",
    "print(','.join(module.always_include_endpoints()))",
  ].join("; ");
  const result = spawnSync("python3", ["-c", code, scriptPath], {
    encoding: "utf8",
    env: { ...process.env, ALWAYS_INCLUDE_ENDPOINTS: "custom-fallback,fi-helsinki-relay" },
  });

  assert.equal(result.status, 0, result.stderr);
  assert.deepEqual(result.stdout.trim().split(","), ["ru-full-relay", "fi-helsinki-relay", "custom-fallback"]);
});

test("owner profile updates retain contractual relays alongside healthy routes", () => {
  const tempBase = path.join(process.cwd(), ".tmp");
  mkdirSync(tempBase, { recursive: true });
  const directory = mkdtempSync(path.join(tempBase, "vpn-health-owner-"));
  const binDirectory = path.join(directory, "bin");
  const argsPath = path.join(directory, "psql-args");
  try {
    mkdirSync(binDirectory);
    const psqlPath = path.join(binDirectory, "psql");
    writeFileSync(
      psqlPath,
      "#!/bin/sh\nprintf '%s\\n' \"$@\" > \"$HEALTH_PSQL_ARGS\"\ncat >/dev/null\n",
    );
    chmodSync(psqlPath, 0o755);

    const code = [
      "import importlib.util, sys",
      "spec = importlib.util.spec_from_file_location('health', sys.argv[1])",
      "module = importlib.util.module_from_spec(spec)",
      "spec.loader.exec_module(module)",
      "module.apply_profiles('postgresql://test', ['smart-de-relay'], ['ru-full-relay', 'fi-helsinki-relay'])",
    ].join("; ");
    const result = spawnSync("python3", ["-c", code, scriptPath], {
      encoding: "utf8",
      env: {
        ...process.env,
        HEALTH_PSQL_ARGS: argsPath,
        PATH: binDirectory + ":" + process.env.PATH,
      },
    });

    assert.equal(result.status, 0, result.stderr);
    assert.match(
      readFileSync(argsPath, "utf8"),
      /owner_profiles=smart-de-relay,ru-full-relay,fi-helsinki-relay/,
    );
    assert.match(
      readFileSync(scriptPath, "utf8"),
      /string_to_array\(:'owner_profiles', ','\)/,
    );
    assert.match(
      readFileSync(scriptPath, "utf8"),
      /update endpoints set enabled = true, updated_at = now\(\)\s+where id = any\(string_to_array\(:'always_include', ','\)\)/,
    );
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

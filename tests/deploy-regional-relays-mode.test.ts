import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

test("regional relay deploy mode is decided after loading .env", async () => {
  const script = await readFile(new URL("../scripts/deploy-regional-relays.sh", import.meta.url), "utf8");
  const sourceEnv = script.indexOf('source "$REPO_DIR/.env"');
  const argumentLoop = script.indexOf('for arg in "$@"; do');

  assert.ok(sourceEnv >= 0);
  assert.ok(argumentLoop > sourceEnv, "only explicit CLI arguments may request a dry run");
  assert.match(script, /--dry-run\) DRY_RUN=true/);
  assert.match(script, /--primary-only\) DEPLOY_HAOS_RESERVE=false/);
  assert.match(script, /HAOS reserve skipped by explicit --primary-only request/);
  assert.match(script, /retry without --primary-only after recovery certificate repair/);
});

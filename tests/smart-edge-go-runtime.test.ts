import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import test from "node:test";

test("canonical Smart Edge deploy installs the Go runtime without privilege expansion", async () => {
  const deploy = await readFile(new URL("../scripts/smart-edge-deploy.mjs", import.meta.url), "utf8");
  const unit = await readFile(new URL("../infra/smart-edge/smart-edge.service", import.meta.url), "utf8");
  const makefile = await readFile(new URL("../scripts/smartedge-go/Makefile", import.meta.url), "utf8");

  assert.match(deploy, /path\.join\(ROOT, 'scripts', 'smartedge-go'\)/);
  assert.match(deploy, /CGO_ENABLED/);
  assert.match(deploy, /\/usr\/local\/bin\/smart-edge/);
  assert.doesNotMatch(deploy, /smart-edge\.py/);

  assert.match(unit, /^User=nobody$/m);
  assert.match(unit, /^Group=nogroup$/m);
  assert.match(unit, /^ExecStart=\/usr\/local\/bin\/smart-edge$/m);
  assert.doesNotMatch(unit, /python3/);
  assert.doesNotMatch(makefile, /deploy-edge|\bscp\b|\bssh\b/);
  await assert.rejects(
    readFile(new URL("../scripts/smartedge-go/smart-edge.service", import.meta.url)),
    { code: "ENOENT" },
  );
});

test("Smart Edge cutover gates CPU under proxied load and rolls back uncertain receipts", async () => {
  const cutoverUrl = new URL("../scripts/smart-edge-go-cutover.sh", import.meta.url);
  const cutover = await readFile(cutoverUrl, "utf8");

  assert.match(cutover, /proxied_value/);
  assert.match(cutover, /CONTROLLED_LOAD_REQUESTS=100/);
  assert.match(cutover, /CONTROLLED_LOAD_CONCURRENCY=20/);
  assert.match(cutover, /run_controlled_load/);
  assert.match(cutover, /controlled\.before\.ok/);
  assert.match(cutover, /controlled\.after\.ok/);
  assert.match(cutover, /stats\.controlled/);
  assert.match(cutover, /sample_cpu.+cpu\.after\.tsv/s);
  assert.match(cutover, /rollback_partial_on_exit/);
  assert.match(cutover, /RECEIPT_ID=smart-edge-go-20260803-r5/);
  assert.match(cutover, /--show-cursor/);
  assert.match(cutover, /--after-cursor/);
  assert.match(cutover, /fail_and_rollback/);
  assert.match(cutover, /traffic_mode=low-load/);
  assert.match(cutover, /before <= 5/);
  assert.match(cutover, /for runtime_wait_index in/);
  assert.match(cutover, /runtime_ready=1/);
  assert.match(cutover, /failure\.status/);
  assert.match(cutover, /https_attempts=20/);
  assert.match(cutover, /stats\.low-load/);
  assert.match(cutover, /https_required=2/);
  assert.doesNotMatch(cutover, /if ! apply_one/);
  assert.match(cutover, /rollback_if_exists vpn2[\s\S]*rollback_if_exists vusa/);
  assert.doesNotMatch(cutover, /curl[^\n]*\s-k/);

  const selftest = spawnSync("bash", [fileURLToPath(cutoverUrl), "selftest"], { encoding: "utf8" });
  assert.equal(selftest.status, 0, selftest.stderr);
  assert.match(selftest.stdout, /partial rollback self-test passed/);
  assert.match(selftest.stdout, /controlled load accounting self-test passed/);
});

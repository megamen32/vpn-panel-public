import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import path from "node:path";
import test from "node:test";

const root = process.cwd();

for (const [script, args] of [
  ["scripts/deploy-all.sh", ["smartdns"]],
  ["scripts/deploy-all.sh", ["router"]],
  ["scripts/deploy-all.sh", []],
  ["scripts/deploy-smartdns-unified.sh", []],
  ["scripts/deploy-router-lan-smart-edge.sh", []],
] as const) {
  test(`${script} fails closed before a retired LAN deployment`, () => {
    const result = spawnSync("bash", [path.join(root, script), ...args], {
      cwd: root,
      encoding: "utf8",
    });
    assert.equal(result.status, 2, `${result.stdout}\n${result.stderr}`);
    assert.match(result.stderr, /retired/i);
  });
}

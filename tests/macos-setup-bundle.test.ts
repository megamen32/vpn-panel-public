import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { access } from "node:fs/promises";
import { spawnSync } from "node:child_process";

const setupPath = "/home/roomhacker/.codex/attachments/1907ab9b-1881-4584-b8c1-7ffa3206cd74/setup";

test("macOS bundle setup exposes safe install and uninstall commands", async () => {
  await access(setupPath);
  const script = await readFile(setupPath, "utf8");
  const tools = await readFile(`${setupPath.slice(0, setupPath.lastIndexOf("/"))}/vpn_tools.py`, "utf8");

  assert.equal(spawnSync("bash", ["-n", setupPath]).status, 0);
  assert.match(script, /install\)/);
  assert.match(script, /uninstall\)/);
  assert.match(script, /root|рут/i);
  assert.match(script, /network|системн.*настрой/i);
  assert.match(script, /install-sing-box/);
  assert.ok(script.includes('"${PYTHON}" "${TOOLS}" update'));
  assert.ok(script.includes('"${PYTHON}" "${TOOLS}" check'));
  assert.doesNotMatch(script, /networksetup\s+-set|scutil\s+--set|route\s+add/);
  assert.doesNotMatch(script, /\r/);
  assert.doesNotMatch(tools, /\r/);
  assert.match(tools, /urllib\.request/);
  assert.match(tools, /urlopen\(/);
  assert.match(tools, /darwin/i);
});

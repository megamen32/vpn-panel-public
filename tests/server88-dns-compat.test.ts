import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

test("server-88 compatibility smoke checks deduplicate synthesized DNS answers", async () => {
  const deploy = await readFile(path.join(projectRoot, "scripts/deploy-server88-dns-compat.sh"), "utf8");

  assert.match(deploy, /instagram_answer=.*sort -u/);
  assert.match(deploy, /chatgpt_answer=.*sort -u/);
  assert.match(deploy, /compat_answer=.*sort -u/);
});

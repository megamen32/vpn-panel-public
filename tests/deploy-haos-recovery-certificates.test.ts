import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

test("HAOS recovery deploy stages every anonymous recovery certificate from server-100", async () => {
  const script = await readFile(new URL("../scripts/deploy-haos-recovery.sh", import.meta.url), "utf8");

  assert.match(script, /cert_dir="\/etc\/letsencrypt\/live\/\$host"/);
  assert.match(script, /fullchain\.pem/);
  assert.match(script, /privkey\.pem/);
  assert.match(script, /CERT_STAGE_DIR/);
  assert.match(script, /install_recovery_certificates/);
  assert.match(script, /docker cp "\$CERT_STAGE_DIR\/\$host\.pem"/);
  assert.ok(script.indexOf("check_staged_recovery_certificates") < script.indexOf("if [[ \"$DRY_RUN\" == true ]]"));
});

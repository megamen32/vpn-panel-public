import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

test("router owns a single LAN Smart Edge address with primary and backup Xray backends", async () => {
  const config = await readFile(new URL("../deploy/router/haproxy/haproxy.cfg", import.meta.url), "utf8");

  assert.match(config, /frontend lan_smart_443_in\n\s+bind 192\.168\.2\.1:443/);
  assert.match(config, /backend lan_smart_443_backends[\s\S]*?server s88 192\.168\.2\.75:443 check[\s\S]*?server s44 192\.168\.2\.5:443 check.* backup/);
  assert.doesNotMatch(config, /frontend lan_smart_80_in/);
});

test("transparent Smart Edge reserves a distinct public-looking LAN DNS alias", async () => {
  const config = await readFile(new URL("../deploy/router/transparent-smart-edge/apply.sh", import.meta.url), "utf8");

  assert.match(config, /public_edge_ip="\$\{5:-203\.0\.113\.1\}"/);
  assert.match(config, /vpn_panel_public_smart_edge_https/);
  assert.match(config, /src_dip=\$public_edge_ip/);
  assert.match(config, /dnat \$haos_ip:443/);
  assert.match(config, /public_alias=\$public_edge_ip/);
  assert.match(config, /--public-alias-apply/);
  assert.match(config, /apply_public_alias/);
});

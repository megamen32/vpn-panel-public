import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const config = fs.readFileSync(path.join(root, "deploy/vusa/nginx/edge-https.conf"), "utf8");

test("VUSA Wisp ingress upgrades only the dedicated /wisp/ location", () => {
	assert.match(config, /location \^~ \/wisp\/ \{/);
	assert.match(config, /proxy_pass http:\/\/127\.0\.0\.1:48081;/);
	assert.match(config, /proxy_set_header Upgrade \$http_upgrade;/);
	assert.match(config, /proxy_set_header Connection "upgrade";/);
	assert.match(config, /access_log off;/);
});

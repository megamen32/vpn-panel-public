import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";

test("HAOS transport renders every newly enabled lane and remains idempotent", async () => {
  await mkdir(".tmp", { recursive: true });
  const dir = await mkdtemp(path.resolve(".tmp/haos-lanes-"));
  try {
    const secure = path.join(dir, "secure.json");
    await writeFile(secure, JSON.stringify({ nodes: [], server_configs: {
      "regional-relays": { fi_connect_address: "198.51.100.10", fi_relay_uuid: "test-uuid", fi_public_key: "test-key", fi_short_id: "test-id" }
    } }));
    const render = (input: object) => {
      const result = spawnSync("bash", ["-c", 'cat | "$1" --import tsx src/cli/render-haos-finland-transport.ts', "render-test", process.execPath], {
        input: JSON.stringify(input), encoding: "utf8",
        env: { ...process.env, VPN_PANEL_SECURE_CONFIG: secure }
      });
      assert.equal(result.status, 0, result.stderr);
      return JSON.parse(result.stdout);
    };
    const base = { outbounds: [
      { type: "vless", tag: "de-cdn" },
      { type: "vless", tag: "de-httpupgrade" },
      { type: "urltest", tag: "de-regional", outbounds: ["de-cdn", "de-httpupgrade"] },
      { type: "vless", tag: "us-cdn" },
      { type: "vless", tag: "us-httpupgrade" },
      { type: "urltest", tag: "us-regional", outbounds: ["us-cdn", "us-httpupgrade"] },
    ], route: { final: "de-regional" } };
    const first = render(base);
    assert.deepEqual(first.outbounds.find((o: any) => o.tag === "direct"), { type: "direct", tag: "direct" });
    assert.equal(first.outbounds.find((o: any) => o.tag === "fi-helsinki").type, "vless");
    const members = ["de-cdn", "de-httpupgrade", "fi-helsinki", "us-cdn", "us-httpupgrade"];
    assert.deepEqual(first.outbounds.find((o: any) => o.tag === "world-auto"), {
      type: "urltest",
      tag: "world-auto",
      outbounds: members,
      url: "https://www.gstatic.com/generate_204",
      interval: "30s",
    });
    assert.deepEqual(first.outbounds.find((o: any) => o.tag === "telegram-auto"), {
      type: "urltest",
      tag: "telegram-auto",
      outbounds: members,
      url: "https://t.me/s/telegram",
      interval: "30s",
    });
    assert.deepEqual(first.route.rules[0], {
      inbound: ["transparent-edge-http"],
      domain_suffix: ["telegram.org", "telegram.me", "t.me", "tdesktop.com", "telesco.pe", "telegra.ph"],
      outbound: "telegram-auto",
    });
    assert.equal(first.route.final, "world-auto");
    assert.deepEqual(first.outbounds[0], base.outbounds[0]);
    assert.deepEqual(render(first), first);
  } finally { await rm(dir, { recursive: true, force: true }); }
});

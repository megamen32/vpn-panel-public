import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const deMobileRelayRoutes = [
  { sni: "smart-de.runet.bezrabotnyi.com", backend: "95.165.165.65:443", label: "Mobile Smart DE relay" },
  { sni: "full-de.runet.bezrabotnyi.com", backend: "95.165.165.65:443", label: "Mobile Full DE relay" },
];

const usMobileRelayRoutes = [
  { sni: "smart-us.runet.bezrabotnyi.com", backend: "95.165.165.65:443", label: "Mobile Smart US relay" },
  { sni: "full-us.runet.bezrabotnyi.com", backend: "95.165.165.65:443", label: "Mobile Full US relay" },
];

const mobileRelayIds = [
  "smart-de-relay-mobile",
  "full-de-relay-mobile",
  "smart-us-relay-mobile",
  "full-us-relay-mobile",
];

test("opposite-region public edges forward mobile relay SNI to the primary RU ingress", async () => {
  const { DEFAULT_SMART_EDGE_TARGETS } = await import("../src/smart-edge-config.js");
  const vusa = DEFAULT_SMART_EDGE_TARGETS.find((target) => target.id === "vusa");
  const vpn2 = DEFAULT_SMART_EDGE_TARGETS.find((target) => target.id === "vpn2");
  assert.ok(vusa);
  assert.ok(vpn2);
  assert.equal(vpn2.streamConfigPath, "/etc/nginx/stream-smart-edge.conf");
  assert.deepEqual(vpn2.obsoleteStreamConfigPaths, ["/etc/nginx/stream-reality.conf"]);
  assert.equal(vpn2.streamAccessLog, true);
  assert.deepEqual(vpn2.specialRoutes.filter((route) => route.label?.startsWith("GPTAdmin ")), [
    { sni: ".t.gptadmin.bezrabotnyi.com", backend: "127.0.0.1:8446", label: "GPTAdmin tunnel" },
    { sni: ".v.gptadmin.bezrabotnyi.com", backend: "127.0.0.1:8445", label: "GPTAdmin vhost" },
  ]);
  assert.deepEqual(vusa.specialRoutes.filter((route) => route.label?.startsWith("Mobile ")), deMobileRelayRoutes);
  assert.deepEqual(vpn2.specialRoutes.filter((route) => route.label?.startsWith("Mobile ")), usMobileRelayRoutes);

  // The CLI owns the deployed nginx stream config and must not drift from the
  // application-side target shown in the admin panel.
  const deployScript = await readFile(new URL("../scripts/smart-edge-deploy.mjs", import.meta.url), "utf8");
  for (const route of [...deMobileRelayRoutes, ...usMobileRelayRoutes]) {
    assert.match(deployScript, new RegExp(`sni: '${route.sni.replaceAll(".", "\\.")}'.+backend: '${route.backend}'`));
  }
  assert.match(deployScript, /obsoleteStreamConfigPaths/);
  assert.match(deployScript, /sed -i.+include/);
  assert.match(deployScript, /access_log \/var\/log\/nginx\/stream-access\.log stream_fmt/);
  assert.match(deployScript, /if ! nginx -t; then[\s\S]+cp -a "\$NGINX_BACKUP" \/etc\/nginx\/nginx\.conf/);
});

test("mobile relay aliases remain available for diagnostics but not public subscriptions", async () => {
  const secureConfig = await import("../src/secure-config.js");
  assert.deepEqual(secureConfig.mobileRelayEndpointOrder, mobileRelayIds);
  assert.ok(secureConfig.subscriptionEndpointOrder.every((id) => !mobileRelayIds.includes(id)));
});

test("regional relay migration creates Safari mobile variants on the stable primary ingress", async () => {
  const { transformSecure } = await import("../src/cli/migrate-regional-relays.js");
  const template = { address: "example.invalid", port: 443, public_key: "public", short_id: "short" };
  const raw = {
    nodes: [
      { ...template, id: "smart-de-relay", label: "Smart DE", sni: "smart-de.runet.bezrabotnyi.com", fingerprint: "chrome" },
      { ...template, id: "us-reality" },
      { ...template, id: "de-xhttp" },
      { ...template, id: "de-httpupgrade" },
      { ...template, id: "de-direct-ws" },
      { ...template, id: "de-grpc" },
      { ...template, id: "de-cdn" },
      { ...template, id: "de-cdn2" },
    ],
    server_configs: {
      ru: { server_names: [] },
      "regional-relays": { fi_relay_uuid: "relay-client", fi_public_key: "public", fi_short_id: "short" },
    },
  };

  const transformed = transformSecure(raw);
  const mobileNodes = transformed.nodes.filter((node) => mobileRelayIds.includes(node.id));
  assert.deepEqual(mobileNodes.map((node) => ({
    id: node.id,
    address: node.address,
    port: node.port,
    sni: node.sni,
    fingerprint: node.fingerprint,
  })), [
    { id: "smart-de-relay-mobile", address: "95.165.165.65", port: 443, sni: "smart-de.runet.bezrabotnyi.com", fingerprint: "safari" },
    { id: "full-de-relay-mobile", address: "95.165.165.65", port: 443, sni: "full-de.runet.bezrabotnyi.com", fingerprint: "safari" },
    { id: "smart-us-relay-mobile", address: "95.165.165.65", port: 443, sni: "smart-us.runet.bezrabotnyi.com", fingerprint: "safari" },
    { id: "full-us-relay-mobile", address: "95.165.165.65", port: 443, sni: "full-us.runet.bezrabotnyi.com", fingerprint: "safari" },
  ]);
  assert.equal(transformed.nodes.find((node) => node.id === "smart-de-relay")?.address, "95.165.165.65");
  const finland = transformed.nodes.find((node) => node.id === "fi-helsinki-relay");
  assert.deepEqual(
    finland && { address: finland.address, port: finland.port, sni: finland.sni, publicCatalog: finland.public_catalog },
    { address: "95.165.165.65", port: 443, sni: "fi.runet.bezrabotnyi.com", publicCatalog: true },
  );
  assert.equal(transformed.nodes.filter((node) => node.id === "fi-helsinki-relay").length, 1);
  assert.equal((transformed.server_configs["regional-relays"] as { fi_relay_uuid?: string }).fi_relay_uuid, "relay-client");
});

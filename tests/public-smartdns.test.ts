import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

test("unified SmartDNS keeps LAN DNS separate from the public plain-DNS listener", async () => {
  const source = await readFile("scripts/deploy-smartdns-unified.sh", "utf8");
  assert.match(source, /\.udpListen = \{host:"192\.168\.2\.100", port:53, profile:"local"\}/);
  assert.match(source, /\.publicDnsListen = \{host:"192\.168\.2\.100", port:5354, profile:"public"\}/);
  assert.match(source, /del\(\.staticA\["bezrabotny\.com"\]\)/);
  assert.match(source, /\.staticA\["bezrabotnyi\.com"\] = \["95\.165\.165\.65"\]/);
  assert.match(source, /\.staticA\["vpn2\.bezrabotnyi\.com"\] = \["212\.192\.31\.128"\]/);
  assert.match(source, /\.staticA\["vusa\.bezrabotnyi\.com"\] = \["185\.240\.120\.152"\]/);
  assert.match(source, /\.staticASuffix\["bezrabotnyi\.com"\] = \["95\.165\.165\.65"\]/);
  assert.match(source, /\.staticAExclude = \["vpn2\.bezrabotnyi\.com", "vusa\.bezrabotnyi\.com"\]/);
  assert.match(source, /SmartDNS Public UDP/);
  assert.match(source, /SmartDNS Public TCP/);
});

test("OpenWrt exposes only WAN port 53 and preserves named usage counters", async () => {
  const source = await readFile("deploy/router/public-smartdns.sh", "utf8");
  assert.match(source, /public_smartdns_udp/);
  assert.match(source, /public_smartdns_tcp/);
  assert.match(source, /src_dport=53/);
  assert.match(source, /server_ip="192\.168\.2\.100"/);
  assert.match(source, /server_port="5354"/);
  assert.match(source, /rate="200\/second"/);
  assert.match(source, /public-smartdns --usage/);
  assert.match(source, /--dry-run/);
  assert.match(source, /--rollback/);
});

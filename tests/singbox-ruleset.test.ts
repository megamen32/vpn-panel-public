import test from 'node:test';
import assert from 'node:assert/strict';
import { singBoxSubscription } from '../src/subscriptions.js';
import type { SecureConfig } from '../src/secure-config.js';
import type { Endpoint } from '../src/types.js';

const secure = { defaults: { domain_strategy: 'AsIs' }, nodes: [], server_configs: {} } as unknown as SecureConfig;
const endpoint: Endpoint = {
  id: 'de-hysteria2', label: 'DE Hysteria2', kind: 'hysteria2', address: 'vpn2.bezrabotnyi.com',
  port: 24443, profile_id: 'de-hysteria2', enabled: true, sort_order: 1,
  config: { public_catalog: true, sni: 'vpn2.bezrabotnyi.com' },
};
// A WS-over-TLS endpoint builds without any Reality key material, so the
// fixture exercises a TCP transport the generator can actually emit.
const tcpEndpoint: Endpoint = {
  id: 'de-cdn', label: 'DE CDN', kind: 'vless-ws', address: 'cdn.demiurge.space', port: 443,
  profile_id: 'de-cdn', enabled: true, sort_order: 2,
  config: {
    public_catalog: true,
    query: { type: 'ws', sni: 'vpn2.bezrabotnyi.com', host: 'vpn2.bezrabotnyi.com', path: '/cdn-ws', fp: 'chrome' },
  },
};
const bundle = {
  accountId: 'a', clientId: 'c', login: 'test', displayName: 'test', token: 'fixture',
  xrayUuid: '11111111-1111-4111-8111-111111111111', endpoints: [endpoint, tcpEndpoint],
};

/** Every string in the config that looks like a URL a client would have to fetch. */
const fetchableUrls = (config: Record<string, unknown>): string[] => {
  const found: string[] = [];
  const walk = (node: unknown): void => {
    if (typeof node === "string") {
      if (/^https?:\/\//.test(node)) found.push(node);
      return;
    }
    if (Array.isArray(node)) return node.forEach(walk);
    if (node && typeof node === "object") Object.values(node).forEach(walk);
  };
  walk(config);
  return found;
};

test('the sing-box subscription needs nothing fetched from the internet to start', () => {
  const config = singBoxSubscription(bundle, secure);

  // sing-box downloads a declared remote rule set during route init with
  // FastFail, so a network that cannot reach the host fails to initialise
  // routing entirely. That surfaces as a tunnel that is up and carrying
  // nothing, and it was caused here by a rule set that 404s upstream.
  const route = config.route as { rule_set?: unknown[] };
  assert.deepEqual(route.rule_set ?? [], [], "the config must declare no remote rule set");

  const urls = fetchableUrls(config);
  const downloads = urls.filter((url) => !url.startsWith("https://1.1.1.1/"));
  assert.deepEqual(downloads, [], "the config must not require any remote download to start");
});

test('every rule set referenced anywhere in the config is declared', () => {
  const config = singBoxSubscription(bundle, secure);
  const route = config.route as { rule_set?: Array<{ tag?: string }> };
  const declared = (route.rule_set ?? []).map((entry) => entry.tag);
  const dns = config.dns as { rules?: Array<{ rule_set?: string[] }> };
  for (const rule of dns.rules ?? []) {
    for (const tag of rule.rule_set ?? []) {
      assert.ok(declared.includes(tag), `DNS rule references undeclared rule set: ${tag}`);
    }
  }
});

test('the DNS rule uses a field sing-box defines for DNS rules', () => {
  const config = singBoxSubscription(bundle, secure);
  const rules = (config.dns as { rules?: Array<Record<string, unknown>> }).rules ?? [];
  // ip_accept_private is not a DNS-rule field; sing-box's strict decoder
  // rejects the whole config on it, which is the difference between a working
  // subscription and one no client can load.
  assert.equal(rules.length, 1);
  assert.equal(rules[0].ip_is_private, true);
  assert.equal(rules[0].server, "local");
  assert.equal((config.dns as { final?: string }).final, "remote");
});

test('the config uses current sing-box DNS and route formats', () => {
  const config = singBoxSubscription(bundle, secure);

  // Legacy `address` servers and a missing default_domain_resolver are
  // deprecated from 1.12 and removed in 1.14: current cores refuse the config
  // outright unless a deprecated-behaviour environment variable is set.
  const servers = (config.dns as { servers?: Array<Record<string, unknown>> }).servers ?? [];
  for (const server of servers) {
    assert.equal(server.address, undefined, "legacy DNS server form is removed in sing-box 1.14");
    assert.ok(server.type, "each DNS server must declare its type");
  }
  const route = config.route as { default_domain_resolver?: unknown };
  assert.ok(route.default_domain_resolver, "sing-box 1.12+ requires a default_domain_resolver");
});

test('the selector does not start a client on a QUIC transport', () => {
  const config = singBoxSubscription(bundle, secure);
  const selector = (config.outbounds as Array<Record<string, unknown>>)
    .find((outbound) => outbound.type === "selector") as Record<string, unknown>;
  // A client that honours this selector begins here. Starting on QUIC means
  // starting on a transport a throttled mobile network answers to a latency
  // probe and then refuses to carry traffic over.
  assert.equal(selector.default, 'de-cdn');
  assert.notEqual(selector.default, 'de-hysteria2');
  assert.ok((selector.outbounds as string[]).includes(selector.default as string));
});
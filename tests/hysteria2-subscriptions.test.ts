import test from 'node:test';
import assert from 'node:assert/strict';
import { vlessLink, xrayClientSubscription, singBoxOutboundFromEndpoint } from '../src/subscriptions.js';
import type { SecureConfig } from '../src/secure-config.js';
import type { Endpoint } from '../src/types.js';

const secure = { defaults: { domain_strategy: 'AsIs' }, nodes: [], server_configs: {} } as unknown as SecureConfig;
const endpoint: Endpoint = { id: 'de-hysteria2', label: 'DE Hysteria2', kind: 'hysteria2',
  address: 'vpn2.bezrabotnyi.com', port: 24443, profile_id: 'de-hysteria2', enabled: true,
  sort_order: 1, config: { public_catalog: true, sni: 'vpn2.bezrabotnyi.com' } };
const credential = '11111111-1111-4111-8111-111111111111';

test('Hysteria URI preserves per-user auth and certificate validation for mobile import', () => {
  const link = new URL(vlessLink(endpoint, credential, secure)!);
  assert.equal(link.protocol, 'hysteria2:');
  assert.equal(link.username, credential);
  assert.equal(link.searchParams.get('sni'), endpoint.address);
  assert.equal(link.searchParams.has('insecure'), false);
  assert.equal(vlessLink({ ...endpoint, enabled: false }, credential, secure), null);
});

test('Xray JSON includes compatible Hysteria2 protocol and per-user auth', () => {
  const config = xrayClientSubscription({ accountId: 'a', clientId: 'c', login: 'test', displayName: 'test',
    token: 'fixture', xrayUuid: credential, endpoints: [endpoint] }, secure);
  const outbound = (config.outbounds as any[])[0];
  assert.equal(outbound.protocol, 'hysteria');
  assert.equal(outbound.settings.version, 2);
  assert.equal(outbound.streamSettings.hysteriaSettings.auth, credential);
  assert.equal(outbound.streamSettings.tlsSettings.serverName, endpoint.address);
});

test('sing-box Hysteria2 uses the same identity without disabling TLS verification', () => {
  const outbound = singBoxOutboundFromEndpoint(endpoint, credential, secure)!;
  assert.equal(outbound.password, credential);
  assert.deepEqual(outbound.tls, { enabled: true, server_name: endpoint.address });
});

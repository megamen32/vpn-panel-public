import assert from "node:assert/strict";
import test from "node:test";

import { smartDnsPage } from "../src/pages.js";
import type {
  RestrictedServiceStatusProbeResult,
  RestrictedServicesCatalog,
  RestrictedServicesStatus,
} from "../src/restricted-services.js";
import { DEFAULT_SMART_DNS_POLICY } from "../src/smart-dns-policy.js";

const catalog: RestrictedServicesCatalog = {
  schemaVersion: 1,
  updatedAt: "2026-07-17",
  description: "Reviewed catalog",
  sources: [{
    id: "advisory",
    repository: "example/advisory",
    homepage: "https://example.com/advisory",
    role: "evidence-only",
    refreshHours: 6,
    feeds: [{ id: "feed-a", repository: "example/feed", url: "https://example.com/feed-a.txt" }],
  }],
  lanEdgeIp: "192.168.2.75",
  publicEdges: [
    { id: "vpn2_sni", label: "VPN2 SNI (DE)", ip: "192.0.2.10" },
    { id: "vusa_sni", label: "VUSA SNI (US)", ip: "192.0.2.11" },
  ],
  lanProxies: [{ id: "us_proxy", label: "LAN US proxy", url: "http://192.168.2.75:3127" }],
  services: [{
    id: "telegram",
    label: "Telegram",
    probeUrl: "https://telegram.org/",
    route: "local-proxy",
    restriction: "DPI/SNI",
    domains: ["telegram.org"],
  }],
};

function probe(overrides: Partial<RestrictedServiceStatusProbeResult>): RestrictedServiceStatusProbeResult {
  return {
    reachable: true,
    stability: "stable",
    attempts: 2,
    successes: 2,
    httpCode: 200,
    latencyMs: 120,
    remoteIp: "192.0.2.1",
    error: null,
    evidence: [
      { attempt: 1, startedAt: "2026-07-17T00:00:00.000Z", durationMs: 120, curlExitCode: 0, reachable: true, httpCode: 200, latencyMs: 120, remoteIp: "192.0.2.1", error: null },
      { attempt: 2, startedAt: "2026-07-17T00:00:01.000Z", durationMs: 120, curlExitCode: 0, reachable: true, httpCode: 200, latencyMs: 120, remoteIp: "192.0.2.1", error: null },
    ],
    ...overrides,
  };
}

test("restricted-services UI distinguishes lane outcomes and stale evidence", () => {
  const status: RestrictedServicesStatus = {
    schemaVersion: 2,
    generatedAt: "2000-01-01T00:00:00.000Z",
    durationMs: 8000,
    catalogUpdatedAt: catalog.updatedAt,
    observationalOnly: true,
    run: { probes: true, externalFeeds: true, attempts: 2, laneConcurrency: 2 },
    sourceSummary: { configured: 1, fetched: 1, failed: 0, skipped: 0, rules: 42 },
    feeds: [{
      id: "feed-a",
      url: "https://example.com/feed-a.txt",
      state: "ok",
      fetchedAt: "2000-01-01T00:00:00.000Z",
      durationMs: 100,
      ruleCount: 42,
      error: null,
    }],
    laneDefinitions: [
      { id: "direct_ru", label: "RU direct", kind: "direct" },
      { id: "lan_sni", label: "LAN SNI", kind: "sni" },
      { id: "vpn2_sni", label: "VPN2 SNI", kind: "sni" },
      { id: "vusa_sni", label: "VUSA SNI", kind: "sni" },
      { id: "us_proxy", label: "LAN US proxy", kind: "http-proxy" },
    ],
    rows: [{
      id: "telegram",
      label: "Telegram",
      route: "local-proxy",
      restriction: "DPI/SNI",
      externalFeeds: ["feed-a<script>alert(1)</script>"],
      lanes: {
        direct_ru: probe({ httpCode: 403, remoteIp: "<img src=x onerror=alert(1)>" }),
        lan_sni: probe({ stability: "flaky", successes: 1, error: "1/2 attempts failed" }),
        vpn2_sni: probe({ reachable: false, stability: "down", successes: 0, httpCode: null, error: "timeout" }),
        vusa_sni: probe({ reachable: false, stability: "skipped", attempts: 0, successes: 0, httpCode: null, error: "disabled", evidence: [] }),
        us_proxy: probe({ httpCode: 200, latencyMs: 80 }),
      },
    }],
    summary: {
      direct_ru: { reachable: 1, stable: 1, flaky: 0, down: 0, skipped: 0, total: 1, attempts: 2, successes: 2 },
      lan_sni: { reachable: 1, stable: 0, flaky: 1, down: 0, skipped: 0, total: 1, attempts: 2, successes: 1 },
      vpn2_sni: { reachable: 0, stable: 0, flaky: 0, down: 1, skipped: 0, total: 1, attempts: 2, successes: 0 },
      vusa_sni: { reachable: 0, stable: 0, flaky: 0, down: 0, skipped: 1, total: 1, attempts: 0, successes: 0 },
      us_proxy: { reachable: 1, stable: 1, flaky: 0, down: 0, skipped: 0, total: 1, attempts: 2, successes: 2 },
    },
  };

  const html = smartDnsPage({ policy: DEFAULT_SMART_DNS_POLICY, restrictedServices: { catalog, status } });

  assert.match(html, /Только локальная сеть/);
  assert.match(html, /HTTP 403/);
  assert.match(html, /стабильно/);
  assert.match(html, /нестабильно/);
  assert.match(html, /недоступно/);
  assert.match(html, /пропущено/);
  assert.match(html, /LAN US proxy/);
  assert.match(html, /устарело/);
  assert.match(html, /42 правил/);
  assert.doesNotMatch(html, /<script>alert\(1\)<\/script>/);
  assert.doesNotMatch(html, /<img src=x onerror=alert\(1\)>/);
});

test("restricted-services UI keeps the reviewed catalog visible without measurements", () => {
  const html = smartDnsPage({ policy: DEFAULT_SMART_DNS_POLICY, restrictedServices: { catalog, status: null } });

  assert.match(html, /Telegram/);
  assert.match(html, /нет измерения/);
  assert.match(html, /Waiting for the first scheduled probe\./);
});

test("restricted-services catalog is folded and a route check returns to its result", () => {
  const html = smartDnsPage({
    policy: DEFAULT_SMART_DNS_POLICY,
    check: {
      input: "chatgpt.com",
      host: "chatgpt.com",
      route: "proxy",
      localRoute: "proxy",
      publicRoute: "proxy",
      publicEdgeProfile: "public",
      reason: "proxySuffixes match",
      matched: "chatgpt.com",
    },
    restrictedServices: { catalog, status: null },
  });

  assert.match(html, /<details class="card" id="restricted-services">/);
  assert.match(html, /<summary class="card-header">\s*<h3>Активный список ограниченных сервисов<\/h3>/);
  assert.match(html, /<div class="card" id="smart-dns-check">/);
  assert.match(html, /<form method="get" action="\/admin\/smart-dns#smart-dns-check"/);
  assert.ok(html.indexOf('id="smart-dns-check"') < html.indexOf("Проверка маршрута"));
});

test("route check gives a plain-language verdict and quick examples", () => {
  const localHtml = smartDnsPage({
    policy: DEFAULT_SMART_DNS_POLICY,
    check: {
      input: "instagram.com",
      host: "instagram.com",
      route: "local-proxy",
      localRoute: "proxy",
      publicRoute: "direct",
      publicEdgeProfile: null,
      reason: "localProxySuffixes match",
      matched: "instagram.com",
    },
  });
  const publicHtml = smartDnsPage({
    policy: DEFAULT_SMART_DNS_POLICY,
    check: {
      input: "chatgpt.com",
      host: "chatgpt.com",
      route: "proxy",
      localRoute: "proxy",
      publicRoute: "proxy",
      publicEdgeProfile: "public",
      reason: "proxySuffixes match",
      matched: "chatgpt.com",
    },
  });

  assert.match(localHtml, /Да — только в локальной сети/);
  assert.match(localHtml, /Публичный SmartDNS оставляет домен direct/);
  assert.match(publicHtml, /Да — проксируется через Smart Edge/);
  assert.match(publicHtml, /antigravity\.google/);
  assert.match(publicHtml, /aria-live="polite"/);
});

import assert from "node:assert/strict";
import { mkdtemp, readFile, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";

import {
  aggregateProbeAttempts,
  buildLaneSummary,
  curlArguments,
  curlAttemptEvidence,
  skippedProbe,
  writeStatusAtomically,
  type ProbeStatusDocument,
} from "../src/cli/probe-restricted-services.js";

function failedAttempt(attempt: number, error = "curl timeout"): ReturnType<typeof curlAttemptEvidence> {
  return curlAttemptEvidence(attempt, "2026-07-17T00:00:00.000Z", 8_000, 28, "000\t8.000\t", error);
}

test("any HTTP response, including 403, proves transport reachability", () => {
  const evidence = curlAttemptEvidence(1, "2026-07-17T00:00:00.000Z", 120, 0, "403\t0.120\t192.0.2.10", "");

  assert.equal(evidence.reachable, true);
  assert.equal(evidence.httpCode, 403);
  assert.equal(evidence.error, null);
});

test("SNI and HTTP proxy lanes use distinct curl transport controls", () => {
  const sniArgs = curlArguments("https://telegram.org/", {
    id: "lan_sni",
    label: "LAN SNI",
    kind: "sni",
    resolveIp: "192.168.2.75",
    proxyUrl: null,
  });
  const proxyArgs = curlArguments("https://telegram.org/", {
    id: "us_proxy",
    label: "LAN US proxy",
    kind: "http-proxy",
    resolveIp: null,
    proxyUrl: "http://192.168.2.75:3127",
  });

  assert.deepEqual(sniArgs.slice(sniArgs.indexOf("--resolve"), sniArgs.indexOf("--resolve") + 2), ["--resolve", "telegram.org:443:192.168.2.75"]);
  assert.equal(sniArgs.includes("--proxy"), false);
  assert.deepEqual(proxyArgs.slice(proxyArgs.indexOf("--proxy"), proxyArgs.indexOf("--proxy") + 2), ["--proxy", "http://192.168.2.75:3127"]);
  assert.equal(proxyArgs.includes("--resolve"), false);
});

test("attempt aggregation distinguishes stable, flaky, down, and skipped", () => {
  const ok1 = curlAttemptEvidence(1, "2026-07-17T00:00:00.000Z", 120, 0, "200\t0.120\t192.0.2.10", "");
  const ok2 = curlAttemptEvidence(2, "2026-07-17T00:00:01.000Z", 150, 0, "403\t0.150\t192.0.2.10", "");
  const failure = failedAttempt(1);

  assert.equal(aggregateProbeAttempts([ok1, ok2]).stability, "stable");
  assert.deepEqual(
    { stability: aggregateProbeAttempts([failure, ok2]).stability, successes: aggregateProbeAttempts([failure, ok2]).successes },
    { stability: "flaky", successes: 1 },
  );
  assert.equal(aggregateProbeAttempts([failure]).stability, "flaky");
  assert.equal(aggregateProbeAttempts([failure, failedAttempt(2)]).stability, "down");
  assert.equal(skippedProbe("probing disabled").stability, "skipped");
});

test("lane summary preserves retry and stability evidence", () => {
  const stable = aggregateProbeAttempts([
    curlAttemptEvidence(1, "2026-07-17T00:00:00.000Z", 100, 0, "200\t0.100\t192.0.2.1", ""),
    curlAttemptEvidence(2, "2026-07-17T00:00:01.000Z", 110, 0, "204\t0.110\t192.0.2.1", ""),
  ]);
  const flaky = aggregateProbeAttempts([
    failedAttempt(1),
    curlAttemptEvidence(2, "2026-07-17T00:00:01.000Z", 125, 0, "403\t0.125\t192.0.2.2", ""),
  ]);
  const summary = buildLaneSummary([stable, flaky, skippedProbe("disabled")]);

  assert.deepEqual(summary, {
    reachable: 2,
    stable: 1,
    flaky: 1,
    down: 0,
    skipped: 1,
    total: 3,
    attempts: 4,
    successes: 3,
  });
});

test("status writer atomically persists the versioned output contract", async () => {
  const directory = await mkdtemp(path.join(tmpdir(), "restricted-services-probe-"));
  const output = path.join(directory, "nested", "status.json");
  const status: ProbeStatusDocument = {
    schemaVersion: 2,
    generatedAt: "2026-07-17T00:00:00.000Z",
    durationMs: 123,
    catalogUpdatedAt: "2026-07-16",
    observationalOnly: true,
    run: { probes: true, externalFeeds: false, attempts: 2, laneConcurrency: 1 },
    sourceSummary: { configured: 0, fetched: 0, failed: 0, skipped: 0, rules: 0 },
    feeds: [],
    laneDefinitions: [{ id: "direct_ru", label: "RU direct", kind: "direct" }],
    rows: [],
    summary: {},
  };

  try {
    await writeStatusAtomically(status, output);
    assert.deepEqual(JSON.parse(await readFile(output, "utf8")), status);
    assert.deepEqual(await readdir(path.dirname(output)), ["status.json"]);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

import { Buffer } from "node:buffer";
import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdir, open, rename, unlink } from "node:fs/promises";
import path from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { pathToFileURL } from "node:url";

import {
  classifyCurlProbe,
  loadRestrictedServicesCatalog,
  matchesRunetFreedomRules,
  parseRunetFreedomRules,
  restrictedServicesStatusPath,
  type RestrictedServiceDefinition,
  type RestrictedFeedFetchState,
  type RestrictedProbeLaneKind,
  type RestrictedProbeStability,
  type RestrictedServiceProbeEvidence,
  type RestrictedServiceStatusProbeResult,
  type RestrictedServicesCatalog,
  type RestrictedServicesFeed,
  type RestrictedServicesStatus,
} from "../restricted-services.js";

const CURL_CONNECT_TIMEOUT_SECONDS = 5;
const CURL_MAX_TIME_SECONDS = 8;
const CURL_PROCESS_TIMEOUT_MS = 12_000;
const CURL_OUTPUT_LIMIT_BYTES = 16 * 1024;
const FEED_FETCH_TIMEOUT_MS = 20_000;
const FEED_MAX_BYTES = 16 * 1024 * 1024;
const FEED_CONCURRENCY = 2;
const RETRY_DELAY_MS = 750;

export type ProbeLaneKind = RestrictedProbeLaneKind;
export type ProbeStability = RestrictedProbeStability;
type FeedFetchState = RestrictedFeedFetchState;

export interface ProbeLane {
  id: string;
  label: string;
  kind: ProbeLaneKind;
  resolveIp: string | null;
  proxyUrl: string | null;
}

export type ProbeAttemptEvidence = RestrictedServiceProbeEvidence;
export type ProbeLaneResult = RestrictedServiceStatusProbeResult;
export type ProbeLaneSummary = RestrictedServicesStatus["summary"][string];

type ProbeFeedStatus = RestrictedServicesStatus["feeds"][number];

interface FeedFetch extends ProbeFeedStatus {
  feed: RestrictedServicesFeed;
  rules: string[];
}

type ProbeStatusRow = RestrictedServicesStatus["rows"][number];
export type ProbeStatusDocument = RestrictedServicesStatus;

interface CliOptions {
  output: string;
  laneConcurrency: number;
  attempts: number;
  external: boolean;
  probes: boolean;
  help: boolean;
}

function boundedInteger(value: string, flag: string, minimum: number, maximum: number): number {
  const parsed = Number.parseInt(value, 10);
  if (!Number.isInteger(parsed) || parsed < minimum || parsed > maximum) throw new Error(`${flag} must be between ${minimum} and ${maximum}`);
  return parsed;
}

function parseOptions(argv: string[]): CliOptions {
  const options: CliOptions = {
    output: restrictedServicesStatusPath(),
    laneConcurrency: 2,
    attempts: 3,
    external: true,
    probes: true,
    help: false,
  };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--help" || arg === "-h") options.help = true;
    else if (arg === "--no-external") options.external = false;
    else if (arg === "--no-probe") options.probes = false;
    else if (arg === "--output") options.output = argv[++index] ?? "";
    else if (arg.startsWith("--output=")) options.output = arg.slice("--output=".length);
    else if (arg === "--lane-concurrency") options.laneConcurrency = boundedInteger(argv[++index] ?? "", arg, 1, 2);
    else if (arg.startsWith("--lane-concurrency=")) options.laneConcurrency = boundedInteger(arg.slice("--lane-concurrency=".length), "--lane-concurrency", 1, 2);
    else if (arg === "--attempts") options.attempts = boundedInteger(argv[++index] ?? "", arg, 2, 5);
    else if (arg.startsWith("--attempts=")) options.attempts = boundedInteger(arg.slice("--attempts=".length), "--attempts", 2, 5);
    else throw new Error(`unknown argument: ${arg}`);
  }
  if (!options.output) throw new Error("--output requires a path");
  return options;
}

function printUsage(): void {
  console.log(`Usage: probe-restricted-services [options]

Options:
  --output PATH              Atomic JSON output path
  --attempts N               Attempts per service and lane (2-5, default 3)
  --lane-concurrency N       Concurrent lanes (1-2, default 2); each lane is sequential
  --no-external              Record external feeds as skipped
  --no-probe                 Record all live probes as skipped
  -h, --help                 Show this help

Exit 0 means a complete status document was written. Observed down/flaky lanes
and unavailable external feeds remain evidence in JSON and do not change the exit code.`);
}

function sanitizeDiagnostic(value: string): string {
  return value
    .replace(/([a-z][a-z0-9+.-]*:\/\/)[^\s/@]+(?::[^\s/@]*)?@/gi, "$1[redacted]@")
    .replace(/\b(token|password|passwd|secret|api[_-]?key)=([^\s&]+)/gi, "$1=[redacted]")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 500);
}

function publicUrl(value: string): string {
  try {
    const parsed = new URL(value);
    parsed.username = "";
    parsed.password = "";
    parsed.search = "";
    parsed.hash = "";
    return parsed.toString();
  } catch {
    return "[invalid URL]";
  }
}

async function readResponseTextWithLimit(response: Response, maximumBytes: number): Promise<string> {
  const contentLength = Number.parseInt(response.headers.get("content-length") ?? "", 10);
  if (Number.isFinite(contentLength) && contentLength > maximumBytes) throw new Error(`response exceeds ${maximumBytes} byte limit`);
  if (!response.body) throw new Error("response body is missing");

  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let bytesRead = 0;
  let text = "";
  try {
    while (true) {
      const chunk = await reader.read();
      if (chunk.done) break;
      bytesRead += chunk.value.byteLength;
      if (bytesRead > maximumBytes) {
        await reader.cancel();
        throw new Error(`response exceeds ${maximumBytes} byte limit`);
      }
      text += decoder.decode(chunk.value, { stream: true });
    }
    return text + decoder.decode();
  } finally {
    reader.releaseLock();
  }
}

async function fetchFeed(feed: RestrictedServicesFeed, enabled: boolean): Promise<FeedFetch> {
  const startedAt = Date.now();
  if (!enabled) {
    return {
      feed,
      id: feed.id,
      url: publicUrl(feed.url),
      state: "skipped",
      fetchedAt: null,
      durationMs: 0,
      rules: [],
      ruleCount: 0,
      error: "external feed fetch disabled",
    };
  }
  try {
    const response = await fetch(feed.url, {
      headers: { "user-agent": "vpn-panel-restricted-services/2.0" },
      redirect: "follow",
      signal: AbortSignal.timeout(FEED_FETCH_TIMEOUT_MS),
    });
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    const rules = parseRunetFreedomRules(await readResponseTextWithLimit(response, FEED_MAX_BYTES));
    return {
      feed,
      id: feed.id,
      url: publicUrl(feed.url),
      state: "ok",
      fetchedAt: new Date().toISOString(),
      durationMs: Date.now() - startedAt,
      rules,
      ruleCount: rules.length,
      error: null,
    };
  } catch (error: unknown) {
    return {
      feed,
      id: feed.id,
      url: publicUrl(feed.url),
      state: "error",
      fetchedAt: null,
      durationMs: Date.now() - startedAt,
      rules: [],
      ruleCount: 0,
      error: sanitizeDiagnostic(error instanceof Error ? error.message : String(error)),
    };
  }
}

export function curlAttemptEvidence(
  attempt: number,
  startedAt: string,
  durationMs: number,
  exitCode: number | null,
  stdout: string,
  stderr: string,
): ProbeAttemptEvidence {
  const result = classifyCurlProbe(exitCode, stdout, sanitizeDiagnostic(stderr));
  return {
    attempt,
    startedAt,
    durationMs,
    curlExitCode: exitCode,
    reachable: result.reachable,
    httpCode: result.httpCode,
    latencyMs: result.latencyMs,
    remoteIp: result.remoteIp,
    error: result.error,
  };
}

export function curlArguments(url: string, lane: ProbeLane): string[] {
  const target = new URL(url);
  const targetPort = target.port || "443";
  const args = [
    "--proto",
    "=https",
    "--http1.1",
    "--silent",
    "--show-error",
    "--output",
    "/dev/null",
    "--write-out",
    "%{http_code}\t%{time_total}\t%{remote_ip}",
    "--connect-timeout",
    String(CURL_CONNECT_TIMEOUT_SECONDS),
    "--max-time",
    String(CURL_MAX_TIME_SECONDS),
    "--user-agent",
    "vpn-panel-restricted-services/2.0",
  ];

  if (lane.kind === "http-proxy") {
    if (!lane.proxyUrl) throw new Error(`proxy URL is missing for lane ${lane.id}`);
    // An empty no-proxy list prevents ambient NO_PROXY from silently bypassing the explicit lane.
    args.push("--noproxy", "", "--proxy", lane.proxyUrl);
  } else {
    // Direct and SNI probes must not inherit ambient HTTP(S)_PROXY settings from systemd.
    args.push("--noproxy", "*");
    if (lane.kind === "sni") {
      if (!lane.resolveIp) throw new Error(`resolve IP is missing for lane ${lane.id}`);
      args.push("--resolve", `${target.hostname}:${targetPort}:${lane.resolveIp}`);
    }
  }
  args.push(url);
  return args;
}

function runCurl(url: string, lane: ProbeLane, attempt: number): Promise<ProbeAttemptEvidence> {
  const startedAtMs = Date.now();
  const startedAt = new Date(startedAtMs).toISOString();
  const args = curlArguments(url, lane);

  return new Promise((resolve) => {
    const child = spawn("/usr/bin/curl", args, { stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    let outputBytes = 0;
    let forcedError: string | null = null;
    let settled = false;
    let processTimer: NodeJS.Timeout | null = null;

    const finish = (exitCode: number | null, errorOverride: string | null): void => {
      if (settled) return;
      settled = true;
      if (processTimer) clearTimeout(processTimer);
      const durationMs = Date.now() - startedAtMs;
      if (errorOverride) resolve(curlAttemptEvidence(attempt, startedAt, durationMs, exitCode, "", errorOverride));
      else resolve(curlAttemptEvidence(attempt, startedAt, durationMs, exitCode, stdout, stderr));
    };

    const appendOutput = (current: string, chunk: string): string => {
      outputBytes += Buffer.byteLength(chunk);
      if (outputBytes > CURL_OUTPUT_LIMIT_BYTES) {
        if (!forcedError) {
          forcedError = `curl output exceeded ${CURL_OUTPUT_LIMIT_BYTES} byte limit`;
          child.kill("SIGKILL");
        }
        return current;
      }
      return current + chunk;
    };

    child.stdout.setEncoding("utf8").on("data", (chunk: string) => { stdout = appendOutput(stdout, chunk); });
    child.stderr.setEncoding("utf8").on("data", (chunk: string) => { stderr = appendOutput(stderr, chunk); });
    child.on("error", (error: Error) => finish(null, `curl spawn failed: ${sanitizeDiagnostic(error.message)}`));
    child.on("close", (code: number | null) => finish(code, forcedError));

    processTimer = setTimeout(() => {
      forcedError = `curl process exceeded ${CURL_PROCESS_TIMEOUT_MS} ms limit`;
      child.kill("SIGKILL");
    }, CURL_PROCESS_TIMEOUT_MS);
  });
}

export function aggregateProbeAttempts(attempts: ProbeAttemptEvidence[]): ProbeLaneResult {
  if (!attempts.length) return skippedProbe("no attempts configured");
  const successful = attempts.filter((attempt) => attempt.reachable);
  const representative = [...successful].sort((left, right) => (left.latencyMs ?? Number.MAX_SAFE_INTEGER) - (right.latencyMs ?? Number.MAX_SAFE_INTEGER))[0]
    ?? attempts.at(-1)!;
  const failures = attempts.length - successful.length;
  // A single timeout is insufficient evidence for down, even when this helper is used outside the CLI's minimum-two-attempt contract.
  const stability: ProbeStability = failures === 0 ? "stable" : successful.length > 0 || attempts.length === 1 ? "flaky" : "down";
  const lastFailure = [...attempts].reverse().find((attempt) => !attempt.reachable);
  return {
    reachable: successful.length > 0,
    stability,
    attempts: attempts.length,
    successes: successful.length,
    httpCode: representative.httpCode,
    latencyMs: representative.latencyMs,
    remoteIp: representative.remoteIp,
    error: failures === 0 ? null : `${failures}/${attempts.length} attempts failed${lastFailure?.error ? `: ${lastFailure.error}` : ""}`,
    evidence: attempts,
  };
}

export function skippedProbe(error: string): ProbeLaneResult {
  return {
    reachable: false,
    stability: "skipped",
    attempts: 0,
    successes: 0,
    httpCode: null,
    latencyMs: null,
    remoteIp: null,
    error,
    evidence: [],
  };
}

async function probeWithRetries(service: RestrictedServiceDefinition, lane: ProbeLane, attempts: number): Promise<ProbeLaneResult> {
  const evidence: ProbeAttemptEvidence[] = [];
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    evidence.push(await runCurl(service.probeUrl, lane, attempt));
    if (attempt < attempts) await delay(RETRY_DELAY_MS);
  }
  return aggregateProbeAttempts(evidence);
}

async function mapWithConcurrency<T, R>(items: T[], concurrency: number, worker: (item: T) => Promise<R>): Promise<R[]> {
  const results = new Array<R>(items.length);
  let cursor = 0;
  async function consume(): Promise<void> {
    while (cursor < items.length) {
      const index = cursor;
      cursor += 1;
      results[index] = await worker(items[index]);
    }
  }
  await Promise.all(Array.from({ length: Math.min(concurrency, items.length) }, () => consume()));
  return results;
}

function buildProbeLanes(catalog: RestrictedServicesCatalog): ProbeLane[] {
  const lanes: ProbeLane[] = [
    { id: "direct_ru", label: "RU direct", kind: "direct", resolveIp: null, proxyUrl: null },
    { id: "lan_sni", label: "LAN SNI gateway", kind: "sni", resolveIp: catalog.lanEdgeIp, proxyUrl: null },
    ...catalog.publicEdges.map((edge) => ({ id: edge.id, label: edge.label, kind: "sni" as const, resolveIp: edge.ip, proxyUrl: null })),
    ...catalog.lanProxies.map((proxy) => ({ id: proxy.id, label: proxy.label, kind: "http-proxy" as const, resolveIp: null, proxyUrl: proxy.url })),
  ];
  const laneIds = new Set<string>();
  for (const lane of lanes) {
    if (laneIds.has(lane.id)) throw new Error(`duplicate probe lane id: ${lane.id}`);
    laneIds.add(lane.id);
  }
  return lanes;
}

export function buildLaneSummary(results: ProbeLaneResult[]): ProbeLaneSummary {
  return {
    reachable: results.filter((result) => result.reachable).length,
    stable: results.filter((result) => result.stability === "stable").length,
    flaky: results.filter((result) => result.stability === "flaky").length,
    down: results.filter((result) => result.stability === "down").length,
    skipped: results.filter((result) => result.stability === "skipped").length,
    total: results.length,
    attempts: results.reduce((total, result) => total + result.attempts, 0),
    successes: results.reduce((total, result) => total + result.successes, 0),
  };
}

export async function writeStatusAtomically(status: ProbeStatusDocument, file: string): Promise<void> {
  const directory = path.dirname(file);
  await mkdir(directory, { recursive: true, mode: 0o750 });
  const temporary = path.join(directory, `.${path.basename(file)}.tmp-${process.pid}-${randomUUID()}`);
  let renamed = false;
  try {
    const handle = await open(temporary, "wx", 0o640);
    try {
      await handle.writeFile(`${JSON.stringify(status, null, 2)}\n`, "utf8");
      await handle.sync();
    } finally {
      await handle.close();
    }
    await rename(temporary, file);
    renamed = true;
    const directoryHandle = await open(directory, "r");
    try {
      await directoryHandle.sync();
    } finally {
      await directoryHandle.close();
    }
  } catch (error: unknown) {
    if (!renamed) {
      try {
        await unlink(temporary);
      } catch (cleanupError: unknown) {
        if ((cleanupError as NodeJS.ErrnoException).code !== "ENOENT") throw cleanupError;
      }
    }
    throw error;
  }
}

async function runProbe(options: CliOptions): Promise<ProbeStatusDocument> {
  const startedAt = Date.now();
  const catalog = await loadRestrictedServicesCatalog();
  const feeds = catalog.sources.flatMap((source) => source.feeds);
  const fetchedFeeds = await mapWithConcurrency(feeds, FEED_CONCURRENCY, (feed) => fetchFeed(feed, options.external));
  const lanes = buildProbeLanes(catalog);

  // Each lane is strictly sequential; only a small number of independent lanes run together.
  const laneResults = await mapWithConcurrency(lanes, options.laneConcurrency, async (lane) => {
    const results: ProbeLaneResult[] = [];
    for (const service of catalog.services) {
      results.push(options.probes ? await probeWithRetries(service, lane, options.attempts) : skippedProbe("live probing disabled"));
    }
    return results;
  });

  const rows: ProbeStatusRow[] = catalog.services.map((service, serviceIndex) => {
    const externalFeeds = fetchedFeeds
      .filter((feed) => feed.state === "ok" && matchesRunetFreedomRules(service.domains, feed.rules))
      .map((feed) => feed.id);
    const laneRecord: Record<string, ProbeLaneResult> = {};
    lanes.forEach((lane, laneIndex) => { laneRecord[lane.id] = laneResults[laneIndex][serviceIndex]; });
    return {
      id: service.id,
      label: service.label,
      route: service.route,
      restriction: service.restriction,
      externalFeeds,
      lanes: laneRecord,
    };
  });

  const summary: Record<string, ProbeLaneSummary> = {};
  lanes.forEach((lane, laneIndex) => { summary[lane.id] = buildLaneSummary(laneResults[laneIndex]); });
  return {
    schemaVersion: 2,
    generatedAt: new Date().toISOString(),
    durationMs: Date.now() - startedAt,
    catalogUpdatedAt: catalog.updatedAt,
    observationalOnly: true,
    run: {
      probes: options.probes,
      externalFeeds: options.external,
      attempts: options.attempts,
      laneConcurrency: options.laneConcurrency,
    },
    sourceSummary: {
      configured: fetchedFeeds.length,
      fetched: fetchedFeeds.filter((feed) => feed.state === "ok").length,
      failed: fetchedFeeds.filter((feed) => feed.state === "error").length,
      skipped: fetchedFeeds.filter((feed) => feed.state === "skipped").length,
      rules: fetchedFeeds.reduce((total, feed) => total + feed.ruleCount, 0),
    },
    feeds: fetchedFeeds.map(({ feed: _feed, rules: _rules, ...status }) => status),
    laneDefinitions: lanes.map(({ id, label, kind }) => ({ id, label, kind })),
    rows,
    summary,
  };
}

export async function main(argv = process.argv.slice(2)): Promise<void> {
  const options = parseOptions(argv);
  if (options.help) {
    printUsage();
    return;
  }
  const status = await runProbe(options);
  await writeStatusAtomically(status, options.output);

  console.log(`Restricted services status: ${status.generatedAt} (${status.durationMs} ms)`);
  console.log(`External feeds: fetched=${status.sourceSummary.fetched}, failed=${status.sourceSummary.failed}, skipped=${status.sourceSummary.skipped}`);
  for (const lane of status.laneDefinitions) {
    const laneSummary = status.summary[lane.id];
    console.log(`${lane.label}: stable=${laneSummary.stable}, flaky=${laneSummary.flaky}, down=${laneSummary.down}, skipped=${laneSummary.skipped}`);
  }
  console.log(`Wrote ${options.output}`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((error: unknown) => {
    console.error(sanitizeDiagnostic(error instanceof Error ? error.stack ?? error.message : String(error)));
    process.exitCode = 1;
  });
}

import crypto from "node:crypto";
import { MACOS_CONFIG_TOKEN } from "./macos-token.js";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { readFile } from "node:fs/promises";
import fastify from "fastify";
import type { FastifyReply, FastifyRequest } from "fastify";
import cookie from "@fastify/cookie";
import formbody from "@fastify/formbody";
import QRCode from "qrcode";
import { z } from "zod";
import { setVpnTestTargetEnabled } from "./vpn-test-targets.js";
import { loadAppConfig } from "./config.js";
import { createPool } from "./db.js";
import { loadSecureConfig, type SecureConfig } from "./secure-config.js";
import { bootstrapAdmin, runMigrations, syncCatalogFromSecureConfig } from "./migrations.js";
import { accountFromRequest, loginAccount, logout, requireRole, setSessionCookie } from "./auth.js";
import {
  ensureSmartDnsClient,
  getSmartDnsClient,
  setSmartDnsClientEnabled,
  setUserEndpointScope,
  setUserRoutingEnabled,
  getUserRoutingEnabled,
  grantAllEndpointsToAllUsers,
  grantWorkingEndpointsToAllUsers,
  createUser,
  deleteUser,
  getUser,
  listEnabledSmartDnsRuntimeClients,
  listEndpoints,
  listUsers,
  rotateToken,
  updateUser,
  getEndpointHealth,
  upsertEndpointHealth,
  getHappInstall,
  getAllHappInstalls,
  upsertHappInstall,
  updateHappSettings,
  updateHappInstallStatus,
  getHwidsForAccount,
  deleteHwid,
  syncHwidsFromHapp,
  captureHwidFromSubscription,
  countAllDevices,
} from "./repository.js";
import {
  announceHeader,
  bundleByAccount,
  bundleByToken,
  diagnosticEndpointsForClient,
  happDeeplink,
  happRoutingLink,
  happJsonSubscription,
  linkSlots,
  personalizedAnnounce,
  plainSubscription,
  macosSingBoxSubscription,
  singBoxSubscription,
  subscriptionUrl,
  v2raySubscription,
  xrayClientSubscription,
} from "./subscriptions.js";
import { registerMacosRoutes } from "./macos-api.js";
import { macosInstallerScript } from "./macos-installer.js";
import { registerWindowsRoutes } from "./windows-api.js";
import {
  happAddInstall,
  happListHwids,
  happDeleteHwid as happApiDeleteHwid,
  happSendCommand,
  happInstallDeeplink,
  happUpdateInstall,
} from "./happ-api.js";
import { accountPage, adminPage, installPage, landingPage, loginPage, smartDnsPage, testsPage, userDetailPage, vpsPage, xrayPolicyPage } from "./pages.js";
import { deServerConfig, serverConfig, clientsForEndpoint } from "./xray-configs.js";
import {
  getSystemStats,
  getUserTraffic,
  getInboundTraffic,
  getXrayConfig,
  updateXrayConfig,
  restartXray,
  getXrayLogs,
  getXrayVersion,
  getXrayStatus,
  syncXrayClients,
  resetTrafficStats,
  checkXrayUpdate,
  updateXray,
  getEngineLogs,
  getEngineStatus,
  getEngineVersion,
  checkEngineUpdate,
  updateEngine,
  sshExec,
  type VpsConnectionConfig,
} from "./vps-ssh.js";
import { checkSmartDnsRoute, hostFromInput, loadSmartDnsPolicy, quickSmartDnsRouteRule, saveSmartDnsPolicy } from "./smart-dns-policy.js";
import { inspectGeoCatalog } from "./geo-catalog.js";
import { normalizeRoutingRules } from "./routing-rules.js";
import { loadSmartEdgeConfig, runSmartEdgeAction, serviceTargetCapabilities } from "./smart-edge-config.js";
import { loadRestrictedServicesCatalog, loadRestrictedServicesStatus } from "./restricted-services.js";
import {
  compileLegacyServiceCatalog,
  loadServiceCatalog,
  normalizeServiceWorkIn,
  saveServiceCatalog,
  ServiceCatalogRevisionConflictError,
  validateServiceCatalog,
  validateServiceTargetCapabilities,
  type ServiceCatalog,
  type ServiceTargetCapability,
} from "./service-catalog.js";
import { buildServiceCatalogActivationPlan } from "./service-catalog-activation-plan.js";
import { smartDnsMobileconfig } from "./mobileconfig.js";
import { allowlistPage, publicIpFromRequest, smartDnsBaseUrl, SmartDnsClient, SmartDnsError } from "./smart-dns-allowlist.js";
import { getVpnTestArtifactPath, getVpnTestEndpointDetail, getVpnTestEndpointScores, getVpnTestRunEvents, listVpnTestRuns, parseVpnTestEvent, recordVpnTestEvent, vpnTestRunFiltersSchema } from "./vpn-test-telemetry.js";

function vpsConfig(secure: SecureConfig, vpsId?: string): VpsConnectionConfig | null {
  // If vps_list is configured, use it
  if (secure.vps_list.length > 0) {
    let entry;
    if (vpsId) {
      entry = secure.vps_list.find((v) => v.id === vpsId);
    } else {
      entry = secure.vps_list[0]; // default to first
    }
    if (!entry) return null;
    const cfg: VpsConnectionConfig = {
      host: entry.host,
      port: entry.port,
      username: entry.username,
    };
    if (entry.password) cfg.password = entry.password;
    if (entry.private_key) cfg.privateKey = entry.private_key;
    if (entry.passphrase) cfg.passphrase = entry.passphrase;
    return cfg;
  }
  // Fallback to legacy vps config
  if (!secure.vps.host) return null;
  const cfg: VpsConnectionConfig = {
    host: secure.vps.host,
    port: secure.vps.port,
    username: secure.vps.username,
  };
  if (secure.vps.password) cfg.password = secure.vps.password;
  if (secure.vps.private_key) cfg.privateKey = secure.vps.private_key;
  if (secure.vps.passphrase) cfg.passphrase = secure.vps.passphrase;
  return cfg;
}

function vpsLabel(secure: SecureConfig, vpsId?: string): string {
  if (secure.vps_list.length > 0) {
    if (vpsId) {
      return secure.vps_list.find((v) => v.id === vpsId)?.label || vpsId;
    }
    return secure.vps_list[0].label;
  }
  return secure.vps.label;
}

type ServiceCatalogForm = Record<string, unknown>;

type AdminTestHttpCheck = {
  id: string;
  label: string;
  url: string;
  group: string;
  enabled?: boolean;
};

type AdminTestTarget = {
  id: string;
  label: string;
  runner: "ssh" | "android-adb";
  sshHost: string;
  sshPort: number;
  mode: "docker" | "native" | "android";
  engine: "xray" | "singbox";
  enabled?: boolean;
};

const testCheckSelectionSchema = z.object({
  checks: z.array(z.string().regex(/^[a-z0-9_-]+$/)).max(50).optional(),
  targets: z.array(z.string().regex(/^[a-z0-9_-]+$/)).max(20).optional(),
  endpoints: z.array(z.string().regex(/^[a-z0-9_-]+$/)).min(1).max(100).optional(),
});

function parseTestCheckSelection(body: unknown): { checks?: string[]; targets?: string[]; endpoints?: string[]; error?: string } {
  const parsed = testCheckSelectionSchema.safeParse(body ?? {});
  if (!parsed.success) return { error: "checks, targets and endpoints must be arrays of lowercase IDs" };
  return parsed.data;
}

async function loadAdminTestHttpChecks(): Promise<AdminTestHttpCheck[]> {
  const planPath = path.resolve(process.cwd(), "vpn-testing", "test-plan.json");
  const parsed = JSON.parse(await readFile(planPath, "utf8")) as { httpChecks?: unknown };
  if (!Array.isArray(parsed.httpChecks)) throw new Error(`test plan has no httpChecks: ${planPath}`);
  return parsed.httpChecks.map((value, index) => {
    if (!value || typeof value !== "object") throw new Error(`test plan httpChecks[${index}] is not an object`);
    const check = value as Record<string, unknown>;
    if (typeof check.id !== "string" || typeof check.label !== "string" || typeof check.url !== "string" || typeof check.group !== "string") {
      throw new Error(`test plan httpChecks[${index}] is missing UI fields`);
    }
    return {
      id: check.id,
      label: check.label,
      url: check.url,
      group: check.group,
      ...(typeof check.enabled === "boolean" ? { enabled: check.enabled } : {}),
    };
  });
}

async function loadAdminTestTargets(): Promise<AdminTestTarget[]> {
  const planPath = path.resolve(process.cwd(), "vpn-testing", "test-plan.json");
  const parsed = JSON.parse(await readFile(planPath, "utf8")) as { testTargets?: unknown };
  if (!Array.isArray(parsed.testTargets)) throw new Error("test plan has no testTargets: " + planPath);
  return parsed.testTargets.map((value, index) => {
    if (!value || typeof value !== "object") throw new Error("test plan testTargets[" + index + "] is not an object");
    const target = value as Record<string, unknown>;
    if (typeof target.id !== "string" || typeof target.label !== "string" || typeof target.runner !== "string" || typeof target.sshHost !== "string" || typeof target.sshPort !== "number" || !Number.isInteger(target.sshPort) || target.sshPort < 1 || typeof target.mode !== "string" || typeof target.engine !== "string") {
      throw new Error("test plan testTargets[" + index + "] is missing execution fields");
    }
    if (!["ssh", "android-adb"].includes(target.runner) || !["docker", "native", "android"].includes(target.mode) || !["xray", "singbox"].includes(target.engine)) {
      throw new Error("test plan testTargets[" + index + "] has invalid execution fields");
    }
    return {
      id: target.id,
      label: target.label,
      runner: target.runner as AdminTestTarget["runner"],
      sshHost: target.sshHost,
      sshPort: target.sshPort,
      mode: target.mode as AdminTestTarget["mode"],
      engine: target.engine as AdminTestTarget["engine"],
      ...(typeof target.enabled === "boolean" ? { enabled: target.enabled } : {}),
    };
  });
}

async function validateAdminTestTargets(targets: string[] | undefined): Promise<string | null> {
  if (targets === undefined) return null;
  if (targets.length === 0) return "select at least one test target";
  const configured = await loadAdminTestTargets();
  const allowed = new Set(configured.filter((target) => target.enabled !== false).map((target) => target.id));
  const unknown = targets.filter((target) => !allowed.has(target));
  return unknown.length > 0 ? "unknown test target: " + unknown.join(", ") : null;
}

function formScalar(value: unknown, field: string): string {
  if (typeof value !== "string" || !value.trim()) throw new Error(`${field} must be a non-empty string`);
  return value.trim();
}

function formCheckbox(value: unknown): boolean {
  if (Array.isArray(value)) return value.length > 0;
  if (typeof value === "boolean") return value;
  if (typeof value === "string") return value === "on" || value === "true" || value === "1";
  return value !== undefined && value !== null;
}

function formArray(value: unknown): string[] {
  const values = value === undefined ? [] : Array.isArray(value) ? value : [value];
  return values.map((entry) => formScalar(entry, "allowedVpsIds[]"));
}

/** Convert one service-editor form into a canonical v2 draft catalog. */
export function serviceCatalogFromForm(catalog: ServiceCatalog, body: ServiceCatalogForm): ServiceCatalog {
  const serviceId = formScalar(body.serviceId, "serviceId");
  const existing = catalog.services.find((service) => service.id === serviceId);
  if (!existing) throw new Error(`unknown serviceId: ${serviceId}`);
  const workIn = normalizeServiceWorkIn({ lan: formCheckbox(body.workInLan), external: formCheckbox(body.workInExternal) });
  const routeKind = formScalar(body.routeKind, "routeKind");
  let routeTo: typeof existing.routeTo;
  if (routeKind === "direct") {
    routeTo = { kind: "direct" };
  } else if (routeKind === "vps-pool") {
    routeTo = {
      kind: "vps-pool",
      allowedVpsIds: formArray(body.allowedVpsIds),
      onNoHealthyTarget: existing.routeTo.kind === "vps-pool" ? existing.routeTo.onNoHealthyTarget : "servfail",
    };
  } else {
    throw new Error("routeKind must be direct or vps-pool");
  }
  const updated: ServiceCatalog = {
    ...catalog,
    services: catalog.services.map((service) => service.id === serviceId
      ? { ...service, enabled: formCheckbox(body.enabled), workIn, routeTo }
      : service),
  };
  return validateServiceCatalog(updated);
}

function isEnoent(error: unknown): boolean {
  return Boolean(error && typeof error === "object" && "code" in error && (error as { code?: unknown }).code === "ENOENT");
}

async function loadDraftServiceCatalog(restrictedServicesCatalog: Awaited<ReturnType<typeof loadRestrictedServicesCatalog>>): Promise<ServiceCatalog> {
  return (await loadDraftServiceCatalogWithSource(restrictedServicesCatalog)).catalog;
}

async function loadDraftServiceCatalogWithSource(restrictedServicesCatalog: Awaited<ReturnType<typeof loadRestrictedServicesCatalog>>): Promise<{ catalog: ServiceCatalog; persisted: boolean }> {
  try {
    return { catalog: await loadServiceCatalog(), persisted: true };
  } catch (error: unknown) {
    if (!isEnoent(error)) throw error;
    return {
      catalog: compileLegacyServiceCatalog(restrictedServicesCatalog, {
        defaultPoolIds: ["vpn2"],
        localPoolIds: ["vpn2"],
        vusaPoolIds: ["vusa"],
      }),
      persisted: false,
    };
  }
}

function catalogTargetCapabilities(smartEdge: Awaited<ReturnType<typeof loadSmartEdgeConfig>>): ServiceTargetCapability[] {
  const capabilities = serviceTargetCapabilities(smartEdge) as Array<ServiceTargetCapability>;
  return capabilities.map((target) => ({
    id: target.id,
    publicDnsEdge: target.publicDnsEdge,
    lanEgress: target.lanEgress,
    ...(target.lanBalancerTag ? { lanBalancerTag: target.lanBalancerTag } : {}),
    ...(target.dedicatedPublicDnsProfile ? { dedicatedPublicDnsProfile: target.dedicatedPublicDnsProfile } : {}),
  }));
}

const createUserSchema = z.object({
  login: z.string().min(1),
  displayName: z.string().min(1),
  password: z.string().min(1),
  xrayUuid: z.string().uuid().optional().or(z.literal("")),
  endpointIds: z.union([z.array(z.string()), z.string()]).optional(),
});

const updateUserSchema = z.object({
  login: z.string().min(1).optional(),
  displayName: z.string().min(1).optional(),
  password: z.string().optional(),
  enabled: z.union([z.boolean(), z.literal("true"), z.literal("false")]).optional(),
  endpointIds: z.union([z.array(z.string()), z.string()]).optional(),
});

function asArray(value: string | string[] | undefined): string[] {
  if (!value) return [];
  return Array.isArray(value) ? value : [value];
}

async function main(): Promise<void> {
  const config = loadAppConfig();
  const pool = createPool(config);
  const secure = await loadSecureConfig(config.secureConfigPath);
  const secureConfigPath = config.secureConfigPath;

  // Save secure config back to disk (used by VPS CRUD)
  async function saveSecureConfig(cfg: SecureConfig, path: string): Promise<void> {
    const { writeFile } = await import("node:fs/promises");
    await writeFile(path, JSON.stringify(cfg, null, 2), "utf8");
  }
  // Auto-migrate legacy vps → vps_list
  if (secure.vps_list.length === 0 && secure.vps.host) {
    const legacyId = secure.vps.host.replace(/[^a-zA-Z0-9-]/g, "-").toLowerCase();
    secure.vps_list.push({
      id: legacyId,
      host: secure.vps.host,
      port: secure.vps.port,
      username: secure.vps.username,
      password: secure.vps.password || "",
      private_key: secure.vps.private_key || "",
      passphrase: secure.vps.passphrase || "",
      label: secure.vps.label || "VPS",
    });
    await saveSecureConfig(secure, secureConfigPath);
    console.log(`Migrated legacy vps → vps_list: ${legacyId} (${secure.vps.host})`);
  }

  await runMigrations(pool);
  await bootstrapAdmin(pool, config);
  await syncCatalogFromSecureConfig(pool, secure);

  const app = fastify({ logger: true });
  await app.register(cookie, { secret: config.sessionSecret });
  await app.register(formbody);

  // Helper: check health API key for script-based health posting (timing-safe)
  function checkHealthApiKey(request: { headers: Record<string, string | string[] | undefined> }): boolean {
    if (!config.healthApiKey) return false;
    const rawAuth = request.headers["authorization"];
    const auth = Array.isArray(rawAuth) ? rawAuth[0] : rawAuth;
    if (!auth) return false;
    const match = /^Bearer\s+(.+)$/i.exec(auth);
    if (!match) return false;
    const a = Buffer.from(match[1], "utf8");
    const b = Buffer.from(config.healthApiKey, "utf8");
    if (a.length !== b.length) return false;
    return crypto.timingSafeEqual(a, b);
  }

  app.get("/", async (_request, reply) => reply.type("text/html").send(landingPage(config.publicBaseUrl)));
  app.get("/install", async (_request, reply) => reply.type("text/html").send(installPage(config.publicBaseUrl)));
  registerMacosRoutes(app, { baseUrl: config.publicBaseUrl, pool, secure });
  registerWindowsRoutes(app, { baseUrl: config.publicBaseUrl });

  const macosInstaller = async (request: FastifyRequest, reply: FastifyReply) => {
    const query = z.object({ token: z.string().min(1) }).safeParse(request.query);
    if (!query.success) return reply.code(400).send({ error: "token is required" });
    const bundle = await bundleByToken(pool, query.data.token);
    if (!bundle) return reply.code(404).send({ error: "installer not found" });
    return reply
      .type("text/plain; charset=utf-8")
      .header("cache-control", "no-store")
      .send(macosInstallerScript(config.publicBaseUrl, bundle.token));
  };
  app.get("/install/macos.sh", macosInstaller);
  app.get("/install/masha-macos.sh", macosInstaller);

  app.get("/admin", async (request, reply) => {
    const account = await accountFromRequest(pool, request);
    if (!account || account.role !== "admin") {
      return reply.type("text/html").send(loginPage("admin"));
    }
    return reply
      .type("text/html")
      .send(adminPage({ users: await listUsers(pool), endpoints: await listEndpoints(pool), health: await getEndpointHealth(pool), baseUrl: config.publicBaseUrl, totalDevices: await countAllDevices(pool) }));
  });

  app.get("/admin/smart-dns", async (request, reply) => {
    const account = await requireRole(pool, request, reply, "admin");
    if (!account) return;
    const query = z.object({ check: z.string().optional(), edgeMessage: z.string().optional(), edgeError: z.string().optional() }).parse(request.query);
    const policy = await loadSmartDnsPolicy();
    const geoCatalog = await inspectGeoCatalog(policy.rules);
    const smartEdge = await loadSmartEdgeConfig(secure);
    const restrictedServicesCatalog = await loadRestrictedServicesCatalog();
    const serviceCatalog = await loadDraftServiceCatalog(restrictedServicesCatalog);
    const serviceTargets = catalogTargetCapabilities(smartEdge);
    let restrictedServicesStatus = null;
    let restrictedServicesStatusError: string | undefined;
    try {
      restrictedServicesStatus = await loadRestrictedServicesStatus();
    } catch (error: unknown) {
      app.log.warn({ error }, "Could not load restricted-services probe status");
      restrictedServicesStatusError = "Не удалось прочитать runtime-status; каталог показан без измерений.";
    }
    const restrictedServices = { catalog: restrictedServicesCatalog, status: restrictedServicesStatus };
    let check;
    let error;
    if (query.check && query.check.trim()) {
      try {
        check = checkSmartDnsRoute(query.check, policy);
      } catch (err) {
        error = String(err instanceof Error ? err.message : err);
      }
    }
    return reply.type("text/html").send(smartDnsPage({ policy, check, geoCatalog, smartEdge, serviceCatalog: { catalog: serviceCatalog, targets: serviceTargets }, restrictedServices, restrictedServicesStatusError, error, edgeMessage: query.edgeMessage, edgeError: query.edgeError }));
  });

  app.get("/admin/xray-policy", async (request, reply) => {
    const account = await requireRole(pool, request, reply, "admin");
    if (!account) return;
    return reply.redirect("/admin/smart-dns#smart-dns-check");
  });

  // Endpoint state is now part of the unified test center. Keep the old URL
  // as an explicit alias so bookmarks and external admin links do not 404.
  app.get("/admin/endpoints", async (request, reply) => {
    const account = await requireRole(pool, request, reply, "admin");
    if (!account) return;
    return reply.redirect("/admin/tests#current-endpoints");
  });

  app.get("/admin/tests", async (request, reply) => {
    const account = await requireRole(pool, request, reply, "admin");
    if (!account) return;
    return reply.type("text/html").send(
      testsPage({ 
        endpoints: await listEndpoints(pool), 
        health: await getEndpointHealth(pool),
        scores: await getVpnTestEndpointScores(pool),
        httpChecks: await loadAdminTestHttpChecks(),
        testTargets: await loadAdminTestTargets(),
      })
    );
  });

  app.get("/admin/users/:id", async (request, reply) => {
    const account = await requireRole(pool, request, reply, "admin");
    if (!account) return;
    const params = z.object({ id: z.string() }).parse(request.params);
    const user = await getUser(pool, params.id);
    if (!user) return reply.code(404).send("not found");
    const bundle = await bundleByAccount(pool, params.id);
    const happInstall = await getHappInstall(pool, params.id);
    const hwids = happInstall ? await getHwidsForAccount(pool, params.id) : [];
    const smartDnsClient = await getSmartDnsClient(pool, params.id);
    return reply.type("text/html").send(
      userDetailPage({
        user,
        endpoints: await listEndpoints(pool),
        health: await getEndpointHealth(pool),
        slots: bundle ? linkSlots(bundle, secure) : [],
        happInstall,
        hwids,
        smartDnsClient,
        smartDnsMobileconfigUrl: smartDnsClient?.enabled && user.token ? `${config.publicBaseUrl}/sub/${user.token}/smart-dns.mobileconfig` : undefined,
        baseUrl: config.publicBaseUrl,
        secure,
      }),
    );
  });

  app.get("/login", async (request, reply) => {
    const account = await accountFromRequest(pool, request);
    if (account?.role === "user") return reply.redirect("/account");
    return reply.type("text/html").send(loginPage("user"));
  });

  app.get("/account", async (request, reply) => {
    const account = await requireRole(pool, request, reply, "user");
    if (!account) return;
    const bundle = await bundleByAccount(pool, account.id);
    if (!bundle) return reply.code(404).send("vpn client not found");
    const smartDnsClient = await getSmartDnsClient(pool, account.id);
    return reply.type("text/html").send(
      accountPage({
        displayName: account.display_name,
        subUrl: subscriptionUrl(config.publicBaseUrl, bundle.token),
        slots: linkSlots(bundle, secure),
        token: bundle.token,
        smartDnsClient,
        smartDnsMobileconfigUrl: smartDnsClient?.enabled ? `${config.publicBaseUrl}/sub/${bundle.token}/smart-dns.mobileconfig` : undefined,
      }),
    );
  });

  app.post("/api/admin/login", async (request, reply) => {
    const body = z.object({ login: z.string(), password: z.string() }).parse(request.body);
    const session = await loginAccount(pool, body.login, body.password, "admin");
    if (!session) return reply.code(401).type("text/html").send(loginPage("admin", "bad credentials"));
    setSessionCookie(reply, session.sessionId);
    return reply.redirect("/admin");
  });

  app.post("/api/user/login", async (request, reply) => {
    const body = z.object({ login: z.string(), password: z.string() }).parse(request.body);
    const session = await loginAccount(pool, body.login, body.password, "user");
    if (!session) return reply.code(401).type("text/html").send(loginPage("user", "bad credentials"));
    setSessionCookie(reply, session.sessionId);
    return reply.redirect("/account");
  });

  app.post("/api/logout", async (request, reply) => {
    await logout(pool, request, reply);
    return reply.redirect("/login");
  });

  app.get("/api/admin/users", async (request, reply) => {
    const account = await requireRole(pool, request, reply, "admin");
    if (!account) return;
    return { users: await listUsers(pool) };
  });

  app.post("/api/admin/users", async (request, reply) => {
    const account = await requireRole(pool, request, reply, "admin");
    if (!account) return;
    const body = createUserSchema.parse(request.body);
    await createUser(pool, {
      login: body.login,
      displayName: body.displayName,
      password: body.password,
      xrayUuid: body.xrayUuid || crypto.randomUUID(),
      endpointIds: asArray(body.endpointIds),
    });
    return reply.redirect("/admin");
  });

  app.post("/api/admin/smart-dns/policy", async (request, reply) => {
    const account = await requireRole(pool, request, reply, "admin");
    if (!account) return;
    const body = z.object({ rules: z.string().min(2) }).parse(request.body);
    const rawRules: unknown = JSON.parse(body.rules);
    if (!Array.isArray(rawRules)) throw new Error("rules must be a JSON array");
    await saveSmartDnsPolicy({ ...await loadSmartDnsPolicy(), rules: normalizeRoutingRules(rawRules) });
    return reply.redirect("/admin/smart-dns");
  });

  app.post("/api/admin/xray-policy", async (request, reply) => {
    const account = await requireRole(pool, request, reply, "admin");
    if (!account) return;
    return reply.code(303).redirect("/admin/smart-dns");
  });

  app.post("/api/admin/smart-dns/quick-vpn-route", async (request, reply) => {
    const account = await requireRole(pool, request, reply, "admin");
    if (!account) return;
    const body = z.object({ input: z.string().min(1), mode: z.enum(["smart-dns", "vpn", "direct"]) }).parse(request.body);
    const host = hostFromInput(body.input);
    if (!host) return reply.code(400).send({ error: "cannot parse host" });
    const policy = await loadSmartDnsPolicy();
    const id = `quick:vpn:${host}`;
    const rules = policy.rules.filter((rule) => rule.id !== id);
    const quickRule = quickSmartDnsRouteRule(host, body.mode);
    rules.push(quickRule);
    const saved = await saveSmartDnsPolicy({ ...policy, rules: normalizeRoutingRules(rules) });
    const applied = saved.rules.find((rule) => rule.id === id);
    if (!applied || applied.through[0] !== quickRule.through[0] || applied.conditions.join(",") !== quickRule.conditions.join(",")) {
      return reply.code(409).send({ error: "route is protected by policy and cannot be overridden" });
    }
    return reply.code(303).redirect(`/admin/smart-dns?check=${encodeURIComponent(body.input)}#smart-dns-check`);
  });

  app.get("/api/admin/service-catalog/plan", async (request, reply) => {
    const account = await requireRole(pool, request, reply, "admin");
    if (!account) return;
    const restrictedServicesCatalog = await loadRestrictedServicesCatalog();
    const catalog = await loadDraftServiceCatalog(restrictedServicesCatalog);
    const smartEdge = await loadSmartEdgeConfig(secure);
    return reply.send(buildServiceCatalogActivationPlan(catalog, {
      activePublicDnsEdgeId: smartEdge.state.activeEdgeId,
      targets: catalogTargetCapabilities(smartEdge),
    }));
  });

  app.post("/api/admin/service-catalog", async (request, reply) => {
    const account = await requireRole(pool, request, reply, "admin");
    if (!account) return;
    if (!request.body || typeof request.body !== "object" || Array.isArray(request.body)) {
      return reply.code(400).send({ error: "invalid service catalog form" });
    }
    const body = request.body as ServiceCatalogForm;
    let revision: string;
    try {
      revision = formScalar(body.revision, "revision");
    } catch (error: unknown) {
      return reply.code(400).send({ error: error instanceof Error ? error.message : String(error) });
    }
    const restrictedServicesCatalog = await loadRestrictedServicesCatalog();
    const draft = await loadDraftServiceCatalogWithSource(restrictedServicesCatalog);
    const catalog = draft.catalog;
    let updated: ServiceCatalog;
    try {
      updated = serviceCatalogFromForm(catalog, body);
      const smartEdge = await loadSmartEdgeConfig(secure);
      validateServiceTargetCapabilities(updated, catalogTargetCapabilities(smartEdge));
    } catch (error: unknown) {
      return reply.code(400).send({ error: error instanceof Error ? error.message : String(error) });
    }
    try {
      await saveServiceCatalog(updated, undefined, { expectedRevision: revision, allowMissingExpectedRevision: !draft.persisted });
    } catch (error: unknown) {
      if (error instanceof ServiceCatalogRevisionConflictError) {
        return reply.code(409).send({ error: error.message });
      }
      throw error;
    }
    return reply.code(303).redirect("/admin/smart-dns#service-catalog");
  });

  app.get("/api/admin/smart-dns/check", async (request, reply) => {
    const account = await requireRole(pool, request, reply, "admin");
    if (!account) return;
    const query = z.object({ url: z.string().min(1) }).parse(request.query);
    const policy = await loadSmartDnsPolicy();
    return { ok: true, policy, result: checkSmartDnsRoute(query.url, policy) };
  });

  app.post("/api/admin/smart-edge/:action", async (request, reply) => {
    const account = await requireRole(pool, request, reply, "admin");
    if (!account) return;
    const params = z.object({ action: z.enum(["deploy", "select-primary", "validate"]) }).parse(request.params);
    const body = z.object({ targetId: z.string().min(1) }).parse(request.body);
    const result = await runSmartEdgeAction(params.action, body.targetId);
    const key = result.ok ? "edgeMessage" : "edgeError";
    const value = `${params.action} ${body.targetId}: ${result.ok ? "OK" : "FAILED"}`;
    return reply.redirect(`/admin/smart-dns?${key}=${encodeURIComponent(value)}`);
  });

  app.get("/api/admin/smart-edge", async (request, reply) => {
    const account = await requireRole(pool, request, reply, "admin");
    if (!account) return;
    return { ok: true, smartEdge: await loadSmartEdgeConfig() };
  });

  app.get("/api/internal/smart-dns/clients", async (request, reply) => {
    if (!checkHealthApiKey(request)) return reply.code(401).send({ error: "unauthorized" });
    const policy = await loadSmartDnsPolicy();
    const clients = await listEnabledSmartDnsRuntimeClients(pool);
    return {
      ok: true,
      generatedAt: new Date().toISOString(),
      clients: clients.map((client) => ({
        accountId: client.account_id,
        login: client.login,
        displayName: client.display_name,
        clientId: client.client_id,
        enabled: client.enabled,
        mode: "non_ru_via_proxy",
        defaultRoute: "proxy",
      })),
      policy: { rules: policy.rules },
    };
  });

  // ---------------------------------------------------------------
  // SmartDNS — IP allow-list (DNS-over-UDP source-IP authentication)
  // Manages the in-memory store consulted by smartedge-go via /edge-auth.
  // ---------------------------------------------------------------

  app.get("/admin/smart-dns/allowlist", async (request, reply) => {
    const account = await requireRole(pool, request, reply, "admin");
    if (!account) return;
    const client = new SmartDnsClient();
    if (!client.isConfigured) {
      return reply.type("text/html").send(allowlistPage({
        status: "error",
        message: "SMART_DNS_TOKEN is empty on the panel — fill it in /etc/vpn-panel/.env",
        detectedIp: publicIpFromRequest(request as unknown as { ip: string; headers: Record<string, unknown> }),
        entries: [],
        ttlMs: 0,
        serverNow: Date.now(),
        panelBaseUrl: smartDnsBaseUrl(),
      }));
    }
    try {
      const snapshot = await client.listAllow();
      return reply.type("text/html").send(allowlistPage({
        status: null,
        message: null,
        detectedIp: publicIpFromRequest(request as unknown as { ip: string; headers: Record<string, unknown> }),
        entries: snapshot.allowed,
        ttlMs: snapshot.ttlMs,
        serverNow: snapshot.now,
        panelBaseUrl: smartDnsBaseUrl(),
      }));
    } catch (err) {
      const e = err instanceof SmartDnsError ? err : new Error(String(err));
      return reply.type("text/html").send(allowlistPage({
        status: "error",
        message: `smartdns unreachable: ${e.message}`,
        detectedIp: publicIpFromRequest(request as unknown as { ip: string; headers: Record<string, unknown> }),
        entries: [],
        ttlMs: 0,
        serverNow: Date.now(),
        panelBaseUrl: smartDnsBaseUrl(),
      }));
    }
  });

  app.post("/api/admin/smart-dns/allowlist/add", async (request, reply) => {
    const account = await requireRole(pool, request, reply, "admin");
    if (!account) return;
    const client = new SmartDnsClient();
    if (!client.isConfigured) {
      return reply.code(503).send({ error: "SMART_DNS_TOKEN is empty on the panel" });
    }
    const body = z.object({
      ip: z.string().min(1),
      ttlMs: z.string().optional(),
      ttlHours: z.string().optional(),
      source: z.string().optional(),
    }).parse(request.body);
    let ttlMs = Number(body.ttlMs || 0);
    if (!ttlMs && body.ttlHours) ttlMs = Number(body.ttlHours) * 3600 * 1000;
    if (!ttlMs) ttlMs = 24 * 3600 * 1000;
    try {
      await client.addAllow({
        ip: body.ip,
        ttlMs,
        source: body.source || `panel:${account.login}`,
      });
      return reply.redirect("/admin/smart-dns/allowlist");
    } catch (err) {
      const e = err instanceof SmartDnsError ? err : new Error(String(err));
      return reply.code(502).send(`smartdns add failed: ${e.message}`);
    }
  });

  app.post("/api/admin/smart-dns/allowlist/remove", async (request, reply) => {
    const account = await requireRole(pool, request, reply, "admin");
    if (!account) return;
    const client = new SmartDnsClient();
    if (!client.isConfigured) {
      return reply.code(503).send({ error: "SMART_DNS_TOKEN is empty on the panel" });
    }
    const body = z.object({ ip: z.string().min(1) }).parse(request.body);
    try {
      await client.removeAllow(body.ip);
      return reply.redirect("/admin/smart-dns/allowlist");
    } catch (err) {
      const e = err instanceof SmartDnsError ? err : new Error(String(err));
      return reply.code(502).send(`smartdns remove failed: ${e.message}`);
    }
  });

  app.post("/api/admin/users/:id/smart-dns/generate", async (request, reply) => {
    const account = await requireRole(pool, request, reply, "admin");
    if (!account) return;
    const params = z.object({ id: z.string() }).parse(request.params);
    const user = await getUser(pool, params.id);
    if (!user) return reply.code(404).send({ error: "not found" });
    await ensureSmartDnsClient(pool, params.id);
    return reply.redirect(`/admin/users/${params.id}`);
  });

  app.post("/api/admin/users/:id/smart-dns/toggle", async (request, reply) => {
    const account = await requireRole(pool, request, reply, "admin");
    if (!account) return;
    const params = z.object({ id: z.string() }).parse(request.params);
    const body = z.object({ enabled: z.enum(["true", "false"]) }).parse(request.body);
    const user = await getUser(pool, params.id);
    if (!user) return reply.code(404).send({ error: "not found" });
    const current = await getSmartDnsClient(pool, params.id);
    if (!current) return reply.code(404).send({ error: "smart dns client not found" });
    await setSmartDnsClientEnabled(pool, params.id, body.enabled === "true");
    return reply.redirect(`/admin/users/${params.id}`);
  });

  app.post("/api/admin/users/:id/routing/toggle", async (request, reply) => {
    const account = await requireRole(pool, request, reply, "admin");
    if (!account) return;
    const params = z.object({ id: z.string() }).parse(request.params);
    const body = z.object({ enabled: z.enum(["true", "false"]) }).parse(request.body);
    const user = await getUser(pool, params.id);
    if (!user) return reply.code(404).send({ error: "not found" });
    await setUserRoutingEnabled(pool, params.id, body.enabled === "true");
    return reply.redirect(`/admin/users/${params.id}`);
  });

  app.post("/api/admin/users/:id/update", async (request, reply) => {
    const account = await requireRole(pool, request, reply, "admin");
    if (!account) return;
    const params = z.object({ id: z.string() }).parse(request.params);
    const body = updateUserSchema.parse(request.body);
    await updateUser(pool, params.id, {
      login: body.login,
      displayName: body.displayName,
      password: body.password || undefined,
      enabled: body.enabled === true || body.enabled === "true",
      endpointIds: asArray(body.endpointIds),
    });
    return reply.redirect(`/admin/users/${params.id}`);
  });

  app.patch("/api/admin/users/:id", async (request, reply) => {
    const account = await requireRole(pool, request, reply, "admin");
    if (!account) return;
    const params = z.object({ id: z.string() }).parse(request.params);
    const body = updateUserSchema.parse(request.body);
    await updateUser(pool, params.id, {
      login: body.login,
      displayName: body.displayName,
      password: body.password || undefined,
      enabled: typeof body.enabled === "boolean" ? body.enabled : undefined,
      endpointIds: asArray(body.endpointIds),
    });
    return { ok: true };
  });

  app.delete("/api/admin/users/:id", async (request, reply) => {
    const account = await requireRole(pool, request, reply, "admin");
    if (!account) return;
    const params = z.object({ id: z.string() }).parse(request.params);
    await deleteUser(pool, params.id);
    return { ok: true };
  });

  app.post("/api/admin/users/:id/rotate-token", async (request, reply) => {
    const account = await requireRole(pool, request, reply, "admin");
    if (!account) return;
    const params = z.object({ id: z.string() }).parse(request.params);
    return { token: await rotateToken(pool, params.id) };
  });

  app.post("/api/admin/users/:id/endpoint-scope", async (request, reply) => {
    const account = await requireRole(pool, request, reply, "admin");
    if (!account) return;
    const params = z.object({ id: z.string() }).parse(request.params);
    const body = z.object({ scope: z.enum(["all", "working"]) }).parse(request.body);
    const user = await getUser(pool, params.id);
    if (!user) return reply.code(404).send({ error: "user not found" });
    await setUserEndpointScope(pool, params.id, body.scope);
    return { ok: true };
  });

  app.post("/api/admin/clients/grant-all", async (request, reply) => {
    const account = await requireRole(pool, request, reply, "admin");
    if (!account) return;
    const result = await grantAllEndpointsToAllUsers(pool);
    request.log.info(
      { admin: account.login, ...result },
      "bulk grant: all endpoints to all users",
    );
    return { ok: true, ...result };
  });

  app.post("/api/admin/clients/grant-working", async (request, reply) => {
    const account = await requireRole(pool, request, reply, "admin");
    if (!account) return;
    const result = await grantWorkingEndpointsToAllUsers(pool);
    request.log.info(
      { admin: account.login, ...result },
      "bulk grant: working endpoints to all users",
    );
    return { ok: true, ...result };
  });

  app.get("/api/admin/users/:id/links", async (request, reply) => {
    const account = await requireRole(pool, request, reply, "admin");
    if (!account) return;
    const params = z.object({ id: z.string() }).parse(request.params);
    const bundle = await bundleByAccount(pool, params.id);
    if (!bundle) return reply.code(404).send({ error: "not found" });
    return { subscription: subscriptionUrl(config.publicBaseUrl, bundle.token), links: linkSlots(bundle, secure) };
  });

  // ─── Health API (supports both session auth and Bearer token) ───

  app.get("/api/admin/endpoint-health", async (request, reply) => {
    const account = await requireRole(pool, request, reply, "admin");
    if (!account) return;
    return { health: await getEndpointHealth(pool) };
  });

  // Public ingestion path for incremental VPN test telemetry. Remote runners
  // use the health bearer key; the fixed Bez profile may submit only its own
  // endpoint diagnostics with its existing bootstrap capability.
  app.post("/api/telemetry/vpn-tests/events", async (request, reply) => {
    const headers = request.headers as { authorization?: string };
    if (!checkHealthApiKey(request as { headers: Record<string, string | undefined> })
      && headers.authorization !== `Bearer ${MACOS_CONFIG_TOKEN}`) {
      return reply.code(401).send({ error: "unauthorized" });
    }
    let parsed;
    try {
      parsed = parseVpnTestEvent(request.body);
    } catch (error) {
      return reply.code(400).send({ error: "invalid telemetry event", detail: String(error) });
    }
    await recordVpnTestEvent(pool, parsed);
    return reply.code(202).send({ ok: true, eventId: parsed.eventId });
  });

  app.get("/api/admin/vpn-tests/runs", async (request, reply) => {
    const account = await requireRole(pool, request, reply, "admin");
    if (!account) return;
    const filters = vpnTestRunFiltersSchema.safeParse(request.query);
    if (!filters.success) return reply.code(400).send({ error: "invalid filters", issues: filters.error.issues });
    return listVpnTestRuns(pool, filters.data);
  });

  app.get("/api/admin/vpn-tests/runs/:runId", async (request, reply) => {
    const account = await requireRole(pool, request, reply, "admin");
    if (!account) return;
    const params = z.object({ runId: z.string().min(1).max(100) }).parse(request.params);
    return { runId: params.runId, events: await getVpnTestRunEvents(pool, params.runId) };
  });

  app.get("/api/admin/vpn-tests/endpoints/:endpointId/summary", async (request, reply) => {
    const account = await requireRole(pool, request, reply, "admin");
    if (!account) return;
    const params = z.object({ endpointId: z.string().min(1).max(200) }).parse(request.params);
    const query = z.object({ days: z.coerce.number().int().min(1).max(30).default(3) }).parse(request.query);
    return getVpnTestEndpointDetail(pool, params.endpointId, query.days);
  });

  app.get("/api/admin/vpn-tests/runs/:runId/artifact", async (request, reply) => {
    const account = await requireRole(pool, request, reply, "admin");
    if (!account) return;
    const params = z.object({ runId: z.string().min(1).max(100) }).parse(request.params);
    const artifactPath = await getVpnTestArtifactPath(pool, params.runId);
    if (!artifactPath) return reply.code(404).send({ error: "artifact not found" });
    const resolved = path.resolve(artifactPath);
    const allowedRoots = [path.resolve("bench-results"), path.resolve("vpn-testing/results")];
    if (!allowedRoots.some((root) => resolved.startsWith(`${root}${path.sep}`))) {
      return reply.code(403).send({ error: "artifact path is outside allowed roots" });
    }
    try {
      return reply.type("application/json; charset=utf-8").send(await readFile(resolved, "utf8"));
    } catch {
      return reply.code(404).send({ error: "artifact file is unavailable" });
    }
  });

  // ─── reg.ru DNS API proxy (for Let's Encrypt DNS-01 challenge) ─────
  // Called by certbot manual hooks on VPSes to add/remove _acme-challenge TXT
  // records. The hooks need to come from a publicly-reachable host (vpn.bezrabotnyi.com
  // proxies through nginx → 127.0.0.1:3129 which is this panel) because the VPSes
  // (esp. the USA one) cannot reach the reg.ru API directly.
  app.post("/api/admin/cert/regru", async (request, reply) => {
    const account = await accountFromRequest(pool, request);
    const hasApiKey = checkHealthApiKey(request as { headers: Record<string, string | undefined> });
    if (!account && !hasApiKey) {
      return reply.code(401).send({ error: "unauthorized" });
    }
    if (account && account.role !== "admin" && !hasApiKey) {
      return reply.code(403).send({ error: "forbidden" });
    }
    const body = z.object({
      action: z.enum(["auth", "cleanup"]),
      subdomain: z.string().min(1),
      value: z.string().min(1),
      zone: z.string().default("bezrabotnyi.com"),
    }).safeParse(request.body);
    if (!body.success) {
      return reply.code(400).send({ error: "invalid body", issues: body.error.issues });
    }
    const { action, subdomain, value, zone } = body.data;
    const { execFile } = await import("node:child_process");
    const scriptPath = path.join(import.meta.dirname || process.cwd(), "..", "scripts", "cert-hooks", "regru_api.py");
    try {
      const stdout = await new Promise<string>((resolve, reject) => {
        const proc = execFile("python3", [scriptPath], {
          env: {
            ...process.env,
            REGRU_ACTION: action,
            REGRU_SUBDOMAIN: subdomain,
            REGRU_VALUE: value,
            REGRU_ZONE: zone,
          },
          timeout: 30000,
        }, (err, stdout) => {
          if (err) return reject(err);
          resolve(stdout);
        });
      });
      const result = JSON.parse(stdout.trim().split("\n").pop() || "{}");
      return result;
    } catch (err) {
      return reply.code(500).send({ error: String(err) });
    }
  });

  app.post("/api/admin/endpoint-health", async (request, reply) => {
    // Accept either admin session or health API key
    const account = await accountFromRequest(pool, request);
    const hasApiKey = checkHealthApiKey(request as { headers: Record<string, string | undefined> });
    if (!account && !hasApiKey) {
      return reply.code(401).send({ error: "unauthorized" });
    }
    if (account && account.role !== "admin" && !hasApiKey) {
      return reply.code(403).send({ error: "forbidden" });
    }

    const body = z.object({
      results: z.array(z.object({
        endpoint: z.string(),
        latency_ms: z.number().nullable().optional(),
        speed_mbps: z.number().nullable().optional(),
        exit_ip: z.string().nullable().optional(),
        pass: z.number().optional(),
        fail: z.number().optional(),
        sites: z.array(z.object({
          label: z.string(),
          code: z.string(),
          ms: z.number(),
          ok: z.boolean(),
        })).optional(),
        error: z.string().optional(),
      })),
    }).parse(request.body);

    for (const result of body.results) {
      if (result.error) continue;
      await upsertEndpointHealth(pool, {
        endpointId: result.endpoint,
        latencyMs: result.latency_ms ?? null,
        speedMbps: result.speed_mbps ?? null,
        exitIp: result.exit_ip ?? null,
        passCount: result.pass ?? 0,
        failCount: result.fail ?? 0,
        sites: result.sites ?? [],
      });
    }

    return { ok: true, updated: body.results.length };
  });

  // ─── Quick Check: parallel Telegram test via Docker Xray on VPS ──

  let quickCheckRunning = false;

  app.patch("/api/admin/endpoint-health/targets/:targetId", async (request, reply) => {
    const account = await requireRole(pool, request, reply, "admin");
    if (!account) return;
    const params = z.object({ targetId: z.string().regex(/^[a-z0-9_-]+$/) }).safeParse(request.params);
    const body = z.object({ enabled: z.boolean() }).safeParse(request.body);
    if (!params.success || !body.success) return reply.code(400).send({ error: "target ID and enabled state are required" });
    try {
      return { target: await setVpnTestTargetEnabled(params.data.targetId, body.data.enabled) };
    } catch (error: unknown) {
      if (error instanceof Error && error.message.startsWith("unknown test target:")) return reply.code(404).send({ error: error.message });
      throw error;
    }
  });

  app.post("/api/admin/endpoint-health/check", async (request, reply) => {
    const account = await requireRole(pool, request, reply, "admin");
    if (!account) return;

    const selection = parseTestCheckSelection(request.body);
    if (selection.error) return reply.code(400).send({ error: selection.error });
    const targetError = await validateAdminTestTargets(selection.targets);
    if (targetError) return reply.code(400).send({ error: targetError });

    if (quickCheckRunning) {
      return reply.code(409).send({ error: "Quick check already running" });
    }

    const cfg = vpsConfig(secure);
    if (!cfg) {
      return reply.code(400).send({ error: "No VPS configured" });
    }

    // Get a VPN token with all endpoints
    const tokenRow = await pool.query<{ token: string }>(
      `select st.token from subscription_tokens st
       join vpn_clients vc on vc.id = st.client_id
       join accounts a on a.id = vc.account_id
       where a.login in ('geier25','Nikita') and st.enabled = true
       order by a.login limit 1`,
    );
    if (tokenRow.rows.length === 0) {
      return reply.code(400).send({ error: "No VPN token found" });
    }
    const vpnToken = tokenRow.rows[0].token;

    quickCheckRunning = true;
    const checkPromise = (async () => {
      try {
        const panelUrl = config.publicBaseUrl;
        const healthKey = config.healthApiKey;
        const envParts: string[] = [`VPN_TOKEN=${vpnToken}`];
        if (healthKey) envParts.push(`HEALTH_API_KEY=${healthKey}`);
        if (panelUrl) envParts.push(`PANEL_URL=${panelUrl}`);
        const envPrefix = envParts.join(" ") + " ";
        const checksPrefix = selection.checks === undefined ? "" : `CHECKS=${selection.checks.join(",")} `;
        const endpointsPrefix = selection.endpoints === undefined ? "" : `ENDPOINTS=${selection.endpoints.join(",")} `;
        const targetPrefix = selection.targets === undefined ? "" : `TARGETS=${selection.targets.join(" ")} PROFILE=quick `;

        const output = await sshExec(
          cfg,
          selection.targets === undefined
            ? `${envPrefix}${checksPrefix}bash /home/roomhacker/apps/vpn-panel/scripts/quick-health-check.sh`
            : `${envPrefix}${checksPrefix}${endpointsPrefix}${targetPrefix}bash /home/roomhacker/apps/vpn-panel/scripts/run-bench-everywhere.sh`,
          120000,
        );

        // The configurable matrix posts telemetry directly; retain the legacy
        // parser only for callers that omit targets (the fixed policy path).
        if (selection.targets !== undefined) {
          console.log(`Quick test matrix complete: ${selection.targets.join(", ")}`);
          return;
        }

        // Parse results from output
        const results: Array<{ endpoint: string; tg: string; ms: number; speed: number; exit_ip: string }> = [];
        for (const line of output.split("\n")) {
          if (!line.startsWith("EP:")) continue;
          const parts: Record<string, string> = {};
          for (const token of line.split(/\s+/)) {
            const [k, v] = token.split(":");
            if (k && v !== undefined) parts[k] = v;
          }
          if (parts.EP) {
            results.push({
              endpoint: parts.EP,
              tg: parts.TG || "000",
              ms: parseInt(parts.MS || "0"),
              speed: parseFloat(parts.SPEED || "0"),
              exit_ip: parts.EXIT || "?",
            });
          }
        }

        // Update DB
        let healthy = 0;
        for (const r of results) {
          const isPass = ["200", "301", "302", "307", "308"].includes(r.tg);
          if (isPass) healthy++;
          const sites = [{ label: "Telegram", code: r.tg, ms: r.ms, ok: isPass }];
          await upsertEndpointHealth(pool, {
            endpointId: r.endpoint,
            latencyMs: isPass ? r.ms : null,
            speedMbps: isPass && r.speed > 0 ? r.speed : null,
            exitIp: isPass && r.exit_ip !== "?" ? r.exit_ip : null,
            passCount: isPass ? 1 : 0,
            failCount: isPass ? 0 : 1,
            sites,
          });
        }

        console.log(`Quick check complete: ${results.length} tested, ${healthy} healthy`);
      } catch (err) {
        console.error("Quick check error:", err);
      } finally {
        quickCheckRunning = false;
      }
    })();

    checkPromise.catch(() => {});
    return { ok: true, message: "Quick check started" };
  });

  app.get("/api/admin/endpoint-health/check/status", async (request, reply) => {
    const account = await requireRole(pool, request, reply, "admin");
    if (!account) return;
    return { running: quickCheckRunning };
  });

  // ─── Run full endpoint health-check on VPS via SSH ────────────────

  // Track running benchmarks to prevent duplicates
  let benchmarkRunning = false;

  app.post("/api/admin/endpoint-health/benchmark", async (request, reply) => {
    const account = await requireRole(pool, request, reply, "admin");
    if (!account) return;

    const selection = parseTestCheckSelection(request.body);
    if (selection.error) return reply.code(400).send({ error: selection.error });
    const targetError = await validateAdminTestTargets(selection.targets);
    if (targetError) return reply.code(400).send({ error: targetError });

    if (benchmarkRunning) {
      return reply.code(409).send({ error: "Health-check already running" });
    }

    const cfg = vpsConfig(secure);
    if (!cfg) {
      return reply.code(400).send({ error: "No VPS configured" });
    }

    // Launch the shared health profile asynchronously; it posts results back via the health API.
    benchmarkRunning = true;
    const benchPromise = (async () => {
      try {
        const panelUrl = config.publicBaseUrl;
        const healthKey = config.healthApiKey;
        // Manual UI runs use the selected target matrix. Omitting targets keeps
        // the fixed hourly policy-check path for automation callers.
        const envParts: string[] = [];
        if (selection.targets !== undefined) envParts.push(`TARGETS=${selection.targets.join(" ")}`, "PROFILE=benchmark");
        if (selection.endpoints !== undefined) envParts.push(`ENDPOINTS=${selection.endpoints.join(",")}`);
        if (healthKey) envParts.push(`HEALTH_API_KEY=${healthKey}`);
        if (panelUrl) envParts.push(`PANEL_URL=${panelUrl}`);
        const envPrefix = envParts.length > 0 ? envParts.join(" ") + " " : "";
        const checksPrefix = selection.checks === undefined ? "" : `CHECKS=${selection.checks.join(",")} `;

        await sshExec(
          cfg,
          selection.targets === undefined
            ? `${envPrefix}${checksPrefix}bash /home/roomhacker/apps/vpn-panel/scripts/auto-endpoint-check.sh`
            : `${envPrefix}${checksPrefix}bash /home/roomhacker/apps/vpn-panel/scripts/run-bench-everywhere.sh`,
          600000,
        );
      } catch (err) {
        console.error("Health-check error:", err);
      } finally {
        benchmarkRunning = false;
      }
    })();

    // Don't await — return immediately, benchmark runs in background
    benchPromise.catch(() => {});

    return { ok: true, message: "Full health-check started on VPS" };
  });

  app.get("/api/admin/endpoint-health/benchmark/status", async (request, reply) => {
    const account = await requireRole(pool, request, reply, "admin");
    if (!account) return;
    return { running: benchmarkRunning };
  });

  // ─── Probe API (multi-site endpoint testing from various nodes) ───

  // Track running probe processes with log streaming
  let probeProcess: { 
    pid: number; 
    started_at: string; 
    proc: import("node:child_process").ChildProcess;
    logs: string[];
  } | null = null;
  const MAX_PROBE_LOGS = 500; // Keep last 500 log lines

  app.post("/api/admin/probe/run", async (request, reply) => {
    const account = await requireRole(pool, request, reply, "admin");
    if (!account) return;

    if (probeProcess && probeProcess.proc.exitCode === null) {
      return reply.code(409).send({ error: "Probe already running", pid: probeProcess.pid });
    }

    const query = request.query as { node?: string; engine?: string };
    const node = query.node || "server-100";
    const engine = query.engine || "xray";

    if (!["server-100", "mac", "server-44", "server-88", "auto"].includes(node)) {
      return reply.code(400).send({ error: `Invalid node: ${node}. Use one of: server-100, mac, server-44, server-88, auto` });
    }
    if (!["xray", "singbox", "both"].includes(engine)) {
      return reply.code(400).send({ error: `Invalid engine: ${engine}. Use one of: xray, singbox, both` });
    }

    const { spawn } = await import("node:child_process");
    const scriptPath = path.join(import.meta.dirname || process.cwd(), "..", "vpn-testing", "probe.sh");
    
    // Capture stdout and stderr for log streaming
    const proc = spawn("bash", [scriptPath, `--node=${node}`, `--engine=${engine}`], {
      cwd: path.join(import.meta.dirname || process.cwd(), ".."),
      stdio: ["ignore", "pipe", "pipe"], // capture stdout and stderr
    });

    const pid = proc.pid;
    if (!pid) {
      return reply.code(500).send({ error: "Failed to spawn probe process" });
    }

    const logs: string[] = [];
    
    // Stream stdout
    proc.stdout?.on("data", (data: Buffer) => {
      const lines = data.toString().split("\n").filter((l: string) => l.trim());
      for (const line of lines) {
        logs.push(`[OUT] ${line}`);
        if (logs.length > MAX_PROBE_LOGS) logs.shift();
      }
    });

    // Stream stderr (probe.sh writes logs to stderr)
    proc.stderr?.on("data", (data: Buffer) => {
      const lines = data.toString().split("\n").filter((l: string) => l.trim());
      for (const line of lines) {
        // Strip ANSI color codes for cleaner logs
        const cleanLine = line.replace(/\x1b\[[0-9;]*m/g, "");
        logs.push(cleanLine);
        if (logs.length > MAX_PROBE_LOGS) logs.shift();
      }
    });

    probeProcess = { pid, started_at: new Date().toISOString(), proc, logs };

    // Clean up when process exits
    proc.on("exit", (code) => {
      logs.push(`[DONE] Probe process exited with code ${code}`);
    });

    return { status: "running", pid };
  });

  app.get("/api/admin/probe/status", async (request, reply) => {
    const account = await requireRole(pool, request, reply, "admin");
    if (!account) return;

    if (probeProcess && probeProcess.proc.exitCode === null) {
      return { 
        status: "running", 
        pid: probeProcess.pid, 
        started_at: probeProcess.started_at,
        log_count: probeProcess.logs.length,
      };
    }
    return { status: "idle" };
  });

  // SSE endpoint for real-time log streaming
  app.get("/api/admin/probe/logs", async (request, reply) => {
    const account = await requireRole(pool, request, reply, "admin");
    if (!account) return;

    // Set SSE headers
    reply.header("Content-Type", "text/event-stream");
    reply.header("Cache-Control", "no-cache");
    reply.header("Connection", "keep-alive");
    reply.header("X-Accel-Buffering", "no"); // Disable nginx buffering

    // Send initial logs
    if (probeProcess && probeProcess.logs.length > 0) {
      reply.raw.write(`data: ${JSON.stringify({ type: "init", logs: probeProcess.logs })}\n\n`);
    }

    // Track last sent index
    let lastIndex = probeProcess?.logs.length || 0;

    // Poll for new logs every 500ms
    const interval = setInterval(() => {
      const isDone = !probeProcess || probeProcess.proc.exitCode !== null;

      // Send new logs first (flush remaining logs before done signal)
      if (probeProcess && probeProcess.logs.length > lastIndex) {
        const newLogs = probeProcess.logs.slice(lastIndex);
        reply.raw.write(`data: ${JSON.stringify({ type: "logs", logs: newLogs })}\n\n`);
        lastIndex = probeProcess.logs.length;
      }

      if (isDone) {
        reply.raw.write(`data: ${JSON.stringify({ type: "done", status: probeProcess?.proc.exitCode })}\n\n`);
        clearInterval(interval);
        reply.raw.end();
      }
    }, 500);

    // Clean up interval when client disconnects
    request.raw.on("close", () => {
      clearInterval(interval);
    });
  });

  app.get("/api/admin/probe/results", async (request, reply) => {
    const account = await requireRole(pool, request, reply, "admin");
    if (!account) return;

    const query = request.query as { node?: string; limit?: string };
    const nodeFilter = query.node;
    const limit = parseInt(query.limit || "50");

    const { readdir, readFile } = await import("node:fs/promises");
    const resultsDir = path.join(import.meta.dirname || process.cwd(), "..", "vpn-testing", "results");

    try {
      const files = await readdir(resultsDir);
      const jsonFiles = files
        .filter((f) => f.endsWith(".json"))
        .filter((f) => !nodeFilter || f.includes(`-${nodeFilter}-`));

      const results: Array<Record<string, unknown>> = [];
      for (const file of jsonFiles) {
        try {
          const content = await readFile(path.join(resultsDir, file), "utf8");
          const parsed = JSON.parse(content);
          parsed._filename = file; // Add filename for reference
          parsed._sortTime = Date.parse(String(parsed.timestamp || "")) || 0;
          results.push(parsed);
        } catch {
          // skip unreadable files
        }
      }
      results.sort((a, b) => Number(b._sortTime || 0) - Number(a._sortTime || 0));
      const limitedResults = results.slice(0, limit);
      for (const item of limitedResults) {
        delete item._sortTime;
      }
      return { results: limitedResults, total: results.length };
    } catch (err) {
      // results directory might not exist yet
      return { results: [], total: 0, error: String(err) };
    }
  });

  app.post("/api/admin/users/:id/happ/create-install", async (request, reply) => {
    const account = await requireRole(pool, request, reply, "admin");
    if (!account) return;
    const params = z.object({ id: z.string() }).parse(request.params);

    if (!secure.happ.auth_key) {
      return reply.code(400).send({ error: "Happ auth_key not configured in secure.json" });
    }

    const user = await getUser(pool, params.id);
    if (!user) return reply.code(404).send({ error: "user not found" });

    const existing = await getHappInstall(pool, params.id);
    if (existing) return reply.code(409).send({ error: "install already exists", install_code: existing.install_code });

    const installCode = crypto.randomBytes(6).toString("base64url").slice(0, 12).replace(/[^A-Za-z0-9]/g, "X");
    const result = await happAddInstall(secure, {
      installCode,
      installLimit: 10,
      note: `${user.display_name} (${user.login})`,
    });

    if (result.rc !== 1 && result.rc !== 2) {
      return reply.code(502).send({ error: "Happ API error", details: result });
    }

    await upsertHappInstall(pool, {
      accountId: params.id,
      installCode: result.install_code || installCode,
      installId: result.id,
      installLimit: 10,
      note: `${user.display_name} (${user.login})`,
    });

    return { ok: true, install_code: result.install_code || installCode, deeplink: happInstallDeeplink(secure, result.install_code || installCode) };
  });

  app.post("/api/admin/users/:id/happ/sync-hwids", async (request, reply) => {
    const account = await requireRole(pool, request, reply, "admin");
    if (!account) return;
    const params = z.object({ id: z.string() }).parse(request.params);

    const happInstall = await getHappInstall(pool, params.id);
    if (!happInstall) return reply.code(404).send({ error: "no happ install" });

    if (!secure.happ.auth_key) {
      return reply.code(400).send({ error: "Happ auth_key not configured" });
    }

    const result = await happListHwids(secure, { installCode: happInstall.install_code });
    if (result.rc !== 1 || !result.data) {
      return reply.code(502).send({ error: "Happ API error", details: result });
    }

    await syncHwidsFromHapp(pool, params.id, happInstall.install_code, result.data);
    return { ok: true, hwid_count: result.data.length };
  });

  app.post("/api/admin/users/:id/happ/hwid/:hwidId/delete", async (request, reply) => {
    const account = await requireRole(pool, request, reply, "admin");
    if (!account) return;
    const params = z.object({ id: z.string(), hwidId: z.string() }).parse(request.params);

    const happInstall = await getHappInstall(pool, params.id);
    const hwids = await getHwidsForAccount(pool, params.id);
    const hwid = hwids.find((h) => h.id === params.hwidId);
    if (!hwid) return reply.code(404).send({ error: "hwid not found" });

    // Delete from Happ API if auth_key is configured
    if (secure.happ.auth_key && happInstall) {
      await happApiDeleteHwid(secure, { installCode: happInstall.install_code, hwid: hwid.hwid });
    }

    await deleteHwid(pool, params.hwidId);
    return { ok: true };
  });

  app.post("/api/admin/users/:id/happ/settings", async (request, reply) => {
    const account = await requireRole(pool, request, reply, "admin");
    if (!account) return;
    const params = z.object({ id: z.string() }).parse(request.params);

    const happInstall = await getHappInstall(pool, params.id);
    if (!happInstall) return reply.code(404).send({ error: "no happ install" });

    // Parse happ_ prefixed form fields into settings object
    const body = request.body as Record<string, string>;
    const settings: Record<string, unknown> = { ...happInstall.happ_settings };
    for (const [key, value] of Object.entries(body)) {
      if (key.startsWith("happ_")) {
        const settingKey = key.slice(5);
        if (value === "true") {
          settings[settingKey] = true;
        } else if (value === "false") {
          settings[settingKey] = false;
        } else {
          settings[settingKey] = value;
        }
      }
    }

    await updateHappSettings(pool, params.id, settings);
    return reply.redirect(`/admin/users/${params.id}`);
  });

  app.post("/api/admin/users/:id/happ/push-settings", async (request, reply) => {
    const account = await requireRole(pool, request, reply, "admin");
    if (!account) return;
    const params = z.object({ id: z.string() }).parse(request.params);

    if (!secure.happ.auth_key) {
      return reply.code(400).send({ error: "Happ auth_key not configured" });
    }

    const happInstall = await getHappInstall(pool, params.id);
    if (!happInstall) return reply.code(404).send({ error: "no happ install" });

    const hwids = await getHwidsForAccount(pool, params.id);
    if (hwids.length === 0) {
      return reply.code(400).send({ error: "no devices registered" });
    }

    const hwidList = hwids.slice(0, 5).map((h) => h.hwid).join(",");
    const result = await happSendCommand(secure, {
      action_type: "set-settings",
      settings: happInstall.happ_settings,
      specific_device_toggle: true,
      hwid: hwidList,
    });

    if (result.rc !== 1) {
      return reply.code(502).send({ error: "Happ API error", details: result });
    }

    return { ok: true, command_id: result.id };
  });

  app.post("/api/admin/users/:id/happ/push-subscription", async (request, reply) => {
    const account = await requireRole(pool, request, reply, "admin");
    if (!account) return;
    const params = z.object({ id: z.string() }).parse(request.params);

    if (!secure.happ.auth_key) {
      return reply.code(400).send({ error: "Happ auth_key not configured" });
    }

    const hwids = await getHwidsForAccount(pool, params.id);
    if (hwids.length === 0) {
      return reply.code(400).send({ error: "no devices registered" });
    }

    const hwidList = hwids.slice(0, 5).map((h) => h.hwid).join(",");
    const result = await happSendCommand(secure, {
      action_type: "update-subscription",
      specific_device_toggle: true,
      hwid: hwidList,
    });

    if (result.rc !== 1) {
      return reply.code(502).send({ error: "Happ API error", details: result });
    }

    return { ok: true, command_id: result.id };
  });

  app.post("/api/admin/users/:id/happ/toggle-status", async (request, reply) => {
    const account = await requireRole(pool, request, reply, "admin");
    if (!account) return;
    const params = z.object({ id: z.string() }).parse(request.params);

    const happInstall = await getHappInstall(pool, params.id);
    if (!happInstall) return reply.code(404).send({ error: "no happ install" });

    const newStatus = happInstall.status === 10 ? 5 : 10;

    if (secure.happ.auth_key && happInstall.install_id) {
      await happSendCommand(secure, {
        action_type: "set-settings",
        settings: {},
        specific_device_toggle: true,
        hwid: "",
      }).catch(() => {}); // best effort
    }

    await updateHappInstallStatus(pool, params.id, newStatus);
    return { ok: true, new_status: newStatus };
  });

  app.post("/api/admin/users/:id/happ/update-limit", async (request, reply) => {
    const account = await requireRole(pool, request, reply, "admin");
    if (!account) return;
    const params = z.object({ id: z.string() }).parse(request.params);
    const body = z.object({ installLimit: z.number().int().min(1).max(100) }).parse(request.body);

    const happInstall = await getHappInstall(pool, params.id);
    if (!happInstall) return reply.code(404).send({ error: "no happ install" });

    await upsertHappInstall(pool, {
      accountId: params.id,
      installCode: happInstall.install_code,
      installId: happInstall.install_id ?? undefined,
      installLimit: body.installLimit,
    });

    // Also update on Happ API
    if (secure.happ.auth_key && happInstall.install_id) {
      await happUpdateInstall(secure, {
        id: happInstall.install_id,
        installLimit: body.installLimit,
      }).catch(() => {}); // best effort
    }

    return { ok: true, install_limit: body.installLimit };
  });

  // ─── Bulk sync all HWIDs from Happ ──────────────────────────────

  app.post("/api/admin/happ/sync-all-hwids", async (request, reply) => {
    const account = await requireRole(pool, request, reply, "admin");
    if (!account) return;

    if (!secure.happ.auth_key) {
      return reply.code(400).send({ error: "Happ auth_key not configured" });
    }

    const installs = await getAllHappInstalls(pool);
    let synced = 0;
    let errors = 0;

    for (const install of installs) {
      if (install.status !== 10) continue; // skip disabled installs
      try {
        const result = await happListHwids(secure, { installCode: install.install_code });
        if (result.rc === 1 && result.data) {
          await syncHwidsFromHapp(pool, install.account_id, install.install_code, result.data);
          synced += result.data.length;
        }
      } catch {
        errors++;
      }
    }

    return { ok: true, synced, errors, total_installs: installs.length };
  });

  // ─── VPS Management ───────────────────────────────────────────────

  app.get("/admin/vps", async (request, reply) => {
    const account = await requireRole(pool, request, reply, "admin");
    if (!account) return;
    const query = request.query as { vps?: string };
    const vpsId = query.vps;
    const vps = vpsConfig(secure, vpsId);
    const activeId = vpsId || (secure.vps_list.length > 0 ? secure.vps_list[0].id : undefined);
    const allVpsFull = secure.vps_list.map(v => ({ id: v.id, host: v.host, port: v.port, username: v.username, label: v.label }));
    if (!vps) {
      return reply.type("text/html").send(vpsPage({ connected: false, error: "VPS not configured. Add a VPS server below.", vpsList: secure.vps_list, activeVpsId: vpsId, allVpsFull }));
    }
    try {
      const [sysStats, xrayInfo, userTraffic, inboundTraffic] = await Promise.all([
        getSystemStats(vps),
        getXrayStatus(vps),
        getUserTraffic(vps),
        getInboundTraffic(vps),
      ]);
      const xrayVersion = await getXrayVersion(vps);
      let singBox: Awaited<ReturnType<typeof getEngineStatus>> & { version: string } | undefined;
      try {
        const [status, version] = await Promise.all([getEngineStatus(vps, "sing-box"), getEngineVersion(vps, "sing-box")]);
        singBox = { ...status, version };
      } catch {
        // sing-box is optional on a VPS; Xray remains the required page engine.
      }
      return reply.type("text/html").send(vpsPage({
        connected: true,
        system: sysStats,
        xray: {
          ...xrayInfo,
          version: xrayVersion,
        },
        singBox,
        userTraffic,
        inboundTraffic,
        vpsLabel: vpsLabel(secure, vpsId),
        vpsList: secure.vps_list,
        activeVpsId: activeId,
        allVpsFull,
      }));
    } catch (err) {
      return reply.type("text/html").send(vpsPage({ connected: false, error: String(err), vpsList: secure.vps_list, activeVpsId: vpsId, allVpsFull }));
    }
  });

  function resolveVps(request: { query: Record<string, string | undefined> }): VpsConnectionConfig | null {
    return vpsConfig(secure, request.query.vps);
  }

  app.get("/api/admin/vps/system", async (request, reply) => {
    const account = await requireRole(pool, request, reply, "admin");
    if (!account) return;
    const vps = resolveVps(request as { query: Record<string, string | undefined> });
    if (!vps) return reply.code(400).send({ error: "VPS not configured" });
    return getSystemStats(vps);
  });

  app.get("/api/admin/vps/xray/status", async (request, reply) => {
    const account = await requireRole(pool, request, reply, "admin");
    if (!account) return;
    const vps = resolveVps(request as { query: Record<string, string | undefined> });
    if (!vps) return reply.code(400).send({ error: "VPS not configured" });
    const [status, version] = await Promise.all([getXrayStatus(vps), getXrayVersion(vps)]);
    return { ...status, version };
  });

  app.get("/api/admin/vps/xray/traffic/users", async (request, reply) => {
    const account = await requireRole(pool, request, reply, "admin");
    if (!account) return;
    const vps = resolveVps(request as { query: Record<string, string | undefined> });
    if (!vps) return reply.code(400).send({ error: "VPS not configured" });
    return { users: await getUserTraffic(vps) };
  });

  app.get("/api/admin/vps/xray/traffic/inbounds", async (request, reply) => {
    const account = await requireRole(pool, request, reply, "admin");
    if (!account) return;
    const vps = resolveVps(request as { query: Record<string, string | undefined> });
    if (!vps) return reply.code(400).send({ error: "VPS not configured" });
    return { inbounds: await getInboundTraffic(vps) };
  });

  app.get("/api/admin/vps/xray/config", async (request, reply) => {
    const account = await requireRole(pool, request, reply, "admin");
    if (!account) return;
    const vps = resolveVps(request as { query: Record<string, string | undefined> });
    if (!vps) return reply.code(400).send({ error: "VPS not configured" });
    const config = await getXrayConfig(vps);
    return reply.type("application/json").send(config);
  });

  app.post("/api/admin/vps/xray/config", async (request, reply) => {
    const account = await requireRole(pool, request, reply, "admin");
    if (!account) return;
    const vps = resolveVps(request as { query: Record<string, string | undefined> });
    if (!vps) return reply.code(400).send({ error: "VPS not configured" });
    const body = request.body as { config?: string };
    if (!body.config) return reply.code(400).send({ error: "config field required" });
    const result = await updateXrayConfig(vps, body.config);
    if (!result.ok) return reply.code(500).send(result);
    return result;
  });

  app.post("/api/admin/vps/xray/restart", async (request, reply) => {
    const account = await requireRole(pool, request, reply, "admin");
    if (!account) return;
    const vps = resolveVps(request as { query: Record<string, string | undefined> });
    if (!vps) return reply.code(400).send({ error: "VPS not configured" });
    const result = await restartXray(vps);
    if (!result.ok) return reply.code(500).send(result);
    return result;
  });

  app.get("/api/admin/vps/xray/logs", async (request, reply) => {
    const account = await requireRole(pool, request, reply, "admin");
    if (!account) return;
    const vps = resolveVps(request as { query: Record<string, string | undefined> });
    if (!vps) return reply.code(400).send({ error: "VPS not configured" });
    const query = request.query as { lines?: string };
    const lines = parseInt(query.lines || "50");
    return { logs: await getXrayLogs(vps, lines) };
  });

  app.get("/api/admin/vps/sing-box/status", async (request, reply) => {
    const account = await requireRole(pool, request, reply, "admin");
    if (!account) return;
    const vps = resolveVps(request as { query: Record<string, string | undefined> });
    if (!vps) return reply.code(400).send({ error: "VPS not configured" });
    const [status, version] = await Promise.all([getEngineStatus(vps, "sing-box"), getEngineVersion(vps, "sing-box")]);
    return { ...status, version };
  });

  app.get("/api/admin/vps/sing-box/logs", async (request, reply) => {
    const account = await requireRole(pool, request, reply, "admin");
    if (!account) return;
    const vps = resolveVps(request as { query: Record<string, string | undefined> });
    if (!vps) return reply.code(400).send({ error: "VPS not configured" });
    const query = request.query as { lines?: string };
    const lines = parseInt(query.lines || "50");
    return { logs: await getEngineLogs(vps, "sing-box", lines) };
  });

  app.get("/api/admin/vps/xray/preview-config", async (request, reply) => {
    const account = await requireRole(pool, request, reply, "admin");
    if (!account) return;
    try {
      const generatedConfig = await deServerConfig(pool, secure);
      return { config: generatedConfig, json: JSON.stringify(generatedConfig, null, 2) };
    } catch (err) {
      return reply.code(500).send({ error: String(err) });
    }
  });

  app.post("/api/admin/vps/xray/sync-clients", async (request, reply) => {
    const account = await requireRole(pool, request, reply, "admin");
    if (!account) return;
    const vps = resolveVps(request as { query: Record<string, string | undefined> });
    if (!vps) return reply.code(400).send({ error: "VPS not configured" });
    try {
      const defaults = secure.defaults;
      const serverConfigDe = secure.server_configs.de || {};

      const relayClient = serverConfigDe.relay_client as Record<string, string> | undefined;
      const deDirectClients = await clientsForEndpoint(pool, "de-direct");
      const relayXrayClient = relayClient?.id
        ? { id: relayClient.id, email: relayClient.email || "ru-relay", flow: relayClient.flow || defaults.flow }
        : undefined;
      const withRelayClient = (clients: { id: string; email?: string; flow?: string }[]) =>
        relayXrayClient && !clients.some((client) => client.id === relayXrayClient.id)
          ? [...clients, relayXrayClient]
          : clients;

      const endpointIds = ["de-xhttp", "de-xhttp-h2", "de-cdn", "de-cdn2", "de-cdn-xhttp", "de-grpc", "de-httpupgrade", "de-direct-ws"];
      const clientMap = new Map<string, { id: string; email: string; flow?: string }[]>();

      clientMap.set("de-reality", withRelayClient(deDirectClients).map((c) => ({
        id: c.id,
        email: c.email || c.id,
        flow: c.flow || defaults.flow,
      })));

      for (const eid of endpointIds) {
        const clients = withRelayClient(await clientsForEndpoint(pool, eid));
        clientMap.set(eid, clients.map((c) => ({
          id: c.id,
          email: c.email || c.id,
        })));
      }

      const result = await syncXrayClients(vps, clientMap);
      if (!result.ok) return reply.code(500).send(result);
      return { ok: true, message: "Xray config synced and restarted" };
    } catch (err) {
      return reply.code(500).send({ ok: false, error: String(err) });
    }
  });

  app.post("/api/admin/vps/xray/reset-stats", async (request, reply) => {
    const account = await requireRole(pool, request, reply, "admin");
    if (!account) return;
    const vps = resolveVps(request as { query: Record<string, string | undefined> });
    if (!vps) return reply.code(400).send({ error: "VPS not configured" });
    return resetTrafficStats(vps);
  });

  // ─── Deploy full server config to VPS ────────────────────────────

  app.post("/api/admin/vps/deploy-server", async (request, reply) => {
    const account = await requireRole(pool, request, reply, "admin");
    if (!account) return;
    const vps = resolveVps(request as { query: Record<string, string | undefined> });
    if (!vps) return reply.code(400).send({ error: "VPS not configured" });

    const query = request.query as { server?: string };
    const serverId = query.server || "de";

    try {
      // 1. Generate full Xray server config
      const generated = await serverConfig(pool, secure, serverId);
      const configJson = JSON.stringify(generated, null, 2);

      // 2. Push config to VPS (validates + writes)
      const pushResult = await updateXrayConfig(vps, configJson);
      if (!pushResult.ok) {
        return reply.code(500).send({ ok: false, error: pushResult.error || "Failed to write config" });
      }

      // 3. Restart Xray
      const restartResult = await restartXray(vps);
      if (!restartResult.ok) {
        return reply.code(500).send({ ok: false, error: restartResult.error || "Failed to restart Xray" });
      }

      const inbounds = (generated.inbounds as Array<Record<string, unknown>> | undefined) || [];
      const inboundSummary = inbounds.map((ib) => ({
        tag: ib.tag,
        port: ib.port,
        clients: ((ib.settings as Record<string, unknown>)?.clients as unknown[] | undefined)?.length || 0,
      }));

      return {
        ok: true,
        serverId,
        message: `Deployed ${serverId} config with ${inbounds.length} inbounds`,
        inbounds: inboundSummary,
      };
    } catch (err) {
      return reply.code(500).send({ ok: false, error: String(err) });
    }
  });

  app.get("/api/admin/vps/xray/check-update", async (request, reply) => {
    const account = await requireRole(pool, request, reply, "admin");
    if (!account) return;
    const vps = resolveVps(request as { query: Record<string, string | undefined> });
    if (!vps) return reply.code(400).send({ error: "VPS not configured" });
    try {
      return await checkXrayUpdate(vps);
    } catch (err) {
      return reply.code(500).send({ error: String(err) });
    }
  });

  app.post("/api/admin/vps/xray/update", async (request, reply) => {
    const account = await requireRole(pool, request, reply, "admin");
    if (!account) return;
    const vps = resolveVps(request as { query: Record<string, string | undefined> });
    if (!vps) return reply.code(400).send({ error: "VPS not configured" });
    const body = request.body as { version?: string };
    if (!body.version) return reply.code(400).send({ error: "version field required" });
    try {
      return await updateXray(vps, body.version);
    } catch (err) {
      return reply.code(500).send({ error: String(err) });
    }
  });

  app.get("/api/admin/vps/sing-box/check-update", async (request, reply) => {
    const account = await requireRole(pool, request, reply, "admin");
    if (!account) return;
    const vps = resolveVps(request as { query: Record<string, string | undefined> });
    if (!vps) return reply.code(400).send({ error: "VPS not configured" });
    try {
      return await checkEngineUpdate(vps, "sing-box");
    } catch (err) {
      return reply.code(500).send({ error: String(err) });
    }
  });

  app.post("/api/admin/vps/sing-box/update", async (request, reply) => {
    const account = await requireRole(pool, request, reply, "admin");
    if (!account) return;
    const vps = resolveVps(request as { query: Record<string, string | undefined> });
    if (!vps) return reply.code(400).send({ error: "VPS not configured" });
    const body = request.body as { version?: string };
    if (!body.version) return reply.code(400).send({ error: "version field required" });
    try {
      return await updateEngine(vps, "sing-box", body.version);
    } catch (err) {
      return reply.code(500).send({ error: String(err) });
    }
  });

  // ─── VPS Service Management ──────────────────────────────────────

  app.post("/api/admin/vps/xray/stop", async (request, reply) => {
    const account = await requireRole(pool, request, reply, "admin");
    if (!account) return;
    const vps = resolveVps(request as { query: Record<string, string | undefined> });
    if (!vps) return reply.code(400).send({ error: "VPS not configured" });
    try {
      const output = await sshExec(vps, "systemctl stop xray 2>&1 && sleep 1 && systemctl is-active xray 2>&1 || echo inactive");
      return { ok: true, status: output.trim() };
    } catch (err) {
      return { ok: false, error: String(err) };
    }
  });

  app.post("/api/admin/vps/xray/start", async (request, reply) => {
    const account = await requireRole(pool, request, reply, "admin");
    if (!account) return;
    const vps = resolveVps(request as { query: Record<string, string | undefined> });
    if (!vps) return reply.code(400).send({ error: "VPS not configured" });
    try {
      const output = await sshExec(vps, "systemctl start xray 2>&1 && sleep 2 && systemctl is-active xray 2>&1");
      const ok = output.trim() === "active";
      return { ok, status: output.trim() };
    } catch (err) {
      return { ok: false, error: String(err) };
    }
  });

  app.get("/api/admin/vps/processes", async (request, reply) => {
    const account = await requireRole(pool, request, reply, "admin");
    if (!account) return;
    const vps = resolveVps(request as { query: Record<string, string | undefined> });
    if (!vps) return reply.code(400).send({ error: "VPS not configured" });
    try {
      const output = await sshExec(vps, "ps aux --sort=-%mem | head -20");
      return { output };
    } catch (err) {
      return reply.code(500).send({ error: String(err) });
    }
  });

  app.get("/api/admin/vps/connections", async (request, reply) => {
    const account = await requireRole(pool, request, reply, "admin");
    if (!account) return;
    const vps = resolveVps(request as { query: Record<string, string | undefined> });
    if (!vps) return reply.code(400).send({ error: "VPS not configured" });
    try {
      const output = await sshExec(vps, "ss -tnp | grep xray | awk '{print $4,$5,$6}' | head -30");
      return { output };
    } catch (err) {
      return reply.code(500).send({ error: String(err) });
    }
  });

  // ─── VPS Config CRUD (add/edit/delete VPS servers) ────────────

  app.post("/api/admin/vps/config", async (request, reply) => {
    const account = await requireRole(pool, request, reply, "admin");
    if (!account) return;
    const body = request.body as { label?: string; host?: string; port?: number; username?: string; password?: string; private_key?: string };
    if (!body.host || !body.label) return reply.code(400).send({ error: "Host and label are required" });
    try {
      const id = body.host.replace(/[^a-zA-Z0-9-]/g, "-").toLowerCase();
      if (secure.vps_list.find(v => v.id === id)) return reply.code(400).send({ error: "VPS with this host already exists" });
      secure.vps_list.push({
        id,
        host: body.host,
        port: body.port || 22,
        username: body.username || "root",
        password: body.password || "",
        private_key: body.private_key || "",
        passphrase: "",
        label: body.label,
      });
      await saveSecureConfig(secure, secureConfigPath);
      return { ok: true, id };
    } catch (err) {
      return reply.code(500).send({ error: String(err) });
    }
  });

  // ─── Centralized config deploy (panel → remote hosts) ──────────────
  // Targets: vpn2 | server-44 | server-88 | router | all
  // See scripts/deploy-all.sh for the actual flow
  app.post("/api/admin/deploy/:target", async (request, reply) => {
    const account = await requireRole(pool, request, reply, "admin");
    if (!account) return;
    const target = (request.params as { target?: string }).target || "";
    const query = request.query as { dry_run?: string };
    const dryRun = query.dry_run === "true" || query.dry_run === "1";
    if (!["vpn2", "vusa", "server-44", "server-88", "smartdns", "router-dns", "router", "all"].includes(target)) {
      return reply.code(400).send({ error: `Unknown target: ${target}. Use one of: vpn2, vusa, server-44, server-88, smartdns, router-dns, router, all` });
    }
    const { spawn } = await import("node:child_process");
    const scriptPath = path.join(import.meta.dirname || process.cwd(), "..", "scripts", "deploy-all.sh");
    const args = [scriptPath];
    if (dryRun) args.push("--dry-run");
    args.push(target);
    try {
      const result = await new Promise<{ ok: boolean; output: string; error?: string }>((resolve) => {
        const proc = spawn("bash", args, { env: { ...process.env, PATH: process.env.PATH || "/usr/bin:/bin" } });
        let output = "";
        let error = "";
        proc.stdout.on("data", (chunk: Buffer) => { output += chunk.toString(); });
        proc.stderr.on("data", (chunk: Buffer) => { error += chunk.toString(); });
        proc.on("close", (code) => {
          resolve({ ok: code === 0, output, error: code !== 0 ? error : undefined });
        });
        proc.on("error", (err) => {
          resolve({ ok: false, output, error: String(err) });
        });
      });
      return result;
    } catch (err) {
      return reply.code(500).send({ ok: false, error: String(err) });
    }
  });

  app.get("/api/admin/deploy/status", async (request, reply) => {
    const account = await requireRole(pool, request, reply, "admin");
    if (!account) return;
    // Show last N log lines from logs/deploy/
    const logDir = path.join(import.meta.dirname || process.cwd(), "..", "logs", "deploy");
    try {
      const { readdirSync, readFileSync } = await import("node:fs");
      const files = readdirSync(logDir).filter((f) => f === "deploy.log").sort();
      const last = files[files.length - 1];
      if (!last) return { output: "(no deploy log yet)" };
      const content = readFileSync(path.join(logDir, last), "utf8");
      const lines = content.split("\n").slice(-100).join("\n");
      return { file: last, output: lines };
    } catch (err) {
      return reply.code(500).send({ error: String(err) });
    }
  });

  app.put("/api/admin/vps/config", async (request, reply) => {
    const account = await requireRole(pool, request, reply, "admin");
    if (!account) return;
    const body = request.body as { id?: string; label?: string; host?: string; port?: number; username?: string; password?: string; private_key?: string };
    if (!body.id) return reply.code(400).send({ error: "VPS id is required" });
    const idx = secure.vps_list.findIndex(v => v.id === body.id);
    if (idx === -1) return reply.code(404).send({ error: "VPS not found" });
    const existing = secure.vps_list[idx];
    secure.vps_list[idx] = {
      ...existing,
      label: body.label || existing.label,
      host: body.host || existing.host,
      port: body.port || existing.port,
      username: body.username || existing.username,
      password: body.password !== undefined ? body.password : existing.password,
      private_key: body.private_key !== undefined ? body.private_key : existing.private_key,
    };
    await saveSecureConfig(secure, secureConfigPath);
    return { ok: true };
  });

  app.delete("/api/admin/vps/config", async (request, reply) => {
    const account = await requireRole(pool, request, reply, "admin");
    if (!account) return;
    const body = request.body as { id?: string };
    if (!body.id) return reply.code(400).send({ error: "VPS id is required" });
    const idx = secure.vps_list.findIndex(v => v.id === body.id);
    if (idx === -1) return reply.code(404).send({ error: "VPS not found" });
    if (secure.vps_list.length <= 1) return reply.code(400).send({ error: "Cannot delete the last VPS" });
    secure.vps_list.splice(idx, 1);
    await saveSecureConfig(secure, secureConfigPath);
    return { ok: true };
  });

  // ─── User API ─────────────────────────────────────────────────────

  app.get("/api/user/links", async (request, reply) => {
    const account = await requireRole(pool, request, reply, "user");
    if (!account) return;
    const bundle = await bundleByAccount(pool, account.id);
    if (!bundle) return reply.code(404).send({ error: "not found" });
    return { subscription: subscriptionUrl(config.publicBaseUrl, bundle.token), links: linkSlots(bundle, secure) };
  });

  app.get("/api/user/macos-config", async (request, reply) => {
    const query = z.object({ token: z.string().min(1) }).safeParse(request.query);
    if (!query.success) return reply.code(401).send({ error: "unauthorized" });
    const bundle = await bundleByToken(pool, query.data.token);
    if (!bundle) return reply.code(401).send({ error: "unauthorized" });
    return macosSingBoxSubscription(bundle, secure, await loadSmartDnsPolicy());
  });

  app.get("/api/admin/xray-config/:serverId", async (request, reply) => {
    const account = await requireRole(pool, request, reply, "admin");
    if (!account) return;
    const params = z.object({ serverId: z.string() }).parse(request.params);
    return serverConfig(pool, secure, params.serverId);
  });

  app.get("/sub/:token/qr", async (request, reply) => {
    const params = z.object({ token: z.string() }).parse(request.params);
    const bundle = await bundleByToken(pool, params.token);
    if (!bundle) return reply.code(404).send("subscription not found");
    const url = subscriptionUrl(config.publicBaseUrl, bundle.token, "plain");
    const qrSvg = await QRCode.toString(url, { type: "svg", width: 400, margin: 1 });
    return reply.type("image/svg+xml").headers({ "cache-control": "public, max-age=3600" }).send(qrSvg);
  });

  app.get("/sub/:token/smart-dns.mobileconfig", async (request, reply) => {
    const params = z.object({ token: z.string() }).parse(request.params);
    const bundle = await bundleByToken(pool, params.token);
    if (!bundle) return reply.code(404).send("subscription not found");
    const smartDnsClient = await getSmartDnsClient(pool, bundle.accountId);
    if (!smartDnsClient?.enabled) return reply.code(404).send("smart dns profile not found");
    const profile = smartDnsMobileconfig({
      clientId: smartDnsClient.client_id,
      displayName: `BezVPN Smart DNS - ${bundle.login}`,
    });
    const filename = `bezvpn-smart-dns-${bundle.login.replace(/[^a-z0-9_-]+/gi, "-")}.mobileconfig`;
    return reply
      .type("application/x-apple-aspen-config")
      .headers({
        "content-disposition": `attachment; filename="${filename}"`,
        "cache-control": "no-store",
      })
      .send(profile);
  });

  async function happHeaders(reply: { header: (k: string, v: string) => void }, bundle: { displayName: string; login: string; accountId: string }) {
    reply.header("profile-title", "BezVPN");
    reply.header("profile-update-interval", "1");
    const routingEnabled = await getUserRoutingEnabled(pool, bundle.accountId);
    reply.header("routing-enable", routingEnabled ? "1" : "0");
    if (routingEnabled) reply.header("routing", happRoutingLink(await loadSmartDnsPolicy()));
    reply.header("providerid", secure.happ.provider_code);
    reply.header("announce", announceHeader(personalizedAnnounce(bundle.displayName, bundle.login)));
  }

  // Helper: capture HWID from Happ client headers (best-effort, never fails)
  async function captureHwid(req: { headers: Record<string, string | string[] | undefined> }, accountId: string): Promise<void> {
    const h = (key: string) => { const v = req.headers[key]; return typeof v === "string" ? v : undefined; };
    await captureHwidFromSubscription(pool, accountId, {
      hwid: h("hwid"),
      "device-name": h("device-name"),
      "device-model": h("device-model"),
      "os-version": h("os-version"),
      "app-version": h("app-version"),
    }).catch(() => {});
  }

  app.get("/sub/:token/plain", async (request, reply) => {
    const params = z.object({ token: z.string() }).parse(request.params);
    const bundle = await bundleByToken(pool, params.token);
    if (!bundle) return reply.code(404).send("subscription not found");
    await happHeaders(reply, bundle);
    await captureHwid(request, bundle.accountId);
    return reply.type("text/plain; charset=utf-8").send(plainSubscription(bundle, secure));
  });

  app.get("/sub/:token/v2ray", async (request, reply) => {
    const params = z.object({ token: z.string() }).parse(request.params);
    const bundle = await bundleByToken(pool, params.token);
    if (!bundle) return reply.code(404).send("subscription not found");
    await happHeaders(reply, bundle);
    await captureHwid(request, bundle.accountId);
    return reply.type("text/plain; charset=utf-8").send(v2raySubscription(bundle, secure));
  });

  app.get("/sub/:token/happ", async (request, reply) => {
    const params = z.object({ token: z.string() }).parse(request.params);
    const bundle = await bundleByToken(pool, params.token);
    if (!bundle) return reply.code(404).send("subscription not found");
    await happHeaders(reply, bundle);
    await captureHwid(request, bundle.accountId);
    const body = (await getUserRoutingEnabled(pool, bundle.accountId) ? `${happRoutingLink(await loadSmartDnsPolicy())}\n` : "") + plainSubscription(bundle, secure);
    return reply.type("text/plain; charset=utf-8").send(body);
  });

  app.get("/sub/:token/happ-json", async (request, reply) => {
    const params = z.object({ token: z.string() }).parse(request.params);
    const query = z.object({ target: z.enum(["external-mac", "external-wireless-android", "lan-server44"]).optional() }).parse(request.query);
    const bundle = await bundleByToken(pool, params.token);
    if (!bundle) return reply.code(404).send({ error: "subscription not found" });
    await happHeaders(reply, bundle);
    await captureHwid(request, bundle.accountId);
    const details = await Promise.all(bundle.endpoints.map((endpoint) => getVpnTestEndpointDetail(pool, endpoint.id, 3)));
    const quality = details.map(({ endpointId, summary, matrix }) => {
      const measurement = query.target ? matrix.find((row) => row.targetId === query.target && row.client === "xray") : summary;
      return {
        endpointId, observations: measurement?.effectiveObservations ?? 0,
        reliability: measurement?.effectiveObservations ? 100 * measurement.passed / measurement.effectiveObservations : null,
        latencyMs: measurement?.stages.find((stage) => stage.stageId === "telegram")?.medianMs ?? null,
        mbps: measurement?.stages.find((stage) => stage.stageId === "throughput")?.medianMbps ?? null,
        source: query.target === "external-mac" ? "Mac" : query.target === "external-wireless-android" ? "Android" : query.target === "lan-server44" ? "LAN" : "Все сети",
      };
    });
    return reply.type("application/json").send(happJsonSubscription(bundle, secure, await loadSmartDnsPolicy(), quality));
  });

  app.get("/sub/:token/sing-box", async (request, reply) => {
    const params = z.object({ token: z.string() }).parse(request.params);
    const bundle = await bundleByToken(pool, params.token);
    if (!bundle) return reply.code(404).send({ error: "subscription not found" });
    await captureHwid(request, bundle.accountId);
    return singBoxSubscription(bundle, secure);
  });

  app.get("/sub/:token/xray-json", async (request, reply) => {
    const params = z.object({ token: z.string() }).parse(request.params);
    const query = z.object({ diagnostic: z.literal("1").optional() }).parse(request.query);
    const bundle = await bundleByToken(pool, params.token);
    if (!bundle) return reply.code(404).send({ error: "subscription not found" });
    if (query.diagnostic === "1" && !checkHealthApiKey(request as { headers: Record<string, string | string[] | undefined> })) {
      return reply.code(403).send({ error: "diagnostic subscription requires health authorization" });
    }
    await captureHwid(request, bundle.accountId);
    const diagnostic = query.diagnostic === "1";
    const diagnosticBundle = diagnostic
      ? { ...bundle, endpoints: await diagnosticEndpointsForClient(pool, bundle.clientId) }
      : bundle;
    return xrayClientSubscription(diagnosticBundle, secure, { includeEveryAssignedEndpoint: diagnostic });
  });

  app.setErrorHandler((error, request, reply) => {
    request.log.error(error);
    const status = error instanceof z.ZodError ? 400 : 500;
    reply.code(status).send({ error: error instanceof Error ? error.message : String(error) });
  });

  await app.listen({ host: config.host, port: config.port });
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((error) => {
    console.error(error);
    process.exit(1);
  });
}

import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import type { UserSummary, EndpointHealth, HappInstallRecord, HappHwidRecord, SmartDnsClient } from "../src/repository.js";
import type { LinkSlot } from "../src/subscriptions.js";
import type { Endpoint } from "../src/types.js";
import type { SecureConfig } from "../src/secure-config.js";
import type { SmartDnsPolicy } from "../src/smart-dns-policy.js";
import type { SmartEdgeConfig } from "../src/smart-edge-config.js";
import type { ServiceCatalog, ServiceTargetCapability } from "../src/service-catalog.js";
import type { VpnTestEndpointScore } from "../src/vpn-test-telemetry.js";

// ─── Fixtures ──────────────────────────────────────────────────────

const baseUser: UserSummary = {
  account_id: "acc-1",
  login: "johndoe",
  display_name: "John Doe",
  enabled: true,
  client_id: "client-1",
  xray_uuid: "uuid-1",
  client_enabled: true,
  token: "tok-abc",
  profiles: ["de-httpupgrade", "ru-smart-relay"],
  device_count: 2,
  happ_status: 10,
  smart_dns_client_id: "sdc-123",
  smart_dns_enabled: true,
};

const baseEndpoints: Endpoint[] = [
  {
    id: "de-httpupgrade",
    label: "DE-HTTPUpgrade",
    kind: "vless-httpupgrade",
    address: "vpn2.bezrabotnyi.com",
    port: 443,
    profile_id: "de-httpupgrade",
    enabled: true,
    sort_order: 0,
    config: { query: { security: "tls", type: "httpupgrade", path: "/hup", host: "vpn2.bezrabotnyi.com", sni: "vpn2.bezrabotnyi.com", fp: "chrome" } },
  },
  {
    id: "ru-smart-relay",
    label: "RU-smart-relay",
    kind: "vless-reality",
    address: "runet.bezrabotnyi.com",
    port: 23445,
    profile_id: "ru-smart-relay",
    enabled: true,
    sort_order: 1,
    config: { public_key: "ru-pbk", short_id: "ru-sid" },
  },
];

const baseHealth: EndpointHealth[] = [
  {
    endpoint_id: "de-httpupgrade",
    latency_ms: 45,
    speed_mbps: 100,
    exit_ip: "212.192.31.128",
    pass_count: 5,
    fail_count: 0,
    sites: [{ label: "Telegram", code: "200", ms: 300, ok: true }],
    checked_at: new Date().toISOString(),
  },
  {
    endpoint_id: "ru-smart-relay",
    latency_ms: null,
    speed_mbps: null,
    exit_ip: null,
    pass_count: 0,
    fail_count: 3,
    sites: [],
    checked_at: new Date().toISOString(),
  },
];

test("stale endpoint health is not rendered as working", async () => {
  const { adminPage } = await import("../src/pages.js");
  const stale = [{ ...baseHealth[0]!, checked_at: new Date(Date.now() - 3 * 60 * 60 * 1000).toISOString() }];
  const html = adminPage({ users: [], endpoints: baseEndpoints, health: stale, baseUrl: "https://vpn.bezrabotnyi.com", totalDevices: 0 });

  assert.match(html, /no check/);
  assert.doesNotMatch(html, /works/);
});

const baseSlots: LinkSlot[] = [
  { id: "de-httpupgrade", label: "DE-HTTPUpgrade", available: true, url: "vless://test@vpn2:443", reason: null },
  { id: "ru-smart-relay", label: "RU-smart-relay", available: false, url: null, reason: "not configured" },
];

const secure: SecureConfig = {
  defaults: { fingerprint: "firefox", flow: "xtls-rprx-vision", sni: "ya.ru", domain_strategy: "IPIfNonMatch" },
  nodes: [],
  server_configs: {},
  happ: { provider_code: "TestProvider", auth_key: "key", base_url: "https://happ-proxy.com" },
};

const basePolicy: SmartDnsPolicy = {
  defaultRoute: "proxy",
  localDefaultRoute: "direct",
  directSuffixes: ["ru", "su"],
  directDomains: ["ya.ru"],
  proxySuffixes: ["telegram.org"],
  proxyDomains: ["api.telegram.org"],
  localProxySuffixes: ["instagram.com", "cdninstagram.com"],
  localProxyDomains: ["i.instagram.com"],
  updatedAt: "2024-01-01T00:00:00Z",
};

test("public install page documents Windows and macOS install and update commands", async () => {
  const { installPage } = await import("../src/pages.js");
  const html = installPage("https://vpn.bezrabotnyi.com/");

  assert.match(html, /Bez VPN: установка и обновление/);
  assert.match(html, /\/install\/bez-windows/);
  assert.match(html, /\/install\/macos\.sh\?token=/);
  assert.match(html, /bez update/);
  assert.match(html, /bez smart/);
  assert.match(html, /block → direct → proxy/);
  assert.match(html, /copyInstallCommand/);
  assert.match(html, /Скопировать команду/);
});

test("public landing page leads a user to installation without exposing admin", async () => {
  const { landingPage } = await import("../src/pages.js");
  const html = landingPage("https://vpn.bezrabotnyi.com/");
  assert.match(html, /Интернет работает как обычно/);
  assert.match(html, /href="\/install"/);
  assert.match(html, /block → direct → proxy/);
  assert.match(html, /Telegram · WhatsApp · OpenAI/);
});

// ─── adminPage ─────────────────────────────────────────────────────

test("adminPage renders user list and stats", async () => {
  const { adminPage } = await import("../src/pages.js");
  const html = adminPage({
    users: [baseUser],
    endpoints: baseEndpoints,
    health: baseHealth,
    baseUrl: "https://vpn.bezrabotnyi.com",
    totalDevices: 5,
  });

  assert.ok(html.includes("VPN Admin"));
  assert.ok(html.includes("John Doe"));
  assert.ok(html.includes("@johndoe"));
  assert.ok(html.includes("Users"));
  assert.ok(html.includes("Endpoints"));
  assert.ok(html.includes("Health"));
  assert.ok(html.includes("Devices"));
  assert.ok(html.includes("5"));
  assert.ok(html.includes("/install/macos.sh?token=tok-abc"));
  assert.ok(html.includes(">Mac</button>"));
});

test("adminPage renders empty state when no users", async () => {
  const { adminPage } = await import("../src/pages.js");
  const html = adminPage({
    users: [],
    endpoints: baseEndpoints,
    health: [],
    baseUrl: "https://vpn.bezrabotnyi.com",
    totalDevices: 0,
  });

  assert.ok(html.includes("No users yet"));
  assert.ok(html.includes("0"));
});

test("adminPage renders multiple users with correct statuses", async () => {
  const { adminPage } = await import("../src/pages.js");
  const disabledUser: UserSummary = { ...baseUser, account_id: "acc-2", login: "disabled", display_name: "Disabled User", enabled: false, client_enabled: false, happ_status: null, device_count: 0 };
  const html = adminPage({
    users: [baseUser, disabledUser],
    endpoints: baseEndpoints,
    health: baseHealth,
    baseUrl: "https://vpn.bezrabotnyi.com",
    totalDevices: 3,
  });

  assert.ok(html.includes("Active"));
  assert.ok(html.includes("Disabled"));
  assert.ok(html.includes("Disabled User"));
  assert.ok(html.includes("Happ"));
});

test("adminPage renders health grid with endpoint data", async () => {
  const { adminPage } = await import("../src/pages.js");
  const html = adminPage({
    users: [],
    endpoints: baseEndpoints,
    health: baseHealth,
    baseUrl: "https://vpn.bezrabotnyi.com",
    totalDevices: 0,
  });

  assert.ok(html.includes("Endpoint Health"));
  assert.ok(html.includes("DE-HTTPUpgrade"));
  assert.ok(html.includes("RU-smart-relay"));
  assert.ok(html.includes("45ms"));
});

test("adminPage separates relay products from diagnostic transports", async () => {
  const { adminPage } = await import("../src/pages.js");
  const product: Endpoint = {
    ...baseEndpoints[1],
    id: "smart-de-relay",
    label: "Smart DE",
    profile_id: "smart-de-relay",
  };
  const html = adminPage({
    users: [baseUser],
    endpoints: [product, baseEndpoints[0]],
    health: [],
    baseUrl: "https://vpn.bezrabotnyi.com",
    totalDevices: 0,
  });

  assert.ok(html.includes("Smart DE"));
  assert.ok(html.includes("Diagnostic transports (1)"));
  assert.ok(html.includes("Deprecated gRPC/HTTPUpgrade and duplicate WS paths are not user products."));
});

test("adminPage renders with user subscription and QR buttons", async () => {
  const { adminPage } = await import("../src/pages.js");
  const html = adminPage({
    users: [baseUser],
    endpoints: baseEndpoints,
    health: [],
    baseUrl: "https://vpn.bezrabotnyi.com",
    totalDevices: 0,
  });

  assert.ok(html.includes("Sub"));
  assert.ok(html.includes("QR"));
  assert.ok(html.includes("Edit"));
});

test("sidebar keeps endpoint navigation inside the unified test center", async () => {
  const { sidebarHtml } = await import("../src/html.js");
  const html = sidebarHtml("/admin/tests");

  assert.ok(html.includes('href="/admin/tests#current-endpoints"'));
  assert.ok(html.includes('href="/install"'));
  assert.ok(!html.includes('href="/admin/xray-policy"'));
  assert.ok(html.includes("Скачать Bez"));
});

test("Xray policy page points clients to the unified rules editor", async () => {
  const { xrayPolicyPage } = await import("../src/pages.js");
  const html = xrayPolicyPage({ policy: basePolicy });

  assert.ok(html.includes("Xray-политика клиентов"));
  assert.ok(html.includes('/admin/smart-dns'));
  assert.ok(html.includes("rules"));
});

test("admin pages share the persistent sidebar shell", async () => {
  const { adminLayout } = await import("../src/html.js");
  const html = adminLayout("/admin/smart-dns", "<section>content</section>");

  assert.match(html, /id="admin-layout"/);
  assert.match(html, /href="\/admin\/vps"/);
  assert.match(html, /href="\/admin\/smart-dns" class="sidebar-link active"/);
  assert.match(html, /aria-label="Показать или скрыть меню"/);
  assert.match(html, /sidebar-collapsed/);
});

test("adminPage renders device count and smart DNS tags", async () => {
  const { adminPage } = await import("../src/pages.js");
  const html = adminPage({
    users: [baseUser],
    endpoints: baseEndpoints,
    health: [],
    baseUrl: "https://vpn.bezrabotnyi.com",
    totalDevices: 2,
  });

  assert.ok(html.includes("2 devices"));
  assert.ok(html.includes("DNS"));
});

// ─── userDetailPage ────────────────────────────────────────────────

test("userDetailPage renders user info and link slots", async () => {
  const { userDetailPage } = await import("../src/pages.js");
  const html = userDetailPage({
    user: baseUser,
    endpoints: baseEndpoints,
    health: baseHealth,
    slots: baseSlots,
    happInstall: null,
    hwids: [],
    smartDnsClient: null,
    baseUrl: "https://vpn.bezrabotnyi.com",
    secure,
  });

  assert.ok(html.includes("John Doe"));
  assert.ok(html.includes("DE-HTTPUpgrade"));
  assert.ok(html.includes("Available"));
  assert.ok(html.includes("not configured"));
  assert.ok(html.includes("/sub/tok-abc/qr"));
  assert.ok(html.includes("QR подписки"));
  assert.ok(html.includes("/install/macos.sh?token=tok-abc"));
  assert.ok(html.includes("Copy macOS command"));
  assert.ok(html.includes('id="admin-layout"'));
  assert.ok(html.includes('href="/admin/vps"'));
});

test("userDetailPage renders happ install section when linked", async () => {
  const { userDetailPage } = await import("../src/pages.js");
  const happInstall: HappInstallRecord = {
    account_id: "acc-1",
    install_code: "ABC123",
    install_id: 1,
    install_limit: 10,
    status: 10,
    note: null,
    happ_settings: {},
    created_at: "2024-01-01",
    updated_at: "2024-01-01",
  };
  const html = userDetailPage({
    user: baseUser,
    endpoints: baseEndpoints,
    health: [],
    slots: baseSlots,
    happInstall,
    hwids: [],
    smartDnsClient: null,
    baseUrl: "https://vpn.bezrabotnyi.com",
    secure,
  });

  assert.ok(html.includes("ABC123"));
  assert.ok(html.includes("Linked"));
  assert.ok(html.includes("Happ Integration"));
});

test("userDetailPage renders HWIDs with device info", async () => {
  const { userDetailPage } = await import("../src/pages.js");
  const happInstall: HappInstallRecord = {
    account_id: "acc-1",
    install_code: "ABC123",
    install_id: 1,
    install_limit: 10,
    status: 10,
    note: null,
    happ_settings: {},
    created_at: "2024-01-01",
    updated_at: "2024-01-01",
  };
  const hwids: HappHwidRecord[] = [{
    id: "hwid-1",
    account_id: "acc-1",
    install_code: "ABC123",
    hwid: "deadbeef1234",
    device_name: "Pixel 7",
    device_model: "Pixel 7 Pro",
    os_version: "Android 14",
    app_version: "1.2.3",
    recorded_at: "2024-01-01",
    last_seen_at: new Date().toISOString(),
  }];
  const html = userDetailPage({
    user: baseUser,
    endpoints: baseEndpoints,
    health: [],
    slots: baseSlots,
    happInstall,
    hwids,
    smartDnsClient: null,
    baseUrl: "https://vpn.bezrabotnyi.com",
    secure,
  });

  assert.ok(html.includes("deadbeef1234"));
  assert.ok(html.includes("Pixel 7"));
  assert.ok(html.includes("Online today"));
});

test("userDetailPage renders Smart DNS section", async () => {
  const { userDetailPage } = await import("../src/pages.js");
  const smartDnsClient: SmartDnsClient = {
    account_id: "acc-1",
    client_id: "abc123def456",
    enabled: true,
    created_at: "2024-01-01",
    updated_at: "2024-01-01",
  };
  const html = userDetailPage({
    user: baseUser,
    endpoints: baseEndpoints,
    health: [],
    slots: baseSlots,
    happInstall: null,
    hwids: [],
    smartDnsClient,
    baseUrl: "https://vpn.bezrabotnyi.com",
    secure,
  });

  assert.ok(html.includes("Smart DNS"));
  assert.ok(html.includes("abc123def456"));
  assert.ok(html.includes("Enabled"));
  assert.ok(html.includes("dns.bezrabotnyi.com"));
});

// ─── accountPage ───────────────────────────────────────────────────

test("accountPage renders subscription URL and link slots", async () => {
  const { accountPage } = await import("../src/pages.js");
  const html = accountPage({
    displayName: "John Doe",
    subUrl: "https://vpn.bezrabotnyi.com/sub/tok-abc/plain",
    slots: baseSlots,
    token: "tok-abc",
  });

  assert.ok(html.includes("John Doe"));
  assert.ok(html.includes("Subscription URL"));
  assert.ok(html.includes("tok-abc"));
  assert.ok(html.includes("Happ deeplink"));
  assert.ok(html.includes("QR Code"));
  assert.ok(html.includes("DE-HTTPUpgrade"));
});

test("accountPage renders without token (no QR button)", async () => {
  const { accountPage } = await import("../src/pages.js");
  const html = accountPage({
    displayName: "Jane Doe",
    subUrl: "https://vpn.bezrabotnyi.com/sub/tok/plain",
    slots: [],
  });

  assert.ok(html.includes("Jane Doe"));
  assert.ok(!html.includes("QR Code"));
});

test("accountPage renders Smart DNS section when client present", async () => {
  const { accountPage } = await import("../src/pages.js");
  const smartDnsClient: SmartDnsClient = {
    account_id: "acc-1",
    client_id: "dns-client-id",
    enabled: true,
    created_at: "2024-01-01",
    updated_at: "2024-01-01",
  };
  const html = accountPage({
    displayName: "John Doe",
    subUrl: "https://vpn.bezrabotnyi.com/sub/tok/plain",
    slots: baseSlots,
    token: "tok",
    smartDnsClient,
    smartDnsMobileconfigUrl: "https://dns.bezrabotnyi.com/profile/dns-client-id.mobileconfig",
  });

  assert.ok(html.includes("Smart DNS"));
  assert.ok(html.includes("dns-client-id"));
  assert.ok(html.includes("mobileconfig"));
});

test("accountPage renders slot unavailability reasons", async () => {
  const { accountPage } = await import("../src/pages.js");
  const slots: LinkSlot[] = [
    { id: "de-cdn", label: "DE-CDN", available: false, url: null, reason: "disabled" },
    { id: "de-xhttp", label: "DE-XHTTP", available: true, url: "vless://x@host:443", reason: null },
  ];
  const html = accountPage({
    displayName: "Test",
    subUrl: "https://vpn.bezrabotnyi.com/sub/tok/plain",
    slots,
  });

  assert.ok(html.includes("disabled"));
  assert.ok(html.includes("Available"));
  assert.ok(html.includes("1 of 2"));
});

// ─── smartDnsPage ──────────────────────────────────────────────────

test("smartDnsPage renders the unified rules editor", async () => {
  const { smartDnsPage } = await import("../src/pages.js");
  const html = smartDnsPage({ policy: basePolicy });

  assert.ok(html.includes("Smart DNS"));
  assert.ok(html.includes("routing-rules-form"));
  assert.ok(html.includes("через что"));
  assert.ok(html.includes("geoip:ru"));
  assert.ok(html.includes("telegram.org"));
  assert.ok(html.includes("instagram.com"));
  assert.ok(html.includes("SNI/DPI"));
  assert.ok(html.includes("Маршрутизация Smart DNS"));
  assert.ok(html.includes("function quickVpnRoute(mode)"));
  assert.ok(html.includes("/api/admin/smart-dns/quick-vpn-route"));
  assert.ok(html.includes(">Администрирование<"));
  assert.ok(html.includes('id="admin-layout"'));
  assert.ok(html.includes('href="/admin/tests"'));
  assert.ok(html.includes(">Выйти<"));
  assert.ok(html.includes("Сохранить rules"));
  assert.equal(html.includes(">Save policy<"), false);
});

test("smartDnsPage documents exact, suffix and set matching", async () => {
  const { smartDnsPage } = await import("../src/pages.js");
  const html = smartDnsPage({ policy: basePolicy });

  assert.ok(html.includes("Каждая строка — одна сущность"));
  assert.ok(html.includes("Direct нельзя выбрать вместе с VPN"));
});

test("smartDnsPage renders route check result", async () => {
  const { smartDnsPage } = await import("../src/pages.js");
  const html = smartDnsPage({
    policy: basePolicy,
    check: { input: "telegram.org", host: "telegram.org", route: "proxy", localRoute: "proxy", publicRoute: "proxy", reason: "proxySuffixes match", matched: "telegram.org", vpnRoute: "direct", vpnMatched: "telegram.org", dimensions: { internalDns: "proxy", externalDns: "proxy", lan: "proxy", vpn: "direct" } },
  });

  assert.ok(html.includes("PROXY"));
  assert.ok(html.includes("telegram.org"));
  assert.ok(html.includes("proxySuffixes match"));
  assert.ok(html.includes("Добавить SmartDNS-обход"));
  assert.ok(html.includes("Добавить VPN-обход (DPI)"));
  assert.ok(html.includes("quickVpnRoute('smart-dns')"));
  assert.ok(html.includes("quickVpnRoute('vpn')"));
  assert.ok(html.includes("quickVpnRoute('direct')"));
  assert.ok(html.includes("LAN + VPN, без external DNS"));
});

test("smartDnsPage route verdict reports the actual LAN and Public routes", async () => {
  const { smartDnsPage } = await import("../src/pages.js");
  const html = smartDnsPage({
    policy: basePolicy,
    check: { input: "unknown.example", host: "unknown.example", route: "proxy", localRoute: "direct", publicRoute: "proxy", reason: "default route", matched: null },
  });

  assert.ok(html.includes("LAN — direct; Публичный SmartDNS — proxy."));
  assert.equal(html.includes("И LAN, и публичный SmartDNS выбирают proxy-маршрут для этого домена."), false);
});

test("smartDnsPage explains local-only route behavior", async () => {
  const { smartDnsPage } = await import("../src/pages.js");
  const html = smartDnsPage({
    policy: basePolicy,
    check: {
      input: "instagram.com",
      host: "instagram.com",
      route: "local-proxy",
      localRoute: "proxy",
      publicRoute: "direct",
      reason: "localProxySuffixes match",
      matched: "instagram.com",
    },
  });

  assert.ok(html.includes("LOCAL-PROXY"));
  assert.ok(html.includes("LAN"));
  assert.ok(html.includes("PUBLIC"));
  assert.ok(html.includes("instagram.com"));
});

test("smartDnsPage renders error and edge messages", async () => {
  const { smartDnsPage } = await import("../src/pages.js");
  const html = smartDnsPage({
    policy: basePolicy,
    error: "Something went wrong",
    edgeMessage: "Edge deployed",
    edgeError: "Edge failed",
  });

  assert.ok(html.includes("Something went wrong"));
  assert.ok(html.includes("Edge deployed"));
  assert.ok(html.includes("Edge failed"));
});

test("smartDnsPage renders smart edge targets", async () => {
  const { smartDnsPage } = await import("../src/pages.js");
  const smartEdge: SmartEdgeConfig = {
    targets: [
      {
        id: "vusa",
        label: "vusa / US edge",
        sshHost: "vusa.bezrabotnyi.com",
        sshUser: "root",
        sshPort: 22,
        publicIp: "185.240.120.152",
        streamConfigPath: "/etc/nginx/stream-smart-edge.conf",
        ownSni: ["vusa.bezrabotnyi.com"],
        ownBackend: "127.0.0.1:8444",
        edgeBackend: "127.0.0.1:9443",
        specialRoutes: [
          { sni: ".t.gptadmin.bezrabotnyi.com", backend: "127.0.0.1:8446" },
          { sni: "www.google.com", backend: "127.0.0.1:23443" },
          { sni: "google.com", backend: "127.0.0.1:23443" },
        ],
      },
      {
        id: "vpn2",
        label: "vpn2 / DE edge",
        sshHost: "vpn2.bezrabotnyi.com",
        sshUser: "root",
        sshPort: 22,
        publicIp: "212.192.31.128",
        streamConfigPath: "/etc/nginx/stream-smart-edge.conf",
        ownSni: ["vpn2.bezrabotnyi.com"],
        ownBackend: "127.0.0.1:8444",
        edgeBackend: "127.0.0.1:9443",
        specialRoutes: [],
      },
    ],
    state: { activeEdgeId: "vusa" },
    targetsPath: "/data/targets.json",
    statePath: "/data/state.json",
  };
  const html = smartDnsPage({ policy: basePolicy, smartEdge });

  assert.ok(html.includes("Smart Edge VPS deploy"));
  assert.ok(html.includes("vusa"));
  assert.ok(html.includes("185.240.120.152"));
  assert.ok(html.includes("PRIMARY"));
  assert.ok(html.includes('disabled aria-disabled="true">Already primary</button>'));
  assert.ok(html.includes("Set primary DNS edge"));
  assert.equal((html.match(/action="\/api\/admin\/smart-edge\/select-primary"/g) ?? []).length, 1);
  assert.ok(html.includes(".btn:disabled"));
});

test("smartDnsPage renders a clearly non-active service catalog draft editor", async () => {
  const { smartDnsPage } = await import("../src/pages.js");
  const catalog: ServiceCatalog = {
    schemaVersion: 2,
    updatedAt: "2024-01-01T00:00:00Z",
    description: "draft",
    services: [{
      id: "telegram",
      label: "Telegram",
      enabled: true,
      domains: [{ match: "suffix", value: "telegram.org" }],
      workIn: "both",
      routeTo: { kind: "vps-pool", allowedVpsIds: ["vpn2"], onNoHealthyTarget: "servfail" },
    }],
  };
  const targets: ServiceTargetCapability[] = [{ id: "vpn2", publicDnsEdge: true, lanEgress: true, lanBalancerTag: "proxy" }];
  const html = smartDnsPage({ policy: basePolicy, serviceCatalog: { catalog, targets } });
  assert.match(html, /Маршруты сервисов \(черновик\)/);
  assert.match(html, /не активно/);
  assert.match(html, /Сохранённые изменения остаются только черновиками и не включают DNS\/Xray до отдельного шага «Применить»/);
  assert.match(html, /action="\/api\/admin\/service-catalog"/);
  assert.match(html, /name="workInLan"/);
  assert.match(html, /telegram\.org/);
});

// ─── testsPage ─────────────────────────────────────────────────────

test("testsPage renders one workspace with current state and probe controls", async () => {
  const { testsPage } = await import("../src/pages.js");
  const html = testsPage({
    endpoints: baseEndpoints,
    health: baseHealth,
  });

  assert.ok(html.includes("VPN Test Center"));
  assert.ok(html.includes("Центр тестирования"));
  assert.ok(html.includes('id="admin-layout"'));
  assert.ok(html.includes("Endpoint Health"));
  assert.ok(html.includes("История запусков"));
  assert.ok(html.includes("Запустить probe"));
});

test("testsPage legacy telemetry renderer renders camelCase latencyMs", async () => {
  const source = await readFile(new URL("../src/pages.ts", import.meta.url), "utf8");
  const rendererStart = source.indexOf("function renderVpnTestStages(stages)");
  const rendererEnd = source.indexOf("function renderAllProbeResults", rendererStart);
  assert.ok(rendererStart >= 0 && rendererEnd > rendererStart);
  assert.match(source.slice(rendererStart, rendererEnd), /stage\.latency_ms \?\? stage\.latencyMs \?\? payload\.latency_ms \?\? payload\.latencyMs/);
});

test("testsPage renders health grid from input", async () => {
  const { testsPage } = await import("../src/pages.js");
  const html = testsPage({
    endpoints: baseEndpoints,
    health: baseHealth,
  });

  assert.ok(html.includes("DE-HTTPUpgrade"));
  assert.ok(html.includes("RU-smart-relay"));
});

test("testsPage renders the three-day endpoint score panel in best-first order", async () => {
  const { testsPage } = await import("../src/pages.js");
  const scores: VpnTestEndpointScore[] = [
    {
      endpointId: "de-xhttp-h2",
      score: 96.6,
      passed: 114,
      effectiveObservations: 118,
      endpointFailures: 4,
      runnerErrors: 0,
      telegramMedianMs: 364,
      telegramP95Ms: 2875,
    },
    {
      endpointId: "de-direct",
      score: 0,
      passed: 0,
      effectiveObservations: 116,
      endpointFailures: 116,
      runnerErrors: 122,
      telegramMedianMs: 11008,
      telegramP95Ms: 11022,
    },
    {
      endpointId: "de-cdn",
      score: 96.6,
      passed: 114,
      effectiveObservations: 118,
      endpointFailures: 4,
      runnerErrors: 0,
      telegramMedianMs: 446,
      telegramP95Ms: 3098,
    },
  ];
  const html = testsPage({ endpoints: baseEndpoints, health: baseHealth, scores });

  assert.match(html, /Score за 3 дня/);
  assert.match(html, /endpoint-detail-card/);
  assert.match(html, /openEndpointDetail/);
  assert.ok(html.indexOf("de-xhttp-h2") < html.indexOf("de-direct"));
  assert.ok(html.indexOf("de-xhttp-h2") < html.indexOf("de-cdn"));
  assert.match(html, /122 runner/);
  assert.match(html, /не выдаётся пользователям/i);
});

# Service routing catalog implementation plan

> **For the implementer:** follow TDD for every task: first add the stated
> failing regression test, run it and observe its intended failure, then write
> the smallest implementation that makes it pass. Do not deploy DNS, Xray, or
> SmartDNS changes until all listed tests and the source-of-truth checks pass.

**Goal:** replace the flat SmartDNS domain lists with first-class services. A
service owns named domain rules, its execution scope, and an independent route
destination. A VPS pool is data-driven from configured targets, so it can hold
one VPS or many without encoding `vpn2` and `vusa` in a route enum.

**Non-goal:** DNS alone cannot prove or choose the globally fastest TCP/TLS
path for every client. The LAN Xray selector can use its existing `leastPing`
balancers. A public pool must initially choose a healthy, deterministic edge
from actual probe evidence; a latency controller is a later, separately tested
component and must never silently change policy from unverified probes.

## Target model

```ts
type DomainMatch = "suffix" | "exact";
type WorkIn = "lan-only" | "external" | "both";
type RouteTo =
  | { kind: "direct" }
  | {
      kind: "vps-pool";
      allowedVpsIds: string[];
      onNoHealthyTarget: "servfail" | "direct";
    };

interface ServiceDomainRule {
  match: DomainMatch;
  value: string;
}

interface ServiceDelivery {
  mode: DeliveryMode;
  selector: EdgeSelector;
}

interface ServiceDefinition {
  id: string;
  label: string;
  probeUrl: string;
  restriction: string;
  domains: ServiceDomainRule[];
  workIn: WorkIn;
  routeTo: RouteTo;
}
```

`direct` has no pool. `vps-pool` requires a non-empty, validated set of dynamic
VPS ids; a single pinned VPS is simply a pool of one. `workIn` controls where a
service is applied: `lan-only` compiles into the LAN DNS/Xray path and is never
advertised as a public DPI bypass; `external` compiles into public SmartDNS edge
selection; `both` applies the same service policy in both paths. The compiler
keeps scope, route target, and domain parsing separate. A pool defaults to
`servfail` when no candidate is healthy; direct fallback must be explicit.

## Compatibility mapping

Read catalog schema version 1 and compile it without changing live behavior:

| Existing route | `workIn` | `routeTo` |
| --- | --- | --- |
| `local-proxy` | `lan-only` | existing LAN pool |
| `proxy` | `both` | compatibility pool preserving existing public and LAN routes |
| `vusa-proxy` | `both` | `["vusa"]` |
| `monitor` | `lan-only` | `direct` |

The migration writes schema version 2 only after validating every generated
selector against `loadSmartEdgeConfig()`. It does not delete administrator
overrides until the v2 compiler has produced equivalent effective routes.

### Task 1: Service model, validation, and v1 migration

**Files:**
- Create: `src/service-catalog.ts`
- Create: `tests/service-catalog.test.ts`
- Modify: `vpn-testing/restricted-services.json`
- Modify: `src/restricted-services.ts`

**Interfaces:**
- Produces `loadServiceCatalog()`, `validateServiceCatalog()`,
  `compileLegacyRestrictedCatalog()`, and `ServiceDefinition`.
- Consumes the existing restricted-services schema only as a read-compatible
  v1 input; later tasks consume the v2 service catalog.

- [ ] Add failing tests for exact versus suffix matching, invalid selectors,
  duplicate domain-rule ownership, `both`, and every row of the compatibility
  table. Reject equal-priority conflicting rules; otherwise resolve exact
  before the longest suffix.
- [ ] Run `npx tsx --test tests/service-catalog.test.ts`; confirm v2 helpers
  are absent or legacy fixtures cannot validate.
- [ ] Implement strict v2 parsing and v1-to-v2 compilation. Normalize domain
  values once and report the service id in every validation error.
- [ ] Convert the reviewed services (Telegram, Discord, WhatsApp, Facebook,
  Instagram, YouTube, X, ChatGPT/OpenAI, Antigravity, Copilot, and the existing
  catalog) to v2 rules. Use suffix rules unless an existing route deliberately
  needs one host only.
- [ ] Re-run the focused test and commit only catalog/model files.

### Task 2: Compile services into effective DNS and LAN routes

**Files:**
- Modify: `src/smart-dns-policy.ts`
- Modify: `src/openwrt-smart-dns.ts`
- Modify: `src/lan-us-config.ts`
- Modify: `src/cli/_gen-server88-config.ts`
- Modify: `tests/smart-dns-policy.test.ts`
- Modify: `tests/openwrt-smart-dns.test.ts`
- Modify: `tests/lan-us-config.test.ts`

**Interfaces:**
- Consumes `ServiceDefinition[]` plus `SmartEdgeConfig.targets` and target
  capabilities (`publicDnsEdge`, `lanEgress`, `lanBalancerTag`).
- Produces `compileServiceRoutes()` with `workIn`, resolved `routeTo`, matched
  service/rule, and generated Xray domain rules.

- [ ] Add failing tests proving a suffix matches the root and subdomains, an
  exact rule does not match a subdomain, `vusa` is selected by id rather than
  an enum, a single-VPS pool works, and an allowed pool is validated against
  dynamic VPS IDs.
- [ ] Validate that every public scope target supports public DNS and every LAN
  scope target supports LAN egress. Do not generate a partial route for an
  unsupported target.
- [ ] Add a failing test that replaces hard-coded
  `ANTIGRAVITY_VUSA_DOMAINS` with a generated service rule targeting `us-auto`.
- [ ] Implement the compiler and make `checkSmartDnsRoute()` expose service id,
  rule kind, LAN decision, public decision, selector kind, and candidate edge
  IDs.
- [ ] Generate OpenWrt address rules only from effective LAN smart-edge routes;
  preserve direct and exact-domain precedence.
- [ ] Generate Xray domain rules from LAN service selectors before the generic
  LAN rule. Keep `leastPing` inside the chosen balancer; do not fake a
  fastest-VPS choice in DNS.
- [ ] Run all three focused test files and `npm run validate:xray`.

### Task 3: Dynamic public SmartDNS profiles and safe pool choice

**Files:**
- Modify: `scripts/smartdns-go/main.go`
- Modify: `scripts/smartdns-go/main_test.go`
- Modify: `scripts/deploy-smartdns-unified.sh`
- Modify: `src/server.ts`
- Modify: `tests/restricted-services.test.ts`

**Interfaces:**
- SmartDNS receives compiled external-service pools and edge profiles keyed by
  dynamic Smart Edge target id.
- `/api/internal/smart-dns/clients` returns the compiled policy, not the
  deprecated flat `vusaProxy*` fields.

- [ ] Add Go tests for direct and VPS-pool selectors. A pool with no healthy
  edge returns `SERVFAIL` by default and may return direct only when the
  service explicitly chooses that fallback; never choose an arbitrary IP.
- [ ] Add TypeScript contract tests for the internal sync payload and ensure
  no service selector references an absent target.
- [ ] Implement profile lookup by selector. `active` uses Smart Edge state;
  `pinned` uses one target; `pool` chooses from the health-ranked allowed list
  with a stable fallback. Log the selected profile id for diagnostics.
- [ ] Replace jq's `vusaProxySuffixes` mutation with generation from the
  compiled service catalog.
- [ ] Run `go test ./...`, focused TypeScript contracts, then the full
  `npm run build && npm test` suite.

### Task 4: Service-centric admin editor and presets

**Files:**
- Modify: `src/pages.ts`
- Modify: `src/server.ts`
- Modify: `tests/restricted-services-ui.test.ts`
- Create: `tests/service-catalog-ui.test.ts`

**Interfaces:**
- `GET /admin/smart-dns` renders services before raw advanced overrides.
- `POST /api/admin/smart-dns/services` validates and atomically saves the v2
  catalog; `POST /api/admin/smart-dns/services/:id` updates one service.

- [ ] Add rendering tests for a service card, rule rows with `suffix`/`exact`,
  `WorkIn` controls, dynamic VPS-pool options, and a no-JavaScript submit path.
- [ ] Add parser/handler tests for add, update, delete, and invalid target id.
- [ ] Replace the raw route-specific textareas with a service table. Each card
  shows its domains, `WorkIn`, `RouteTo`, resolved candidate VPS names, and a
  route-check link. Keep the global defaults under an “advanced” fold.
- [ ] Add preset buttons that create reviewed, initially disabled service
  definitions rather than duplicates: Telegram, Discord, WhatsApp,
  Facebook/Instagram, YouTube, X/Twitter, ChatGPT/OpenAI, Antigravity, and
  GitHub Copilot. Enabling is an explicit production policy change.
- [ ] Re-run browser verification: add an exact and a suffix rule, choose a
  VUSA pin and an allowed pool, submit, then verify the route-check verdicts.

### Task 5: Controlled migration and deployment

**Files:**
- Modify: `docs/15-smartdns.md`
- Modify: `docs/16-openwrt-dns-migration.md`
- Modify: `AGENTS.md` only if an operational contract genuinely changes

- [ ] Before live deployment, read the infrastructure source-of-truth contract
  and re-check `smart-dns.service`, OpenWrt dnsmasq, server-88 Xray, and the
  current deployed policy read-only.
- [ ] Stage generated configs, run `scripts/deploy-all.sh --dry-run router-dns`
  and the SmartDNS deploy dry run, review diffs, then deploy only the approved
  SmartDNS/router-DNS/server-88 scopes. Do not touch nginx, HAProxy, WAN :443,
  or unrelated firewall configuration.
- [ ] Verify LAN and public DNS for a direct service, a LAN-only service, an
  active/pinned service, and a pool service. Verify the panel check UI and
  service status display the selected target and its health evidence.
- [ ] Commit model/compiler, runtime, UI, and docs as separate logical commits;
  push each to `origin/main` and report the final SHA(s).

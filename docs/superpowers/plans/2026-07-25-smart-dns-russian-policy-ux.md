# Smart DNS Russian Policy UX Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make `.ua` an always-proxied system rule and explain Smart DNS routing clearly in Russian.

**Architecture:** Preserve the current four route classes. Normalize every policy to retain a protected `ua` proxy suffix and remove it from contradictory user-configurable route lists; the existing DNS and OpenWrt renderers then inherit the route without a new wire format. The editor presents route results as LAN and Public columns and documents literal suffix/exact matching.

**Tech Stack:** TypeScript ESM, Fastify templates, Node test runner, Go SmartDNS runtime.

## Global Constraints

- `ua`, `site.ua`, and `www.site.ua` route through proxy in both LAN and public profiles.
- `.ua` must not be overridden by direct, local-only, or VUSA entries.
- Do not claim DNS routing is a general external DPI bypass.

---

### Task 1: Protect `.ua` policy routing

**Files:**
- Modify: `src/smart-dns-policy.ts`
- Test: `tests/smart-dns-policy.test.ts`

**Interfaces:**
- Produces: normalized policies whose `proxySuffixes` contain `ua` and whose conflicting lists do not.

- [x] **Step 1:** Add failing assertions that `ua`, `site.ua`, and `www.site.ua` are proxy in both profiles despite conflicting direct entries.
- [x] **Step 2:** Run `npx tsx --test tests/smart-dns-policy.test.ts`; expect the direct conflict to win before implementation.
- [x] **Step 3:** Add a protected suffix constant and normalization that removes the protected suffix from direct, local-only, and VUSA lists while retaining it in proxy.
- [x] **Step 4:** Re-run the focused test; expect PASS.

### Task 2: Explain route classes in Russian

**Files:**
- Modify: `src/pages.ts`
- Test: `tests/pages-extended.test.ts`

**Interfaces:**
- Consumes: `SmartDnsRouteCheck.localRoute` and `publicRoute`.
- Produces: Russian labels and literal suffix/exact matching examples.

- [x] **Step 1:** Add failing markup assertions for the immutable `.ua` rule, suffix/exact examples, anti-DPI scope, and separate LAN/Public result wording.
- [x] **Step 2:** Run `npx tsx --test tests/pages-extended.test.ts`; expect missing text.
- [x] **Step 3:** Replace mixed-language labels with Russian route descriptions; add the matrix explanation and ensure split routes are not described as proxied in both profiles.
- [x] **Step 4:** Re-run the focused test; expect PASS.

### Task 3: Validate downstream rendering

**Files:**
- Test: `tests/openwrt-smart-dns.test.ts`, `scripts/smartdns-go/main_test.go`

- [x] **Step 1:** Add a `.ua` policy expectation to the existing downstream contract tests. Go, OpenWrt, and macOS consumer verification required tests only; no downstream production code changed.
- [x] **Step 2:** Run focused Node and Go tests; expect failure if the protected rule is absent downstream.
- [x] **Step 3:** Run `npm test`, `npm run build`, and the focused Go suite after green.

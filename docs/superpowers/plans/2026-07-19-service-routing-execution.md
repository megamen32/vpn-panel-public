# Service Routing Execution Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use subagent-driven-development or inline execution task-by-task. Steps use checkbox syntax for tracking.

**Goal:** Replace ad-hoc SmartDNS route lists with a service editor that lets an administrator choose direct routing or a capability-validated VPS pool, while keeping one canonical catalog.

**Architecture:** The v2 ServiceCatalog remains the durable product source. A compiler derives the effective SmartDNS policy, OpenWrt address rules, and server-88 Xray domain rules. The website edits the catalog atomically; raw policy defaults remain an advanced fallback, never a second per-service list.

**Tech Stack:** TypeScript ESM, Fastify, JSON catalog, Xray, OpenWrt dnsmasq, Node test runner.

## Global Constraints

- Preserve legacy restricted-services input during migration; do not maintain duplicate service domain lists.
- `direct` must bypass LAN address synthesis and VPS pools.
- A VPS pool uses dynamic target IDs and declared target capabilities; no hard-coded `vpn2`/`vusa` enum.
- A pool with no healthy supported target must fail closed unless direct fallback is explicitly chosen.
- No nginx, HAProxy, public :443, or WAN redirect changes.
- Every behavior change begins with a failing runtime-contract test.

---

- [ ] Roll back the Cloudflare challenge VUSA exception from source, runtime policy, generated server-88 config, and OpenWrt rules. Keep existing ChatGPT/OpenAI legacy VPN2 policy until the editor exposes an explicit direct choice.
- [ ] Compile enabled ServiceCatalog entries into effective SmartDNS/OpenWrt/Xray decisions, including exact-before-suffix precedence and `lan-only` / `external` / `both` scope.
- [ ] Add atomic catalog persistence and admin handlers for create, update, enable, and delete; reject unsupported or unknown pool targets before saving.
- [ ] Replace the read-only restricted-services section with service cards and presets. Each card exposes exact/suffix rules, WorkIn, and RouteTo (direct or selected VPS pool); keep advanced defaults folded.
- [ ] Deploy only the derived DNS/Xray changes after validation, then prove the UI verdict, DNS answer, and TLS route together.

# Public README Product Story Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make the public README explain the VPN Panel as a three-part product with router-wide VPN, access-controlled SmartDNS, adaptive endpoint monitoring, web-based VDS management, and a truthful low-resource router case study.

**Architecture:** Keep the change documentation-only in `README.md`, with one repository-local Mermaid diagram rendered by GitHub and no new runtime assets or secrets. Reconcile every claim with the existing README and project contracts, explicitly distinguishing DNS steering from DPI/SNI bypass and client-specific transport behavior.

**Tech Stack:** Markdown, Mermaid, existing TypeScript/Fastify VPN Panel terminology, existing SmartDNS/Xray/sing-box/endpoint-monitoring contracts.

## Global Constraints

- Modify only public documentation; do not change application, deployment, infrastructure, or credentials.
- Do not publish private IPs, hostnames, tokens, passwords, UUIDs, Reality keys, or internal admin details.
- Preserve the existing warning that public SmartDNS is not itself a DPI bypass; DPI-sensitive routes require the LAN/Xray path.
- Describe endpoint monitoring as adaptive evidence across clients and networks, not as a guarantee that every endpoint works everywhere.
- Use the supplied case-study figures exactly as an operator experience: 14 MB free RAM, about 16,000 active connections, router-wide automatic VPN, no observed performance loss.

---

### Task 1: Add the public product overview and architecture visual

**Files:**
- Modify: `README.md` near the title and before `## Runtime`

**Interfaces:**
- Consumes: Existing SmartDNS, Xray, sing-box, client-profile, endpoint-health, and VDS-management terminology already documented in this repository.
- Produces: A public-facing overview that identifies the three product areas and includes a Mermaid flow diagram.

- [ ] **Step 1: Add a short positioning paragraph** explaining that the repository combines (1) VPN/SmartRelay access, (2) SmartDNS/router-wide traffic steering, and (3) a web control plane for clients, endpoints, and remote VDS nodes.
- [ ] **Step 2: Add a Mermaid diagram** showing clients and routers feeding DNS/routing policy, endpoint selection/monitoring, and the web panel/VDS control plane, while keeping internal addresses and credentials out.
- [ ] **Step 3: Keep the wording public-safe** by describing roles and protocols rather than deployment hostnames, ports, or secrets.

### Task 2: Explain routing, DPI limits, and endpoint reality

**Files:**
- Modify: `README.md` in `## Features` and `## Restricted-service policy and evidence`

**Interfaces:**
- Consumes: Existing `local-proxy`, `proxy`, `vusa-proxy`, and `monitor` policy classes; public SmartDNS limitation; per-client endpoint assignment; hourly endpoint health check.
- Produces: A concise explanation of DNS routing, VPN routing, client-specific access, and why wired/4G and sing-box/Xray results can differ.

- [ ] **Step 1: Add a router-wide SmartDNS paragraph** stating that a compatible router can give all LAN devices automatic VPN behavior without per-device setup, with direct/proxy decisions made by policy.
- [ ] **Step 2: Add the DPI boundary** stating that DNS steering does not hide TLS SNI and that DPI-sensitive destinations need the LAN/Xray edge or an appropriate VPN transport; do not advertise public SmartDNS as a universal bypass.
- [ ] **Step 3: Add monitoring language** explaining that endpoint status is continuously/periodically checked and broken endpoints can be removed from ordinary client assignments, while privileged/test profiles can retain the full catalog.
- [ ] **Step 4: Add the network/client variability explanation**: transport success depends on ISP/network conditions and client engine behavior; a transport that works on wired access may fail on 4G, and a sing-box result does not prove the same Xray behavior.

### Task 3: Add web-based VDS management and operator case study

**Files:**
- Modify: `README.md` in `## Features` before `## Subscription Endpoints`

**Interfaces:**
- Consumes: Existing admin panel and `/api/admin/xray-config/:serverId` descriptions, plus the supplied router case study.
- Produces: Clear public copy for web management and a concrete, bounded case study.

- [ ] **Step 1: Add a VDS-management paragraph** explaining that remote VPN nodes are managed from the web panel with per-node configuration, endpoint assignment, checks, and deployment workflows instead of ad-hoc SSH command sequences.
- [ ] **Step 2: Add a case-study block** with the exact constraints and observed outcome: approximately 14 MB free router RAM, approximately 16,000 active connections, automatic VPN for all devices, and no observed performance loss.
- [ ] **Step 3: Qualify the case study** as a real deployment example rather than a universal benchmark or promise.

### Task 4: Review the public README and verify the documentation change

**Files:**
- Modify: `README.md` only if review finds an inconsistency

- [ ] **Step 1: Search the final README** for secrets, private addresses, credentials, and claims stronger than the existing runtime contracts.
- [ ] **Step 2: Check Markdown structure** and ensure Mermaid syntax is fenced as `mermaid`.
- [ ] **Step 3: Run the repository's documentation-safe focused checks** available without changing runtime state, then inspect `git diff --check` and the final diff.

**Expected verification:** `git diff --check` succeeds; no source, deployment, or credential files change; README includes the three-product overview, diagram, DPI caveat, adaptive monitoring explanation, web VDS management, and the router case study.

# Unified client routing and install guide

Status: in progress — unified rule-schema implementation started 2026-08-19

Outcome: Windows, macOS, and the hub use one understandable routing policy:
default direct; explicit block, direct, and proxy rules; an unauthenticated
public install/update guide exists for both desktop clients.

Shortest business canary: install page renders publicly; each client receives
the same central policy; a named Telegram, WhatsApp, OpenAI, Grok, and Facebook
host resolves to proxy while an unrelated control domain is direct.

Work slices:

1. Completed — identify divergence: separate Windows/Mac installers share Xray
   configuration but not policy controls; public SmartDNS defaults conflict with
   the desired direct-first behaviour.
2. Completed — add the shared TypeScript desktop policy projection
   (`block/direct/proxy`, exact-domain handling and direct default) and make the
   shared Xray subscription consume it. Focused client policy, Mac, Windows and
   subscription tests pass (57), as does the TypeScript build.
3. Completed — move both installers to neutral shared client endpoints
   (`/api/user/client-xray-config` and `/api/user/client-policy`); old macOS
   endpoint names remain aliases for already-installed clients. The expanded
   focused suite passes (59) and the build passes.
4. Completed — add a public product landing page at `/` and an `/install` guide
   with copyable Windows/macOS install, update and diagnostic commands. The
   public page leads with direct-first Smart routing instead of redirecting a
   visitor into the administrative UI; page tests (32) and build pass.
5. In progress — replace the multi-field SmartDNS editor with one rule model:
   domain exact/suffix and geoip/geosite selectors; `direct` XOR ordered
   `vpn2`/`vusa` targets; internal DNS, external DNS, and VPN scopes.
6. Pending — compile the policy into SmartDNS, Xray, sing-box, and Happ under
   explicit capability constraints; migrate the current policy with a preview
   and prove the end-user routes on both desktop clients and the hub.

Constraint: geosite and geoip remain native Xray rules. SmartDNS receives the
domain projection only; it cannot interpret geosite or geoip itself.

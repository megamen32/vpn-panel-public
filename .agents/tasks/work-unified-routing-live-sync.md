# Unified routing live sync

- Original request: apply unified policy to Xray, sing-box, SmartDNS and related consumers.
- Objective: deploy the pushed `main` policy/config projections with backups, validation and final canaries.
- Business canary: `z.ai` remains direct; a policy-routed host resolves through expected LAN/public DNS edge and VPN subscriptions contain matching rule output.
- Confirmed scope: server-100 SmartDNS/panel, vpn2/vusa Xray, server-44 sing-box, server-88 Xray edge, router DNS projection.
- Exclusions: nginx/public ingress and unrelated dirty `.agents/tasks` files.
- Initial estimate: 30-45 active minutes; actual active time not continuously measured.
- Status: complete. Applied with backups; all target services active and final DNS/proxy canaries passed.
